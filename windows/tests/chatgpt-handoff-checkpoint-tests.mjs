import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  acquireHandoffCheckpointLock,
  checkpointLockPath,
  commitHandoffDelivery,
  releaseHandoffCheckpointLock,
  writeJsonAtomically,
} from "../scripts/chatgpt-handoff-checkpoint.mjs";

const TEST_FILE = fileURLToPath(import.meta.url);
const CONVERSATION_ID = "local:019f8955-8d91-7da1-93e3-8f3a900160c4";

const UNITS = [{
  key: "turn-1:assistant",
  role: "assistant",
  text: `CODEX_HANDOFF
\`\`\`json
{"schemaVersion":1,"type":"CODEX_HANDOFF","taskId":"cross-process-task","status":"proposed","objective":"跨进程去重","acceptance":["只交付一次"],"constraints":[]}
\`\`\``,
  codeBlocks: [],
}, {
  key: "turn-2:user",
  role: "user",
  text: "CODEX_APPROVE cross-process-task",
  codeBlocks: [],
}];

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-handoff-p0-"));
}

async function runWorker(checkpointPath, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      TEST_FILE,
      "--handoff-worker",
      checkpointPath,
      String(holdMs),
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`worker output was invalid: ${error.message}; ${stdout}`));
      }
    });
  });
}

if (process.argv[2] === "--handoff-worker") {
  const checkpointPath = process.argv[3];
  const holdMs = Number(process.argv[4] || 0);
  const result = await commitHandoffDelivery({
    checkpointPath,
    conversationId: CONVERSATION_ID,
    units: UNITS,
    waitMs: 5000,
    staleMs: 1000,
    onLockAcquired: async () => {
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
    },
  });
  process.stdout.write(JSON.stringify({ status: result.status, taskId: result.handoff?.taskId || null }));
} else {
  test("two independent Node processes deliver one handoff atomically", async () => {
    const root = await makeTempRoot();
    const checkpointPath = path.join(root, "checkpoint.json");
    try {
      const results = await Promise.all([
        runWorker(checkpointPath, 250),
        runWorker(checkpointPath, 0),
      ]);
      assert.deepEqual(results.map((item) => item.status).sort(), ["handoff-ready", "no-new-delivery"]);
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      assert.equal(checkpoint.delivered.length, 1);
      assert.equal(checkpoint.delivered[0].taskId, "cross-process-task");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("active checkpoint lock is bounded and non-owner release cannot remove it", async () => {
    const root = await makeTempRoot();
    const checkpointPath = path.join(root, "checkpoint.json");
    const first = await acquireHandoffCheckpointLock(checkpointPath, { waitMs: 20, staleMs: 60000 });
    try {
      await assert.rejects(
        acquireHandoffCheckpointLock(checkpointPath, { waitMs: 30, staleMs: 60000 }),
        (error) => error.code === "ELOCKBUSY",
      );
      assert.equal(await releaseHandoffCheckpointLock(checkpointPath, "wrong-owner"), false);
      const lockStats = await fs.stat(checkpointLockPath(checkpointPath));
      assert.ok(lockStats.isDirectory());
    } catch (error) {
      await first.release();
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
    await first.release();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("young incomplete lock is busy while a clearly stale dead lock is recoverable", async () => {
    const root = await makeTempRoot();
    const checkpointPath = path.join(root, "checkpoint.json");
    const lockPath = checkpointLockPath(checkpointPath);
    try {
      await fs.mkdir(lockPath);
      await assert.rejects(
        acquireHandoffCheckpointLock(checkpointPath, { waitMs: 20, staleMs: 60000 }),
        (error) => error.code === "ELOCKBUSY",
      );
      await fs.rm(lockPath, { recursive: true, force: true });

      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
        schemaVersion: 1,
        ownerId: "dead-owner",
        pid: 2147483647,
        checkpointPath,
        acquiredAt: "2020-01-01T00:00:00.000Z",
      }), "utf8");
      const old = new Date("2020-01-01T00:00:00.000Z");
      await fs.utimes(lockPath, old, old);
      const recovered = await acquireHandoffCheckpointLock(checkpointPath, {
        waitMs: 100,
        staleMs: 10,
      });
      await recovered.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("corrupt or rebound checkpoint is never replaced", async () => {
    const root = await makeTempRoot();
    const checkpointPath = path.join(root, "checkpoint.json");
    try {
      const corrupt = "{not-json";
      await fs.writeFile(checkpointPath, corrupt, "utf8");
      await assert.rejects(commitHandoffDelivery({
        checkpointPath,
        conversationId: CONVERSATION_ID,
        units: UNITS,
        waitMs: 100,
      }), /JSON|checkpoint/i);
      assert.equal(await fs.readFile(checkpointPath, "utf8"), corrupt);

      const rebound = {
        schemaVersion: 1,
        conversationId: "local:119f8955-8d91-7da1-93e3-8f3a900160c4",
        delivered: [],
      };
      await fs.writeFile(checkpointPath, JSON.stringify(rebound), "utf8");
      await assert.rejects(commitHandoffDelivery({
        checkpointPath,
        conversationId: CONVERSATION_ID,
        units: UNITS,
        waitMs: 100,
      }), /identity|conversation/i);
      assert.deepEqual(JSON.parse(await fs.readFile(checkpointPath, "utf8")), rebound);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("atomic JSON write keeps the old file and cleans temp files on write or rename failure", async () => {
    const root = await makeTempRoot();
    const target = path.join(root, "state.json");
    const baseFs = {
      mkdir: fs.mkdir.bind(fs),
      open: fs.open.bind(fs),
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs),
    };
    try {
      await fs.writeFile(target, JSON.stringify({ version: "old" }), "utf8");
      await assert.rejects(writeJsonAtomically(target, { version: "rename-fail" }, {
        fsApi: { ...baseFs, rename: async () => { throw new Error("injected rename failure"); } },
      }), /rename failure/i);
      assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { version: "old" });
      assert.equal((await fs.readdir(root)).some((name) => name.includes(".tmp")), false);

      const writeFailFs = {
        ...baseFs,
        open: async (...args) => {
          const handle = await fs.open(...args);
          return {
            writeFile: async () => { throw new Error("injected write failure"); },
            sync: handle.sync.bind(handle),
            close: handle.close.bind(handle),
          };
        },
      };
      await assert.rejects(writeJsonAtomically(target, { version: "write-fail" }, { fsApi: writeFailFs }), /write failure/i);
      assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { version: "old" });
      assert.equal((await fs.readdir(root)).some((name) => name.includes(".tmp")), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("checkpoint commit remains the deduplication fact when report persistence fails", async () => {
    const root = await makeTempRoot();
    const checkpointPath = path.join(root, "checkpoint.json");
    const reportPath = path.join(root, "report.json");
    try {
      const first = await commitHandoffDelivery({
        checkpointPath,
        conversationId: CONVERSATION_ID,
        units: UNITS,
        waitMs: 100,
      });
      assert.equal(first.status, "handoff-ready");
      await assert.rejects(writeJsonAtomically(reportPath, { status: "handoff-ready" }, {
        fsApi: {
          mkdir: fs.mkdir.bind(fs),
          open: fs.open.bind(fs),
          unlink: fs.unlink.bind(fs),
          rename: async () => { throw new Error("injected report failure"); },
        },
      }), /report failure/i);

      const second = await commitHandoffDelivery({
        checkpointPath,
        conversationId: CONVERSATION_ID,
        units: UNITS,
        waitMs: 100,
      });
      assert.equal(second.status, "no-new-delivery");
      assert.equal(JSON.parse(await fs.readFile(checkpointPath, "utf8")).delivered.length, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
