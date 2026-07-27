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
  recordDeliveredHandoff,
  selectNextApprovedHandoff,
  validateHandoffCheckpoint,
  validateHandoffApprovalManifest,
  validateHandoffWatchManifest,
} from "./chatgpt-handoff-protocol.mjs";
import {
  acquireBridgeControllerLock,
  buildDispatchPlan,
  readQuickChatHealth,
  recordQuickChatHealth,
  releaseBridgeControllerLock,
} from "./chatgpt-bridge-product-control.mjs";

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
    surface: typeof job.surface === "string" ? job.surface : null,
    status: typeof job.status === "string" ? job.status : "pending",
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

export function buildComposerFocusExpression() {
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
    composer.focus();
    return document.activeElement === composer || composer.contains(document.activeElement);
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

export function buildComposerReadinessExpression(marker) {
  if (typeof marker !== "string" || !marker || marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(marker)) {
    throw new Error("composer marker is invalid");
  }
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
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
    const composer = composerSelectors.map((selector) => document.querySelector(selector)).find(visible) || null;
    const directSend = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ].map((selector) => document.querySelector(selector)).find(visible) || null;
    const semanticSend = [...document.querySelectorAll('button')].find((button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
        .filter(Boolean).join(' ');
      return visible(button) && /(?:send|发送|提交)/i.test(label);
    }) || null;
    const send = directSend || semanticSend;
    const composerText = composer
      ? ('value' in composer ? composer.value : (composer.innerText || composer.textContent || ''))
      : '';
    return Boolean(composer && send && !send.disabled && composerText.includes(marker));
  })()`;
}

export function buildSendClickExpression() {
  return `(() => {
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const directSend = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ].map((selector) => document.querySelector(selector)).find(visible) || null;
    const semanticSend = [...document.querySelectorAll('button')].find((button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
        .filter(Boolean).join(' ');
      return visible(button) && /(?:send|发送|提交)/i.test(label);
    }) || null;
    const send = directSend || semanticSend;
    if (!send || send.disabled) return false;
    send.click();
    return true;
  })()`;
}

export function buildConversationSnapshotExpression(marker, surface = "quick-chat") {
  if (typeof marker !== "string" || !marker || marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(marker)) {
    throw new Error("snapshot marker is invalid");
  }
  if (!new Set(["quick-chat", "main-chat"]).has(surface)) throw new Error("snapshot surface is invalid");
  const markerJson = JSON.stringify(marker);
  const rootExpression = surface === "main-chat" ? `(() => {
      const visible = (node) => {
        if (!node || node.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
      };
      const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')].find(visible) ||
        [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
      if (dialog) return dialog;
      const modeActive = [...document.querySelectorAll('button, [role="button"]')].some((node) => {
        const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
          .filter(Boolean).join(' ').trim();
        return visible(node) && /(?:当前模式|current mode)\s*[:：]?\s*ChatGPT/iu.test(label);
      });
      return modeActive ? document : null;
    })()` : "document";
  return `(() => {
    const marker = ${markerJson};
    const root = ${rootExpression};
    if (!root) return { markerPresent: false, composerBusy: false, hasStopButton: false, sendPresent: false, assistantMessageCount: 0, userMessageCount: 0, assistantText: '', images: [] };
    const units = [...root.querySelectorAll('[data-content-search-unit-key]')]
      .map((node) => {
        const key = node.getAttribute('data-content-search-unit-key') || '';
        const role = key.endsWith(':assistant') ? 'assistant' : key.endsWith(':user') ? 'user' : null;
        if (!role) return null;
        return {
          key,
          role,
          text: (node.innerText || node.textContent || '').trim(),
          images: role === 'assistant' ? [...node.querySelectorAll('img')].map((image) => ({
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
      markerPresent: users.some((unit) => unit.text.includes(marker)),
      composerBusy: Boolean(root.querySelector('button[aria-label="停止"], button[aria-label="Stop"]')),
      hasStopButton: Boolean(root.querySelector('button[aria-label="停止"], button[aria-label="Stop"]')),
      sendPresent: Boolean(root.querySelector('button[aria-label="发送"], button[aria-label="Send"]')),
      assistantMessageCount: assistants.length,
      userMessageCount: users.length,
      assistantText: latest?.text || '',
      images,
    };
  })()`;
}

export function buildMainChatSubmissionLeaseExpression(conversationId, marker) {
  if (!LOCAL_CHATGPT_ID_PATTERN.test(conversationId) && !LOCAL_THREAD_ID_PATTERN.test(conversationId)) {
    throw new Error("main ChatGPT submission lease conversation identity is invalid");
  }
  if (typeof marker !== "string" || !marker || marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(marker)) {
    throw new Error("main ChatGPT submission lease marker is invalid");
  }
  return `(() => {
    const expectedConversationId = ${JSON.stringify(conversationId)};
    const conversationId = ${buildMainChatConversationIdExpression()};
    if (conversationId !== expectedConversationId) {
      return { conversationId, snapshot: null };
    }
    const snapshot = ${buildConversationSnapshotExpression(marker, "main-chat")};
    return { conversationId, snapshot };
  })()`;
}

export function buildHandoffUnitsExpression(expectedConversationId = null) {
  if (expectedConversationId !== null &&
      !LOCAL_CHATGPT_ID_PATTERN.test(expectedConversationId) &&
      !LOCAL_THREAD_ID_PATTERN.test(expectedConversationId)) {
    throw new Error("handoff unit conversation identity is invalid");
  }
  return `(() => {
    const expected = ${JSON.stringify(expectedConversationId)};
    const visible = (node) => {
      if (!node || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')].find(visible) ||
      [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
    const modeActive = [...document.querySelectorAll('button, [role="button"]')].some((node) => {
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .filter(Boolean).join(' ').trim();
      return visible(node) && /(?:当前模式|current mode)\\s*[:：]?\\s*ChatGPT/iu.test(label);
    });
    const identityNodes = [...document.querySelectorAll('[data-above-composer-conversation-id]')];
    const exactDocument = Boolean(expected) && (
      identityNodes.some((node) => {
        const raw = node.getAttribute('data-above-composer-conversation-id')?.trim() || '';
        const actual = raw.startsWith('chatgpt:') ? raw.slice('chatgpt:'.length) :
          (/^[0-9a-f-]{36}$/iu.test(raw) ? 'local:' + raw : raw);
        return actual === expected;
      }) ||
      (() => {
        try { return decodeURIComponent(location.href).includes(expected); } catch { return false; }
      })()
    );
    const root = dialog || ((modeActive || exactDocument) ? document : null);
    if (!root) return { readable: false, units: [] };
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
    return { readable: true, units };
  })()`;
}

export function buildHandoffApprovalFocusExpression(conversationId) {
  if (!LOCAL_CHATGPT_ID_PATTERN.test(conversationId) && !LOCAL_THREAD_ID_PATTERN.test(conversationId)) {
    throw new Error("handoff approval conversation identity is invalid");
  }
  return `(() => {
    const expected = ${JSON.stringify(conversationId)};
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')]
      .find(visible) || [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
    const routeMatches = (() => {
      try { return decodeURIComponent(location.href).includes(expected); } catch { return false; }
    })();
    const root = dialog || (routeMatches ? document : null);
    if (!root) return { ok: false, reason: 'exact-root-missing' };
    const raw = root.querySelector('[data-above-composer-conversation-id]')
      ?.getAttribute('data-above-composer-conversation-id')?.trim() || '';
    const activeThread = document.querySelector(
      '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-id][aria-current="page"]',
    )?.getAttribute('data-app-action-sidebar-thread-id')?.trim() || '';
    const actual = raw.startsWith('chatgpt:') ? raw.slice('chatgpt:'.length) :
      (/^[0-9a-f-]{36}$/iu.test(raw) ? 'local:' + raw : (routeMatches ? expected : activeThread));
    if (actual !== expected) return { ok: false, reason: 'conversation-identity-mismatch', actual };
    const selectors = [
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label="给 ChatGPT 发消息"]',
      '[contenteditable="true"][aria-label*="ChatGPT"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea'
    ];
    const composer = selectors.map((selector) => root.querySelector(selector)).find(visible) || null;
    if (!composer) return { ok: false, reason: 'composer-missing' };
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
    };
  })()`;
}

export function buildHandoffApprovalSubmitExpression(conversationId, taskId) {
  if (!LOCAL_CHATGPT_ID_PATTERN.test(conversationId) && !LOCAL_THREAD_ID_PATTERN.test(conversationId)) {
    throw new Error("handoff approval conversation identity is invalid");
  }
  if (!ID_PATTERN.test(taskId)) throw new Error("handoff approval taskId is invalid");
  const approval = `CODEX_APPROVE ${taskId}`;
  return `(() => {
    const expected = ${JSON.stringify(conversationId)};
    const approval = ${JSON.stringify(approval)};
    const visible = (node) => {
      if (!node || node.disabled || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    };
    const dialog = [...document.querySelectorAll('[data-pip-obstacle="quick-chat"]')]
      .find(visible) || [...document.querySelectorAll('[role="dialog"]')].find(visible) || null;
    const routeMatches = (() => {
      try { return decodeURIComponent(location.href).includes(expected); } catch { return false; }
    })();
    const root = dialog || (routeMatches ? document : null);
    if (!root) return { ok: false, reason: 'exact-root-missing' };
    const raw = root.querySelector('[data-above-composer-conversation-id]')
      ?.getAttribute('data-above-composer-conversation-id')?.trim() || '';
    const activeThread = document.querySelector(
      '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-id][aria-current="page"]',
    )?.getAttribute('data-app-action-sidebar-thread-id')?.trim() || '';
    const actual = raw.startsWith('chatgpt:') ? raw.slice('chatgpt:'.length) :
      (/^[0-9a-f-]{36}$/iu.test(raw) ? 'local:' + raw : (routeMatches ? expected : activeThread));
    if (actual !== expected) return { ok: false, reason: 'conversation-identity-mismatch', actual };
    const selectors = [
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label="给 ChatGPT 发消息"]',
      '[contenteditable="true"][aria-label*="ChatGPT"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea'
    ];
    const composer = selectors.map((selector) => root.querySelector(selector)).find(visible) || null;
    const composerText = composer
      ? ('value' in composer ? composer.value : (composer.innerText || composer.textContent || ''))
      : '';
    if (composerText.trim() !== approval) {
      return { ok: false, reason: 'approval-mismatch', composerText: composerText.slice(0, 200) };
    }
    const directSend = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ].map((selector) => root.querySelector(selector)).find(visible) || null;
    const semanticSend = [...root.querySelectorAll('button')].find((button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
        .filter(Boolean).join(' ');
      return visible(button) && /(?:send|发送|提交)/iu.test(label);
    }) || null;
    const send = directSend || semanticSend;
    if (!send || send.disabled) return { ok: false, reason: 'send-missing' };
    send.click();
    return { ok: true, reason: 'clicked' };
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

export function buildAttachmentButtonExpression() {
  return `(() => {
    if (document.querySelector('input[type="file"]')) return { inputPresent: true, clicked: false };
    const controls = [...document.querySelectorAll('button, [role="button"]')];
    const attach = controls.find((node) => /Attach|Add files|Upload|添加|附加|上传|文件/i.test(
      node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent || ''));
    if (!attach) return { inputPresent: false, clicked: false };
    attach.click();
    return { inputPresent: false, clicked: true };
  })()`;
}

export function buildAttachmentAcknowledgementExpression(expectedNames) {
  if (!Array.isArray(expectedNames) || !expectedNames.length || expectedNames.some((name) =>
    typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name))) {
    throw new Error("attachment acknowledgement names are invalid");
  }
  return `(() => {
    const expected = ${JSON.stringify(expectedNames)};
    const input = document.querySelector('input[type="file"]');
    const selected = input ? [...input.files].map((file) => file.name) : [];
    const body = document.body.innerText || '';
    const renderedLabels = [...document.querySelectorAll('[aria-label], [title], img[alt]')]
      .flatMap((node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('title') || '',
        node.getAttribute('alt') || '',
      ]);
    return expected.every((name) => selected.includes(name) || body.includes(name) ||
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
  if (typeof source !== "string" || !/^blob:app:\/\/-\/[A-Za-z0-9._-]{1,200}$/.test(source)) {
    throw new Error("Rendered blob image URL is invalid");
  }
  return `(() => {
    const source = ${JSON.stringify(source)};
    const image = [...document.images]
      .find((node) => (node.currentSrc || node.src || '') === source);
    if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 ||
        image.naturalWidth * image.naturalHeight > 40000000) {
      throw new Error('Rendered blob image is unavailable or invalid');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Rendered blob image canvas is unavailable');
    context.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 41943040) {
      throw new Error('Rendered blob image export is invalid');
    }
    return dataUrl;
  })()`;
}

export function buildBlobImageChunkExpression(source, offset, chunkSize = 1024 * 1024) {
  if (typeof source !== "string" || !/^blob:app:\/\/-\/[A-Za-z0-9._-]{1,200}$/.test(source)) {
    throw new Error("Rendered blob image URL is invalid");
  }
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 4 * 1024 * 1024) {
    throw new Error("Rendered blob image chunk offset or size is invalid");
  }
  return `(() => {
    const source = ${JSON.stringify(source)};
    const offset = ${offset};
    const chunkSize = ${chunkSize};
    const image = [...document.images]
      .find((node) => (node.currentSrc || node.src || '') === source);
    if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 ||
        image.naturalWidth * image.naturalHeight > 40000000) {
      throw new Error('Rendered blob image is unavailable or invalid');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Rendered blob image canvas is unavailable');
    context.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 41943040 || offset >= dataUrl.length) {
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

async function materializeRenderedImages(session, images) {
  const materialized = [];
  for (const image of images) {
    if (typeof image?.src === "string" && image.src.startsWith("blob:")) {
      const chunks = [];
      let offset = 0;
      let total = null;
      for (let index = 0; index < 64; index += 1) {
        const part = await session.evaluate(buildBlobImageChunkExpression(image.src, offset), false, 60000);
        if (!isPlainObject(part) || typeof part.chunk !== "string" || part.offset !== offset ||
            !Number.isInteger(part.nextOffset) || part.nextOffset <= offset ||
            !Number.isInteger(part.total) || part.total < part.nextOffset || typeof part.done !== "boolean") {
          throw new Error("Rendered blob image chunk is invalid");
        }
        chunks.push(part.chunk);
        total = part.total;
        if (part.done) break;
        offset = part.nextOffset;
      }
      const dataUrl = chunks.join("");
      if (!total || dataUrl.length !== total || !dataUrl.startsWith("data:image/png;base64,")) {
        throw new Error("Rendered blob image chunks are incomplete");
      }
      materialized.push({ ...image, src: dataUrl });
    } else {
      materialized.push(image);
    }
  }
  return materialized;
}

function normalizeImage(image) {
  if (!isPlainObject(image) || typeof image.src !== "string") return null;
  let safe = false;
  try {
    const url = new URL(image.src);
    safe = url.protocol === "https:" || url.protocol === "http:" ||
      (url.protocol === "data:" && /^data:image\/(?:png|jpeg|webp);base64,/i.test(image.src));
  } catch {
    safe = false;
  }
  if (!safe) return null;
  const width = Number.isFinite(image.width) && image.width >= 0 ? Number(image.width) : 0;
  const height = Number.isFinite(image.height) && image.height >= 0 ? Number(image.height) : 0;
  const alt = typeof image.alt === "string" ? image.alt.slice(0, 500) : "";
  return Object.freeze({ src: image.src, width, height, alt });
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
  return images.map((image) => ({
    sourceType: typeof image?.src === "string" && image.src.startsWith("data:image/") ?
      "materialized-app-blob" : "remote-image",
    width: Number(image?.width) || 0,
    height: Number(image?.height) || 0,
    alt: typeof image?.alt === "string" ? image.alt : "",
  }));
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
      return ready ? { url, conversationId, surface: "chatgpt-quick-chat" } : null;
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
        const snapshot = await session.evaluate(buildConversationSnapshotExpression(marker, "main-chat"));
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
    const snapshot = await session.evaluate(buildConversationSnapshotExpression(job.marker, surface));
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
            buildConversationSnapshotExpression(job.marker, "main-chat"),
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

async function attachJobReferences(session, job) {
  if (!job.references?.length) return;
  await verifyJobReferences(job);
  await session.evaluate(buildAttachmentButtonExpression(), true);
  await waitFor(async () => session.evaluate("Boolean(document.querySelector('input[type=\"file\"]'))"),
    5000, `attachment input for ${job.id}`);
  const documentNode = await session.send("DOM.getDocument", { depth: 1, pierce: true });
  const selected = await session.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "input[type=file]",
  });
  if (!selected?.nodeId) throw new Error(`attachment input node is unavailable for ${job.id}`);
  await session.send("DOM.setFileInputFiles", {
    nodeId: selected.nodeId,
    files: job.references.map((reference) => reference.path),
  });
  const expectedNames = job.references.map((reference) => path.basename(reference.path));
  await waitFor(async () => session.evaluate(buildAttachmentAcknowledgementExpression(expectedNames)),
    15000, `reference attachment acknowledgement for ${job.id}`);
}

async function submitJob(session, prepared, job, runId) {
  const marker = bridgeMarker(runId, job.id);
  const effectivePrompt = `${job.prompt}\n\n任务追踪标记：${marker}。不要在回答中复述该标记。`;
  await attachJobReferences(session, job);
  const composerFocused = await session.evaluate(buildComposerFocusExpression(), true);
  if (!composerFocused) throw new Error("ChatGPT composer is unavailable before submission");
  await session.send("Input.insertText", { text: effectivePrompt });
  const ready = await waitFor(async () => session.evaluate(
    buildComposerReadinessExpression(marker),
  ), 5000, `composer readiness for ${job.id}`);
  if (!ready) throw new Error(`ChatGPT composer did not accept job ${job.id}`);

  const submittedAt = new Date().toISOString();
  const clicked = await session.evaluate(buildSendClickExpression(), true);
  if (!clicked) throw new Error(`ChatGPT send control did not submit job ${job.id}`);

  const submission = {
    id: job.id,
    promptHash: createHash("sha256").update(job.prompt, "utf8").digest("hex"),
    marker,
    references: job.references || [],
    conversationId: prepared.conversationId,
    url: prepared.url,
    surface: prepared.surface || "chatgpt-quick-chat",
    submittedAt,
    status: "submitted",
  };
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

function imageExtension(contentType) {
  if (/image\/png/i.test(contentType)) return ".png";
  if (/image\/(?:jpeg|jpg)/i.test(contentType)) return ".jpg";
  if (/image\/webp/i.test(contentType)) return ".webp";
  return null;
}

async function downloadJobImages(job, outputFile) {
  const images = job.result?.images || [];
  if (!images.length) return [];
  const root = path.join(path.dirname(outputFile), `${path.basename(outputFile, path.extname(outputFile))}.assets`, job.id);
  await fs.mkdir(root, { recursive: true });
  const artifacts = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    try {
      let bytes;
      let contentType;
      if (image.src.startsWith("data:image/")) {
        const match = image.src.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i);
        if (!match) throw new Error("unsupported data image");
        contentType = match[1];
        bytes = Buffer.from(match[2], "base64");
      } else {
        const response = await fetch(image.src, { redirect: "follow" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        contentType = response.headers.get("content-type") || "";
        bytes = Buffer.from(await response.arrayBuffer());
      }
      const extension = imageExtension(contentType);
      if (!extension || bytes.length < 100 || bytes.length > 30 * 1024 * 1024) {
        throw new Error("downloaded image type or size is invalid");
      }
      const file = path.join(root, `image-${index + 1}${extension}`);
      await fs.writeFile(file, bytes, { flag: "wx" });
      artifacts.push({
        index,
        status: "downloaded",
        path: file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        contentType,
      });
    } catch (error) {
      artifacts.push({ index, status: "metadata-only", error: error.message });
    }
  }
  return artifacts;
}

async function writeJsonAtomically(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
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

async function readHandoffCheckpointOrEmpty(file, conversationId) {
  try {
    return validateHandoffCheckpoint(await readStrictJson(file), conversationId);
  } catch (error) {
    if (error?.code === "ENOENT" || /ENOENT|cannot find|not found/i.test(error?.message || "")) {
      return createEmptyHandoffCheckpoint(conversationId);
    }
    throw error;
  }
}

async function readHandoffObservation(discovery, expectedConversationId) {
  const session = await openCdpSessionAtStage(async () => {
    const targets = await fetchCdpJson(discovery.state.port, "/json/list");
    return selectCdpPageTargetById(targets, discovery.state.port, discovery.target.id);
  }, discovery.state.port, "handoff-watch-session-open");
  session.ownsWindow = false;
  try {
    const identity = await evaluateAtStage(
      session,
      buildMainChatConversationIdExpression(),
      "handoff-watch-conversation-identity",
    );
    if (identity !== expectedConversationId) {
      return { identity, units: [], active: false, readable: false };
    }
    const rendered = await evaluateAtStage(
      session,
      buildHandoffUnitsExpression(expectedConversationId),
      "handoff-watch-rendered-units",
    );
    if (!rendered || typeof rendered.readable !== "boolean" || !Array.isArray(rendered.units)) {
      throw new Error("handoff watch rendered units are invalid");
    }
    return {
      identity,
      units: rendered.units,
      active: true,
      readable: rendered.readable,
    };
  } finally {
    session.close();
  }
}

async function runWatch(options, discovery) {
  const manifest = validateHandoffWatchManifest(await readStrictJson(options.input));
  let checkpoint = await readHandoffCheckpointOrEmpty(
    manifest.checkpointPath,
    manifest.conversationId,
  );
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + options.timeoutMs;
  let polls = 0;
  let lastIdentity = null;
  let lastReadable = false;
  let observedUnits = 0;

  while (true) {
    polls += 1;
    const observation = await readHandoffObservation(discovery, manifest.conversationId);
    lastIdentity = observation.identity || null;
    lastReadable = observation.readable;
    observedUnits = observation.units.length;
    if (observation.active && observation.readable) {
      let handoff;
      try {
        handoff = selectNextApprovedHandoff(observation.units, checkpoint);
      } catch (error) {
        const report = {
          schemaVersion: 1,
          pass: false,
          command: "watch",
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
      if (handoff) {
        const deliveredAt = new Date().toISOString();
        checkpoint = recordDeliveredHandoff(checkpoint, handoff, deliveredAt);
        await writeJsonAtomically(manifest.checkpointPath, checkpoint);
        const report = {
          schemaVersion: 1,
          pass: true,
          command: "watch",
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
          handoff,
        };
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
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    status: lastIdentity !== manifest.conversationId ? "conversation-not-active" :
      lastReadable ? "no-handoff" : "conversation-not-readable",
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
        buildConversationSnapshotExpression(manifest.marker, "main-chat"),
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

async function runApprove(options, discovery) {
  const manifest = validateHandoffApprovalManifest(await readStrictJson(options.input));
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const approvalText = `CODEX_APPROVE ${manifest.taskId}`;
  let session = null;
  let submittedAt = null;
  let proposal = null;
  let status = "not-submitted";
  let errorText = null;
  try {
    const opened = await openHandoffApprovalConversation(discovery, manifest);
    session = opened.session;
    const observation = await evaluateAtStage(
      session,
      buildHandoffUnitsExpression(manifest.conversationId),
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
        buildHandoffApprovalFocusExpression(manifest.conversationId),
        "handoff-approve-composer-focus",
        true,
      );
      if (!focused?.ok) throw new Error(`handoff approval composer rejected focus: ${focused?.reason || "unknown"}`);
      await session.send("Input.insertText", { text: approvalText });
      submittedAt = new Date().toISOString();
      const clicked = await evaluateAtStage(
        session,
        buildHandoffApprovalSubmitExpression(manifest.conversationId, manifest.taskId),
        "handoff-approve-send-click",
        true,
      );
      if (!clicked?.ok) throw new Error(`handoff approval was not submitted: ${clicked?.reason || "unknown"}`);
      await waitFor(async () => {
        const currentIdentity = await evaluateAtStage(
          session,
          buildMainChatConversationIdExpression(),
          "handoff-approve-ack-identity",
        );
        if (currentIdentity !== manifest.conversationId) return null;
        const current = await evaluateAtStage(
          session,
          buildHandoffUnitsExpression(manifest.conversationId),
          "handoff-approve-ack-units",
        );
        return current?.units?.some((unit) =>
          unit.role === "user" && unit.text.trim() === approvalText) || null;
      }, Math.min(options.timeoutMs, 30000), `handoff approval acknowledgement for ${manifest.taskId}`);
      status = "approved";
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

async function recordGenerationLifecycle(batch, report, reportPath) {
  if (batch.schemaVersion !== 2) return null;
  const entries = buildLifecycleEntries(report, {
    jobType: batch.jobType,
    retentionDays: batch.retentionDays,
    reportPath,
  });
  const existing = await readLifecycleLedgerOrEmpty(batch.lifecycleLedgerPath);
  const merged = mergeLifecycleEntries(existing, entries);
  await writeJsonAtomically(batch.lifecycleLedgerPath, merged);
  return { path: batch.lifecycleLedgerPath, recordedEntries: entries.length };
}

async function recordGenerationCheckpoint(batch, runId, jobs, reportPath) {
  if (batch.schemaVersion !== 2) return null;
  const retainedJobs = jobs.filter((job) => job?.conversationId && job?.surface && job?.submittedAt);
  if (!retainedJobs.length) return null;
  return recordGenerationLifecycle(batch, {
    runId,
    surface: summarizeBatchSurface(retainedJobs),
    jobs: retainedJobs,
  }, reportPath);
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

async function runPlan(options, discovery) {
  const batch = validateBridgeBatch(await readStrictJson(options.input));
  if (batch.schemaVersion === 2) {
    await Promise.all(batch.jobs.map((job) => verifyJobReferences(job)));
  }
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

async function runBatch(options, discovery) {
  const batch = validateBridgeBatch(await readStrictJson(options.input));
  if (batch.schemaVersion === 2) {
    await Promise.all(batch.jobs.map((job) => verifyJobReferences(job)));
  }
  const dispatchPlan = await inspectDispatchPlan(options, discovery, batch);
  if (dispatchPlan.selectedMode === "unavailable") {
    throw new Error(dispatchPlan.userNotice);
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const jobs = [];
  let runError = null;
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
            await recordGenerationCheckpoint(batch, runId, [submission], options.output);
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
              await recordGenerationCheckpoint(batch, runId, [collected], options.output);
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
          await recordGenerationCheckpoint(batch, runId, [collectedJob], options.output);
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
      await downloadJobImages(jobs[index], options.output) : [];
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
  const lifecycle = await recordGenerationLifecycle(batch, report, options.output);
  if (lifecycle) {
    report.lifecycle = lifecycle;
    await writeJsonAtomically(options.output, report);
  }
  currentJobId = null;
  await persistBatchProgress("complete", reportError);
  return report;
}

async function runResume(options, discovery) {
  const manifest = validateResumeManifest(await readStrictJson(options.input));
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
      await downloadJobImages(jobs[index], options.output) : [];
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
    const lifecycle = await recordGenerationLifecycle({
      schemaVersion: 2,
      jobType: manifest.jobType,
      retentionDays: manifest.retentionDays,
      lifecycleLedgerPath: manifest.lifecycleLedgerPath,
    }, report, options.output);
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

async function runCleanup(options, discovery) {
  const ledger = validateConversationLifecycleLedger(await readStrictJson(options.input));
  const selected = selectCleanupCandidates(ledger, new Date());
  const manifest = validateCleanupManifest({
    schemaVersion: 1,
    jobs: selected.map((entry) => ({
      id: entry.jobId,
      conversationId: entry.conversationId,
      marker: entry.marker,
      title: entry.historyTitle,
      artifacts: entry.artifacts,
    })),
  });
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

async function main() {
  const options = parseBridgeArgs(process.argv.slice(2));
  const discovery = await discoverBridge(options);
  if (options.command === "discover") {
    console.log(JSON.stringify(publicDiscovery(discovery), null, 2));
    return;
  }
  if (options.command === "probe") {
    console.log(JSON.stringify(await probeBridge(discovery), null, 2));
    return;
  }
  if (options.command === "plan") {
    console.log(JSON.stringify(await runPlan(options, discovery), null, 2));
    return;
  }
  if (options.command === "resume") {
    console.log(JSON.stringify(await runWithBridgeController(
      options,
      discovery,
      () => runResume(options, discovery),
    ), null, 2));
    return;
  }
  if (options.command === "watch") {
    console.log(JSON.stringify(await runWatch(options, discovery), null, 2));
    return;
  }
  if (options.command === "approve") {
    console.log(JSON.stringify(await runWithBridgeController(
      options,
      discovery,
      () => runApprove(options, discovery),
    ), null, 2));
    return;
  }
  if (options.command === "cleanup") {
    console.log(JSON.stringify(await runWithBridgeController(
      options,
      discovery,
      () => runCleanup(options, discovery),
    ), null, 2));
    return;
  }
  console.log(JSON.stringify(await runWithBridgeController(
    options,
    discovery,
    () => runBatch(options, discovery),
  ), null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ pass: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
