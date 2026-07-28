import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
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

export function checkpointLockPath(checkpointPath) {
  return `${checkpointPathValue(checkpointPath)}.lock`;
}

export function checkpointLockResource(checkpointPath) {
  const normalized = checkpointPathValue(checkpointPath);
  const resourceKey = process.platform === "win32"
    ? path.win32.normalize(normalized).toLowerCase()
    : normalized;
  const digest = createHash("sha256").update(resourceKey, "utf8").digest("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\codex-handoff-${digest}`;
  return path.join(os.tmpdir(), `codex-handoff-${digest}.sock`);
}

function errorWithCleanupFailure(primaryError, cleanupError, message) {
  const aggregate = new AggregateError([primaryError, cleanupError], message, { cause: primaryError });
  aggregate.primaryError = primaryError;
  aggregate.cleanupError = cleanupError;
  return aggregate;
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
    let cleanupError = null;
    try { await fsApi.unlink(temporary); } catch (candidate) {
      if (!isMissing(candidate)) cleanupError = candidate;
    }
    if (cleanupError) {
      throw errorWithCleanupFailure(
        error,
        cleanupError,
        "atomic JSON write failed and temporary-file cleanup also failed",
      );
    }
    throw error;
  }
}

function lockBusyFrom(error, resource) {
  if (error?.code === "ELOCKBUSY" || error?.code === "EADDRINUSE" || error?.code === "EEXIST") {
    return lockBusyError(resource);
  }
  return error;
}

function acquireNamedPipeLease(resource, netApi = net) {
  return new Promise((resolve, reject) => {
    const server = netApi.createServer((socket) => socket.destroy());
    let acquired = false;
    const onError = (error) => {
      if (acquired) return;
      acquired = false;
      reject(lockBusyFrom(error, resource));
    };
    server.on("error", onError);
    server.once("listening", () => {
      acquired = true;
      let released = false;
      resolve({
        ownerId: null,
        async release() {
          if (released) return false;
          released = true;
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          });
          return true;
        },
      });
    });
    try {
      server.listen({ path: resource, exclusive: true });
    } catch (error) {
      onError(error);
    }
  });
}

function defaultExclusiveApi(netApi) {
  return {
    acquire(resource) {
      return acquireNamedPipeLease(resource, netApi);
    },
  };
}

export async function releaseHandoffCheckpointLock(checkpointPath, ownerId, {
  exclusiveLease = null,
} = {}) {
  const resource = checkpointLockResource(checkpointPath);
  if (typeof ownerId !== "string" || !ownerId ||
      !exclusiveLease || exclusiveLease.ownerId !== ownerId ||
      exclusiveLease.resource !== resource ||
      typeof exclusiveLease.release !== "function") return false;
  return exclusiveLease.release();
}

export async function acquireHandoffCheckpointLock(checkpointPath, {
  waitMs = DEFAULT_LOCK_WAIT_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
  pollMs = DEFAULT_LOCK_POLL_MS,
  fsApi = fs,
  now = () => Date.now(),
  processId = process.pid,
  idFactory = randomUUID,
  netApi = net,
  exclusiveApi = defaultExclusiveApi(netApi),
} = {}) {
  const normalized = checkpointPathValue(checkpointPath);
  // `staleMs` remains accepted for manifest compatibility; metadata age never
  // decides ownership or triggers a lock-path deletion.
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(staleMs) || staleMs < 0 ||
      !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error("handoff checkpoint lock timing is invalid");
  }
  const lockPath = checkpointLockPath(normalized);
  const resource = checkpointLockResource(normalized);
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

  // The named pipe is the exclusive primitive. The adjacent directory is only
  // an audit location for owner metadata and is never used for reclamation.
  await fsApi.mkdir(path.dirname(normalized), { recursive: true });

  while (true) {
    let exclusiveLease = null;
    let acquiredExclusive = false;
    try {
      exclusiveLease = await exclusiveApi.acquire(resource, { owner });
      if (!exclusiveLease || typeof exclusiveLease.release !== "function") {
        throw new Error("handoff checkpoint exclusive lease is invalid");
      }
      acquiredExclusive = true;
      const ownedLease = {
        ownerId,
        resource,
        release: () => exclusiveLease.release(),
      };
      await writeJsonAtomically(ownerPath, owner, { fsApi, processId, idFactory });
      let released = false;
      return {
        ...owner,
        lockPath,
        resource,
        async release() {
          if (released) return false;
          released = true;
          return releaseHandoffCheckpointLock(normalized, ownerId, { exclusiveLease: ownedLease });
        },
      };
    } catch (error) {
      if (exclusiveLease && typeof exclusiveLease.release === "function") {
        try {
          await exclusiveLease.release();
        } catch (cleanupError) {
          throw errorWithCleanupFailure(
            error,
            cleanupError,
            "handoff checkpoint lease setup failed and lease release also failed",
          );
        }
      }
      if (acquiredExclusive) throw error;
      const normalizedError = lockBusyFrom(error, resource);
      if (normalizedError.code !== "ELOCKBUSY") throw normalizedError;
      if (now() >= deadline) throw normalizedError;
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
  now,
  processId,
  idFactory,
  netApi,
  exclusiveApi,
} = {}) {
  const normalized = checkpointPathValue(checkpointPath);
  const lock = await acquireHandoffCheckpointLock(normalized, {
    waitMs,
    staleMs,
    pollMs,
    fsApi,
    now,
    processId,
    idFactory,
    netApi,
    exclusiveApi,
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
