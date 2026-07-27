import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireBridgeControllerLock,
  bridgeCapabilityCachePath,
  bridgeControllerLockPath,
  buildDispatchPlan,
  readQuickChatHealth,
  recordQuickChatHealth,
  releaseBridgeControllerLock,
} from "../scripts/chatgpt-bridge-product-control.mjs";

test("product dispatch defaults to an explicit serial main-surface plan", () => {
  const plan = buildDispatchPlan({
    requestedJobs: 3,
    timeoutMs: 600000,
    mainChatAvailable: true,
    experimentalQuickChat: false,
    quickChatLimit: 2,
    occupiedQuickChatWindows: 0,
    quickChatHealth: null,
  });

  assert.equal(plan.selectedMode, "serial-main-chat");
  assert.equal(plan.selectedSurface, "chatgpt-main-chat");
  assert.equal(plan.concurrency, 1);
  assert.equal(plan.quickChat.attempt, false);
  assert.equal(plan.quickChat.reason, "experimental-quick-chat-disabled");
  assert.equal(plan.worstCaseCollectionMs, 1800000);
  assert.match(plan.userNotice, /串行|serial/i);
});

test("experimental Quick Chat obeys the session health cache and keeps a serial fallback", () => {
  const unhealthy = buildDispatchPlan({
    requestedJobs: 4,
    timeoutMs: 600000,
    mainChatAvailable: true,
    experimentalQuickChat: true,
    quickChatLimit: 2,
    occupiedQuickChatWindows: 0,
    quickChatHealth: {
      status: "unhealthy",
      reason: "owned target timed out",
    },
  });
  assert.equal(unhealthy.selectedMode, "serial-main-chat");
  assert.equal(unhealthy.quickChat.attempt, false);
  assert.match(unhealthy.quickChat.reason, /cached-unhealthy/i);

  const eligible = buildDispatchPlan({
    requestedJobs: 4,
    timeoutMs: 600000,
    mainChatAvailable: true,
    experimentalQuickChat: true,
    quickChatLimit: 2,
    occupiedQuickChatWindows: 0,
    quickChatHealth: null,
  });
  assert.equal(eligible.selectedMode, "adaptive-quick-chat");
  assert.equal(eligible.concurrency, 2);
  assert.equal(eligible.quickChat.attempt, true);
  assert.equal(eligible.fallbackMode, "serial-main-chat");
  assert.equal(eligible.worstCaseCollectionMs, 2400000);
});

test("Quick Chat health is scoped to one Codex version and browser session", async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-health-"));
  try {
    const statePath = path.join(temporaryRoot, "state.json");
    const identity = {
      browserId: "browser-a",
      codexVersion: "26.715.10079.0",
    };
    const observedAt = new Date("2026-07-27T00:00:00.000Z");
    await recordQuickChatHealth(statePath, identity, {
      status: "unhealthy",
      reason: "target unavailable",
      now: observedAt,
      ttlMs: 900000,
    });

    const cached = await readQuickChatHealth(
      statePath,
      identity,
      new Date("2026-07-27T00:05:00.000Z"),
    );
    assert.equal(cached.status, "unhealthy");
    assert.equal(cached.reason, "target unavailable");
    assert.equal(
      bridgeCapabilityCachePath(statePath),
      path.join(temporaryRoot, "capabilities.json"),
    );

    assert.equal(await readQuickChatHealth(statePath, {
      ...identity,
      browserId: "browser-b",
    }, new Date("2026-07-27T00:05:00.000Z")), null);
    assert.equal(await readQuickChatHealth(statePath, {
      ...identity,
      codexVersion: "26.999.0.0",
    }, new Date("2026-07-27T00:05:00.000Z")), null);
    assert.equal(await readQuickChatHealth(
      statePath,
      identity,
      new Date("2026-07-27T00:16:00.000Z"),
    ), null);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("one global controller lock blocks different report paths and recovers a dead owner", async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-lock-"));
  try {
    const statePath = path.join(temporaryRoot, "state.json");
    const first = await acquireBridgeControllerLock({
      statePath,
      command: "batch",
      outputPath: path.join(temporaryRoot, "report-a.json"),
      browserId: "browser-a",
    });
    await assert.rejects(
      acquireBridgeControllerLock({
        statePath,
        command: "batch",
        outputPath: path.join(temporaryRoot, "report-b.json"),
        browserId: "browser-a",
      }),
      /controller.*busy|already.*running/i,
    );
    await releaseBridgeControllerLock(first);

    const second = await acquireBridgeControllerLock({
      statePath,
      command: "batch",
      outputPath: path.join(temporaryRoot, "report-b.json"),
      browserId: "browser-a",
    });
    await releaseBridgeControllerLock(second);

    const lockPath = bridgeControllerLockPath(statePath);
    writeFileSync(lockPath, JSON.stringify({
      schemaVersion: 1,
      ownerId: "dead-owner",
      pid: 2147483647,
      command: "batch",
      outputPath: path.join(temporaryRoot, "dead-report.json"),
      browserId: "browser-a",
      acquiredAt: "2026-07-27T00:00:00.000Z",
    }));
    const recovered = await acquireBridgeControllerLock({
      statePath,
      command: "batch",
      outputPath: path.join(temporaryRoot, "report-c.json"),
      browserId: "browser-a",
    });
    const current = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(current.ownerId, recovered.ownerId);
    await releaseBridgeControllerLock(recovered);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
