import assert from "node:assert/strict";

const moduleUrl = new URL("../scripts/chatgpt-generation-lifecycle.mjs", import.meta.url);
const {
  buildLifecycleEntries,
  mergeLifecycleEntries,
  selectCleanupCandidates,
  validateConversationLifecycleLedger,
} = await import(moduleUrl.href);

const report = {
  surface: "chatgpt-quick-chat",
  runId: "run-001",
  jobs: [
    {
      id: "candidate-a",
      status: "complete",
      surface: "chatgpt-main-chat",
      conversationId: "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de",
      historyTitle: "桥接生图 candidate-a",
      marker: "CODEX-BRIDGE-c39c8a08-candidate-a",
      promptHash: "a".repeat(64),
      references: [],
      submittedAt: "2026-07-01T00:00:05.000Z",
      completedAt: "2026-07-01T00:00:00.000Z",
      artifacts: [{ path: "C:\\outputs\\candidate-a.png", sha256: "b".repeat(64), bytes: 100 }],
    },
    {
      id: "candidate-b",
      status: "timeout-after-submit",
      surface: "chatgpt-main-chat",
      conversationId: "local-chatgpt:260a7a9e-a491-455c-bc68-d007dd7230de",
      marker: "CODEX-BRIDGE-c39c8a08-candidate-b",
      promptHash: "c".repeat(64),
      completedAt: null,
      artifacts: [],
    },
    {
      id: "candidate-c",
      status: "not-submitted",
      promptHash: "d".repeat(64),
      submittedAt: null,
      completedAt: null,
      artifacts: [],
      error: "quick-chat renderer was never created",
    },
  ],
};

const entries = buildLifecycleEntries(report, {
  jobType: "image-generation",
  retentionDays: 7,
  reportPath: "C:\\reports\\run-001.json",
});
assert.equal(entries.length, 2);
assert.notEqual(entries[0].conversationId, entries[1].conversationId);
assert.equal(entries[0].surface, "chatgpt-main-chat");
assert.equal(entries[0].submittedAt, "2026-07-01T00:00:05.000Z");
assert.equal(entries[0].cleanupEligibility, "eligible-after-retention");
assert.equal(entries[1].cleanupEligibility, "blocked-ambiguous-result");

const recoveryWithoutSubmittedAt = structuredClone(entries[0]);
recoveryWithoutSubmittedAt.runId = "run-002";
recoveryWithoutSubmittedAt.status = "complete";
recoveryWithoutSubmittedAt.submittedAt = null;
const preservedSubmittedAt = mergeLifecycleEntries(
  { schemaVersion: 1, entries: [entries[0]] },
  [recoveryWithoutSubmittedAt],
);
assert.equal(preservedSubmittedAt.entries[0].submittedAt, "2026-07-01T00:00:05.000Z");

const mixedSurfaceReport = structuredClone(report);
mixedSurfaceReport.surface = "mixed";
assert.equal(buildLifecycleEntries(mixedSurfaceReport, {
  jobType: "image-generation",
  retentionDays: 7,
  reportPath: "C:\\reports\\mixed-run-001.json",
}).length, 2);

const ledger = validateConversationLifecycleLedger({ schemaVersion: 1, entries });
const selected = selectCleanupCandidates(ledger, new Date("2026-07-22T00:00:00.000Z"));
assert.deepEqual(selected.map(({ jobId }) => jobId), ["candidate-a"]);

const retained = structuredClone(ledger);
retained.entries[0].userRetention = "keep";
assert.equal(selectCleanupCandidates(retained, new Date("2026-07-22T00:00:00.000Z")).length, 0);

const duplicateConversation = structuredClone(ledger);
duplicateConversation.entries[1].conversationId = duplicateConversation.entries[0].conversationId;
assert.throws(() => validateConversationLifecycleLedger(duplicateConversation), /conversation|duplicate/i);

const noHash = structuredClone(ledger);
delete noHash.entries[0].artifacts[0].sha256;
assert.throws(() => validateConversationLifecycleLedger(noHash), /artifact|sha/i);

const noTitleReport = structuredClone(report);
delete noTitleReport.jobs[0].historyTitle;
const noTitleEntries = buildLifecycleEntries(noTitleReport, {
  jobType: "image-generation",
  retentionDays: 7,
  reportPath: "C:\\reports\\run-001.json",
});
assert.equal(noTitleEntries[0].cleanupEligibility, "blocked-title-missing");

const merged = validateConversationLifecycleLedger({ schemaVersion: 1, entries: [entries[0]] });
const revalidated = validateConversationLifecycleLedger({
  schemaVersion: 1,
  entries: [{ ...merged.entries[0], cleanupStatus: "deleted", deletedAt: "2026-07-22T00:00:00.000Z" }],
});
assert.equal(revalidated.entries[0].cleanupStatus, "deleted");

const failedResumeEntry = {
  ...entries[1],
  runId: "resume-run-001",
  status: "not-recovered",
  reportPath: "C:\\reports\\resume-run-001.json",
  cleanupEligibility: "blocked-incomplete",
};
const preservedAfterFailedResume = mergeLifecycleEntries(
  { schemaVersion: 1, entries: [entries[1]] },
  [failedResumeEntry],
);
assert.equal(preservedAfterFailedResume.entries[0].status, "timeout-after-submit");
assert.equal(preservedAfterFailedResume.entries[0].runId, "run-001");
assert.equal(preservedAfterFailedResume.entries[0].reportPath, "C:\\reports\\run-001.json");
assert.equal(preservedAfterFailedResume.entries[0].surface, "chatgpt-main-chat");

const recoveredCompleteEntry = {
  ...entries[1],
  runId: "resume-run-002",
  status: "complete",
  completedAt: "2026-07-02T00:00:00.000Z",
  reportPath: "C:\\reports\\resume-run-002.json",
  historyTitle: "桥接生图 candidate-b",
  artifacts: [{ path: "C:\\outputs\\candidate-b.png", sha256: "e".repeat(64), bytes: 120 }],
  cleanupEligibility: "eligible-after-retention",
  deleteAfter: "2026-07-09T00:00:00.000Z",
};
const upgradedAfterSuccessfulResume = mergeLifecycleEntries(
  { schemaVersion: 1, entries: [entries[1]] },
  [recoveredCompleteEntry],
);
assert.equal(upgradedAfterSuccessfulResume.entries[0].status, "complete");
assert.equal(upgradedAfterSuccessfulResume.entries[0].runId, "resume-run-002");
assert.equal(upgradedAfterSuccessfulResume.entries[0].reportPath, "C:\\reports\\resume-run-002.json");
assert.equal(upgradedAfterSuccessfulResume.entries[0].surface, "chatgpt-main-chat");

console.log(JSON.stringify({ pass: true, test: "chatgpt-generation-lifecycle" }));
