import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildLifecycleEntries,
  mergeLifecycleEntries,
  selectCleanupCandidates,
  validateConversationLifecycleLedger,
  verifyMaterializedArtifacts,
} from "./chatgpt-generation-lifecycle.mjs";
import {
  createEmptyHandoffCheckpoint,
  selectNextApprovedHandoff,
  validateHandoffApprovalManifest,
  validateHandoffWatchManifest,
} from "./chatgpt-handoff-protocol.mjs";
import {
  commitHandoffDelivery,
  checkpointLockPath,
  writeJsonAtomically,
} from "./chatgpt-handoff-checkpoint.mjs";
import {
  IMAGE_LIMITS,
  isMetadataOnlyImageSource,
  isStrictAppBlobSource,
  parseStrictImageDataUrl,
} from "./chatgpt-image-materialization.mjs";
import {
  acquireBridgeControllerLock,
  buildDispatchPlan,
  bridgeCapabilityCachePath,
  bridgeControllerLockPath,
  readQuickChatHealth,
  recordQuickChatHealth,
  releaseBridgeControllerLock,
} from "./chatgpt-bridge-product-control.mjs";
import { auditPathSet } from "./chatgpt-path-safety.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CDP_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const CONVERSATION_ID_PATTERN = /^(?:local-chatgpt:)?[A-Za-z0-9._-]{1,200}$/;
const LOCAL_CHATGPT_ID_PATTERN = /^local-chatgpt:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_THREAD_ID_PATTERN = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_REFERENCE_EXTENSION = /\.(?:png|jpe?g|webp)$/iu;
const QUICK_CHAT_RPC_BY_VERSION = new Map([
  ["26.707.9564.0", "./assets/rpc-BfVaZKPC.js"],
  ["26.715.10079.0", "./assets/rpc-Ci0K2syu.js"],
]);
const QUICK_CHAT_WINDOW_LIMIT_BY_VERSION = new Map([
  ["26.707.9564.0", 2],
  ["26.715.10079.0", 2],
]);
const QUICK_CHAT_SERVICE_EXPORT_BY_VERSION = new Map([
  ["26.707.9564.0", "n"],
  ["26.715.10079.0", "appServices"],
]);
const STATE_FIELDS = new Set([
  "browserId",
  "codexExe",
  "codexPackageFamilyName",
  "codexPackageFullName",
  "codexPackageRoot",
  "codexVersion",
  "createdAt",
  "platform",
  "port",
  "schemaVersion",
]);
const execFileAsync = promisify(execFile);
const defaultStatePath = path.join(
  process.env.LOCALAPPDATA || "",
  "CodexChatGPTBridge",
  "state.json",
);
export const DEFAULT_TIMEOUT_MS = 600000;
const PNG_DATA_PREFIX = "data:image/png;base64,";
const MAX_RENDERED_DATA_URL_LENGTH = PNG_DATA_PREFIX.length + IMAGE_LIMITS.maxBase64Length;
const MAX_BLOB_CHUNK_SIZE = 1024 * 1024;
const MATERIALIZED_APP_BLOB = Symbol("materialized-app-blob");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function assertKnownFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${label} contains unknown field: ${field}`);
  }
}

export function buildDetachedEvaluateParams(expression, userGesture = false) {
  if (typeof expression !== "string" || !expression) throw new Error("Detached evaluation expression is invalid");
  return {
    expression,
    awaitPromise: false,
    returnByValue: false,
    userGesture: Boolean(userGesture),
  };
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.win32.normalize(value);
}

export function batchProgressPath(reportPath) {
  return `${requireAbsolute(reportPath, "report path")}.progress.json`;
}

function progressJob(value) {
  const job = isPlainObject(value) ? value : {};
  return {
    id: typeof job.id === "string" ? job.id : "unknown",
    promptHash: typeof job.promptHash === "string" ? job.promptHash : null,
    marker: typeof job.marker === "string" ? job.marker : null,
    conversationId: typeof job.conversationId === "string" ? job.conversationId : null,
    expectedConversationId: typeof job.expectedConversationId === "string" ?
      job.expectedConversationId : null,
    surface: typeof job.surface === "string" ? job.surface : null,
    status: typeof job.status === "string" ? job.status : "pending",
    attemptedAt: typeof job.attemptedAt === "string" ? job.attemptedAt : null,
    submittedAt: typeof job.submittedAt === "string" ? job.submittedAt : null,
    completedAt: typeof job.completedAt === "string" ? job.completedAt : null,
    historyTitle: typeof job.historyTitle === "string" ? job.historyTitle : null,
    routing: isPlainObject(job.routing) ? {
      requestedSurface: job.routing.requestedSurface || null,
      selectedSurface: job.routing.selectedSurface || null,
      fallbackReason: job.routing.fallbackReason || null,
    } : null,
    artifactCount: Array.isArray(job.artifacts) ? job.artifacts.length : 0,
    error: typeof job.error === "string" ? job.error : null,
  };
}

export function buildBatchProgress(value) {
  if (!isPlainObject(value)) throw new Error("batch progress must be an object");
  const jobs = Array.isArray(value.jobs) ? value.jobs.map(progressJob) : [];
  const state = value.state || "running";
  if (!["running", "complete", "failed"].includes(state)) {
    throw new Error("batch progress state is invalid");
  }
  const reportPath = requireAbsolute(value.reportPath, "report path");
  return {
    schemaVersion: 1,
    command: "batch",
    launchId: value.launchId || null,
    state,
    runId: value.runId,
    reportPath,
    progressPath: batchProgressPath(reportPath),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt || new Date().toISOString(),
    requestedJobs: Number.isInteger(value.requestedJobs) ? value.requestedJobs : jobs.length,
    submittedJobs: jobs.filter((job) => Boolean(job.submittedAt)).length,
    completedJobs: jobs.filter((job) => job.status === "complete").length,
    currentJobId: value.currentJobId || null,
    dispatchPlan: isPlainObject(value.dispatchPlan) ? value.dispatchPlan : null,
    error: value.error || null,
    jobs,
  };
}

export function parseBridgeArgs(argv) {
  if (!Array.isArray(argv) || !argv.length) throw new Error("A bridge command is required");
  const options = {
    command: argv[0],
    allowSend: false,
    allowDelete: false,
    input: null,
    output: null,
    statePath: null,
    launchToken: null,
    experimentalQuickChat: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  if (!["discover", "probe", "plan", "batch", "resume", "watch", "approve", "cleanup"].includes(options.command)) {
    throw new Error(`Unknown bridge command: ${options.command}`);
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-send") options.allowSend = true;
    else if (argument === "--allow-delete") options.allowDelete = true;
    else if (argument === "--experimental-quick-chat") options.experimentalQuickChat = true;
    else if (argument === "--input") options.input = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--state") options.statePath = argv[++index];
    else if (argument === "--bridge-launch-token") {
      const launchToken = argv[++index];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(launchToken || "")) {
        throw new Error("bridge launch token must be a UUID");
      }
      options.launchToken = launchToken;
    }
    else if (argument === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (argument === "--poll-ms") options.pollMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.experimentalQuickChat && !["plan", "batch"].includes(options.command)) {
    throw new Error(`${options.command} does not accept experimental Quick Chat`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 5000 || options.timeoutMs > 900000) {
    throw new Error("timeout-ms must be an integer between 5000 and 900000");
  }
  if (options.command === "watch") {
    options.pollMs ??= 5000;
    if (!Number.isInteger(options.pollMs) || options.pollMs < 250 || options.pollMs > 30000) {
      throw new Error("poll-ms must be an integer between 250 and 30000");
    }
  } else if (Object.hasOwn(options, "pollMs")) {
    throw new Error(`${options.command} does not accept --poll-ms`);
  }
  if (options.statePath !== null) options.statePath = requireAbsolute(options.statePath, "state path");
  if (["plan", "batch", "resume", "watch", "approve", "cleanup"].includes(options.command)) {
    options.input = requireAbsolute(options.input, "input path");
    options.output = requireAbsolute(options.output, "output path");
    if (["batch", "approve"].includes(options.command) && !options.allowSend) {
      throw new Error(`${options.command} requires explicit --allow-send authorization`);
    }
    if (options.command === "plan" && options.allowSend) {
      throw new Error("plan is read-only and does not accept --allow-send");
    }
    if (options.command === "resume" && options.allowSend) {
      throw new Error("resume is read-only and does not accept --allow-send");
    }
    if (options.command === "watch" && options.allowSend) {
      throw new Error("watch is read-only and does not accept --allow-send");
    }
    if (options.command === "cleanup" && !options.allowDelete) {
      throw new Error("cleanup requires explicit --allow-delete authorization");
    }
    if (options.command !== "cleanup" && options.allowDelete) {
      throw new Error(`${options.command} does not accept --allow-delete`);
    }
    if (options.command === "cleanup" && options.allowSend) {
      throw new Error("cleanup does not accept --allow-send");
    }
  } else if (options.input !== null || options.output !== null || options.allowSend ||
      options.allowDelete || options.experimentalQuickChat) {
    throw new Error(`${options.command} does not accept batch mutation arguments`);
  }
  return options;
}

export function validateBridgeBatch(value) {
  if (!isPlainObject(value)) throw new Error("bridge batch must be an object");
  if (![1, 2].includes(value.schemaVersion)) throw new Error("bridge batch schemaVersion must be 1 or 2");
  const fields = value.schemaVersion === 1 ? new Set(["schemaVersion", "jobs"]) :
    new Set(["schemaVersion", "jobType", "conversationMode", "retentionDays", "lifecycleLedgerPath", "jobs"]);
  assertKnownFields(value, fields, "bridge batch");
  if (value.schemaVersion === 2) {
    if (!["image-generation", "image-edit"].includes(value.jobType)) {
      throw new Error("generation bridge jobType must be image-generation or image-edit");
    }
    if (value.conversationMode !== "fresh-per-job") {
      throw new Error("generation bridge conversationMode must be fresh-per-job");
    }
    if (!Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 90) {
      throw new Error("generation bridge retentionDays must be 1-90");
    }
    requireAbsolute(value.lifecycleLedgerPath, "lifecycle ledger path");
  }
  if (!Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > 6) {
    throw new Error("bridge batch jobs must contain between 1 and 6 jobs");
  }
  const seen = new Set();
  const jobs = value.jobs.map((job) => {
    if (!isPlainObject(job)) throw new Error("bridge job must be an object");
    assertKnownFields(job, value.schemaVersion === 2 ? new Set(["id", "prompt", "references"]) :
      new Set(["id", "prompt"]), "bridge job");
    if (typeof job.id !== "string" || !ID_PATTERN.test(job.id)) {
      throw new Error("bridge job id must be lower-case kebab-case");
    }
    if (seen.has(job.id)) throw new Error(`duplicate bridge job id: ${job.id}`);
    seen.add(job.id);
    if (typeof job.prompt !== "string" || !job.prompt.trim() || job.prompt.length > 30000 || job.prompt.includes("\0")) {
      throw new Error(`bridge job ${job.id} prompt is invalid`);
    }
    let references;
    if (value.schemaVersion === 2) {
      const minimumReferences = value.jobType === "image-edit" ? 1 : 0;
      const referenceRange = `${minimumReferences}-8`;
      if (!Array.isArray(job.references) ||
          job.references.length < minimumReferences ||
          job.references.length > 8) {
        throw new Error(
          `bridge job ${job.id} ${value.jobType} references must contain ${referenceRange} image attachments`,
        );
      }
      references = job.references.map((reference, index) => {
        if (!isPlainObject(reference)) throw new Error(`bridge job ${job.id} reference ${index} is invalid`);
        assertKnownFields(reference, new Set(["path", "sha256"]), `bridge job ${job.id} reference`);
        const referencePath = requireAbsolute(reference.path, `bridge job ${job.id} reference path`);
        if (!IMAGE_REFERENCE_EXTENSION.test(referencePath)) {
          throw new Error(`bridge job ${job.id} reference must be png, jpg, jpeg, or webp`);
        }
        if (!/^[a-f0-9]{64}$/i.test(reference.sha256 || "")) {
          throw new Error(`bridge job ${job.id} reference SHA-256 is invalid`);
        }
        return Object.freeze({ path: referencePath, sha256: reference.sha256.toLowerCase() });
      });
    }
    return Object.freeze({ id: job.id, prompt: job.prompt, ...(references ? { references: Object.freeze(references) } : {}) });
  });
  return Object.freeze({
    ...(value.schemaVersion === 2 ? {
      schemaVersion: 2,
      jobType: value.jobType,
      conversationMode: value.conversationMode,
      retentionDays: value.retentionDays,
      lifecycleLedgerPath: path.win32.normalize(value.lifecycleLedgerPath),
    } : { schemaVersion: 1 }),
    jobs: Object.freeze(jobs),
  });
}

export function validateResumeManifest(value) {
  if (!isPlainObject(value)) throw new Error("resume manifest must be an object");
  assertKnownFields(value, new Set(["schemaVersion", "jobType", "retentionDays", "lifecycleLedgerPath", "jobs"]), "resume manifest");
  if (value.schemaVersion !== 1 || !Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > 6) {
    throw new Error("resume manifest schema or jobs are invalid");
  }
  const seen = new Set();
  const jobs = value.jobs.map((job) => {
    if (!isPlainObject(job)) throw new Error("resume job must be an object");
    assertKnownFields(job, new Set(["id", "conversationId", "marker", "title", "surface", "promptHash"]), "resume job");
    if (typeof job.id !== "string" || !ID_PATTERN.test(job.id) || seen.has(job.id)) {
      throw new Error("resume job identity is invalid or duplicated");
    }
    seen.add(job.id);
    if (typeof job.conversationId !== "string" ||
        (!LOCAL_CHATGPT_ID_PATTERN.test(job.conversationId) && !LOCAL_THREAD_ID_PATTERN.test(job.conversationId))) {
      throw new Error(`resume job ${job.id} conversation identity is invalid`);
    }
    if (typeof job.marker !== "string" || !/^CODEX-BRIDGE-[A-Za-z0-9-]{3,180}$/.test(job.marker)) {
      throw new Error(`resume job ${job.id} marker is invalid`);
    }
    if (job.title !== undefined &&
        (typeof job.title !== "string" || !job.title.trim() || job.title.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(job.title))) {
      throw new Error(`resume job ${job.id} title is invalid`);
    }
    if (!["chatgpt-quick-chat", "chatgpt-main-chat"].includes(job.surface)) {
      throw new Error(`resume job ${job.id} surface must be chatgpt-quick-chat or chatgpt-main-chat`);
    }
    if (job.promptHash !== undefined && !/^[a-f0-9]{64}$/i.test(job.promptHash)) {
      throw new Error(`resume job ${job.id} promptHash is invalid`);
    }
    return Object.freeze({ ...job });
  });
  if (value.jobType !== undefined && !["image-generation", "image-edit"].includes(value.jobType)) {
    throw new Error("resume manifest jobType is invalid");
  }
  if (value.retentionDays !== undefined && (!Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 90)) {
    throw new Error("resume manifest retentionDays is invalid");
  }
  if (value.lifecycleLedgerPath !== undefined) requireAbsolute(value.lifecycleLedgerPath, "resume lifecycle ledger path");
  const hasLifecycleMetadata = value.jobType !== undefined || value.retentionDays !== undefined || value.lifecycleLedgerPath !== undefined;
  if (hasLifecycleMetadata && (value.jobType === undefined || value.retentionDays === undefined || value.lifecycleLedgerPath === undefined)) {
    throw new Error("resume lifecycle metadata is incomplete");
  }
  if (hasLifecycleMetadata && jobs.some((job) => !job.promptHash)) {
    throw new Error("resume lifecycle metadata requires promptHash for every job");
  }
  return Object.freeze({
    schemaVersion: 1,
    ...(value.jobType !== undefined ? {
      jobType: value.jobType,
      retentionDays: value.retentionDays,
      lifecycleLedgerPath: path.win32.normalize(value.lifecycleLedgerPath),
    } : {}),
    jobs: Object.freeze(jobs),
  });
}

export function validateCleanupManifest(value) {
  if (!isPlainObject(value)) throw new Error("cleanup manifest must be an object");
  assertKnownFields(value, new Set(["schemaVersion", "jobs"]), "cleanup manifest");
  if (value.schemaVersion !== 1 || !Array.isArray(value.jobs) || value.jobs.length > 50) {
    throw new Error("cleanup manifest schema or jobs are invalid");
  }
  const seen = new Set();
  const jobs = value.jobs.map((job) => {
    if (!isPlainObject(job)) throw new Error("cleanup job must be an object");
    assertKnownFields(job, new Set(["id", "conversationId", "marker", "title", "artifacts"]), "cleanup job");
    if (typeof job.id !== "string" || !ID_PATTERN.test(job.id) || seen.has(job.conversationId)) {
      throw new Error("cleanup job identity is invalid or duplicated");
    }
    seen.add(job.conversationId);
    if (typeof job.conversationId !== "string" ||
        (!LOCAL_CHATGPT_ID_PATTERN.test(job.conversationId) && !LOCAL_THREAD_ID_PATTERN.test(job.conversationId))) {
      throw new Error(`cleanup job ${job.id} conversation identity is invalid`);
    }
    if (typeof job.marker !== "string" || !/^CODEX-BRIDGE-[A-Za-z0-9-]{3,180}$/.test(job.marker)) {
      throw new Error(`cleanup job ${job.id} marker is invalid`);
    }
    if (typeof job.title !== "string" || !job.title.trim() || job.title.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(job.title)) {
      throw new Error(`cleanup job ${job.id} title is invalid`);
    }
    if (!Array.isArray(job.artifacts) || job.artifacts.length < 1) {
      throw new Error(`cleanup job ${job.id} requires materialized artifacts`);
    }
    const artifacts = job.artifacts.map((artifact, index) => {
      if (!isPlainObject(artifact)) throw new Error(`cleanup job ${job.id} artifact ${index} is invalid`);
      assertKnownFields(artifact, new Set(["path", "sha256", "bytes"]), `cleanup job ${job.id} artifact`);
      const artifactPath = requireAbsolute(artifact.path, `cleanup job ${job.id} artifact path`);
      if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 || "") || !Number.isInteger(artifact.bytes) || artifact.bytes < 1) {
        throw new Error(`cleanup job ${job.id} artifact hash or size is invalid`);
      }
      return Object.freeze({ path: artifactPath, sha256: artifact.sha256.toLowerCase(), bytes: artifact.bytes });
    });
    return Object.freeze({ ...job, title: job.title.trim(), artifacts: Object.freeze(artifacts) });
  });
  return Object.freeze({ schemaVersion: 1, jobs: Object.freeze(jobs) });
}

export function validateBridgeState(value) {
  if (!isPlainObject(value)) throw new Error("Bridge runtime state must be an object");
  assertKnownFields(value, STATE_FIELDS, "Bridge runtime state");
  if (value.schemaVersion !== 1) throw new Error("Bridge runtime state schemaVersion must be 1");
  if (value.platform !== "windows") throw new Error("Bridge runtime state platform must be windows");
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
    throw new Error("Bridge runtime state port is invalid");
  }
  if (typeof value.browserId !== "string" || !CDP_ID_PATTERN.test(value.browserId)) {
    throw new Error("Bridge runtime state browser identity is invalid");
  }
  for (const field of [
    "codexExe",
    "codexPackageFamilyName",
    "codexPackageFullName",
    "codexPackageRoot",
    "codexVersion",
  ]) {
    if (typeof value[field] !== "string" || !value[field] || value[field].includes("\0")) {
      throw new Error(`Bridge runtime state ${field} is invalid`);
    }
  }
  if (value.createdAt !== undefined &&
      (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))) {
    throw new Error("Bridge runtime state createdAt is invalid");
  }
  const root = requireAbsolute(value.codexPackageRoot, "Codex package root");
  const executable = requireAbsolute(value.codexExe, "Codex executable");
  const expectedExecutable = path.win32.join(root, "app", "ChatGPT.exe");
  if (executable.toLowerCase() !== expectedExecutable.toLowerCase() ||
      !root.toLowerCase().includes("\\windowsapps\\openai.codex")) {
    throw new Error("Codex package executable identity is inconsistent");
  }
  return Object.freeze({ ...value });
}

export function validatedDebuggerUrl(target, port) {
  if (!isPlainObject(target) || target.type !== "page" || typeof target.url !== "string" ||
      !target.url.startsWith("app://") || typeof target.id !== "string" ||
      !CDP_ID_PATTERN.test(target.id) || typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Rejected an invalid CDP page target");
  }
  const url = new URL(target.webSocketDebuggerUrl);
  const expectedPath = `/devtools/page/${target.id}`;
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) !== port ||
      url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) {
    throw new Error("Rejected a CDP target outside the saved loopback identity");
  }
  return url.href;
}

export function browserIdFromVersion(version, port) {
  if (!isPlainObject(version) || typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP browser identity response is invalid");
  }
  const url = new URL(version.webSocketDebuggerUrl);
  const match = url.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/);
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port) !== port ||
      url.username || url.password || url.search || url.hash || !match) {
    throw new Error("Rejected a CDP browser outside the saved loopback identity");
  }
  return match[1];
}

export function selectAppTarget(targets, port) {
  if (!Array.isArray(targets)) throw new Error("CDP target list is invalid");
  const candidates = targets.filter((target) => {
    try {
      validatedDebuggerUrl(target, port);
      const url = new URL(target.url);
      return url.protocol === "app:" && url.pathname === "/index.html" && !url.search;
    } catch {
      return false;
    }
  });
  if (!candidates.length) throw new Error("No verified Codex app renderer target was found");
  if (candidates.length > 1) throw new Error("Multiple verified Codex app renderers were found");
  return candidates[0];
}

export function selectCdpPageTargetById(targets, port, expectedTargetId) {
  if (!Array.isArray(targets)) throw new Error("CDP target list is invalid");
  if (typeof expectedTargetId !== "string" || !CDP_ID_PATTERN.test(expectedTargetId)) {
    throw new Error("Expected CDP target identity is invalid");
  }
  const candidate = targets.find((target) => target?.id === expectedTargetId);
  if (!candidate) return null;
  validatedDebuggerUrl(candidate, port);
  return candidate;
}

export function selectReusedQuickChatTarget(targets, port, expectedTargetId, excludedMainTargetId = null) {
  const exact = selectCdpPageTargetById(targets, port, expectedTargetId);
  if (exact) return exact;
  if (excludedMainTargetId !== null &&
      (typeof excludedMainTargetId !== "string" || !CDP_ID_PATTERN.test(excludedMainTargetId))) {
    throw new Error("Excluded main CDP target identity is invalid");
  }
  const candidates = targets.filter((target) => {
    try {
      validatedDebuggerUrl(target, port);
      const url = new URL(target.url);
      return target.id !== excludedMainTargetId && url.protocol === "app:" && url.pathname === "/index.html" &&
        (excludedMainTargetId !== null || target.title === "ChatGPT");
    } catch {
      return false;
    }
  });
  if (!candidates.length) return null;
  if (candidates.length > 1) throw new Error("Multiple rebuilt ChatGPT quick-chat renderers were found");
  return candidates[0];
}

export function selectQuickChatTarget(targets, port, expectedConversationId = null) {
  if (!Array.isArray(targets)) throw new Error("CDP target list is invalid");
  const candidates = targets.filter((target) => {
    try {
      validatedDebuggerUrl(target, port);
      const conversationId = conversationIdFromAppUrl(target.url);
      return expectedConversationId === null ? conversationId !== null ||
        new URL(target.url).searchParams.get("initialRoute") === "/chatgpt/quick-chat-prewarm" :
        conversationId === expectedConversationId;
    } catch {
      return false;
    }
  });
  if (!candidates.length) return null;
  if (candidates.length > 1) throw new Error("Multiple ChatGPT quick-chat renderers were found");
  return candidates[0];
}

export function selectNewOrUniquePrewarmQuickChatTarget(targets, port, knownTargetIds) {
  if (!Array.isArray(targets)) throw new Error("CDP target list is invalid");
  if (!(knownTargetIds instanceof Set) || [...knownTargetIds].some((id) =>
    typeof id !== "string" || !CDP_ID_PATTERN.test(id))) {
    throw new Error("Known quick-chat target identities are invalid");
  }
  const candidates = targets.filter((target) => {
    try {
      validatedDebuggerUrl(target, port);
      const url = new URL(target.url);
      return conversationIdFromAppUrl(target.url) !== null ||
        url.searchParams.get("initialRoute") === "/chatgpt/quick-chat-prewarm";
    } catch {
      return false;
    }
  });
  const created = candidates.filter((target) => !knownTargetIds.has(target.id));
  if (created.length > 1) throw new Error("Multiple new ChatGPT quick-chat renderers were found");
  if (created.length === 1) return created[0];
  const reusablePrewarm = candidates.filter((target) => {
    const url = new URL(target.url);
    return knownTargetIds.has(target.id) &&
      url.searchParams.get("initialRoute") === "/chatgpt/quick-chat-prewarm";
  });
  if (reusablePrewarm.length > 1) throw new Error("Multiple existing ChatGPT prewarm renderers were found");
  return reusablePrewarm[0] || null;
}

export function selectOwnedQuickChatTarget(
  targets,
  port,
  expectedConversationId,
  prewarmTargetId,
  knownTargetIds,
  failedTargetIds = new Set(),
) {
  if (!Array.isArray(targets)) throw new Error("CDP target list is invalid");
  if (typeof expectedConversationId !== "string" || !LOCAL_CHATGPT_ID_PATTERN.test(expectedConversationId)) {
    throw new Error("Expected ChatGPT conversation identity is invalid");
  }
  if (typeof prewarmTargetId !== "string" || !CDP_ID_PATTERN.test(prewarmTargetId)) {
    throw new Error("Expected prewarm CDP target identity is invalid");
  }
  for (const [label, ids] of [["known", knownTargetIds], ["failed", failedTargetIds]]) {
    if (!(ids instanceof Set) || [...ids].some((id) => typeof id !== "string" || !CDP_ID_PATTERN.test(id))) {
      throw new Error(`${label} quick-chat target identities are invalid`);
    }
  }
  if (!failedTargetIds.has(prewarmTargetId)) {
    const ownedPrewarm = targets.find((target) => {
      try {
        validatedDebuggerUrl(target, port);
        const url = new URL(target.url);
        return target.id === prewarmTargetId && target.type === "page" &&
          url.protocol === "app:" && url.pathname === "/index.html";
      } catch {
        return false;
      }
    });
    if (ownedPrewarm) return ownedPrewarm;
  }
  const candidates = targets.filter((target) => {
    try {
      validatedDebuggerUrl(target, port);
      if (failedTargetIds.has(target.id)) return false;
      const url = new URL(target.url);
      const route = url.searchParams.get("initialRoute");
      return conversationIdFromAppUrl(target.url) === expectedConversationId ||
        route === "/chatgpt/quick-chat-prewarm";
    } catch {
      return false;
    }
  });
  const exactConversation = candidates.filter((target) => {
    try { return conversationIdFromAppUrl(target.url) === expectedConversationId; } catch { return false; }
  });
  if (exactConversation.length > 1) throw new Error("Multiple exact ChatGPT conversation renderers were found");
  if (exactConversation.length === 1) return exactConversation[0];
  const exactPrewarm = candidates.find((target) => target.id === prewarmTargetId) || null;
  if (exactPrewarm) return exactPrewarm;
  const created = candidates.filter((target) => !knownTargetIds.has(target.id));
  if (created.length > 1) throw new Error("Multiple attributable rebuilt ChatGPT renderers were found");
  if (created.length === 1) return created[0];
  const reusablePrewarm = candidates.filter((target) => knownTargetIds.has(target.id));
  if (reusablePrewarm.length > 1) throw new Error("Multiple reusable ChatGPT prewarm renderers were found");
  return reusablePrewarm[0] || null;
}

export function isRetryableCdpOpenError(error) {
  return error instanceof Error &&
    /^CDP websocket open (?:failed|timed out)(?: for target [A-F0-9]{32})?$/.test(error.message);
}

export function activeCdpOpenCooldownTargets(cooldownByTarget, now = Date.now()) {
  if (!(cooldownByTarget instanceof Map) || !Number.isFinite(now)) {
    throw new Error("CDP target cooldown state is invalid");
  }
  const active = new Set();
  for (const [targetId, retryAfter] of cooldownByTarget) {
    if (typeof targetId !== "string" || !CDP_ID_PATTERN.test(targetId) || !Number.isFinite(retryAfter)) {
      throw new Error("CDP target cooldown entry is invalid");
    }
    if (retryAfter > now) active.add(targetId);
  }
  return active;
}

export function buildQuickChatPrewarmExpression(codexVersion) {
  const rpcModule = QUICK_CHAT_RPC_BY_VERSION.get(codexVersion);
  if (!rpcModule) throw new Error(`Unsupported Codex version for native quick chat: ${codexVersion}`);
  const serviceExport = QUICK_CHAT_SERVICE_EXPORT_BY_VERSION.get(codexVersion);
  return `(async () => {
    const rpc = await import(${JSON.stringify(rpcModule)});
    const service = rpc[${JSON.stringify(serviceExport)}]?.quickChatWindow;
    if (!service?.prewarm) throw new Error('Quick Chat window service is unavailable');
    await service.prewarm();
    return true;
  })()`;
}

function quickChatOpenSpec(codexVersion, conversationId, popoverBounds) {
  const rpcModule = QUICK_CHAT_RPC_BY_VERSION.get(codexVersion);
  if (!rpcModule) throw new Error(`Unsupported Codex version for native quick chat: ${codexVersion}`);
  const serviceExport = QUICK_CHAT_SERVICE_EXPORT_BY_VERSION.get(codexVersion);
  if (typeof conversationId !== "string" || !LOCAL_CHATGPT_ID_PATTERN.test(conversationId)) {
    throw new Error("Native quick-chat conversation identity is invalid");
  }
  if (!isPlainObject(popoverBounds)) throw new Error("Quick-chat popover bounds are invalid");
  const bounds = {};
  for (const field of ["x", "y", "width", "height"]) {
    const value = popoverBounds[field];
    if (!Number.isFinite(value) || value < 0 || value > 10000) {
      throw new Error(`Quick-chat popover bound ${field} is invalid`);
    }
    bounds[field] = Number(value);
  }
  if (bounds.width < 320 || bounds.height < 320) {
    throw new Error("Quick-chat popover dimensions are too small");
  }
  return { rpcModule, serviceExport, bounds };
}

export function buildQuickChatOpenExpression(codexVersion, conversationId, popoverBounds) {
  const { rpcModule, serviceExport, bounds } = quickChatOpenSpec(codexVersion, conversationId, popoverBounds);
  return `(async () => {
    const rpc = await import(${JSON.stringify(rpcModule)});
    const service = rpc[${JSON.stringify(serviceExport)}]?.quickChatWindow;
    if (!service?.open) throw new Error('Quick Chat window service is unavailable');
    await service.open(${JSON.stringify({ conversationId, popoverBounds: bounds })});
    return ${JSON.stringify(conversationId)};
  })()`;
}

export function buildQuickChatOpenDispatchExpression(codexVersion, conversationId, popoverBounds) {
  const { rpcModule, serviceExport, bounds } = quickChatOpenSpec(codexVersion, conversationId, popoverBounds);
  const operationKey = `open:${conversationId}`;
  return `(() => {
    const store = globalThis.__codexChatBridgeLifecycle ||= Object.create(null);
    const key = ${JSON.stringify(operationKey)};
    store[key] = { state: 'starting' };
    Promise.resolve().then(async () => {
      const rpc = await import(${JSON.stringify(rpcModule)});
      const service = rpc[${JSON.stringify(serviceExport)}]?.quickChatWindow;
      if (!service?.open) throw new Error('Quick Chat window service is unavailable');
      store[key] = { state: 'dispatched' };
      await service.open(${JSON.stringify({ conversationId, popoverBounds: bounds })});
      store[key] = { state: 'fulfilled' };
    }).catch((error) => {
      store[key] = { state: 'rejected', message: String(error?.message || error) };
    });
    return key;
  })()`;
}

export function buildQuickChatRendererReadyExpression(codexVersion, conversationId) {
  const rpcModule = QUICK_CHAT_RPC_BY_VERSION.get(codexVersion);
  if (!rpcModule) throw new Error(`Unsupported Codex version for native quick chat: ${codexVersion}`);
  const serviceExport = QUICK_CHAT_SERVICE_EXPORT_BY_VERSION.get(codexVersion);
  if (typeof conversationId !== "string" || !LOCAL_CHATGPT_ID_PATTERN.test(conversationId)) {
    throw new Error("Native quick-chat conversation identity is invalid");
  }
  const operationKey = `renderer-ready:${conversationId}`;
  return `(() => {
    const store = globalThis.__codexChatBridgeLifecycle ||= Object.create(null);
    const key = ${JSON.stringify(operationKey)};
    store[key] = { state: 'starting' };
    Promise.resolve().then(async () => {
      const rpc = await import(${JSON.stringify(rpcModule)});
      const service = rpc[${JSON.stringify(serviceExport)}]?.quickChatWindow;
      if (!service?.rendererReady) throw new Error('Quick Chat renderer-ready service is unavailable');
      const ready = service.rendererReady(${JSON.stringify(conversationId)});
      store[key] = { state: 'dispatched' };
      ready.catch((error) => { store[key] = { state: 'rejected', message: String(error?.message || error) }; });
    }).catch((error) => { store[key] = { state: 'failed', message: String(error?.message || error) }; });
    return key;
  })()`;
}

export function buildQuickChatOperationStatusExpression(operation, conversationId) {
  if (!['open', 'renderer-ready'].includes(operation)) {
    throw new Error(`Unknown quick-chat lifecycle operation: ${operation}`);
  }
  if (typeof conversationId !== "string" || !LOCAL_CHATGPT_ID_PATTERN.test(conversationId)) {
    throw new Error("Native quick-chat conversation identity is invalid");
  }
  const operationKey = `${operation}:${conversationId}`;
  return `(() => {
    const value = globalThis.__codexChatBridgeLifecycle?.[${JSON.stringify(operationKey)}];
    return value && typeof value === 'object' ? value : null;
  })()`;
}

export function quickChatWaveSize(codexVersion, occupiedWindows) {
  const limit = QUICK_CHAT_WINDOW_LIMIT_BY_VERSION.get(codexVersion);
  if (!limit) throw new Error(`Unsupported Codex version for native quick chat: ${codexVersion}`);
  if (!Number.isInteger(occupiedWindows) || occupiedWindows < 0) {
    throw new Error("Quick-chat occupied window count is invalid");
  }
  const available = limit - occupiedWindows;
  if (available < 1) {
    throw new Error("Quick-chat window capacity is full; close an existing ChatGPT pop-out window and retry");
  }
  return available;
}

export function conversationIdFromAppUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "app:" || url.username || url.password) {
    throw new Error("ChatGPT conversation URL must use the app protocol");
  }
  const initialRoute = url.searchParams.get("initialRoute");
  if (!initialRoute) return null;
  let route = initialRoute;
  try { route = decodeURIComponent(route); } catch {}
  const match = route.match(/^\/chatgpt\/quick-chat\/([^/]+)$/);
  if (!match) {
    if (route.startsWith("/chatgpt/quick-chat/")) {
      throw new Error("ChatGPT conversation route is malformed");
    }
    return null;
  }
  const conversationId = match[1];
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error("ChatGPT conversation identity is invalid");
  }
  return conversationId;
}

export function isExpectedConversationAppUrl(value, expectedConversationId) {
  if (typeof expectedConversationId !== "string" || !LOCAL_CHATGPT_ID_PATTERN.test(expectedConversationId)) {
    throw new Error("Expected ChatGPT conversation identity is invalid");
  }
  try {
    return conversationIdFromAppUrl(value) === expectedConversationId;
  } catch {
    return false;
  }
}

export function buildChatProbeExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const chatButton = [...document.querySelectorAll('button,a,[role="button"]')].find((node) => {
      if (!visible(node)) return false;
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return /^(?:聊天|Quick chat|快速聊天)(?:\\s|$)/iu.test(label);
    }) || null;
    const chatModeButton = [...document.querySelectorAll('button,[role="button"]')].find((node) => {
      if (!visible(node)) return false;
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return /(?:当前模式|current mode)\s*[:：]?\s*ChatGPT/iu.test(label);
    }) || null;
    const composer = document.querySelector('[contenteditable="true"],textarea');
    return {
      title: document.title,
      url: location.href,
      appRenderer: location.protocol === 'app:',
      chatEntry: Boolean(chatButton || chatModeButton),
      chatEntryTag: chatButton?.tagName || null,
      chatEntryPressed: chatButton?.getAttribute('aria-pressed') || null,
      chatModeActive: Boolean(chatModeButton),
      composerPresent: Boolean(composer),
    };
  })()`;
}

export function buildMainChatEntryExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const button = [...document.querySelectorAll('button, [role="button"]')].find((node) => {
      const label = [node.getAttribute('aria-label'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return visible(node) && /^(?:聊天|Quick chat|快速聊天)(?:\\s|$)/iu.test(label);
    });
    const chatModeButton = [...document.querySelectorAll('button, [role="button"]')].find((node) => {
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return visible(node) && /(?:当前模式|current mode)\\s*[:：]?\\s*ChatGPT/iu.test(label);
    });
    const quickChatDialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')].find(visible) || null;
    const ownedDialog = quickChatDialog || [...document.querySelectorAll('[role="dialog"]')].find((dialog) => {
      if (!visible(dialog)) return false;
      return Boolean(
        dialog.querySelector('[data-above-composer-conversation-id]') ||
        dialog.querySelector('[contenteditable="true"][aria-label*="ChatGPT"], textarea[data-testid="prompt-textarea"]')
      );
    }) || null;
    if (ownedDialog || chatModeButton) return true;
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

export function buildMainChatNewConversationExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const chatModeButton = [...document.querySelectorAll('button, [role="button"]')].find((node) => {
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return visible(node) && /(?:当前模式|current mode)\\s*[:：]?\\s*ChatGPT/iu.test(label);
    });
    const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')].find(visible) ||
      [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
    if (!dialog && !chatModeButton) return false;
    const scope = dialog || document;
    const button = [...scope.querySelectorAll('button, [role="button"]')]
      .find((node) => {
        if (!visible(node)) return false;
        const labels = [
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
          node.innerText,
          node.textContent
        ].filter(Boolean).map((value) => value.trim());
        return labels.some((value) => /^(?:新聊天|New chat)$/iu.test(value));
      });
    if (button) {
      button.click();
      return true;
    }
    return [...scope.querySelectorAll('header, h1, h2, h3')]
      .some((node) => visible(node) &&
        /^(?:新聊天|New chat)$/iu.test((node.innerText || node.textContent || '').trim()));
  })()`;
}

export function buildMainChatBlankExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const chatModeButton = [...document.querySelectorAll('button, [role="button"]')].find((node) => {
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return visible(node) && /(?:当前模式|current mode)\\s*[:：]?\\s*ChatGPT/iu.test(label);
    });
    const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')].find(visible) ||
      [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
    if (!dialog && !chatModeButton) return false;
    const scope = dialog || document;
    const composerSelectors = [
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label="给 ChatGPT 发消息"]',
      '[contenteditable="true"][aria-label*="ChatGPT"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea'
    ];
    const composer = composerSelectors.map((selector) => scope.querySelector(selector)).find(visible) || null;
    const text = composer ? ('value' in composer ? composer.value : (composer.innerText || composer.textContent || '')) : '';
    const visibleUnits = [...scope.querySelectorAll('[data-content-search-unit-key]')].filter(visible).length;
    const stop = [...scope.querySelectorAll('button')].some((button) => visible(button) &&
      /^(?:停止|Stop)$/iu.test((button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim()));
    return Boolean(composer && !text.trim() && visibleUnits === 0 && !stop);
  })()`;
}

export function buildMainChatConversationIdExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')].find(visible) ||
      [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
    const node = (dialog || document).querySelector('[data-above-composer-conversation-id]');
    const raw = node?.getAttribute('data-above-composer-conversation-id')?.trim() || '';
    const match = /^chatgpt:(local-chatgpt:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(raw);
    if (match) return match[1];
    const activeThread = document.querySelector(
      '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-id][aria-current="page"]',
    );
    const activeId = activeThread?.getAttribute('data-app-action-sidebar-thread-id')?.trim() || '';
    if (/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(activeId)) {
      return activeId;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)) {
      return 'local:' + raw;
    }
    return null;
  })()`;
}

function validateSubmissionExpressionInput(surface, conversationId, marker = null) {
  if (!new Set(["chatgpt-quick-chat", "chatgpt-main-chat"]).has(surface)) {
    throw new Error("submission surface is invalid");
  }
  const validConversationId = surface === "chatgpt-quick-chat" ?
    LOCAL_CHATGPT_ID_PATTERN.test(conversationId) :
    LOCAL_CHATGPT_ID_PATTERN.test(conversationId) || LOCAL_THREAD_ID_PATTERN.test(conversationId);
  if (!validConversationId) throw new Error("submission conversation identity is invalid");
  if (marker !== null &&
      (typeof marker !== "string" || !marker || marker.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(marker))) {
    throw new Error("submission marker is invalid");
  }
}

function buildExactSubmissionRootSource(surface, conversationId) {
  validateSubmissionExpressionInput(surface, conversationId);
  return `
    const surface = ${JSON.stringify(surface)};
    const expectedConversationId = ${JSON.stringify(conversationId)};
    const visible = (node) => {
      if (!node || node.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const composerSelectors = [
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label="给 ChatGPT 发消息"]',
      '[contenteditable="true"][aria-label*="ChatGPT"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea'
    ];
    const sendSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ];
    const uniqueVisible = (root, selectors) => {
      const matches = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const node of root.querySelectorAll(selector)) {
          if (!seen.has(node) && visible(node)) {
            seen.add(node);
            matches.push(node);
          }
        }
      }
      return matches;
    };
    const composersIn = (root) => uniqueVisible(root, composerSelectors)
      .filter((composer) => !composer.disabled);
    const sendsIn = (root) => {
      const sends = uniqueVisible(root, sendSelectors);
      const seen = new Set(sends);
      for (const button of root.querySelectorAll('button')) {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.textContent
        ].filter(Boolean).join(' ');
        if (!seen.has(button) && visible(button) && /(?:send|发送|提交)/iu.test(label)) {
          seen.add(button);
          sends.push(button);
        }
      }
      return sends;
    };
    const normalizeIdentity = (rawValue) => {
      const raw = String(rawValue || '').trim();
      const quick = /^chatgpt:(local-chatgpt:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(raw);
      if (quick) return quick[1];
      if (/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)) {
        return raw;
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)) {
        return 'local:' + raw;
      }
      return null;
    };
    const currentQuickChatConversationId = () => {
      try {
        const url = new URL(location.href);
        if (url.protocol !== 'app:' || url.username || url.password) return null;
        const initialRoute = url.searchParams.get('initialRoute');
        if (!initialRoute) return null;
        let route = initialRoute;
        try {
          route = decodeURIComponent(route);
        } catch {}
        const match = /^\\/chatgpt\\/quick-chat\\/([^/]+)$/.exec(route);
        if (!match) return null;
        const conversationId = match[1];
        if (!/^(?:local-chatgpt:)?[A-Za-z0-9._-]{1,200}$/.test(conversationId)) {
          return null;
        }
        return conversationId;
      } catch {
        return null;
      }
    };
    const hasChatGptMode = (root) => [...root.querySelectorAll('button,[role="button"]')].some((node) => {
      if (!visible(node)) return false;
      const label = [
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
        node.textContent
      ].filter(Boolean).join(' ').trim();
      return /(?:当前模式\\s*[:：]?\\s*ChatGPT|current mode\\s*[:：]?\\s*ChatGPT)/iu.test(label);
    });
    const isExplicitChatGptComposer = (composer) => {
      const label = [
        composer.getAttribute('aria-label'),
        composer.getAttribute('title')
      ].filter(Boolean).join(' ');
      return /ChatGPT/iu.test(label);
    };
    const ownerForComposer = (composer) => {
      const quickChat = composer.closest('[data-pip-obstacle="quick-chat"]');
      if (quickChat) return quickChat;
      const dialog = composer.closest('[role="dialog"]');
      if (dialog) return dialog;
      const identityOwner = composer.closest('[data-above-composer-conversation-id]');
      if (identityOwner) return identityOwner;
      if (surface !== 'chatgpt-main-chat') return null;
      let current = composer.parentElement;
      while (current && current !== document) {
        if (current.matches?.('main, [role="main"], section') && hasChatGptMode(current)) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    const rootHasExpectedIdentity = (root) => {
      const identityNodes = [];
      if (root.matches?.('[data-above-composer-conversation-id]')) identityNodes.push(root);
      identityNodes.push(...root.querySelectorAll('[data-above-composer-conversation-id]'));
      const identities = [...new Set(identityNodes
        .map((node) => normalizeIdentity(node.getAttribute('data-above-composer-conversation-id')))
        .filter(Boolean))];
      if (identities.length > 0) return identities.length === 1 && identities[0] === expectedConversationId;
      if (surface !== 'chatgpt-main-chat' ||
          !expectedConversationId.startsWith('local:') ||
          !hasChatGptMode(root)) {
        return false;
      }
      const rootComposers = composersIn(root);
      if (rootComposers.length !== 1 || !isExplicitChatGptComposer(rootComposers[0])) return false;
      const activeIds = [...new Set([...document.querySelectorAll(
        '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-id][aria-current="page"]'
      )].filter(visible).map((node) =>
        normalizeIdentity(node.getAttribute('data-app-action-sidebar-thread-id'))
      ).filter(Boolean))];
      return activeIds.length === 1 && activeIds[0] === expectedConversationId;
    };
    const resolveExactOwner = (requireSend) => {
      if (surface === 'chatgpt-quick-chat') {
        const currentConversationId = currentQuickChatConversationId();
        if (currentConversationId !== expectedConversationId) {
          return {
            ok: false,
            reason: 'quick-chat-route-mismatch',
            currentConversationId,
            expectedConversationId
          };
        }
        const composers = composersIn(document);
        if (composers.length !== 1) {
          return { ok: false, reason: 'composer-count', rootCount: 1, composerCount: composers.length };
        }
        const sends = requireSend ? sendsIn(document) : [];
        if (requireSend && sends.length !== 1) {
          return { ok: false, reason: 'send-count', rootCount: 1, sendCount: sends.length };
        }
        return { ok: true, root: document, composer: composers[0], send: sends[0] || null };
      }
      const candidateRoots = [];
      const seenRoots = new Set();
      for (const composer of composersIn(document)) {
        const root = ownerForComposer(composer);
        if (root && !seenRoots.has(root)) {
          seenRoots.add(root);
          candidateRoots.push(root);
        }
      }
      const exactRoots = candidateRoots.filter(rootHasExpectedIdentity);
      if (exactRoots.length !== 1) {
        return { ok: false, reason: 'exact-root-count', rootCount: exactRoots.length };
      }
      const root = exactRoots[0];
      const composers = composersIn(root);
      if (composers.length !== 1) {
        return { ok: false, reason: 'composer-count', rootCount: 1, composerCount: composers.length };
      }
      const sends = requireSend ? sendsIn(root) : [];
      if (requireSend && sends.length !== 1) {
        return { ok: false, reason: 'send-count', rootCount: 1, sendCount: sends.length };
      }
      return { ok: true, root, composer: composers[0], send: sends[0] || null };
    };`;
}

export function buildComposerFocusExpression(surface, conversationId) {
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return resolved;
    resolved.composer.focus();
    const focused = document.activeElement === resolved.composer ||
      resolved.composer.contains(document.activeElement);
    return {
      ok: focused,
      reason: focused ? 'focused' : 'focus-rejected',
      conversationId: expectedConversationId
    };
  })()`;
}

export function buildComposerAvailabilityExpression(requireBlank = true) {
  if (typeof requireBlank !== "boolean") throw new Error("composer blank requirement is invalid");
  return `(() => {
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const selectors = [
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label="给 ChatGPT 发消息"]',
      '[contenteditable="true"][aria-label*="ChatGPT"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea'
    ];
    const composer = selectors.map((selector) => document.querySelector(selector)).find(visible) || null;
    if (!composer) return false;
    if (!${JSON.stringify(requireBlank)}) return true;
    const text = 'value' in composer ? composer.value : (composer.innerText || composer.textContent || '');
    return !text.trim() && document.querySelectorAll('[data-content-search-unit-key]').length === 0;
  })()`;
}

export function buildComposerReadinessExpression(surface, conversationId, marker) {
  validateSubmissionExpressionInput(surface, conversationId, marker);
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    ${rootSource}
    const resolved = resolveExactOwner(true);
    if (!resolved.ok) return resolved;
    const composerText = 'value' in resolved.composer ?
      resolved.composer.value :
      (resolved.composer.innerText || resolved.composer.textContent || '');
    if (!composerText.includes(marker)) {
      return { ok: false, reason: 'marker-mismatch', conversationId: expectedConversationId };
    }
    if (resolved.send.disabled) {
      return { ok: false, reason: 'send-disabled', conversationId: expectedConversationId };
    }
    return { ok: true, reason: 'ready', conversationId: expectedConversationId };
  })()`;
}

export function buildSendClickExpression(surface, conversationId, marker) {
  validateSubmissionExpressionInput(surface, conversationId, marker);
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    ${rootSource}
    const resolved = resolveExactOwner(true);
    if (!resolved.ok) return { clicked: false, ...resolved };
    const composerText = 'value' in resolved.composer ?
      resolved.composer.value :
      (resolved.composer.innerText || resolved.composer.textContent || '');
    if (!composerText.includes(marker)) {
      return {
        clicked: false,
        reason: 'marker-mismatch',
        conversationId: expectedConversationId
      };
    }
    if (resolved.send.disabled ||
        !resolved.root.contains(resolved.composer) ||
        !resolved.root.contains(resolved.send)) {
      return {
        clicked: false,
        reason: 'owner-mismatch',
        conversationId: expectedConversationId
      };
    }
    resolved.send.click();
    return {
      clicked: true,
      reason: 'clicked',
      conversationId: expectedConversationId
    };
  })()`;
}

function buildSnapshotBodySource(marker) {
  return `
    const marker = ${JSON.stringify(marker)};
    const units = [...root.querySelectorAll('[data-content-search-unit-key]')]
      .filter(visible)
      .map((node) => {
        const key = node.getAttribute('data-content-search-unit-key') || '';
        const role = key.endsWith(':assistant') ? 'assistant' : key.endsWith(':user') ? 'user' : null;
        if (!role) return null;
        return {
          key,
          role,
          text: (node.innerText || node.textContent || '').trim(),
          images: role === 'assistant' ? [...node.querySelectorAll('img')]
            .filter(visible)
            .map((image) => ({
              src: image.currentSrc || image.src || '',
              width: image.naturalWidth || image.width || 0,
              height: image.naturalHeight || image.height || 0,
              alt: image.alt || '',
            })) : [],
        };
      })
      .filter(Boolean);
    const assistants = units.filter((unit) => unit.role === 'assistant');
    const users = units.filter((unit) => unit.role === 'user');
    const latest = assistants.at(-1) || null;
    const generatedImages = [...root.querySelectorAll('img')]
      .filter(visible)
      .filter((image) => image.naturalWidth >= 512 && image.naturalHeight >= 512 &&
        /(?:generated image|生成图像)/i.test(image.alt || ''))
      .map((image) => ({
        src: image.currentSrc || image.src || '',
        width: image.naturalWidth || image.width || 0,
        height: image.naturalHeight || image.height || 0,
        alt: image.alt || '',
      }));
    const images = [...(latest?.images || []), ...generatedImages]
      .filter((image, index, all) => image.src && all.findIndex((item) => item.src === image.src) === index);
    return {
      readable: true,
      conversationId: expectedConversationId,
      markerPresent: users.some((unit) => unit.text.includes(marker)),
      composerBusy: Boolean(root.querySelector('button[aria-label="停止"], button[aria-label="Stop"]')),
      hasStopButton: Boolean(root.querySelector('button[aria-label="停止"], button[aria-label="Stop"]')),
      sendPresent: Boolean(root.querySelector('button[aria-label="发送"], button[aria-label="Send"]')),
      assistantMessageCount: assistants.length,
      userMessageCount: users.length,
      assistantText: latest?.text || '',
      images,
    };
  `;
}

function emptySnapshotSource(reasonExpression) {
  return `{
      readable: false,
      conversationId: null,
      reason: ${reasonExpression},
      markerPresent: false,
      composerBusy: false,
      hasStopButton: false,
      sendPresent: false,
      assistantMessageCount: 0,
      userMessageCount: 0,
      assistantText: '',
      images: [],
    }`;
}

export function buildConversationSnapshotExpression(marker, expectedConversationId, surface = "quick-chat") {
  if (typeof marker !== "string" || !marker || marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(marker)) {
    throw new Error("snapshot marker is invalid");
  }
  if (!new Set(["quick-chat", "main-chat"]).has(surface)) throw new Error("snapshot surface is invalid");
  const submissionSurface = surface === "quick-chat" ? "chatgpt-quick-chat" : "chatgpt-main-chat";
  validateSubmissionExpressionInput(submissionSurface, expectedConversationId);
  const rootSource = buildExactSubmissionRootSource(submissionSurface, expectedConversationId);
  const bodySource = buildSnapshotBodySource(marker);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return ${emptySnapshotSource("resolved.reason")};
    const root = resolved.root;
    ${bodySource}
  })()`;
}

export function buildMainChatSubmissionLeaseExpression(conversationId, marker) {
  if (!LOCAL_CHATGPT_ID_PATTERN.test(conversationId) && !LOCAL_THREAD_ID_PATTERN.test(conversationId)) {
    throw new Error("main ChatGPT submission lease conversation identity is invalid");
  }
  if (typeof marker !== "string" || !marker || marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(marker)) {
    throw new Error("main ChatGPT submission lease marker is invalid");
  }
  const rootSource = buildExactSubmissionRootSource("chatgpt-main-chat", conversationId);
  const bodySource = buildSnapshotBodySource(marker);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) {
      return { conversationId: null, snapshot: ${emptySnapshotSource("resolved.reason")} };
    }
    const root = resolved.root;
    const snapshot = (() => {
      ${bodySource}
    })();
    return { conversationId: expectedConversationId, snapshot };
  })()`;
}

export function buildHandoffUnitsExpression(surface, expectedConversationId) {
  validateSubmissionExpressionInput(surface, expectedConversationId);
  const rootSource = buildExactSubmissionRootSource(surface, expectedConversationId);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return { readable: false, conversationId: null, units: [] };
    const root = resolved.root;
    const units = [...root.querySelectorAll('[data-content-search-unit-key]')]
      .filter(visible)
      .map((node) => {
        const key = node.getAttribute('data-content-search-unit-key') || '';
        const role = key.endsWith(':assistant') ? 'assistant' : key.endsWith(':user') ? 'user' : null;
        if (!role) return null;
        return {
          key: key.slice(0, 300),
          role,
          text: (node.innerText || node.textContent || '').slice(0, 30000),
          codeBlocks: [...node.querySelectorAll('code')]
            .map((code) => (code.innerText || code.textContent || '').slice(0, 30000))
            .slice(0, 20),
        };
      })
      .filter(Boolean)
      .slice(-500);
    return { readable: true, conversationId: expectedConversationId, units };
  })()`;
}

export function buildHandoffApprovalFocusExpression(surface, conversationId) {
  validateSubmissionExpressionInput(surface, conversationId);
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return resolved;
    const root = resolved.root;
    const composer = resolved.composer;
    const composerText = 'value' in composer ? composer.value : (composer.innerText || composer.textContent || '');
    if (composerText.trim()) return { ok: false, reason: 'composer-not-empty' };
    const stop = [...root.querySelectorAll('button')].find((button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
        .filter(Boolean).join(' ');
      return visible(button) && /^(?:stop|停止)$/iu.test(label.trim());
    });
    if (stop) return { ok: false, reason: 'conversation-busy' };
    composer.focus();
    return {
      ok: document.activeElement === composer || composer.contains(document.activeElement),
      reason: 'focused',
      conversationId: expectedConversationId,
    };
  })()`;
}

export function buildHandoffApprovalSubmitExpression(surface, conversationId, taskId) {
  validateSubmissionExpressionInput(surface, conversationId);
  if (!ID_PATTERN.test(taskId)) throw new Error("handoff approval taskId is invalid");
  const approval = `CODEX_APPROVE ${taskId}`;
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    const approval = ${JSON.stringify(approval)};
    ${rootSource}
    const resolved = resolveExactOwner(true);
    if (!resolved.ok) return { ok: false, clicked: false, ...resolved };
    const root = resolved.root;
    const composer = resolved.composer;
    const composerText = 'value' in composer ? composer.value : (composer.innerText || composer.textContent || '');
    if (composerText.trim() !== approval) {
      return { ok: false, clicked: false, reason: 'approval-mismatch', composerText: composerText.slice(0, 200) };
    }
    if (!root.contains(composer) || !root.contains(resolved.send) || resolved.send.disabled) {
      return { ok: false, clicked: false, reason: 'owner-mismatch' };
    }
    resolved.send.click();
    return { ok: true, clicked: true, reason: 'clicked', conversationId: expectedConversationId };
  })()`;
}

export function buildHistoryTitleExpression() {
  return `(() => {
    const buttons = [...document.querySelectorAll('button[aria-label]')];
    const active = buttons.filter((button) => {
      const owner = button.closest('[aria-current="page"], [aria-selected="true"], [data-state="active"], [data-active="true"]');
      return Boolean(owner || button.getAttribute('aria-current') === 'page' ||
        button.getAttribute('aria-selected') === 'true' || button.getAttribute('data-state') === 'active');
    });
    const excluded = /^(发送|停止|关闭|最小化|最大化|更多|菜单|Send|Stop|Close|Minimize|Maximize|More|Menu)$/i;
    const titles = active.map((button) => (button.getAttribute('aria-label') || '').trim())
      .filter((title) => title && title.length <= 200 && !excluded.test(title));
    return titles.length === 1 ? titles[0] : null;
  })()`;
}

export function buildHistoryTitleListExpression() {
  return `(() => {
    const excluded = /^(发送|停止|关闭|最小化|最大化|更多|菜单|Send|Stop|Close|Minimize|Maximize|More|Menu)$/i;
    const titles = [...document.querySelectorAll('button[aria-label]')].filter((button) => {
      let container = button;
      for (let depth = 0; depth < 5 && container; depth += 1, container = container.parentElement) {
        const controls = [...container.querySelectorAll('button')].filter((candidate) => candidate !== button);
        if (controls.some((candidate) => /更多|More|菜单|menu/i.test(
          candidate.getAttribute('aria-label') || candidate.getAttribute('title') || ''))) return true;
      }
      return false;
    }).map((button) => (button.getAttribute('aria-label') || '').trim())
      .filter((title) => title && title.length <= 200 && !excluded.test(title));
    return [...new Set(titles)].slice(0, 50);
  })()`;
}

export function buildMarkerPresenceExpression(marker) {
  if (typeof marker !== "string" || !marker || marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(marker)) {
    throw new Error("history marker is invalid");
  }
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    return [...document.querySelectorAll('[data-content-search-unit-key]')]
      .filter((node) => (node.getAttribute('data-content-search-unit-key') || '').endsWith(':user'))
      .some((node) => (node.innerText || node.textContent || '').includes(marker));
  })()`;
}

export function buildAttachmentButtonExpression(surface, conversationId) {
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return { inputPresent: false, clicked: false, ...resolved };
    const inputs = [...resolved.root.querySelectorAll('input[type="file"]')];
    if (inputs.length > 1) {
      return { inputPresent: false, clicked: false, reason: 'file-input-count', inputCount: inputs.length };
    }
    if (inputs.length === 1) return { inputPresent: true, clicked: false };
    const controls = [...resolved.root.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter((node) => /Attach|Add files|Upload|添加|附加|上传|文件/iu.test(
        node.getAttribute('aria-label') || node.getAttribute('title') ||
        node.innerText || node.textContent || ''));
    if (controls.length !== 1) {
      return { inputPresent: false, clicked: false, reason: 'attach-control-count', controlCount: controls.length };
    }
    const attach = controls[0];
    attach.click();
    return { inputPresent: false, clicked: true };
  })()`;
}

export function buildAttachmentInputStateExpression(surface, conversationId) {
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return { ok: false, inputCount: null, ...resolved };
    const inputCount = [...resolved.root.querySelectorAll('input[type="file"]')].length;
    return {
      ok: inputCount === 1,
      inputCount,
      inputPresent: inputCount === 1,
      reason: inputCount === 0 ? 'file-input-missing' : inputCount > 1 ? 'file-input-count' : 'ready',
    };
  })()`;
}

export function buildAttachmentInputExpression(surface, conversationId) {
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return null;
    const inputs = [...resolved.root.querySelectorAll('input[type="file"]')];
    return inputs.length === 1 ? inputs[0] : null;
  })()`;
}

export function buildAttachmentAcknowledgementExpression(surface, conversationId, expectedNames) {
  validateSubmissionExpressionInput(surface, conversationId);
  if (!Array.isArray(expectedNames) || !expectedNames.length || expectedNames.some((name) =>
    typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name))) {
    throw new Error("attachment acknowledgement names are invalid");
  }
  const rootSource = buildExactSubmissionRootSource(surface, conversationId);
  return `(() => {
    const expected = ${JSON.stringify(expectedNames)};
    ${rootSource}
    const resolved = resolveExactOwner(false);
    if (!resolved.ok) return false;
    const inputs = [...resolved.root.querySelectorAll('input[type="file"]')];
    if (inputs.length !== 1) return false;
    const input = inputs[0];
    const selected = input ? [...input.files].map((file) => file.name) : [];
    const attachmentSemantic = /attachment|attached|file|upload|image|picture|图片|附件|文件|上传|图像/iu;
    const renderedLabels = [...resolved.root.querySelectorAll('[aria-label], [title], img[alt], [data-testid]')]
      .filter(visible)
      .filter((node) => {
        const tagName = (node.tagName || '').toLowerCase();
        const dataTestId = node.getAttribute('data-testid') || '';
        const label = [
          node.getAttribute('aria-label') || '',
          node.getAttribute('title') || '',
          tagName === 'img' ? node.getAttribute('alt') || '' : '',
        ].join(' ');
        return tagName === 'img' && Boolean(node.getAttribute('alt')) ||
          attachmentSemantic.test(label) ||
          /attachment|attached|file|upload/iu.test(dataTestId);
      })
      .flatMap((node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('title') || '',
        node.getAttribute('alt') || '',
        node.getAttribute('data-testid') || '',
      ]);
    return expected.every((name) => selected.includes(name) ||
      renderedLabels.some((label) => label.includes(name)));
  })()`;
}

export function buildHistoryDeleteStartExpression(title) {
  if (typeof title !== "string" || !title.trim() || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw new Error("history title is invalid");
  }
  return `(() => {
    const title = ${JSON.stringify(title.trim())};
    const matches = [...document.querySelectorAll('button[aria-label]')]
      .filter((button) => button.getAttribute('aria-label') === title);
    if (matches.length !== 1) return { pass: false, reason: 'title-not-unique' };
    const target = matches[0];
    let container = target;
    for (let depth = 0; depth < 5 && container; depth += 1, container = container.parentElement) {
      const controls = [...container.querySelectorAll('button')].filter((button) => button !== target);
      const menu = controls.find((button) => /更多|More|菜单|menu/i.test(
        button.getAttribute('aria-label') || button.getAttribute('title') || ''));
      if (menu) {
        menu.click();
        return { pass: true };
      }
    }
    return { pass: false, reason: 'menu-not-found' };
  })()`;
}

function buildHistoryDeleteMenuExpression() {
  return `(() => {
    const nodes = [...document.querySelectorAll('[role="menuitem"], button')];
    const item = nodes.find((node) => /^(删除|Delete)$/i.test((node.innerText || node.textContent || '').trim()));
    if (!item) return false;
    item.click();
    return true;
  })()`;
}

function buildHistoryDeleteConfirmExpression() {
  return `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const buttons = [...dialog.querySelectorAll('button')];
    const confirm = buttons.find((button) => /^(删除|Delete)$/i.test((button.innerText || button.textContent || '').trim()));
    if (!confirm) return false;
    confirm.click();
    return true;
  })()`;
}

export function buildBlobImageDataExpression(source) {
  if (!isStrictAppBlobSource(source)) {
    throw new Error("Rendered blob image URL is invalid");
  }
  return `(() => {
    const source = ${JSON.stringify(source)};
    const image = [...document.images]
      .find((node) => (node.currentSrc || node.src || '') === source);
    if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 ||
        image.naturalWidth > ${IMAGE_LIMITS.maxDimension} || image.naturalHeight > ${IMAGE_LIMITS.maxDimension} ||
        image.naturalWidth * image.naturalHeight > ${IMAGE_LIMITS.maxPixels}) {
      throw new Error('Rendered blob image is unavailable or invalid');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Rendered blob image canvas is unavailable');
    context.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith(${JSON.stringify(PNG_DATA_PREFIX)}) || dataUrl.length > ${MAX_RENDERED_DATA_URL_LENGTH}) {
      throw new Error('Rendered blob image export is invalid');
    }
    return dataUrl;
  })()`;
}

export function buildBlobImageChunkExpression(source, offset, chunkSize = MAX_BLOB_CHUNK_SIZE) {
  if (!isStrictAppBlobSource(source)) {
    throw new Error("Rendered blob image URL is invalid");
  }
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_BLOB_CHUNK_SIZE) {
    throw new Error("Rendered blob image chunk offset or size is invalid");
  }
  return `(() => {
    const source = ${JSON.stringify(source)};
    const offset = ${offset};
    const chunkSize = ${chunkSize};
    const image = [...document.images]
      .find((node) => (node.currentSrc || node.src || '') === source);
    if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 ||
        image.naturalWidth > ${IMAGE_LIMITS.maxDimension} || image.naturalHeight > ${IMAGE_LIMITS.maxDimension} ||
        image.naturalWidth * image.naturalHeight > ${IMAGE_LIMITS.maxPixels}) {
      throw new Error('Rendered blob image is unavailable or invalid');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Rendered blob image canvas is unavailable');
    context.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith(${JSON.stringify(PNG_DATA_PREFIX)}) || dataUrl.length > ${MAX_RENDERED_DATA_URL_LENGTH} || offset >= dataUrl.length) {
      throw new Error('Rendered blob image export is invalid');
    }
    const nextOffset = Math.min(offset + chunkSize, dataUrl.length);
    return {
      chunk: dataUrl.slice(offset, nextOffset),
      offset,
      nextOffset,
      total: dataUrl.length,
      done: nextOffset >= dataUrl.length,
    };
  })()`;
}

export function classifyJobObservation(observation) {
  if (!isPlainObject(observation) || observation.submitted !== true) return "not-submitted";
  if (!observation.expectedConversationId ||
      observation.currentConversationId !== observation.expectedConversationId) {
    return "unknown-after-submit";
  }
  if (observation.composerBusy || observation.hasStopButton ||
      (!observation.hasGeneratedImages &&
        observation.assistantMessageCount <= observation.baselineAssistantMessageCount) ||
      observation.stablePolls < 2) {
    return "waiting";
  }
  return "complete";
}

function reportedImageDimensions(width, height) {
  if (Number.isInteger(width) && Number.isInteger(height) && width >= 0 && height >= 0 &&
      width <= IMAGE_LIMITS.maxDimension && height <= IMAGE_LIMITS.maxDimension &&
      width * height <= IMAGE_LIMITS.maxPixels) {
    return { width, height };
  }
  return { width: 0, height: 0 };
}

function consumeRenderedImageBudget(budget, dataUrlLength, decodedBytes) {
  if (!Number.isInteger(dataUrlLength) || !Number.isInteger(decodedBytes) ||
      budget.dataUrlLength + dataUrlLength > IMAGE_LIMITS.maxAggregateDataUrlLength ||
      budget.decodedBytes + decodedBytes > IMAGE_LIMITS.maxAggregateBytes) {
    throw new Error("rendered image aggregate safety budget exceeded");
  }
  budget.dataUrlLength += dataUrlLength;
  budget.decodedBytes += decodedBytes;
}

export async function materializeRenderedImages(session, images) {
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.maxImages) {
    throw new Error("rendered image count exceeds the safety limit");
  }
  const budget = { dataUrlLength: 0, decodedBytes: 0 };
  const materialized = [];
  for (const image of images) {
    if (isStrictAppBlobSource(image?.src)) {
      const chunks = [];
      let offset = 0;
      let total = null;
      let received = 0;
      let completed = false;
      const maxChunks = Math.ceil(MAX_RENDERED_DATA_URL_LENGTH / MAX_BLOB_CHUNK_SIZE);
      for (let index = 0; index < maxChunks; index += 1) {
        const part = await session.evaluate(buildBlobImageChunkExpression(image.src, offset), false, 60000);
        if (!isPlainObject(part) || typeof part.chunk !== "string" || part.offset !== offset ||
            !Number.isInteger(part.nextOffset) || part.nextOffset <= offset ||
            !Number.isInteger(part.total) || part.total < part.nextOffset ||
            (total !== null && part.total !== total) ||
            part.total > MAX_RENDERED_DATA_URL_LENGTH ||
            part.nextOffset - part.offset !== part.chunk.length ||
            part.chunk.length < 1 || part.chunk.length > MAX_BLOB_CHUNK_SIZE ||
            received + part.chunk.length > MAX_RENDERED_DATA_URL_LENGTH ||
            typeof part.done !== "boolean" || part.done !== (part.nextOffset === part.total)) {
          throw new Error("Rendered blob image chunk is invalid");
        }
        chunks.push(part.chunk);
        received += part.chunk.length;
        total = part.total;
        if (part.done) {
          completed = true;
          break;
        }
        offset = part.nextOffset;
      }
      const dataUrl = chunks.join("");
      if (!completed || !total || dataUrl.length !== total || !dataUrl.startsWith(PNG_DATA_PREFIX)) {
        throw new Error("Rendered blob image chunks are incomplete");
      }
      const inspected = parseStrictImageDataUrl(dataUrl);
      consumeRenderedImageBudget(budget, dataUrl.length, inspected.bytes.length);
      materialized.push({ ...image, src: dataUrl, [MATERIALIZED_APP_BLOB]: true });
    } else {
      if (typeof image?.src === "string" && image.src.startsWith("data:")) {
        const inspected = parseStrictImageDataUrl(image.src);
        consumeRenderedImageBudget(budget, image.src.length, inspected.bytes.length);
      }
      materialized.push(image);
    }
  }
  return materialized;
}

function normalizeImage(image) {
  if (!isPlainObject(image) || typeof image.src !== "string") return null;
  let data = null;
  let url = null;
  try {
    if (image.src.startsWith("data:")) data = parseStrictImageDataUrl(image.src);
    else url = new URL(image.src);
  } catch {
    return null;
  }
  const remote = url && isMetadataOnlyImageSource(image.src);
  if (!data && !remote) return null;
  const dimensions = data ? data : reportedImageDimensions(image.width, image.height);
  const alt = typeof image.alt === "string" ? image.alt.slice(0, 500) : "";
  const normalized = { src: image.src, width: dimensions.width, height: dimensions.height, alt };
  if (data && image[MATERIALIZED_APP_BLOB] === true) {
    Object.defineProperty(normalized, MATERIALIZED_APP_BLOB, { value: true, enumerable: false });
  }
  return Object.freeze(normalized);
}

function remoteImageMetadata(image) {
  if (!isPlainObject(image) || typeof image.src !== "string") return null;
  let url;
  try {
    url = new URL(image.src);
  } catch {
    return null;
  }
  if (!isMetadataOnlyImageSource(image.src) || !url.protocol) return null;
  const dimensions = reportedImageDimensions(image.width, image.height);
  return Object.freeze({
    width: dimensions.width,
    height: dimensions.height,
    alt: typeof image.alt === "string" ? image.alt.slice(0, 500) : "",
  });
}

export function normalizeCollectedResult(value) {
  if (!isPlainObject(value) || typeof value.conversationId !== "string" ||
      !CONVERSATION_ID_PATTERN.test(value.conversationId)) {
    throw new Error("collected result conversation identity is invalid");
  }
  if (typeof value.url !== "string" || typeof value.assistantText !== "string" || !Array.isArray(value.images)) {
    throw new Error("collected conversation result is invalid");
  }
  const url = new URL(value.url);
  if (url.protocol !== "app:" || url.username || url.password) {
    throw new Error("collected conversation URL is invalid");
  }
  const images = value.images.map(normalizeImage).filter(Boolean);
  return Object.freeze({
    conversationId: value.conversationId,
    url: value.url,
    assistantText: value.assistantText.slice(0, 100000),
    images: Object.freeze(images),
  });
}

export function summarizeCollectedImages(images) {
  if (!Array.isArray(images)) throw new Error("collected image list is invalid");
  return images.map((image) => {
    const remote = isMetadataOnlyImageSource(image?.src);
    const dimensions = reportedImageDimensions(image?.width, image?.height);
    return {
      sourceType: remote ? "remote-image" : image?.[MATERIALIZED_APP_BLOB] === true ?
        "materialized-app-blob" : "renderer-data-url",
      materializationStatus: remote ? "metadata-only" : "materialized",
      width: dimensions.width,
      height: dimensions.height,
      alt: typeof image?.alt === "string" ? image.alt : "",
    };
  });
}

export function buildJobRouting(
  selectedSurface,
  fallbackReason = null,
  requestedSurface = "chatgpt-quick-chat",
) {
  if (!['chatgpt-quick-chat', 'chatgpt-main-chat'].includes(selectedSurface)) {
    throw new Error("selected bridge surface is invalid");
  }
  if (!['chatgpt-quick-chat', 'chatgpt-main-chat'].includes(requestedSurface)) {
    throw new Error("requested bridge surface is invalid");
  }
  if (fallbackReason !== null &&
      (typeof fallbackReason !== "string" || !fallbackReason.trim())) {
    throw new Error("bridge fallback reason is invalid");
  }
  return Object.freeze({
    requestedSurface,
    selectedSurface,
    fallbackReason,
  });
}

export function summarizeBatchSurface(jobs) {
  if (!Array.isArray(jobs)) throw new Error("bridge job list is invalid");
  const surfaces = new Set(jobs
    .map((job) => job?.surface)
    .filter((surface) => typeof surface === "string"));
  if (surfaces.size === 1) return [...surfaces][0];
  if (surfaces.size > 1) return "mixed";
  return "unknown";
}

export function summarizeBatchError(runError, jobs) {
  if (!Array.isArray(jobs)) throw new Error("bridge job list is invalid");
  const jobErrors = jobs
    .filter((job) => job?.status !== "complete")
    .map((job) => `${job.id}: ${job.status}${job.error ? ` (${job.error})` : ""}`);
  return [...new Set([runError, ...jobErrors].filter((value) => typeof value === "string" && value.trim()))].join("; ") || null;
}

export function isNativeQuickChatFallbackError(error) {
  if (!(error instanceof Error)) return false;
  return [
    "quick-chat-control-session-open",
    "quick-chat-prewarm",
    "native quick-chat prewarm target",
    "quick-chat-open",
    "quick-chat-open-dispatch",
    "native quick-chat owned target after open",
    "native quick-chat open completion",
    "quick-chat-conversation-session-open",
    "native quick-chat exact conversation target after open",
    "native quick-chat expected conversation route",
    "native blank ChatGPT conversation",
  ].some((stage) => error.message.includes(stage));
}

async function readStrictJson(file) {
  const bytes = await fs.readFile(file);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(source);
}

async function assertNoRunningBatchProgress(progressPath) {
  try {
    const progress = await readStrictJson(progressPath);
    if (progress?.state === "running") {
      throw new Error(`batch progress is already running: ${progress.runId || "unknown run"}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof SyntaxError) throw new Error(`batch progress is invalid: ${progressPath}`);
    throw error;
  }
}

async function fetchCdpJson(port, resource) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CDP ${resource} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyWindowsIdentity(state) {
  if (process.platform !== "win32") throw new Error("ChatGPT bridge is Windows-only");
  const script = `
$port = [int]$env:CODEX_BRIDGE_PORT
$packageFullName = $env:CODEX_BRIDGE_PACKAGE_FULL_NAME
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | ForEach-Object {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$_.OwningProcess)" -ErrorAction Stop
  [pscustomobject]@{
    localAddress = "$($_.LocalAddress)"
    processId = [int]$_.OwningProcess
    executablePath = "$($process.ExecutablePath)"
    commandLine = "$($process.CommandLine)"
  }
})
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
  Where-Object { "$($_.PackageFullName)" -ceq "$packageFullName" } |
  Select-Object -First 1
if ($null -eq $package) { throw 'Registered OpenAI.Codex package was not found.' }
[pscustomobject]@{
  listeners = $listeners
  package = [pscustomobject]@{
    installLocation = "$($package.InstallLocation)"
    packageFamilyName = "$($package.PackageFamilyName)"
    packageFullName = "$($package.PackageFullName)"
    signatureKind = "$($package.SignatureKind)"
  }
} | ConvertTo-Json -Depth 6 -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CODEX_BRIDGE_PORT: String(state.port),
      CODEX_BRIDGE_PACKAGE_FULL_NAME: state.codexPackageFullName,
    },
  });
  const report = JSON.parse(stdout.trim());
  const listeners = Array.isArray(report.listeners) ? report.listeners : [report.listeners].filter(Boolean);
  if (!listeners.length) throw new Error("Saved CDP port has no listener");
  for (const listener of listeners) {
    const address = String(listener.localAddress || "").toLowerCase();
    const executable = path.win32.normalize(String(listener.executablePath || ""));
    const commandLine = String(listener.commandLine || "");
    if (!["127.0.0.1", "::1"].includes(address) ||
        executable.toLowerCase() !== path.win32.normalize(state.codexExe).toLowerCase() ||
        !new RegExp(`(?:^|\\s)--remote-debugging-port(?:=|\\s+)${state.port}(?:$|\\s)`, "i").test(commandLine) ||
        !/(?:^|\s)--remote-debugging-address(?:=|\s+)127\.0\.0\.1(?:$|\s)/i.test(commandLine)) {
      throw new Error("Saved CDP listener is not owned by the verified Codex process");
    }
  }
  const registered = report.package;
  if (!registered || registered.packageFullName !== state.codexPackageFullName ||
      registered.packageFamilyName !== state.codexPackageFamilyName ||
      path.win32.normalize(registered.installLocation).toLowerCase() !==
        path.win32.normalize(state.codexPackageRoot).toLowerCase() ||
      registered.signatureKind !== "Store") {
    throw new Error("Saved Codex package identity no longer matches the registered Store package");
  }
  return Object.freeze({ listenerCount: listeners.length, processId: listeners[0].processId });
}

class CdpSession {
  constructor(target, port) {
    this.url = validatedDebuggerUrl(target, port);
    this.targetId = target.id;
    this.port = port;
    this.socket = null;
    this.ownsWindow = true;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(
        new Error(`CDP websocket open timed out for target ${this.targetId}`),
      ), 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`CDP websocket open failed for target ${this.targetId}`));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => this.failPending(new Error("CDP websocket closed")));
    await this.send("Runtime.enable");
    return this;
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.close();
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
    else pending.resolve(message.result);
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, userGesture = false, timeoutMs = 10000) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return response.result?.value;
  }

  async evaluateRemoteObject(expression, userGesture = false, timeoutMs = 10000) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: false,
      userGesture,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return response.result;
  }

  async evaluateDetached(expression, userGesture = false, timeoutMs = 10000) {
    const response = await this.send(
      "Runtime.evaluate",
      buildDetachedEvaluateParams(expression, userGesture),
      timeoutMs,
    );
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return true;
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.failPending(new Error("CDP session closed"));
    try { this.socket?.close(); } catch {}
  }
}

async function openCdpSessionAtStage(resolveTarget, port, stage, timeoutMs = 12000) {
  if (typeof resolveTarget !== "function") throw new Error("CDP target resolver is invalid");
  const deadline = Date.now() + timeoutMs;
  const cooldownByTarget = new Map();
  let lastError = null;
  while (Date.now() < deadline) {
    let target;
    try {
      target = await resolveTarget(activeCdpOpenCooldownTargets(cooldownByTarget));
    } catch (error) {
      throw annotateBridgeStageError(stage, error);
    }
    if (!target) {
      await sleep(250);
      continue;
    }
    const session = new CdpSession(target, port);
    try {
      return await session.open();
    } catch (error) {
      session.close();
      if (!isRetryableCdpOpenError(error)) throw annotateBridgeStageError(stage, error);
      lastError = error;
      cooldownByTarget.set(target.id, Date.now() + 1500);
      await sleep(250);
    }
  }
  throw annotateBridgeStageError(stage, lastError || new Error("No attributable CDP target became connectable"));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function annotateBridgeStageError(stage, error) {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new Error(`${stage}: ${cause.message}`, { cause });
}

async function evaluateAtStage(session, expression, stage, userGesture = false, timeoutMs = 10000) {
  try {
    return await session.evaluate(expression, userGesture, timeoutMs);
  } catch (error) {
    throw annotateBridgeStageError(stage, error);
  }
}

async function evaluateRemoteObjectAtStage(session, expression, stage, userGesture = false, timeoutMs = 10000) {
  try {
    return await session.evaluateRemoteObject(expression, userGesture, timeoutMs);
  } catch (error) {
    throw annotateBridgeStageError(stage, error);
  }
}

async function waitForQuickChatOperationDispatch(session, operation, conversationId) {
  return waitFor(async () => {
    const status = await evaluateAtStage(
      session,
      buildQuickChatOperationStatusExpression(operation, conversationId),
      `${operation}-dispatch-status`,
    );
    if (status?.state === "failed" || status?.state === "rejected") {
      throw new Error(`${operation} dispatch ${status.state}: ${status.message || "unknown error"}`);
    }
    return ["dispatched", "fulfilled"].includes(status?.state) ? status : null;
  }, 10000, `native quick-chat ${operation} dispatch acknowledgement`);
}

async function waitForQuickChatOperationCompletion(session, operation, conversationId) {
  return waitFor(async () => {
    const status = await evaluateAtStage(
      session,
      buildQuickChatOperationStatusExpression(operation, conversationId),
      `${operation}-completion-status`,
    );
    if (status?.state === "failed" || status?.state === "rejected") {
      throw new Error(`${operation} dispatch ${status.state}: ${status.message || "unknown error"}`);
    }
    return status?.state === "fulfilled" ? status : null;
  }, 30000, `native quick-chat ${operation} completion`);
}

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function currentRendererUrl(session) {
  const value = await evaluateAtStage(session, "location.href", "renderer-route-read");
  if (typeof value !== "string" || !value.startsWith("app://")) {
    throw new Error("ChatGPT renderer returned an invalid app URL");
  }
  return value;
}

export function shouldRequireExpectedConversationRoute(mode) {
  if (mode === "history-fallback") return false;
  if (["generation", "direct-recovery"].includes(mode)) return true;
  throw new Error(`Unknown quick-chat route mode: ${mode}`);
}

export function approvalConversationRoute(conversationId) {
  if (LOCAL_CHATGPT_ID_PATTERN.test(conversationId)) return "native-direct";
  if (LOCAL_THREAD_ID_PATTERN.test(conversationId)) return "main-active";
  throw new Error("handoff approval conversation identity is invalid");
}

async function openNativeQuickChat(discovery, conversationId, index, {
  requireBlank = true,
  routeMode = "generation",
} = {}) {
  const requireExpectedRoute = shouldRequireExpectedConversationRoute(routeMode);
  const mainSession = await openCdpSessionAtStage(async () => {
    const targets = await fetchCdpJson(discovery.state.port, "/json/list");
    return selectCdpPageTargetById(targets, discovery.state.port, discovery.target.id);
  }, discovery.state.port, "quick-chat-control-session-open");
  let knownTargetIds = new Set();
  let prewarmTargetId = null;
  try {
    const initialTargets = await fetchCdpJson(discovery.state.port, "/json/list");
    knownTargetIds = new Set(initialTargets
      .map((target) => target?.id)
      .filter((targetId) => typeof targetId === "string" && CDP_ID_PATTERN.test(targetId)));
    await evaluateAtStage(
      mainSession,
      buildQuickChatPrewarmExpression(discovery.state.codexVersion),
      "quick-chat-prewarm",
      true,
      30000,
    );
    prewarmTargetId = await waitFor(async () => {
      const targets = await fetchCdpJson(discovery.state.port, "/json/list");
      const target = selectNewOrUniquePrewarmQuickChatTarget(
        targets,
        discovery.state.port,
        knownTargetIds,
      );
      return target ? target.id : null;
    }, 30000, "native quick-chat prewarm target");
    const offset = (index % 4) * 28;
    const popoverBounds = { x: 480 + offset, y: 60 + offset, width: 960, height: 900 };
    await evaluateAtStage(
      mainSession,
      buildQuickChatOpenDispatchExpression(
        discovery.state.codexVersion,
        conversationId,
        popoverBounds,
      ),
      "quick-chat-open-dispatch",
      true,
      10000,
    );
    await waitForQuickChatOperationDispatch(mainSession, "open", conversationId);
    await waitFor(async () => {
      const targets = await fetchCdpJson(discovery.state.port, "/json/list");
      const target = selectCdpPageTargetById(targets, discovery.state.port, prewarmTargetId);
      return target ? target.id : null;
    }, 30000, "native quick-chat owned target after open");
    await waitForQuickChatOperationCompletion(mainSession, "open", conversationId);
  } finally {
    mainSession.close();
  }

  let observedTargets = [];
  let session;
  try {
    session = await openCdpSessionAtStage(async (failedTargetIds) => {
      const targets = await fetchCdpJson(discovery.state.port, "/json/list");
      observedTargets = targets
        .filter((target) => target?.type === "page" && typeof target.url === "string" && target.url.startsWith("app://"))
        .map((target) => ({
          id: target.id,
          title: target.title || "",
          url: target.url,
          type: target.type,
        }))
        .slice(0, 8);
      const target = selectOwnedQuickChatTarget(
        targets,
        discovery.state.port,
        conversationId,
        prewarmTargetId,
        knownTargetIds,
        failedTargetIds,
      );
      return target && !failedTargetIds.has(target.id) ? target : null;
    }, discovery.state.port, "quick-chat-conversation-session-open", 30000);
  } catch (error) {
    throw new Error(`${error.message}; observedTargets=${JSON.stringify(observedTargets)}`, { cause: error });
  }
  try {
    if (requireExpectedRoute) {
      await waitFor(async () => {
        const url = await currentRendererUrl(session);
        return isExpectedConversationAppUrl(url, conversationId) ? conversationId : null;
      }, 30000, "native quick-chat expected conversation route");
    }
    const prepared = await waitFor(async () => {
      const url = await currentRendererUrl(session);
      const ready = await evaluateAtStage(
        session,
        buildComposerAvailabilityExpression(requireBlank),
        "composer-readiness",
      );
      return ready ? {
        url,
        conversationId,
        surface: "chatgpt-quick-chat",
        exactRouteVerified: requireExpectedRoute,
      } : null;
    }, 30000, requireBlank ? "native blank ChatGPT conversation" : "native ChatGPT conversation");
    return { session, prepared };
  } catch (error) {
    session.close();
    throw error;
  }
}

async function openMainChatConversation(discovery, conversationId) {
  const session = await openCdpSessionAtStage(async () => {
    const targets = await fetchCdpJson(discovery.state.port, "/json/list");
    return selectCdpPageTargetById(targets, discovery.state.port, discovery.target.id);
  }, discovery.state.port, "main-chat-session-open");
  session.ownsWindow = false;
  try {
    await evaluateAtStage(session, buildMainChatEntryExpression(), "main-chat-entry-open", true);
    await waitFor(async () => evaluateAtStage(
      session,
      buildMainChatNewConversationExpression(),
      "main-chat-new-conversation-click",
      true,
    ), 10000, "main ChatGPT new conversation control");
    const prepared = await waitFor(async () => {
      const url = await currentRendererUrl(session);
      const ready = await evaluateAtStage(session, buildMainChatBlankExpression(), "main-chat-blank-readiness");
      if (!ready) return null;
      const actualConversationId = await evaluateAtStage(
        session,
        buildMainChatConversationIdExpression(),
        "main-chat-conversation-identity",
      );
      return actualConversationId ?
        { url, conversationId: actualConversationId, surface: "chatgpt-main-chat" } : null;
    }, 30000, "main ChatGPT blank conversation");
    return { session, prepared };
  } catch (error) {
    session.close();
    throw error;
  }
}

async function openMainChatSubmittedConversation(discovery, conversationId, marker) {
  const session = await openCdpSessionAtStage(async () => {
    const targets = await fetchCdpJson(discovery.state.port, "/json/list");
    return selectCdpPageTargetById(targets, discovery.state.port, discovery.target.id);
  }, discovery.state.port, "main-chat-recovery-session-open");
  session.ownsWindow = false;
  try {
    await evaluateAtStage(session, buildMainChatEntryExpression(), "main-chat-recovery-entry-open", true);
    let directError = null;
    try {
      await waitFor(async () => {
        const identity = await session.evaluate(buildMainChatConversationIdExpression());
        if (identity !== conversationId) return null;
        const snapshot = await session.evaluate(buildConversationSnapshotExpression(
          marker,
          conversationId,
          "main-chat",
        ));
        return snapshot?.markerPresent ? snapshot : null;
      }, 15000, "main ChatGPT submitted marker");
    } catch (error) {
      directError = error;
    }
    if (directError) {
      await discoverHistoryConversation(session, {
        id: "main-recovery",
        conversationId,
        marker,
      }, "main-chat");
    }
    return {
      session,
      prepared: {
        url: discovery.target.url,
        conversationId,
        surface: "chatgpt-main-chat",
      },
    };
  } catch (error) {
    session.close();
    throw error;
  }
}

async function selectHistoryConversation(session, job, surface = "quick-chat") {
  await waitFor(async () => session.evaluate(`(() => [...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label') === ${JSON.stringify(job.title)}))()`),
  10000, `ChatGPT history title for ${job.id}`);
  const clicked = await session.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === ${JSON.stringify(job.title)});
    if (!button) return false;
    button.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`ChatGPT history title did not open for ${job.id}`);
  return waitFor(async () => {
    if (surface === "main-chat") {
      const identity = await session.evaluate(buildMainChatConversationIdExpression());
      if (identity !== job.conversationId) return null;
    }
    const snapshot = await session.evaluate(buildConversationSnapshotExpression(
      job.marker,
      job.conversationId,
      surface,
    ));
    return snapshot?.markerPresent ? snapshot : null;
  }, 20000, `ChatGPT history marker for ${job.id}`);
}

async function discoverHistoryConversation(session, job, surface = "quick-chat") {
  const titles = await evaluateAtStage(session, buildHistoryTitleListExpression(), "history-title-list");
  if (!Array.isArray(titles) || titles.some((title) => typeof title !== "string")) {
    throw new Error(`ChatGPT history title list is invalid for ${job.id}`);
  }
  for (const title of titles) {
    const clicked = await evaluateAtStage(session, `(() => {
      const matches = [...document.querySelectorAll('button[aria-label]')]
        .filter((node) => node.getAttribute('aria-label') === ${JSON.stringify(title)});
      if (matches.length !== 1) return false;
      matches[0].click();
      return true;
    })()`, `history-row-open:${title}`, true);
    if (!clicked) continue;
    try {
      const found = await waitFor(async () => {
        if (surface === "main-chat") {
          const identity = await evaluateAtStage(
            session,
            buildMainChatConversationIdExpression(),
            `history-conversation-identity:${title}`,
          );
          if (identity !== job.conversationId) return null;
          const snapshot = await evaluateAtStage(
            session,
            buildConversationSnapshotExpression(job.marker, job.conversationId, "main-chat"),
            `history-marker-scan:${title}`,
          );
          return snapshot?.markerPresent ? snapshot : null;
        }
        return evaluateAtStage(
          session,
          buildMarkerPresenceExpression(job.marker),
          `history-marker-scan:${title}`,
        );
      }, 3000, `ChatGPT history marker scan for ${job.id}`);
      if (found) return title;
    } catch {}
  }
  throw new Error(`ChatGPT history marker was not found in visible titled conversations for ${job.id}`);
}

function bridgeMarker(runId, jobId) {
  return `CODEX-BRIDGE-${runId.slice(0, 8)}-${jobId}`;
}

async function verifyJobReferences(job) {
  for (const reference of job.references || []) {
    const bytes = await fs.readFile(reference.path);
    if (bytes.length < 100 || bytes.length > 30 * 1024 * 1024) {
      throw new Error(`reference size is invalid: ${reference.path}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== reference.sha256) throw new Error(`reference SHA-256 changed: ${reference.path}`);
  }
}

export async function requestExactAttachmentInputNode(session, prepared) {
  validatePreparedSubmission(prepared);
  const remote = await evaluateRemoteObjectAtStage(
    session,
    buildAttachmentInputExpression(prepared.surface, prepared.conversationId),
    "attachment-file-input-resolve",
  );
  const objectId = remote?.objectId;
  if (typeof objectId !== "string" || !objectId) {
    throw new Error("exact ChatGPT attachment file input was not resolved");
  }
  let requestError = null;
  try {
    const requested = await session.send("DOM.requestNode", { objectId });
    if (!requested?.nodeId) throw new Error("exact ChatGPT attachment file input node is unavailable");
    return requested.nodeId;
  } catch (error) {
    requestError = error;
    throw error;
  } finally {
    try {
      await session.send("Runtime.releaseObject", { objectId });
    } catch (releaseError) {
      if (!requestError) throw annotateBridgeStageError("attachment-file-input-release", releaseError);
    }
  }
}

function checkpointAuditEntries(checkpointPath) {
  const lockPath = checkpointLockPath(checkpointPath);
  return [
    { role: "watch.checkpoint", path: checkpointPath, allowMissing: true },
    { role: "watch.checkpoint-lock", path: lockPath, allowMissing: true },
    { role: "watch.checkpoint-lock-owner", path: path.win32.join(lockPath, "owner.json"), allowMissing: true },
  ];
}

function commandPathEntries(options, statePath) {
  const entries = [
    { role: "bridge.state", path: statePath, allowMissing: false },
  ];
  if (["plan", "batch", "resume", "watch", "approve", "cleanup"].includes(options.command)) {
    entries.push({
      role: options.command === "cleanup" ? "cleanup.ledger-input" : "command.input",
      path: options.input,
      allowMissing: false,
    });
    entries.push({ role: "command.output", path: options.output, allowMissing: true });
  }
  if (["plan", "batch", "resume", "approve", "cleanup"].includes(options.command)) {
    entries.push({
      role: "bridge.controller-lock",
      path: bridgeControllerLockPath(statePath),
      allowMissing: true,
    });
  }
  if (["plan", "batch"].includes(options.command)) {
    entries.push({
      role: "bridge.capability-cache",
      path: bridgeCapabilityCachePath(statePath),
      allowMissing: true,
    });
  }
  if (options.command === "batch") {
    entries.push({ role: "batch.progress", path: batchProgressPath(options.output), allowMissing: true });
  }
  return entries;
}

function addBatchPathEntries(entries, batch) {
  if (batch.schemaVersion !== 2) return;
  entries.push({ role: "generation.lifecycle-ledger", path: batch.lifecycleLedgerPath, allowMissing: true });
  for (const job of batch.jobs) {
    for (let index = 0; index < (job.references || []).length; index += 1) {
      entries.push({
        role: `batch.job.${job.id}.reference.${index}`,
        path: job.references[index].path,
        allowMissing: false,
      });
    }
  }
}

function addResumePathEntries(entries, manifest) {
  if (manifest.lifecycleLedgerPath) {
    entries.push({ role: "resume.lifecycle-ledger", path: manifest.lifecycleLedgerPath, allowMissing: true });
  }
}

function addCleanupPathEntries(entries, cleanupManifest) {
  for (const job of cleanupManifest.jobs) {
    for (let index = 0; index < job.artifacts.length; index += 1) {
      entries.push({
        role: `cleanup.job.${job.id}.artifact.${index}`,
        path: job.artifacts[index].path,
        allowMissing: false,
      });
    }
  }
}

export async function prepareBridgeCommand(options) {
  if (!isPlainObject(options) || typeof options.command !== "string") {
    throw new Error("bridge command options are invalid");
  }
  const statePath = options.statePath || defaultStatePath;
  const entries = commandPathEntries(options, statePath);
  let manifest = null;
  let ledger = null;
  let lifecycleLedger = null;
  let cleanupManifest = null;
  if (options.command === "plan" || options.command === "batch") {
    manifest = validateBridgeBatch(await readStrictJson(options.input));
    addBatchPathEntries(entries, manifest);
  } else if (options.command === "resume") {
    manifest = validateResumeManifest(await readStrictJson(options.input));
    addResumePathEntries(entries, manifest);
  } else if (options.command === "watch") {
    manifest = validateHandoffWatchManifest(await readStrictJson(options.input));
    entries.push(...checkpointAuditEntries(manifest.checkpointPath));
  } else if (options.command === "approve") {
    manifest = validateHandoffApprovalManifest(await readStrictJson(options.input));
  } else if (options.command === "cleanup") {
    ledger = validateConversationLifecycleLedger(await readStrictJson(options.input));
    const selected = selectCleanupCandidates(ledger, new Date());
    cleanupManifest = validateCleanupManifest({
      schemaVersion: 1,
      jobs: selected.map((entry) => ({
        id: entry.jobId,
        conversationId: entry.conversationId,
        marker: entry.marker,
        title: entry.historyTitle,
        artifacts: entry.artifacts,
      })),
    });
    addCleanupPathEntries(entries, cleanupManifest);
  }
  const pathAudit = await auditPathSet(entries);
  if ((options.command === "plan" || options.command === "batch" || options.command === "resume") &&
      manifest?.lifecycleLedgerPath) {
    lifecycleLedger = await readLifecycleLedgerOrEmpty(manifest.lifecycleLedgerPath);
  }
  if (manifest?.schemaVersion === 2 && ["plan", "batch"].includes(options.command)) {
    await Promise.all(manifest.jobs.map((job) => verifyJobReferences(job)));
  }
  return Object.freeze({
    options,
    statePath,
    manifest,
    ledger,
    lifecycleLedger,
    cleanupManifest,
    pathAudit,
  });
}

async function attachJobReferences(session, prepared, job) {
  validatePreparedSubmission(prepared);
  if (!job.references?.length) return;
  await verifyJobReferences(job);
  const buttonState = await session.evaluate(buildAttachmentButtonExpression(
    prepared.surface,
    prepared.conversationId,
  ), true);
  if (buttonState?.reason === "file-input-count") {
    throw new Error(`ChatGPT attachment input count is ambiguous for ${job.id}: ${buttonState.inputCount}`);
  }
  if (!buttonState?.inputPresent && !buttonState?.clicked) {
    throw new Error(`ChatGPT attachment control was not uniquely resolved for ${job.id}: ${buttonState?.reason || "unknown"}`);
  }
  const inputState = await waitFor(async () => {
    const state = await session.evaluate(buildAttachmentInputStateExpression(
      prepared.surface,
      prepared.conversationId,
    ));
    if (state?.inputCount > 1) {
      return { fatal: true, reason: "file-input-count", inputCount: state.inputCount };
    }
    return state?.inputPresent ? state : null;
  }, 5000, `attachment input for ${job.id}`);
  if (inputState?.fatal) {
    throw new Error(`ChatGPT attachment input count is ambiguous for ${job.id}: ${inputState.inputCount}`);
  }
  const nodeId = await requestExactAttachmentInputNode(session, prepared);
  await session.send("DOM.setFileInputFiles", {
    nodeId,
    files: job.references.map((reference) => reference.path),
  });
  const expectedNames = job.references.map((reference) => path.basename(reference.path));
  await waitFor(async () => session.evaluate(buildAttachmentAcknowledgementExpression(
    prepared.surface,
    prepared.conversationId,
    expectedNames,
  )),
    15000, `reference attachment acknowledgement for ${job.id}`);
}

export { attachJobReferences };

function validatePreparedSubmission(prepared) {
  if (!isPlainObject(prepared)) throw new Error("prepared submission is invalid");
  validateSubmissionExpressionInput(prepared.surface, prepared.conversationId);
  if (prepared.surface === "chatgpt-quick-chat" && prepared.exactRouteVerified !== true) {
    throw new Error("quick-chat submission route was not exactly verified");
  }
  return prepared;
}

export async function attemptExactSendClick(
  session,
  prepared,
  marker,
  now = () => new Date().toISOString(),
) {
  validatePreparedSubmission(prepared);
  const expression = buildSendClickExpression(
    prepared.surface,
    prepared.conversationId,
    marker,
  );
  const attemptedAt = now();
  if (typeof attemptedAt !== "string" || !attemptedAt) {
    throw new Error("submission attempt timestamp is invalid");
  }
  const identity = {
    attemptedAt,
    expectedConversationId: prepared.conversationId,
    expectedSurface: prepared.surface,
    marker,
  };
  try {
    const result = await session.evaluate(expression, true);
    if (result?.clicked !== true) {
      return Object.freeze({
        ...identity,
        clicked: false,
        submittedAt: null,
        status: "not-submitted",
        error: `ChatGPT send control rejected submission: ${result?.reason || "clicked-false"}`,
      });
    }
    return Object.freeze({
      ...identity,
      clicked: true,
      submittedAt: attemptedAt,
      status: "submitted",
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      ...identity,
      clicked: null,
      submittedAt: attemptedAt,
      status: "unknown-after-submit",
      error: `send-click-attempt: ${error.message}`,
    });
  }
}

export async function attemptHandoffApprovalClick(
  session,
  prepared,
  taskId,
  now = () => new Date().toISOString(),
) {
  validatePreparedSubmission(prepared);
  if (!ID_PATTERN.test(taskId)) throw new Error("handoff approval taskId is invalid");
  const expression = buildHandoffApprovalSubmitExpression(
    prepared.surface,
    prepared.conversationId,
    taskId,
  );
  const attemptedAt = now();
  if (typeof attemptedAt !== "string" || !attemptedAt) {
    throw new Error("approval attempt timestamp is invalid");
  }
  const identity = {
    attemptedAt,
    expectedConversationId: prepared.conversationId,
    expectedSurface: prepared.surface,
    taskId,
  };
  try {
    const result = await session.evaluate(expression, true);
    if (result?.ok !== true || result?.clicked !== true) {
      return Object.freeze({
        ...identity,
        clicked: false,
        submittedAt: null,
        status: "not-submitted",
        error: `ChatGPT approval send control rejected submission: ${result?.reason || "clicked-false"}`,
      });
    }
    return Object.freeze({
      ...identity,
      clicked: true,
      submittedAt: attemptedAt,
      status: "submitted",
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      ...identity,
      clicked: null,
      submittedAt: attemptedAt,
      status: "unknown-after-submit",
      error: `handoff-approve-send-click: ${error.message}`,
    });
  }
}

async function submitJob(session, prepared, job, runId) {
  validatePreparedSubmission(prepared);
  const marker = bridgeMarker(runId, job.id);
  const effectivePrompt = `${job.prompt}\n\n任务追踪标记：${marker}。不要在回答中复述该标记。`;
  await attachJobReferences(session, prepared, job);
  const composerFocused = await session.evaluate(buildComposerFocusExpression(
    prepared.surface,
    prepared.conversationId,
  ), true);
  if (!composerFocused?.ok) {
    throw new Error(
      `ChatGPT composer is unavailable before submission: ${composerFocused?.reason || "unknown"}`,
    );
  }
  await session.send("Input.insertText", { text: effectivePrompt });
  const ready = await waitFor(async () => {
    const result = await session.evaluate(buildComposerReadinessExpression(
      prepared.surface,
      prepared.conversationId,
      marker,
    ));
    return result?.ok ? result : null;
  }, 5000, `composer readiness for ${job.id}`);
  if (!ready) throw new Error(`ChatGPT composer did not accept job ${job.id}`);

  const attempt = await attemptExactSendClick(session, prepared, marker);
  const submission = {
    id: job.id,
    promptHash: createHash("sha256").update(job.prompt, "utf8").digest("hex"),
    marker,
    references: job.references || [],
    conversationId: prepared.conversationId,
    expectedConversationId: attempt.expectedConversationId,
    url: prepared.url,
    surface: prepared.surface,
    attemptedAt: attempt.attemptedAt,
    submittedAt: attempt.submittedAt,
    status: attempt.status,
  };
  if (attempt.status !== "submitted") {
    return Object.freeze({
      ...submission,
      error: attempt.error,
    });
  }
  try {
    const acknowledged = await waitFor(async () => {
      if (submission.surface === "chatgpt-main-chat") {
        const lease = await evaluateAtStage(
          session,
          buildMainChatSubmissionLeaseExpression(submission.conversationId, marker),
          "main-chat-submission-acknowledgement",
        );
        return lease?.conversationId === prepared.conversationId && lease.snapshot?.markerPresent ?
          lease.snapshot : null;
      }
      const currentId = conversationIdFromAppUrl(await currentRendererUrl(session));
      if (currentId !== prepared.conversationId) return null;
      const snapshot = await session.evaluate(buildConversationSnapshotExpression(
        marker,
        prepared.conversationId,
        "quick-chat",
      ));
      return snapshot?.markerPresent ? snapshot : null;
    }, 10000, `submission acknowledgement for ${job.id}`);
    if (!acknowledged) throw new Error("submission acknowledgement was empty");
    return Object.freeze(submission);
  } catch (error) {
    return Object.freeze({
      ...submission,
      status: "unknown-after-submit",
      error: error.message,
    });
  }
}

async function navigateToConversation(session, submission) {
  if (submission.surface === "chatgpt-main-chat") {
    return waitFor(async () => {
      const lease = await evaluateAtStage(
        session,
        buildMainChatSubmissionLeaseExpression(submission.conversationId, submission.marker),
        "main-chat-post-submit-lease-read",
      );
      return lease?.conversationId === submission.conversationId && lease.snapshot?.markerPresent ?
        lease.snapshot : null;
    }, 15000, `main-chat-post-submit-lease for ${submission.id}`);
  }
  const currentId = conversationIdFromAppUrl(await currentRendererUrl(session));
  if (currentId !== submission.conversationId) {
    await session.evaluate(`(() => {
      location.href = ${JSON.stringify(submission.url)};
      return true;
    })()`);
  }
  return waitFor(async () => {
    const id = conversationIdFromAppUrl(await currentRendererUrl(session));
    if (id !== submission.conversationId) return null;
    const snapshot = await session.evaluate(buildConversationSnapshotExpression(
      submission.marker,
      submission.conversationId,
      submission.surface === "chatgpt-main-chat" ? "main-chat" : "quick-chat",
    ));
    return snapshot?.markerPresent ? snapshot : null;
  }, 15000, `conversation navigation for ${submission.id}`);
}

async function collectJob(session, submission, timeoutMs) {
  if (submission.surface === "chatgpt-main-chat") {
    const currentLease = await evaluateAtStage(
      session,
      buildMainChatSubmissionLeaseExpression(submission.conversationId, submission.marker),
      "main-chat-current-submission-lease",
    );
    if (currentLease?.conversationId !== submission.conversationId ||
        !currentLease.snapshot?.markerPresent) {
      await evaluateAtStage(
        session,
        buildMainChatEntryExpression(),
        "main-chat-collection-entry-open",
        true,
      );
    }
  }
  await navigateToConversation(session, submission);
  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;
  let previousSignature = null;
  while (Date.now() < deadline) {
    const currentUrl = await currentRendererUrl(session);
    let currentConversationId;
    let snapshot;
    if (submission.surface === "chatgpt-main-chat") {
      const lease = await evaluateAtStage(
        session,
        buildMainChatSubmissionLeaseExpression(submission.conversationId, submission.marker),
        "main-chat-collection-lease",
      );
      currentConversationId = lease?.conversationId || null;
      snapshot = lease?.snapshot || null;
    } else {
      currentConversationId = conversationIdFromAppUrl(currentUrl);
      snapshot = await session.evaluate(buildConversationSnapshotExpression(
        submission.marker,
        submission.conversationId,
        "quick-chat",
      ));
    }
    const signature = JSON.stringify({ text: snapshot?.assistantText || "", images: snapshot?.images || [] });
    stablePolls = signature === previousSignature ? stablePolls + 1 : 0;
    previousSignature = signature;
    const classification = classifyJobObservation({
      submitted: true,
      expectedConversationId: submission.conversationId,
      currentConversationId,
      composerBusy: snapshot?.composerBusy ?? true,
      assistantMessageCount: snapshot?.assistantMessageCount ?? 0,
      baselineAssistantMessageCount: 0,
      hasStopButton: snapshot?.hasStopButton ?? true,
      hasGeneratedImages: Array.isArray(snapshot?.images) && snapshot.images.length > 0,
      stablePolls,
    });
    if (classification === "unknown-after-submit") {
      const error = submission.surface === "chatgpt-main-chat" ?
        `main-chat-collection-lease-lost for ${submission.id}` :
        `conversation identity changed during collection for ${submission.id}`;
      return { ...submission, status: classification, completedAt: null, result: null, error };
    }
    if (classification === "complete") {
      const images = await materializeRenderedImages(session, snapshot.images || []);
      const historyTitle = await session.evaluate(buildHistoryTitleExpression());
      const result = normalizeCollectedResult({
        conversationId: submission.conversationId,
        url: currentUrl,
        assistantText: snapshot.assistantText || "",
        images,
      });
      return {
        ...submission,
        historyTitle: typeof historyTitle === "string" && historyTitle.trim() ? historyTitle.trim() : null,
        status: "complete",
        completedAt: new Date().toISOString(),
        result,
      };
    }
    await sleep(1500);
  }
  return { ...submission, status: "timeout-after-submit", completedAt: null, result: null };
}

async function closeOwnedQuickChat(session) {
  if (session.ownsWindow === false) {
    session.close();
    return;
  }
  try {
    await session.evaluate("window.close(); true", true);
  } catch {
    // The renderer normally closes before CDP can return the evaluation result.
  } finally {
    session.close();
  }
  await sleep(250);
  const targets = await fetchCdpJson(session.port, "/json/list");
  if (!targets.some((target) => target.id === session.targetId)) return;
  const response = await fetch(`http://127.0.0.1:${session.port}/json/close/${session.targetId}`, {
    redirect: "error",
  });
  if (!response.ok) throw new Error(`CDP target close returned HTTP ${response.status}`);
  await waitFor(async () => {
    const remaining = await fetchCdpJson(session.port, "/json/list");
    return !remaining.some((target) => target.id === session.targetId);
  }, 5000, "owned quick-chat target close");
}

export async function materializeJobImages(job, outputFile) {
  const images = job.result?.images || [];
  if (!images.length) return [];
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.maxImages) {
    throw new Error("job image count exceeds the safety limit");
  }
  const root = path.join(path.dirname(outputFile), `${path.basename(outputFile, path.extname(outputFile))}.assets`, job.id);
  let rootCreated = false;
  let aggregateBytes = 0;
  let aggregateBudgetExceeded = false;
  const artifacts = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const remote = remoteImageMetadata(image);
    if (!remote) {
      if (aggregateBudgetExceeded) {
        artifacts.push({
          index,
          status: "metadata-only",
          materializationStatus: "metadata-only",
          sourceType: "unsupported-image",
          ...reportedImageDimensions(image?.width, image?.height),
          alt: typeof image?.alt === "string" ? image.alt : "",
          error: "job image aggregate safety budget exceeded",
        });
        continue;
      }
      try {
        const inspected = parseStrictImageDataUrl(image?.src);
        if (aggregateBytes + inspected.bytes.length > IMAGE_LIMITS.maxAggregateBytes) {
          aggregateBudgetExceeded = true;
          throw new Error("job image aggregate safety budget exceeded");
        }
        aggregateBytes += inspected.bytes.length;
        if (!rootCreated) {
          await fs.mkdir(root, { recursive: true });
          rootCreated = true;
        }
        const extension = inspected.mime === "image/png" ? ".png" :
          inspected.mime === "image/jpeg" ? ".jpg" : ".webp";
        const file = path.join(root, `image-${index + 1}${extension}`);
        await fs.writeFile(file, inspected.bytes, { flag: "wx" });
        artifacts.push({
          index,
          status: "downloaded",
          materializationStatus: "materialized",
          sourceType: image?.[MATERIALIZED_APP_BLOB] === true ?
            "materialized-app-blob" : "renderer-data-url",
          path: file,
          sha256: createHash("sha256").update(inspected.bytes).digest("hex"),
          bytes: inspected.bytes.length,
          contentType: inspected.mime,
          width: inspected.width,
          height: inspected.height,
        });
      } catch (error) {
        artifacts.push({
          index,
          status: "metadata-only",
          materializationStatus: "metadata-only",
          sourceType: "unsupported-image",
          ...reportedImageDimensions(image?.width, image?.height),
          alt: typeof image?.alt === "string" ? image.alt : "",
          error: error.message,
        });
      }
      continue;
    }
    artifacts.push({
      index,
      status: "metadata-only",
      materializationStatus: "metadata-only",
      sourceType: "remote-image",
      width: remote.width,
      height: remote.height,
      alt: remote.alt,
      error: "remote image materialization is disabled; renderer-provided data is required",
    });
  }
  return artifacts;
}

async function readLifecycleLedgerOrEmpty(file) {
  try {
    return validateConversationLifecycleLedger(await readStrictJson(file));
  } catch (error) {
    if (error?.code === "ENOENT" || /ENOENT|cannot find|not found/i.test(error?.message || "")) {
      return { schemaVersion: 1, entries: [] };
    }
    throw error;
  }
}

async function readHandoffObservation(discovery, expectedSurface, expectedConversationId) {
  const session = await openCdpSessionAtStage(async () => {
    const targets = await fetchCdpJson(discovery.state.port, "/json/list");
    return selectCdpPageTargetById(targets, discovery.state.port, discovery.target.id);
  }, discovery.state.port, "handoff-watch-session-open");
  session.ownsWindow = false;
  try {
    const rendered = await evaluateAtStage(
      session,
      buildHandoffUnitsExpression(expectedSurface, expectedConversationId),
      "handoff-watch-rendered-units",
    );
    if (!rendered || typeof rendered.readable !== "boolean" || !Array.isArray(rendered.units)) {
      throw new Error("handoff watch rendered units are invalid");
    }
    const identity = rendered.readable ? rendered.conversationId : null;
    return {
      identity,
      units: rendered.units,
      active: rendered.readable,
      readable: rendered.readable,
    };
  } finally {
    session.close();
  }
}

async function runWatch(options, discovery, manifest) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + options.timeoutMs;
  let polls = 0;
  let lastIdentity = null;
  let lastReadable = false;
  let observedUnits = 0;

  while (true) {
    polls += 1;
    const observation = await readHandoffObservation(
      discovery,
      manifest.surface,
      manifest.conversationId,
    );
    lastIdentity = observation.identity || null;
    lastReadable = observation.readable;
    observedUnits = observation.units.length;
    if (observation.active && observation.readable) {
      let delivery = null;
      try {
        delivery = await commitHandoffDelivery({
          checkpointPath: manifest.checkpointPath,
          conversationId: manifest.conversationId,
          units: observation.units,
        });
      } catch (error) {
        if (error?.code !== "ELOCKBUSY") {
          const report = {
            schemaVersion: 1,
            pass: false,
            command: "watch",
            launchId: options.launchToken,
            runId,
            startedAt,
            completedAt: new Date().toISOString(),
            status: "invalid-handoff",
            conversationId: manifest.conversationId,
            surface: manifest.surface,
            checkpointPath: manifest.checkpointPath,
            polls,
            observedUnits,
            error: error.message,
            handoff: null,
          };
          await writeJsonAtomically(options.output, report);
          return report;
        }
      }
      if (delivery?.status === "handoff-ready") {
        const deliveredAt = new Date().toISOString();
        const report = {
          schemaVersion: 1,
          pass: true,
          command: "watch",
          launchId: options.launchToken,
          runId,
          startedAt,
          completedAt: deliveredAt,
          status: "handoff-ready",
          conversationId: manifest.conversationId,
          surface: manifest.surface,
          checkpointPath: manifest.checkpointPath,
          polls,
          observedUnits,
          error: null,
          handoff: delivery.handoff,
        };
        // This is deliberately outside the checkpoint transaction catch. If
        // report persistence fails, the committed checkpoint still prevents a
        // later watcher from redelivering the same handoff.
        await writeJsonAtomically(options.output, report);
        return report;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(options.pollMs, remaining));
  }

  const report = {
    schemaVersion: 1,
    pass: true,
    command: "watch",
    launchId: options.launchToken,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    status: !lastReadable ? "conversation-not-readable" :
      lastIdentity !== manifest.conversationId ? "conversation-not-active" : "no-handoff",
    conversationId: manifest.conversationId,
    observedConversationId: lastIdentity,
    surface: manifest.surface,
    checkpointPath: manifest.checkpointPath,
    polls,
    observedUnits,
    readable: lastReadable,
    error: null,
    handoff: null,
  };
  await writeJsonAtomically(options.output, report);
  return report;
}

async function openHandoffApprovalConversation(discovery, manifest) {
  let activeMainSession = null;
  try {
    activeMainSession = await openCdpSessionAtStage(async () => {
      const targets = await fetchCdpJson(discovery.state.port, "/json/list");
      return selectCdpPageTargetById(targets, discovery.state.port, discovery.target.id);
    }, discovery.state.port, "handoff-approve-active-main-session-open");
    activeMainSession.ownsWindow = false;
    const activeIdentity = await evaluateAtStage(
      activeMainSession,
      buildMainChatConversationIdExpression(),
      "handoff-approve-active-main-identity",
    );
    const activeSnapshot = activeIdentity === manifest.conversationId ?
      await evaluateAtStage(
        activeMainSession,
        buildConversationSnapshotExpression(manifest.marker, manifest.conversationId, "main-chat"),
        "handoff-approve-active-main-marker",
      ) : null;
    if (activeSnapshot?.markerPresent) {
      return {
        session: activeMainSession,
        prepared: {
          url: discovery.target.url,
          conversationId: manifest.conversationId,
          surface: "chatgpt-main-chat",
        },
      };
    }
  } catch {
    // Continue to exact route recovery.
  }
  activeMainSession?.close();
  if (approvalConversationRoute(manifest.conversationId) === "native-direct") {
    let nativeSession = null;
    try {
      const opened = await openNativeQuickChat(discovery, manifest.conversationId, 0, {
        requireBlank: false,
        routeMode: "direct-recovery",
      });
      nativeSession = opened.session;
      await waitFor(async () => evaluateAtStage(
        nativeSession,
        buildMarkerPresenceExpression(manifest.marker),
        "handoff-approve-native-marker",
      ), 10000, `handoff approval native marker for ${manifest.taskId}`);
      return opened;
    } catch {
      nativeSession?.close();
    }
  }
  return openMainChatSubmittedConversation(
    discovery,
    manifest.conversationId,
    manifest.marker,
  );
}

export function takeHandoffApprovalSession(opened) {
  const session = opened?.session;
  if (!session || typeof session.close !== "function" ||
      typeof session.evaluate !== "function" || typeof session.send !== "function") {
    throw new Error("handoff approval session is invalid");
  }
  return session;
}

async function runApprove(options, discovery, manifest) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const approvalText = `CODEX_APPROVE ${manifest.taskId}`;
  let session = null;
  let attemptedAt = null;
  let submittedAt = null;
  let proposal = null;
  let status = "not-submitted";
  let errorText = null;
  try {
    const opened = await openHandoffApprovalConversation(discovery, manifest);
    session = takeHandoffApprovalSession(opened);
    if (!opened?.prepared || opened.prepared.conversationId !== manifest.conversationId) {
      throw new Error("handoff approval prepared conversation identity mismatch");
    }
    validateSubmissionExpressionInput(opened.prepared.surface, opened.prepared.conversationId);
    const observation = await evaluateAtStage(
      session,
      buildHandoffUnitsExpression(opened.prepared.surface, manifest.conversationId),
      "handoff-approve-proposal-read",
    );
    if (!observation?.readable) throw new Error("handoff approval conversation is not readable");
    const checkpoint = createEmptyHandoffCheckpoint(manifest.conversationId);
    const existing = selectNextApprovedHandoff(observation.units, checkpoint);
    if (existing) {
      if (existing.taskId !== manifest.taskId) {
        throw new Error(`another handoff task is already approved: ${existing.taskId}`);
      }
      proposal = existing;
      status = "already-approved";
    } else {
      const syntheticApproval = {
        key: `codex-approval-probe:${manifest.taskId}:user`,
        role: "user",
        text: approvalText,
        codeBlocks: [],
      };
      proposal = selectNextApprovedHandoff(
        [...observation.units, syntheticApproval],
        checkpoint,
      );
      if (!proposal || proposal.taskId !== manifest.taskId) {
        throw new Error(`no exact proposed CODEX_HANDOFF was found for ${manifest.taskId}`);
      }
      const focused = await evaluateAtStage(
        session,
        buildHandoffApprovalFocusExpression(opened.prepared.surface, manifest.conversationId),
        "handoff-approve-composer-focus",
        true,
      );
      if (!focused?.ok) throw new Error(`handoff approval composer rejected focus: ${focused?.reason || "unknown"}`);
      await session.send("Input.insertText", { text: approvalText });
      const attempt = await attemptHandoffApprovalClick(
        session,
        opened.prepared,
        manifest.taskId,
      );
      attemptedAt = attempt.attemptedAt;
      submittedAt = attempt.submittedAt;
      if (attempt.status !== "submitted") {
        status = attempt.status;
        errorText = attempt.error;
      } else {
        status = "submitted";
        await waitFor(async () => {
          const current = await evaluateAtStage(
            session,
            buildHandoffUnitsExpression(opened.prepared.surface, manifest.conversationId),
            "handoff-approve-ack-units",
          );
          return current?.readable && current?.conversationId === manifest.conversationId &&
            current?.units?.some((unit) =>
            unit.role === "user" && unit.text.trim() === approvalText) || null;
        }, Math.min(options.timeoutMs, 30000), `handoff approval acknowledgement for ${manifest.taskId}`);
        status = "approved";
      }
    }
  } catch (error) {
    errorText = error.message;
    status = submittedAt ? "unknown-after-submit" : "not-submitted";
  } finally {
    session?.close();
  }
  const report = {
    schemaVersion: 1,
    pass: ["approved", "already-approved"].includes(status),
    command: "approve",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    status,
    attemptedAt,
    conversationId: manifest.conversationId,
    surface: manifest.surface,
    marker: manifest.marker,
    taskId: manifest.taskId,
    approvalText,
    submittedAt,
    proposal: proposal ? {
      taskId: proposal.taskId,
      objective: proposal.objective,
      acceptance: proposal.acceptance,
      constraints: proposal.constraints,
      ...(proposal.context ? { context: proposal.context } : {}),
      planHash: proposal.planHash,
      proposalUnitKey: proposal.proposalUnitKey,
    } : null,
    error: errorText,
  };
  await writeJsonAtomically(options.output, report);
  return report;
}

async function recordGenerationLifecycle(batch, report, reportPath, lifecycleLedgerState = null) {
  if (batch.schemaVersion !== 2) return null;
  const entries = buildLifecycleEntries(report, {
    jobType: batch.jobType,
    retentionDays: batch.retentionDays,
    reportPath,
  });
  const existing = lifecycleLedgerState ? lifecycleLedgerState.value :
    await readLifecycleLedgerOrEmpty(batch.lifecycleLedgerPath);
  const merged = mergeLifecycleEntries(existing, entries);
  await writeJsonAtomically(batch.lifecycleLedgerPath, merged);
  if (lifecycleLedgerState) lifecycleLedgerState.value = merged;
  return { path: batch.lifecycleLedgerPath, recordedEntries: entries.length };
}

async function recordGenerationCheckpoint(batch, runId, jobs, reportPath, lifecycleLedgerState = null) {
  if (batch.schemaVersion !== 2) return null;
  const retainedJobs = jobs.filter((job) => job?.conversationId && job?.surface && job?.submittedAt);
  if (!retainedJobs.length) return null;
  return recordGenerationLifecycle(batch, {
    runId,
    surface: summarizeBatchSurface(retainedJobs),
    jobs: retainedJobs,
  }, reportPath, lifecycleLedgerState);
}

async function inspectDispatchPlan(options, discovery, batch) {
  const probe = await probeBridge(discovery);
  const targets = await fetchCdpJson(discovery.state.port, "/json/list");
  const occupiedQuickChatWindows = targets.filter((target) => {
    try { return conversationIdFromAppUrl(target.url) !== null; } catch { return false; }
  }).length;
  const quickChatHealth = await readQuickChatHealth(discovery.statePath, {
    browserId: discovery.state.browserId,
    codexVersion: discovery.state.codexVersion,
  });
  return buildDispatchPlan({
    requestedJobs: batch.jobs.length,
    timeoutMs: options.timeoutMs,
    mainChatAvailable: Boolean(probe.probe?.chatEntry),
    experimentalQuickChat: options.experimentalQuickChat,
    quickChatLimit: QUICK_CHAT_WINDOW_LIMIT_BY_VERSION.get(discovery.state.codexVersion) || 0,
    occupiedQuickChatWindows,
    quickChatHealth,
  });
}

async function runPlan(options, discovery, batch) {
  const dispatchPlan = await inspectDispatchPlan(options, discovery, batch);
  const report = {
    schemaVersion: 1,
    pass: dispatchPlan.selectedMode !== "unavailable",
    command: "plan",
    plannedAt: new Date().toISOString(),
    codexVersion: discovery.state.codexVersion,
    packageFullName: discovery.state.codexPackageFullName,
    port: discovery.state.port,
    browserId: discovery.state.browserId,
    requestedJobs: batch.jobs.length,
    timeoutMs: options.timeoutMs,
    dispatchPlan,
  };
  await writeJsonAtomically(options.output, report);
  return report;
}

async function runBatch(options, discovery, batch, preloadedLifecycleLedger = null) {
  const dispatchPlan = await inspectDispatchPlan(options, discovery, batch);
  if (dispatchPlan.selectedMode === "unavailable") {
    throw new Error(dispatchPlan.userNotice);
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const jobs = [];
  let runError = null;
  const lifecycleLedgerState = preloadedLifecycleLedger ? { value: preloadedLifecycleLedger } : null;
  const progressPath = batchProgressPath(options.output);
  await assertNoRunningBatchProgress(progressPath);
  let progressJobs = batch.jobs.map((job) => ({
    id: job.id,
    promptHash: createHash("sha256").update(job.prompt, "utf8").digest("hex"),
    marker: bridgeMarker(runId, job.id),
    status: "pending",
  }));
  let currentJobId = null;
  let nativeQuickChatDisabledReason = null;
  const persistBatchProgress = async (state = "running", error = null) => {
    await writeJsonAtomically(progressPath, buildBatchProgress({
      runId,
      launchId: options.launchToken,
      reportPath: options.output,
      startedAt,
      updatedAt: new Date().toISOString(),
      state,
      requestedJobs: batch.jobs.length,
      currentJobId,
      dispatchPlan,
      error,
      jobs: progressJobs,
    }));
  };
  const updateProgressJob = (job) => {
    progressJobs = progressJobs.map((existing) => existing.id === job.id ? {
      ...existing,
      ...job,
    } : existing);
  };
  await persistBatchProgress();
  const waveSize = dispatchPlan.quickChat.attempt ? dispatchPlan.concurrency : 1;
  const requestedSurface = dispatchPlan.quickChat.attempt ?
    "chatgpt-quick-chat" : "chatgpt-main-chat";

  for (let offset = 0; offset < batch.jobs.length; offset += waveSize) {
    const wave = batch.jobs.slice(offset, offset + waveSize);
    const sessions = new Map();
    const submissions = [];
    try {
      for (let localIndex = 0; localIndex < wave.length; localIndex += 1) {
        const job = wave[localIndex];
        let session = null;
        currentJobId = job.id;
        updateProgressJob({ id: job.id, status: "preparing" });
        try {
          const conversationId = `local-chatgpt:${randomUUID()}`;
          let opened;
          let fallbackReason = null;
          if (!dispatchPlan.quickChat.attempt) {
            opened = await openMainChatConversation(discovery, conversationId);
          } else if (nativeQuickChatDisabledReason) {
            fallbackReason = `${nativeQuickChatDisabledReason}; native Quick chat disabled for the remainder of this batch`;
            opened = await openMainChatConversation(discovery, conversationId);
          } else {
            try {
              opened = await openNativeQuickChat(discovery, conversationId, offset + localIndex);
              await recordQuickChatHealth(discovery.statePath, {
                browserId: discovery.state.browserId,
                codexVersion: discovery.state.codexVersion,
              }, {
                status: "healthy",
                reason: "owned Quick Chat target opened successfully",
              });
            } catch (error) {
              if (!isNativeQuickChatFallbackError(error)) throw error;
              nativeQuickChatDisabledReason = error.message;
              fallbackReason = error.message;
              await recordQuickChatHealth(discovery.statePath, {
                browserId: discovery.state.browserId,
                codexVersion: discovery.state.codexVersion,
              }, {
                status: "unhealthy",
                reason: error.message,
              });
              opened = await openMainChatConversation(discovery, conversationId);
            }
          }
          session = opened.session;
          updateProgressJob({
            id: job.id,
            conversationId: opened.prepared.conversationId,
            surface: opened.prepared.surface,
            status: "prepared",
            routing: buildJobRouting(opened.prepared.surface, fallbackReason, requestedSurface),
          });
          await persistBatchProgress();
          const submission = {
            ...(await submitJob(session, opened.prepared, job, runId)),
            routing: buildJobRouting(opened.prepared.surface, fallbackReason, requestedSurface),
          };
          updateProgressJob(submission);
          await persistBatchProgress();
          try {
            await recordGenerationCheckpoint(batch, runId, [submission], options.output, lifecycleLedgerState);
          } catch (error) {
            runError = `${runError ? `${runError}; ` : ""}Lifecycle checkpoint failed at ${job.id}: ${error.message}`;
            updateProgressJob({
              id: job.id,
              error: `lifecycle checkpoint: ${error.message}`,
            });
            await persistBatchProgress("running", error.message);
          }
          if (opened.prepared.surface === "chatgpt-main-chat") {
            let collected = submission;
            if (["submitted", "unknown-after-submit"].includes(submission.status)) {
              try {
                collected = await collectJob(session, submission, options.timeoutMs);
              } catch (error) {
                collected = {
                  ...submission,
                  status: "unknown-after-submit",
                  completedAt: null,
                  result: null,
                  error: error.message,
                };
              }
            }
            submissions.push(collected);
            updateProgressJob(collected);
            await persistBatchProgress();
            try {
              await recordGenerationCheckpoint(batch, runId, [collected], options.output, lifecycleLedgerState);
            } catch (error) {
              runError = `${runError ? `${runError}; ` : ""}Lifecycle checkpoint failed at ${job.id}: ${error.message}`;
              updateProgressJob({ id: job.id, error: `lifecycle checkpoint: ${error.message}` });
              await persistBatchProgress("running", error.message);
            }
            await closeOwnedQuickChat(session);
            session = null;
          } else {
            sessions.set(job.id, session);
            submissions.push(submission);
          }
        } catch (error) {
          if (session) await closeOwnedQuickChat(session);
          sessions.delete(job.id);
          submissions.push({
            id: job.id,
            promptHash: createHash("sha256").update(job.prompt, "utf8").digest("hex"),
            status: "not-submitted",
            submittedAt: null,
            completedAt: null,
            result: null,
            error: error.message,
          });
          updateProgressJob(submissions.at(-1));
          await persistBatchProgress("running", error.message);
          runError = `${runError ? `${runError}; ` : ""}Submission failed at ${job.id}: ${error.message}`;
        }
      }

      const collected = await Promise.all(submissions.map(async (job) => {
        const session = sessions.get(job.id);
        if (!session || !["submitted", "unknown-after-submit"].includes(job.status)) return job;
        try {
          return await collectJob(session, job, options.timeoutMs);
        } catch (error) {
          return {
            ...job,
            status: "unknown-after-submit",
            completedAt: null,
            result: null,
            error: error.message,
          };
        }
      }));
      jobs.push(...collected);
      for (const collectedJob of collected) updateProgressJob(collectedJob);
      await persistBatchProgress();
      for (const collectedJob of collected) {
        try {
          await recordGenerationCheckpoint(batch, runId, [collectedJob], options.output, lifecycleLedgerState);
        } catch (error) {
          runError = `${runError ? `${runError}; ` : ""}Lifecycle checkpoint failed at ${collectedJob.id}: ${error.message}`;
          updateProgressJob({ id: collectedJob.id, error: `lifecycle checkpoint: ${error.message}` });
        }
      }
      await persistBatchProgress("running", runError);
    } finally {
      await Promise.all([...sessions.values()].map((session) => closeOwnedQuickChat(session)));
    }
  }

  for (let index = 0; index < jobs.length; index += 1) {
    const artifacts = jobs[index].status === "complete" ?
      await materializeJobImages(jobs[index], options.output) : [];
    jobs[index] = {
      ...jobs[index],
      result: jobs[index].result ? {
        ...jobs[index].result,
        images: summarizeCollectedImages(jobs[index].result.images),
      } : null,
      artifacts,
    };
    updateProgressJob(jobs[index]);
  }
  const completedCount = jobs.filter((job) => job.status === "complete").length;
  const reportError = summarizeBatchError(runError, jobs);
  const report = {
    schemaVersion: 1,
    pass: completedCount === batch.jobs.length,
    command: "batch",
    launchId: options.launchToken,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    codexVersion: discovery.state.codexVersion,
    packageFullName: discovery.state.codexPackageFullName,
    port: discovery.state.port,
    browserId: discovery.state.browserId,
    surface: summarizeBatchSurface(jobs),
    runState: "complete",
    timeoutMs: options.timeoutMs,
    progressPath,
    dispatchPlan,
    requestedJobs: batch.jobs.length,
    completedJobs: completedCount,
    error: reportError,
    jobs,
    generationPolicy: batch.schemaVersion === 2 ? {
      jobType: batch.jobType,
      conversationMode: batch.conversationMode,
      retentionDays: batch.retentionDays,
      lifecycleLedgerPath: batch.lifecycleLedgerPath,
    } : null,
  };
  await writeJsonAtomically(options.output, report);
  const lifecycle = await recordGenerationLifecycle(batch, report, options.output, lifecycleLedgerState);
  if (lifecycle) {
    report.lifecycle = lifecycle;
    await writeJsonAtomically(options.output, report);
  }
  currentJobId = null;
  await persistBatchProgress("complete", reportError);
  return report;
}

async function runResume(options, discovery, manifest, preloadedLifecycleLedger = null) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const jobs = [];
  let runError = null;
  const initialTargets = await fetchCdpJson(discovery.state.port, "/json/list");
  const occupiedWindows = initialTargets.filter((target) => {
    try { return conversationIdFromAppUrl(target.url) !== null; } catch { return false; }
  }).length;
  const waveSize = quickChatWaveSize(discovery.state.codexVersion, occupiedWindows);

  for (let offset = 0; offset < manifest.jobs.length; offset += waveSize) {
    const wave = manifest.jobs.slice(offset, offset + waveSize);
    const sessions = new Map();
    const selected = [];
    try {
      for (let localIndex = 0; localIndex < wave.length; localIndex += 1) {
        const job = wave[localIndex];
        let session = null;
        try {
          if (job.surface === "chatgpt-main-chat") {
            const opened = await openMainChatSubmittedConversation(
              discovery,
              job.conversationId,
              job.marker,
            );
            session = opened.session;
            sessions.set(job.id, session);
            selected.push({
              ...job,
              sourceConversationId: job.conversationId,
              conversationId: job.conversationId,
              url: opened.prepared.url,
              surface: "chatgpt-main-chat",
              submittedAt: null,
              status: "submitted",
            });
            continue;
          }
          const directRecovery = !job.title;
          let recoveryWindowId = directRecovery ? job.conversationId : `local-chatgpt:${randomUUID()}`;
          let opened = null;
          let recoveredTitle = job.title || null;
          if (directRecovery) {
            try {
              opened = await openNativeQuickChat(discovery, recoveryWindowId, offset + localIndex, {
                requireBlank: false,
                routeMode: "direct-recovery",
              });
              session = opened.session;
              await waitFor(async () => evaluateAtStage(
                session,
                buildMarkerPresenceExpression(job.marker),
                "direct-recovery-marker-scan",
              ),
                10000, `ChatGPT direct recovery marker for ${job.id}`);
            } catch {
              if (session) await closeOwnedQuickChat(session);
              session = null;
              recoveryWindowId = `local-chatgpt:${randomUUID()}`;
              opened = await openNativeQuickChat(discovery, recoveryWindowId, offset + localIndex, {
                requireBlank: true,
                routeMode: "history-fallback",
              });
              session = opened.session;
              recoveredTitle = await discoverHistoryConversation(session, job);
            }
          } else {
            opened = await openNativeQuickChat(discovery, recoveryWindowId, offset + localIndex, {
              requireBlank: true,
            });
            session = opened.session;
            await selectHistoryConversation(session, job);
          }
          sessions.set(job.id, session);
          selected.push({
            ...job,
            ...(recoveredTitle ? { title: recoveredTitle } : {}),
            sourceConversationId: job.conversationId,
            conversationId: recoveryWindowId,
            url: opened.prepared.url,
            submittedAt: null,
            status: "submitted",
          });
        } catch (error) {
          if (session) await closeOwnedQuickChat(session);
          sessions.delete(job.id);
          selected.push({
            ...job,
            submittedAt: null,
            completedAt: null,
            status: "not-recovered",
            result: null,
            error: error.message,
          });
          runError = `${runError ? `${runError}; ` : ""}Recovery failed at ${job.id}: ${error.message}`;
        }
      }
      const collected = await Promise.all(selected.map(async (job) => {
        const session = sessions.get(job.id);
        if (!session || job.status !== "submitted") return job;
        try {
          return await collectJob(session, job, options.timeoutMs);
        } catch (error) {
          if (job.surface === "chatgpt-main-chat" && /CDP websocket closed/i.test(error.message)) {
            try {
              session.close();
              const reopened = await openMainChatSubmittedConversation(
                discovery,
                job.conversationId,
                job.marker,
              );
              sessions.set(job.id, reopened.session);
              return await collectJob(reopened.session, job, options.timeoutMs);
            } catch (recoveryError) {
              return {
                ...job,
                status: "not-recovered",
                completedAt: null,
                result: null,
                error: recoveryError.message,
              };
            }
          }
          return {
            ...job,
            status: "not-recovered",
            completedAt: null,
            result: null,
            error: error.message,
          };
        }
      }));
      jobs.push(...collected);
    } finally {
      await Promise.all([...sessions.values()].map((session) => closeOwnedQuickChat(session)));
    }
  }

  for (let index = 0; index < jobs.length; index += 1) {
    const artifacts = jobs[index].status === "complete" ?
      await materializeJobImages(jobs[index], options.output) : [];
    jobs[index] = {
      ...jobs[index],
      result: jobs[index].result ? {
        ...jobs[index].result,
        images: summarizeCollectedImages(jobs[index].result.images),
      } : null,
      artifacts,
    };
  }
  const completedCount = jobs.filter((job) => job.status === "complete").length;
  const report = {
    schemaVersion: 1,
    pass: completedCount === manifest.jobs.length,
    command: "resume",
    launchId: options.launchToken,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    codexVersion: discovery.state.codexVersion,
    packageFullName: discovery.state.codexPackageFullName,
    port: discovery.state.port,
    browserId: discovery.state.browserId,
    surface: summarizeBatchSurface(jobs),
    requestedJobs: manifest.jobs.length,
    completedJobs: completedCount,
    error: runError,
    jobs,
    generationPolicy: manifest.jobType ? {
      jobType: manifest.jobType,
      conversationMode: "fresh-per-job",
      retentionDays: manifest.retentionDays,
      lifecycleLedgerPath: manifest.lifecycleLedgerPath,
    } : null,
  };
  await writeJsonAtomically(options.output, report);
  if (manifest.jobType) {
    const lifecycleLedgerState = preloadedLifecycleLedger ? { value: preloadedLifecycleLedger } : null;
    const lifecycle = await recordGenerationLifecycle({
      schemaVersion: 2,
      jobType: manifest.jobType,
      retentionDays: manifest.retentionDays,
      lifecycleLedgerPath: manifest.lifecycleLedgerPath,
    }, report, options.output, lifecycleLedgerState);
    report.lifecycle = lifecycle;
    await writeJsonAtomically(options.output, report);
  }
  return report;
}

async function deleteHistoryConversation(session, job) {
  await selectHistoryConversation(session, { ...job, title: job.title });
  const started = await session.evaluate(buildHistoryDeleteStartExpression(job.title), true);
  if (!started?.pass) throw new Error(`history delete menu was not opened: ${started?.reason || "unknown"}`);
  await waitFor(async () => session.evaluate(buildHistoryDeleteMenuExpression(), true),
    5000, `history delete action for ${job.id}`);
  await waitFor(async () => session.evaluate(buildHistoryDeleteConfirmExpression(), true),
    5000, `history delete confirmation for ${job.id}`);
  await waitFor(async () => session.evaluate(`(() => ![...document.querySelectorAll('button[aria-label]')]
    .some((button) => button.getAttribute('aria-label') === ${JSON.stringify(job.title)}))()`),
  10000, `history removal for ${job.id}`);
}

async function runCleanup(options, discovery, ledger, manifest) {
  const selected = ledger.entries.filter((entry) =>
    manifest.jobs.some((job) => job.conversationId === entry.conversationId));
  const results = [];
  for (let index = 0; index < manifest.jobs.length; index += 1) {
    const job = manifest.jobs[index];
    const ledgerEntry = selected.find((entry) => entry.conversationId === job.conversationId);
    let session = null;
    try {
      await verifyMaterializedArtifacts(ledgerEntry);
      const cleanupWindowId = `local-chatgpt:${randomUUID()}`;
      // Cleanup is intentionally serial, so every temporary verifier window can
      // reuse the same safe position instead of drifting with the ledger index.
      const opened = await openNativeQuickChat(discovery, cleanupWindowId, 0);
      session = opened.session;
      await deleteHistoryConversation(session, job);
      results.push({ id: job.id, conversationId: job.conversationId, status: "deleted", error: null });
    } catch (error) {
      results.push({ id: job.id, conversationId: job.conversationId, status: "not-deleted", error: error.message });
    } finally {
      if (session) await closeOwnedQuickChat(session);
    }
  }
  const completedAt = new Date().toISOString();
  const updatedEntries = ledger.entries.map((entry) => {
    const result = results.find((item) => item.conversationId === entry.conversationId);
    if (!result) return entry;
    if (result.status === "deleted") return {
      ...entry,
      cleanupStatus: "deleted",
      deletedAt: completedAt,
      lastCleanupError: null,
    };
    return {
      ...entry,
      cleanupStatus: "pending",
      cleanupAttempts: Number.isInteger(entry.cleanupAttempts) ? entry.cleanupAttempts + 1 : 1,
      lastCleanupError: result.error,
    };
  });
  const updatedLedger = validateConversationLifecycleLedger({ schemaVersion: 1, entries: updatedEntries });
  await writeJsonAtomically(options.input, updatedLedger);
  const report = {
    schemaVersion: 1,
    pass: results.every((result) => result.status === "deleted"),
    command: "cleanup",
    completedAt,
    codexVersion: discovery.state.codexVersion,
    surface: "chatgpt-quick-chat",
    selectedJobs: manifest.jobs.length,
    deletedJobs: results.filter((result) => result.status === "deleted").length,
    jobs: results,
  };
  await writeJsonAtomically(options.output, report);
  return report;
}

async function discoverBridge(options) {
  const statePath = options.statePath || defaultStatePath;
  const state = validateBridgeState(await readStrictJson(statePath));
  const [identity, version, targets] = await Promise.all([
    verifyWindowsIdentity(state),
    fetchCdpJson(state.port, "/json/version"),
    fetchCdpJson(state.port, "/json/list"),
  ]);
  const actualBrowserId = browserIdFromVersion(version, state.port);
  if (actualBrowserId !== state.browserId) {
    throw new Error(`CDP browser identity changed from ${state.browserId} to ${actualBrowserId}`);
  }
  const target = selectAppTarget(targets, state.port);
  return Object.freeze({ statePath, state, identity, version, target });
}

function publicDiscovery(discovery) {
  return {
    pass: true,
    command: "discover",
    codexVersion: discovery.state.codexVersion,
    packageFullName: discovery.state.codexPackageFullName,
    port: discovery.state.port,
    browserId: discovery.state.browserId,
    browser: discovery.version.Browser || null,
    renderer: {
      id: discovery.target.id,
      title: discovery.target.title || null,
      url: discovery.target.url,
    },
    processId: discovery.identity.processId,
  };
}

async function probeBridge(discovery) {
  const session = await new CdpSession(discovery.target, discovery.state.port).open();
  try {
    const probe = await session.evaluate(buildChatProbeExpression());
    if (!probe?.appRenderer || !probe.chatEntry) {
      throw new Error("The verified renderer does not expose the integrated ChatGPT chat entry");
    }
    return {
      ...publicDiscovery(discovery),
      command: "probe",
      probe,
    };
  } finally {
    session.close();
  }
}

async function runWithBridgeController(options, discovery, operation) {
  const lease = await acquireBridgeControllerLock({
    statePath: discovery.statePath,
    command: options.command,
    outputPath: options.output,
    browserId: discovery.state.browserId,
  });
  try {
    return await operation();
  } finally {
    await releaseBridgeControllerLock(lease);
  }
}

export async function runBridgeMain(argv, { discover = discoverBridge } = {}) {
  const options = parseBridgeArgs(argv);
  const prepared = await prepareBridgeCommand(options);
  const discovery = await discover(options);
  if (options.command === "discover") {
    return publicDiscovery(discovery);
  }
  if (options.command === "probe") {
    return await probeBridge(discovery);
  }
  if (options.command === "plan") {
    return await runPlan(options, discovery, prepared.manifest);
  }
  if (options.command === "resume") {
    return await runWithBridgeController(
      options,
      discovery,
      () => runResume(options, discovery, prepared.manifest, prepared.lifecycleLedger),
    );
  }
  if (options.command === "watch") {
    return await runWatch(options, discovery, prepared.manifest);
  }
  if (options.command === "approve") {
    return await runWithBridgeController(
      options,
      discovery,
      () => runApprove(options, discovery, prepared.manifest),
    );
  }
  if (options.command === "cleanup") {
    return await runWithBridgeController(
      options,
      discovery,
      () => runCleanup(options, discovery, prepared.ledger, prepared.cleanupManifest),
    );
  }
  return await runWithBridgeController(
    options,
    discovery,
    () => runBatch(options, discovery, prepared.manifest, prepared.lifecycleLedger),
  );
}

async function main() {
  const result = await runBridgeMain(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ pass: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
