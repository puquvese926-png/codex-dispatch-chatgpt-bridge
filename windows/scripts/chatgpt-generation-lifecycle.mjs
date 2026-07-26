import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/iu;
const CONVERSATION = /^(?:local-chatgpt|local):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MARKER = /^CODEX-BRIDGE-[A-Za-z0-9-]{3,180}$/u;
const JOB_TYPES = new Set(["image-generation", "image-edit"]);
const SURFACES = new Set(["chatgpt-quick-chat", "chatgpt-main-chat"]);
const REPORT_SURFACES = new Set([...SURFACES, "mixed", "unknown"]);
const RECOVERY_NO_PROGRESS_STATUSES = new Set([
  "not-recovered",
  "unknown-after-submit",
  "timeout-after-submit",
]);

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${label} must be non-empty text`);
  return value.trim();
}

function date(value, label) {
  const normalized = text(value, label, 100);
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date`);
  return new Date(normalized).toISOString();
}

function validateArtifact(value, label) {
  const artifact = object(value, label);
  const artifactPath = text(artifact.path, `${label}.path`);
  if (!path.win32.isAbsolute(artifactPath)) fail(`${label}.path must be absolute`);
  if (!SHA256.test(artifact.sha256 || "")) fail(`${label}.sha256 must be a SHA-256 hash`);
  if (!Number.isInteger(artifact.bytes) || artifact.bytes < 1) fail(`${label}.bytes must be positive`);
  return { path: path.win32.normalize(artifactPath), sha256: artifact.sha256.toLowerCase(), bytes: artifact.bytes };
}

function plusDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

export function buildLifecycleEntries(reportValue, optionsValue) {
  const report = object(reportValue, "bridge report");
  const options = object(optionsValue, "lifecycle options");
  if (!REPORT_SURFACES.has(report.surface)) fail("bridge report surface is invalid");
  if (!Array.isArray(report.jobs) || report.jobs.length < 1) fail("bridge report jobs are missing");
  if (!JOB_TYPES.has(options.jobType)) fail("jobType must be image-generation or image-edit");
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 90) {
    fail("retentionDays must be 1-90");
  }
  const reportPath = text(options.reportPath, "reportPath");
  if (!path.win32.isAbsolute(reportPath)) fail("reportPath must be absolute");
  const seen = new Set();
  return report.jobs.flatMap((raw, index) => {
    const job = object(raw, `jobs[${index}]`);
    // A pre-submit failure never created a ChatGPT conversation, so there is
    // nothing to retain, resume, or clean up in the conversation ledger.
    if (job.status === "not-submitted") return [];
    const conversationId = text(job.conversationId, `jobs[${index}].conversationId`);
    if (!CONVERSATION.test(conversationId)) fail(`jobs[${index}].conversationId is invalid`);
    if (seen.has(conversationId)) fail("bridge report contains duplicate conversation IDs; fresh-per-job is required");
    seen.add(conversationId);
    if (!SURFACES.has(job.surface)) fail(`jobs[${index}].surface is invalid`);
    if (!MARKER.test(job.marker || "")) fail(`jobs[${index}].marker is invalid`);
    if (!SHA256.test(job.promptHash || "")) fail(`jobs[${index}].promptHash is invalid`);
    const artifacts = Array.isArray(job.artifacts)
      ? job.artifacts.filter((artifact) => artifact?.status === "downloaded" ||
        (artifact?.path && artifact?.sha256 && artifact?.bytes))
        .map((artifact, artifactIndex) => validateArtifact(artifact, `jobs[${index}].artifacts[${artifactIndex}]`))
      : [];
    const historyTitle = typeof job.historyTitle === "string" && job.historyTitle.trim() ? job.historyTitle.trim() : null;
    const completeAndMaterialized = job.status === "complete" && artifacts.length > 0 && job.completedAt;
    const completedAt = job.completedAt ? date(job.completedAt, `jobs[${index}].completedAt`) : null;
    return [{
      schemaVersion: 1,
      runId: text(report.runId, "runId"),
      jobId: text(job.id, `jobs[${index}].id`),
      jobType: options.jobType,
      surface: job.surface,
      conversationId,
      marker: job.marker,
      historyTitle,
      promptHash: job.promptHash.toLowerCase(),
      status: text(job.status, `jobs[${index}].status`),
      completedAt,
      reportPath: path.win32.normalize(reportPath),
      artifacts,
      cleanupEligibility: completeAndMaterialized && historyTitle ? "eligible-after-retention" :
        completeAndMaterialized ? "blocked-title-missing" :
        ["unknown-after-submit", "timeout-after-submit"].includes(job.status) ? "blocked-ambiguous-result" : "blocked-incomplete",
      deleteAfter: completeAndMaterialized && historyTitle ? plusDays(completedAt, options.retentionDays) : null,
      userRetention: "default",
      cleanupStatus: "pending",
    }];
  });
}

export function validateConversationLifecycleLedger(value) {
  const ledger = object(value, "conversation lifecycle ledger");
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) fail("conversation lifecycle ledger schema is invalid");
  const seen = new Set();
  const entries = ledger.entries.map((raw, index) => {
    const entry = object(raw, `entries[${index}]`);
    if (!CONVERSATION.test(entry.conversationId || "")) fail(`entries[${index}].conversationId is invalid`);
    if (seen.has(entry.conversationId)) fail("conversation lifecycle ledger contains duplicate conversation IDs");
    seen.add(entry.conversationId);
    if (!MARKER.test(entry.marker || "")) fail(`entries[${index}].marker is invalid`);
    if (!SHA256.test(entry.promptHash || "")) fail(`entries[${index}].promptHash is invalid`);
    if (!JOB_TYPES.has(entry.jobType)) fail(`entries[${index}].jobType is invalid`);
    if (entry.surface !== undefined && !SURFACES.has(entry.surface)) {
      fail(`entries[${index}].surface is invalid`);
    }
    const artifacts = Array.isArray(entry.artifacts)
      ? entry.artifacts.map((artifact, artifactIndex) => validateArtifact(artifact, `entries[${index}].artifacts[${artifactIndex}]`))
      : [];
    if (entry.cleanupEligibility === "eligible-after-retention") {
      if (artifacts.length < 1) fail(`entries[${index}] eligible cleanup requires materialized artifacts`);
      if (typeof entry.historyTitle !== "string" || !entry.historyTitle.trim()) {
        fail(`entries[${index}] eligible cleanup requires a history title`);
      }
    }
    if (!["pending", "deleted", "failed"].includes(entry.cleanupStatus || "pending")) {
      fail(`entries[${index}].cleanupStatus is invalid`);
    }
    const deletedAt = entry.deletedAt ? date(entry.deletedAt, `entries[${index}].deletedAt`) : null;
    if ((entry.cleanupStatus || "pending") === "deleted" && !deletedAt) {
      fail(`entries[${index}] deleted cleanup requires deletedAt`);
    }
    return {
      ...entry,
      artifacts,
      userRetention: entry.userRetention || "default",
      cleanupStatus: entry.cleanupStatus || "pending",
      deletedAt,
    };
  });
  return { schemaVersion: 1, entries };
}

export function mergeLifecycleEntries(ledgerValue, newEntriesValue) {
  const ledger = validateConversationLifecycleLedger(ledgerValue);
  if (!Array.isArray(newEntriesValue)) fail("new lifecycle entries must be an array");
  const merged = new Map(ledger.entries.map((entry) => [entry.conversationId, entry]));
  for (const entry of newEntriesValue) {
    const validated = validateConversationLifecycleLedger({ schemaVersion: 1, entries: [entry] }).entries[0];
    const existing = merged.get(validated.conversationId);
    if (existing && existing.promptHash !== validated.promptHash) {
      fail(`conversation ${validated.conversationId} cannot be rebound to another prompt`);
    }
    if (existing &&
        validated.runId !== existing.runId &&
        RECOVERY_NO_PROGRESS_STATUSES.has(validated.status)) {
      continue;
    }
    merged.set(validated.conversationId, existing ? {
      ...validated,
      surface: validated.surface || existing.surface,
      userRetention: existing.userRetention,
      cleanupStatus: existing.cleanupStatus,
      deletedAt: existing.deletedAt || null,
    } : validated);
  }
  return validateConversationLifecycleLedger({ schemaVersion: 1, entries: [...merged.values()] });
}

export async function verifyMaterializedArtifacts(entryValue) {
  const entry = validateConversationLifecycleLedger({ schemaVersion: 1, entries: [entryValue] }).entries[0];
  for (const artifact of entry.artifacts) {
    const bytes = await fs.readFile(artifact.path);
    if (bytes.length !== artifact.bytes) fail(`artifact byte length changed: ${artifact.path}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) fail(`artifact SHA-256 changed: ${artifact.path}`);
  }
  return true;
}

export function selectCleanupCandidates(value, nowValue = new Date()) {
  const ledger = validateConversationLifecycleLedger(value);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) fail("cleanup selection time is invalid");
  return ledger.entries.filter((entry) =>
    entry.cleanupEligibility === "eligible-after-retention" &&
    entry.cleanupStatus === "pending" &&
    entry.userRetention !== "keep" &&
    entry.deleteAfter &&
    Date.parse(entry.deleteAfter) <= now.getTime());
}
