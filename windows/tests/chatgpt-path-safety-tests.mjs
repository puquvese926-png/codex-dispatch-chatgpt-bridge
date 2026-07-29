import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  auditPathSet,
  inspectPathIdentity,
} from "../scripts/chatgpt-path-safety.mjs";
import * as bridgeRuntime from "../scripts/chatgpt-bridge.mjs";

const CONVERSATION_ID = "local-chatgpt:50b66343-af73-4c20-96e1-63b4a7565329";
const execFileAsync = promisify(execFile);

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-path-p0-"));
}

function planManifest() {
  return {
    schemaVersion: 1,
    jobs: [{ id: "job-a", prompt: "test prompt" }],
  };
}

function imageBatch(referencePath, lifecyclePath) {
  return {
    schemaVersion: 2,
    jobType: "image-generation",
    conversationMode: "fresh-per-job",
    retentionDays: 7,
    lifecycleLedgerPath: lifecyclePath,
    jobs: [{
      id: "job-a",
      prompt: "test prompt",
      references: [{ path: referencePath, sha256: "a".repeat(64) }],
    }],
  };
}

function args(command, statePath, inputPath, outputPath, extra = []) {
  return [command, "--state", statePath, "--input", inputPath, "--output", outputPath, ...extra];
}

async function assertNoDiscoverOnCollision(argv, originalInput) {
  let discoverCalls = 0;
  const before = await fs.readFile(originalInput, "utf8");
  await assert.rejects(
    bridgeRuntime.runBridgeMain(argv, {
      discover: async () => {
        discoverCalls += 1;
        throw new Error("discover must not run");
      },
    }),
    (error) => error?.code === "EPATHCOLLISION" && /<->/.test(error.message),
  );
  assert.equal(discoverCalls, 0);
  assert.equal(await fs.readFile(originalInput, "utf8"), before);
}

async function makeJunction(target, alias) {
  try {
    await fs.symlink(target, alias, "junction");
    return true;
  } catch {
    try {
      await execFileAsync("cmd.exe", ["/d", "/c", "mklink", "/J", alias, target], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
}

test("path identity normalizes case, dot segments, realpath aliases and missing children", async (t) => {
  const root = await makeRoot();
  try {
    const realDir = path.join(root, "Real");
    const aliasDir = path.join(root, "Alias");
    await fs.mkdir(realDir);
    if (!await makeJunction(realDir, aliasDir)) {
      t.skip("junction creation is unavailable in this Windows test host");
      return;
    }
    const realTarget = path.join(realDir, "target.txt");
    const aliasTarget = path.join(aliasDir, "target.txt");
    await fs.writeFile(realTarget, "target");

    const existing = await inspectPathIdentity(realTarget.toUpperCase(), { label: "existing" });
    assert.equal(existing.exists, true);
    assert.ok(existing.physical);
    assert.equal(typeof existing.canonical, "string");
    await assert.rejects(
      auditPathSet([
        { role: "real-file", path: realTarget },
        { role: "symlink-file", path: aliasTarget },
      ]),
      /real-file <-> symlink-file.*(?:canonical|physical)/i,
    );

    const missingReal = path.join(realDir, "new", "child.json");
    const missingAlias = path.join(aliasDir, ".", "new", "..", "new", "child.json");
    await assert.rejects(
      auditPathSet([
        { role: "missing-real", path: missingReal },
        { role: "missing-junction", path: missingAlias },
      ]),
      /missing-real <-> missing-junction.*canonical/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hardlinks and lexical aliases are rejected, while distinct paths pass", async () => {
  const root = await makeRoot();
  try {
    const first = path.join(root, "first.png");
    const second = path.join(root, "second.png");
    await fs.writeFile(first, Buffer.alloc(128, 7));
    await fs.link(first, second);
    await assert.rejects(
      auditPathSet([
        { role: "reference.0", path: first },
        { role: "reference.1", path: second },
      ]),
      /reference\.0 <-> reference\.1.*physical/i,
    );
    await assert.rejects(
      auditPathSet([
        { role: "dot-path", path: path.join(root, "folder", "..", "first.png") },
        { role: "case-path", path: first.toUpperCase() },
      ]),
      /dot-path <-> case-path.*(?:lexical|canonical)/i,
    );
    const distinct = await auditPathSet([
      { role: "one", path: path.join(root, "one.json") },
      { role: "two", path: path.join(root, "two.json") },
    ]);
    assert.equal(distinct.entries.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collision preflight stops discovery and every write", async () => {
  const root = await makeRoot();
  try {
    const state = path.join(root, "state.json");
    const input = path.join(root, "input.json");
    await fs.writeFile(state, "state");
    await fs.writeFile(input, JSON.stringify(planManifest()));
    const original = await fs.readFile(input, "utf8");
    await assertNoDiscoverOnCollision(args("plan", state, input, input), input);
    assert.equal(await fs.readFile(input, "utf8"), original);

    const stateAsOutput = path.join(root, "state-output.json");
    await fs.writeFile(stateAsOutput, "state");
    const stateInput = path.join(root, "state-input.json");
    await fs.writeFile(stateInput, JSON.stringify(planManifest()));
    await assertNoDiscoverOnCollision(args("plan", stateAsOutput, stateInput, stateAsOutput), stateInput);

    const progressState = path.join(root, "report.json.progress.json");
    await fs.writeFile(progressState, "state");
    const progressInput = path.join(root, "progress-input.json");
    await fs.writeFile(progressInput, JSON.stringify(planManifest()));
    await assertNoDiscoverOnCollision(
      args("batch", progressState, progressInput, path.join(root, "report.json"), ["--allow-send"]),
      progressInput,
    );
    const output = path.join(root, "report.json");
    assert.equal(await fs.stat(output).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch reference, lifecycle, checkpoint and cleanup artifact collisions fail before discovery", async () => {
  const root = await makeRoot();
  try {
    const state = path.join(root, "state.json");
    const input = path.join(root, "batch.json");
    const ref = path.join(root, "reference.png");
    await fs.writeFile(state, "state");
    await fs.writeFile(ref, Buffer.alloc(128, 1));
    await fs.writeFile(input, JSON.stringify(imageBatch(ref, ref)));
    await assertNoDiscoverOnCollision(
      args("batch", state, input, path.join(root, "report.json"), ["--allow-send"]),
      input,
    );

    const watchInput = path.join(root, "watch.json");
    const watchOutput = path.join(root, "watch-report.json");
    await fs.writeFile(watchInput, JSON.stringify({
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      surface: "chatgpt-main-chat",
      checkpointPath: watchOutput,
    }));
    await assertNoDiscoverOnCollision(args("watch", state, watchInput, watchOutput), watchInput);

    const cleanupLedger = path.join(root, "cleanup-ledger.json");
    const cleanupOutput = path.join(root, "cleanup-report.json");
    await fs.writeFile(cleanupLedger, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        schemaVersion: 1,
        runId: "run-cleanup",
        jobId: "job-a",
        jobType: "image-generation",
        surface: "chatgpt-main-chat",
        conversationId: CONVERSATION_ID,
        marker: "CODEX-BRIDGE-cleanup-job-a",
        historyTitle: "cleanup title",
        promptHash: "a".repeat(64),
        submittedAt: "2026-07-01T00:00:00.000Z",
        completedAt: "2026-07-01T00:00:00.000Z",
        status: "complete",
        reportPath: path.join(root, "old-report.json"),
        artifacts: [{ path: cleanupLedger, sha256: "b".repeat(64), bytes: 100 }],
        cleanupEligibility: "eligible-after-retention",
        deleteAfter: "2020-01-01T00:00:00.000Z",
        userRetention: "default",
        cleanupStatus: "pending",
      }],
    }));
    await assertNoDiscoverOnCollision(
      args("cleanup", state, cleanupLedger, cleanupOutput, ["--allow-delete"]),
      cleanupLedger,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preflight reads and validates the manifest before discovery and passes one prepared object", async () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const mainStart = source.indexOf("export async function runBridgeMain");
  const prepareCall = source.indexOf("prepareBridgeCommand(options)", mainStart);
  const discoverCall = source.indexOf("const discovery = await discover(options)", mainStart);
  assert.ok(mainStart >= 0 && prepareCall > mainStart && discoverCall > prepareCall);
  for (const functionName of ["runPlan", "runBatch", "runResume", "runWatch", "runApprove", "runCleanup"]) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf("\n}", start);
    assert.doesNotMatch(source.slice(start, end), /readStrictJson\(options\.input\)/u);
  }
});
