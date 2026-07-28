import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createEmptyHandoffCheckpoint,
  recordDeliveredHandoff,
  selectNextApprovedHandoff,
  validateHandoffCheckpoint,
} from "./chatgpt-handoff-protocol.mjs";

const DEFAULT_LOCK_WAIT_MS = 2000;
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_LOCK_POLL_MS = 25;
const OWNER_FIELDS = new Set(["schemaVersion", "ownerId", "pid", "checkpointPath", "acquiredAt"]);

function checkpointPathValue(value) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) {
    throw new Error("handoff checkpoint path must be absolute");
  }
  return path.normalize(value);
}

function lockBusyError(lockPath) {
  const error = new Error(`handoff checkpoint lock is busy: ${lockPath}`);
  error.code = "ELOCKBUSY";
  return error;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseOwner(value, expectedCheckpointPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("handoff checkpoint lock owner metadata is invalid");
  }
  for (const field of Object.keys(value)) {
    if (!OWNER_FIELDS.has(field)) throw new Error("handoff checkpoint lock owner metadata has unknown fields");
  }
  if (value.schemaVersion !== 1 || typeof value.ownerId !== "string" ||
      !value.ownerId || value.ownerId.length > 200 || !Number.isInteger(value.pid) || value.pid < 1 ||
      typeof value.acquiredAt !== "string" || Number.isNaN(Date.parse(value.acquiredAt))) {
    throw new Error("handoff checkpoint lock owner metadata is invalid");
  }
  if (checkpointPathValue(value.checkpointPath) !== expectedCheckpointPath) {
    throw new Error("handoff checkpoint lock owner path changed");
  }
  return {
    schemaVersion: 1,
    ownerId: value.ownerId,
    pid: value.pid,
    checkpointPath: expectedCheckpointPath,
    acquiredAt: new Date(value.acquiredAt).toISOString(),
  };
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readOwner(ownerPath, expectedCheckpointPath, fsApi = fs) {
  const raw = await fsApi.readFile(ownerPath, "utf8");
  return parseOwner(JSON.parse(raw), expectedCheckpointPath);
}

async function removeExactLock(lockPath, fsApi = fs) {
  try {
    await fsApi.rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function checkpointLockPath(checkpointPath) {
  return `${checkpointPathValue(checkpointPath)}.lock`;
}

export async function writeJsonAtomically(file, value, {
  fsApi = fs,
  processId = process.pid,
  idFactory = randomUUID,
} = {}) {
  const target = checkpointPathValue(file);
  await fsApi.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${processId}.${idFactory()}.tmp`;
  let handle = null;
  try {
    handle = await fsApi.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    await fsApi.rename(temporary, target);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the original write error */ }
    }
    try { await fsApi.unlink(temporary); } catch (cleanupError) {
      if (!isMissing(cleanupError)) { /* preserve the original error and leave no silent overwrite */ }
    }
    throw error;
  }
}

async function inspectExistingLock(lockPath, expectedCheckpointPath, {
  fsApi,
  staleMs,
  now,
  processAlive,
}) {
  let stats;
  try {
    stats = await fsApi.stat(lockPath);
  } catch (error) {
    if (isMissing(error)) return { reclaim: false };
    throw error;
  }
  const ageMs = Math.max(0, now() - stats.mtimeMs);
  let owner = null;
  let ownerValid = true;
  try {
    owner = await readOwner(path.join(lockPath, "owner.json"), expectedCheckpointPath, fsApi);
  } catch (error) {
    if (!isMissing(error)) ownerValid = false;
  }
  if (ageMs < staleMs) return { reclaim: false };
  if (!ownerValid || !owner) return { reclaim: true };
  return { reclaim: !processAlive(owner.pid) };
}

export async function releaseHandoffCheckpointLock(checkpointPath, ownerId, { fsApi = fs } = {}) {
  const normalized = checkpointPathValue(checkpointPath);
  const lockPath = checkpointLockPath(normalized);
  if (typeof ownerId !== "string" || !ownerId) return false;
  let owner;
  try {
    owner = await readOwner(path.join(lockPath, "owner.json"), normalized, fsApi);
  } catch {
    return false;
  }
  if (owner.ownerId !== ownerId) return false;
  try {
    await fsApi.rm(lockPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function acquireHandoffCheckpointLock(checkpointPath, {
  waitMs = DEFAULT_LOCK_WAIT_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
  pollMs = DEFAULT_LOCK_POLL_MS,
  fsApi = fs,
  now = () => Date.now(),
  processAlive = defaultProcessAlive,
  processId = process.pid,
  idFactory = randomUUID,
} = {}) {
  const normalized = checkpointPathValue(checkpointPath);
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(staleMs) || staleMs < 0 ||
      !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error("handoff checkpoint lock timing is invalid");
  }
  const lockPath = checkpointLockPath(normalized);
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerId = idFactory();
  const deadline = now() + waitMs;
  const owner = {
    schemaVersion: 1,
    ownerId,
    pid: processId,
    checkpointPath: normalized,
    acquiredAt: new Date(now()).toISOString(),
  };

  // The lock is adjacent to the checkpoint, so create only its known parent
  // before attempting the exclusive mkdir. The lock directory itself remains
  // the atomic acquisition primitive.
  await fsApi.mkdir(path.dirname(normalized), { recursive: true });

  while (true) {
    let created = false;
    try {
      await fsApi.mkdir(lockPath);
      created = true;
      await writeJsonAtomically(ownerPath, owner, { fsApi, processId, idFactory });
      let released = false;
      return {
        ...owner,
        lockPath,
        async release() {
          if (released) return false;
          released = true;
          return releaseHandoffCheckpointLock(normalized, ownerId, { fsApi });
        },
      };
    } catch (error) {
      if (created) {
        await removeExactLock(lockPath, fsApi);
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
      const state = await inspectExistingLock(lockPath, normalized, {
        fsApi,
        staleMs,
        now,
        processAlive,
      });
      if (state.reclaim) {
        await removeExactLock(lockPath, fsApi);
        continue;
      }
      if (now() >= deadline) throw lockBusyError(lockPath);
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  }
}

async function readCheckpointOrEmpty(checkpointPath, conversationId, fsApi = fs) {
  try {
    const checkpoint = JSON.parse(await fsApi.readFile(checkpointPath, "utf8"));
    return validateHandoffCheckpoint(checkpoint, conversationId);
  } catch (error) {
    if (isMissing(error)) return createEmptyHandoffCheckpoint(conversationId);
    throw error;
  }
}

export async function commitHandoffDelivery({
  checkpointPath,
  conversationId,
  units,
  waitMs,
  staleMs,
  pollMs,
  fsApi = fs,
  onLockAcquired = null,
} = {}) {
  const normalized = checkpointPathValue(checkpointPath);
  const lock = await acquireHandoffCheckpointLock(normalized, {
    waitMs,
    staleMs,
    pollMs,
    fsApi,
  });
  try {
    if (onLockAcquired) await onLockAcquired(lock);
    const checkpoint = await readCheckpointOrEmpty(normalized, conversationId, fsApi);
    const handoff = selectNextApprovedHandoff(units, checkpoint);
    if (!handoff) return { status: "no-new-delivery", checkpoint, handoff: null };
    const delivered = recordDeliveredHandoff(checkpoint, handoff);
    await writeJsonAtomically(normalized, delivered, { fsApi });
    return { status: "handoff-ready", checkpoint: delivered, handoff };
  } finally {
    await lock.release();
  }
}
