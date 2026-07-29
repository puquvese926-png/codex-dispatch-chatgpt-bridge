import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_QUICK_CHAT_HEALTH_TTL_MS = 15 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function requireDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value;
}

async function writeJsonAtomically(filePath, value) {
  const target = requireAbsolutePath(filePath, "JSON path");
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function bridgeCapabilityCachePath(statePath) {
  return path.join(path.dirname(requireAbsolutePath(statePath, "state path")), "capabilities.json");
}

export function bridgeControllerLockPath(statePath) {
  return path.join(path.dirname(requireAbsolutePath(statePath, "state path")), "controller-lock.json");
}

export function buildDispatchPlan(value) {
  if (!isPlainObject(value)) throw new Error("dispatch plan input must be an object");
  const requestedJobs = value.requestedJobs;
  const timeoutMs = value.timeoutMs;
  if (!Number.isInteger(requestedJobs) || requestedJobs < 1 || requestedJobs > 6) {
    throw new Error("requestedJobs must be an integer between 1 and 6");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 900000) {
    throw new Error("timeoutMs must be an integer between 5000 and 900000");
  }

  const mainChatAvailable = value.mainChatAvailable === true;
  const experimentalQuickChat = value.experimentalQuickChat === true;
  const quickChatLimit = Number.isInteger(value.quickChatLimit) && value.quickChatLimit > 0 ?
    value.quickChatLimit : 0;
  const occupiedQuickChatWindows = Number.isInteger(value.occupiedQuickChatWindows) &&
    value.occupiedQuickChatWindows >= 0 ? value.occupiedQuickChatWindows : 0;
  const availableQuickChatWindows = Math.max(0, quickChatLimit - occupiedQuickChatWindows);
  const unhealthy = value.quickChatHealth?.status === "unhealthy";

  let selectedMode = "serial-main-chat";
  let selectedSurface = "chatgpt-main-chat";
  let concurrency = 1;
  let quickChatAttempt = false;
  let quickChatReason = "experimental-quick-chat-disabled";
  let userNotice = `当前使用主 ChatGPT 串行模式，共 ${requestedJobs} 个任务。`;

  if (!mainChatAvailable) {
    selectedMode = "unavailable";
    selectedSurface = null;
    concurrency = 0;
    quickChatReason = "main-chat-unavailable";
    userNotice = "当前没有可验证的主 ChatGPT 界面，任务不会发送。";
  } else if (experimentalQuickChat && unhealthy) {
    quickChatReason = `cached-unhealthy${value.quickChatHealth.reason ? `: ${value.quickChatHealth.reason}` : ""}`;
    userNotice = `Quick Chat 本会话已判定不可用，当前使用主 ChatGPT 串行模式，共 ${requestedJobs} 个任务。`;
  } else if (experimentalQuickChat && quickChatLimit === 0) {
    quickChatReason = "unsupported-codex-version";
    userNotice = `当前 Codex 版本不支持已验证的 Quick Chat，使用主 ChatGPT 串行模式，共 ${requestedJobs} 个任务。`;
  } else if (experimentalQuickChat && availableQuickChatWindows === 0) {
    quickChatReason = "quick-chat-capacity-unavailable";
    userNotice = `Quick Chat 当前没有空闲容量，使用主 ChatGPT 串行模式，共 ${requestedJobs} 个任务。`;
  } else if (experimentalQuickChat) {
    selectedMode = "adaptive-quick-chat";
    selectedSurface = "chatgpt-quick-chat";
    concurrency = Math.min(requestedJobs, availableQuickChatWindows);
    quickChatAttempt = true;
    quickChatReason = value.quickChatHealth?.status === "healthy" ?
      "session-health-cache-healthy" : "experimental-session-check-required";
    userNotice = `当前尝试 Quick Chat，最多并行 ${concurrency} 个任务；失败时切换到主 ChatGPT 串行模式。`;
  }

  const waves = concurrency > 0 ? Math.ceil(requestedJobs / concurrency) : 0;
  return {
    schemaVersion: 1,
    selectedMode,
    selectedSurface,
    fallbackMode: selectedMode === "adaptive-quick-chat" ? "serial-main-chat" : null,
    concurrency,
    requestedJobs,
    waves,
    timeoutPerJobMs: timeoutMs,
    estimatedCollectionMs: waves * timeoutMs,
    worstCaseCollectionMs: requestedJobs * timeoutMs,
    mainChat: {
      available: mainChatAvailable,
      concurrency: mainChatAvailable ? 1 : 0,
    },
    quickChat: {
      requested: experimentalQuickChat,
      attempt: quickChatAttempt,
      status: value.quickChatHealth?.status || "unknown",
      reason: quickChatReason,
      capacity: availableQuickChatWindows,
    },
    userNotice,
  };
}

function validateQuickChatHealth(value) {
  if (!isPlainObject(value) || value.schemaVersion !== 1) {
    throw new Error("Quick Chat capability cache is invalid");
  }
  if (!["healthy", "unhealthy"].includes(value.status)) {
    throw new Error("Quick Chat capability status is invalid");
  }
  if (typeof value.browserId !== "string" || !value.browserId ||
      typeof value.codexVersion !== "string" || !value.codexVersion) {
    throw new Error("Quick Chat capability identity is invalid");
  }
  const observedAt = new Date(value.observedAt);
  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(observedAt.getTime()) || Number.isNaN(expiresAt.getTime()) ||
      expiresAt <= observedAt) {
    throw new Error("Quick Chat capability timestamps are invalid");
  }
  if (value.reason !== null && typeof value.reason !== "string") {
    throw new Error("Quick Chat capability reason is invalid");
  }
  return {
    schemaVersion: 1,
    browserId: value.browserId,
    codexVersion: value.codexVersion,
    status: value.status,
    reason: value.reason,
    observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function readQuickChatHealth(statePath, identity, now = new Date()) {
  requireDate(now, "now");
  const cachePath = bridgeCapabilityCachePath(statePath);
  let value;
  try {
    value = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Quick Chat capability cache is invalid: ${cachePath}`);
    throw error;
  }
  const record = validateQuickChatHealth(value);
  if (record.browserId !== identity?.browserId || record.codexVersion !== identity?.codexVersion) return null;
  if (new Date(record.expiresAt) <= now) return null;
  return record;
}

export async function recordQuickChatHealth(statePath, identity, value) {
  if (!isPlainObject(identity) || typeof identity.browserId !== "string" || !identity.browserId ||
      typeof identity.codexVersion !== "string" || !identity.codexVersion) {
    throw new Error("Quick Chat capability identity is invalid");
  }
  if (!isPlainObject(value) || !["healthy", "unhealthy"].includes(value.status)) {
    throw new Error("Quick Chat capability status must be healthy or unhealthy");
  }
  const now = requireDate(value.now || new Date(), "now");
  const ttlMs = value.ttlMs ?? DEFAULT_QUICK_CHAT_HEALTH_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new Error("Quick Chat capability ttlMs is invalid");
  }
  const record = validateQuickChatHealth({
    schemaVersion: 1,
    browserId: identity.browserId,
    codexVersion: identity.codexVersion,
    status: value.status,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 2000) : null,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  await writeJsonAtomically(bridgeCapabilityCachePath(statePath), record);
  return record;
}

function validateControllerLock(value, lockPath) {
  if (!isPlainObject(value) || value.schemaVersion !== 1 ||
      typeof value.ownerId !== "string" || !value.ownerId ||
      !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.command !== "string" || !value.command ||
      typeof value.outputPath !== "string" ||
      typeof value.browserId !== "string" || !value.browserId ||
      Number.isNaN(new Date(value.acquiredAt).getTime())) {
    throw new Error(`bridge controller lock is invalid: ${lockPath}`);
  }
  return value;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (["ESRCH", "EINVAL"].includes(error?.code)) return false;
    throw error;
  }
}

async function readControllerLock(lockPath) {
  try {
    return validateControllerLock(JSON.parse(await fs.readFile(lockPath, "utf8")), lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`bridge controller lock is invalid: ${lockPath}`);
    throw error;
  }
}

export async function acquireBridgeControllerLock(value) {
  if (!isPlainObject(value)) throw new Error("bridge controller lock request must be an object");
  const statePath = requireAbsolutePath(value.statePath, "state path");
  const outputPath = requireAbsolutePath(value.outputPath, "output path");
  if (typeof value.command !== "string" || !value.command ||
      typeof value.browserId !== "string" || !value.browserId) {
    throw new Error("bridge controller lock identity is invalid");
  }
  const lockPath = bridgeControllerLockPath(statePath);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const record = {
    schemaVersion: 1,
    ownerId: randomUUID(),
    pid: process.pid,
    command: value.command,
    outputPath,
    browserId: value.browserId,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
      return Object.freeze({ ...record, lockPath });
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const existing = await readControllerLock(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(
          `bridge controller is busy: pid=${existing.pid}, command=${existing.command}, ` +
          `output=${existing.outputPath}`,
        );
      }
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new Error(`bridge controller lock could not be acquired: ${lockPath}`);
}

export async function releaseBridgeControllerLock(lease) {
  if (!isPlainObject(lease) || typeof lease.lockPath !== "string" ||
      typeof lease.ownerId !== "string" || !lease.ownerId) {
    throw new Error("bridge controller lease is invalid");
  }
  const lockPath = requireAbsolutePath(lease.lockPath, "controller lock path");
  const existing = await readControllerLock(lockPath);
  if (!existing || existing.ownerId !== lease.ownerId) return false;
  await fs.rm(lockPath);
  return true;
}
