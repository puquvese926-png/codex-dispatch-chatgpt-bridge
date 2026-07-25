import assert from "node:assert/strict";

const moduleUrl = new URL("../scripts/chatgpt-generation-lifecycle.mjs", import.meta.url);
const {
  buildLifecycleEntries,
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
      conversationId: "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de",
      historyTitle: "桥接生图 candidate-a",
      marker: "CODEX-BRIDGE-c39c8a08-candidate-a",
      promptHash: "a".repeat(64),
      completedAt: "2026-07-01T00:00:00.000Z",
      artifacts: [{ path: "C:\\outputs\\candidate-a.png", sha256: "b".repeat(64), bytes: 100 }],
    },
    {
      id: "candidate-b",
      status: "timeout-after-submit",
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
assert.equal(entries[0].cleanupEligibility, "eligible-after-retention");
assert.equal(entries[1].cleanupEligibility, "blocked-ambiguous-result");

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

console.log(JSON.stringify({ pass: true, test: "chatgpt-generation-lifecycle" }));
