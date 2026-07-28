import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import * as bridgeRuntime from "../scripts/chatgpt-bridge.mjs";
import {
  browserIdFromVersion,
  buildChatProbeExpression,
  buildDetachedEvaluateParams,
  buildBlobImageDataExpression,
  buildBlobImageChunkExpression,
  buildConversationSnapshotExpression,
  buildHistoryDeleteStartExpression,
  buildHistoryTitleListExpression,
  buildHistoryTitleExpression,
  buildHandoffApprovalFocusExpression,
  buildHandoffApprovalSubmitExpression,
  buildHandoffUnitsExpression,
  buildMarkerPresenceExpression,
  buildAttachmentAcknowledgementExpression,
  buildAttachmentButtonExpression,
  buildComposerFocusExpression,
  buildComposerAvailabilityExpression,
  buildComposerReadinessExpression,
  buildSendClickExpression,
  buildMainChatEntryExpression,
  buildMainChatNewConversationExpression,
  buildMainChatBlankExpression,
  buildMainChatConversationIdExpression,
  buildQuickChatPrewarmExpression,
  buildQuickChatOpenDispatchExpression,
  buildQuickChatOpenExpression,
  buildQuickChatRendererReadyExpression,
  buildQuickChatOperationStatusExpression,
  annotateBridgeStageError,
  approvalConversationRoute,
  classifyJobObservation,
  conversationIdFromAppUrl,
  isExpectedConversationAppUrl,
  normalizeCollectedResult,
  parseBridgeArgs,
  quickChatWaveSize,
  shouldRequireExpectedConversationRoute,
  selectAppTarget,
  selectCdpPageTargetById,
  selectQuickChatTarget,
  selectNewOrUniquePrewarmQuickChatTarget,
  selectOwnedQuickChatTarget,
  selectReusedQuickChatTarget,
  isRetryableCdpOpenError,
  activeCdpOpenCooldownTargets,
  buildJobRouting,
  summarizeBatchSurface,
  isNativeQuickChatFallbackError,
  DEFAULT_TIMEOUT_MS,
  batchProgressPath,
  buildBatchProgress,
  summarizeBatchError,
  summarizeCollectedImages,
  validateBridgeBatch,
  validateResumeManifest,
  validateBridgeState,
  validateCleanupManifest,
  validatedDebuggerUrl,
} from "../scripts/chatgpt-bridge.mjs";
import {
  createEmptyHandoffCheckpoint,
  recordDeliveredHandoff,
  selectNextApprovedHandoff,
  validateHandoffCheckpoint,
  validateHandoffApprovalManifest,
  validateHandoffWatchManifest,
} from "../scripts/chatgpt-handoff-protocol.mjs";

const EXACT_CHATGPT_ID = "local-chatgpt:11111111-1111-4111-8111-111111111111";
const EXACT_LOCAL_ID = "local:22222222-2222-4222-8222-222222222222";
const EXACT_MARKER = "CODEX-BRIDGE-exact-root-marker";

function createDomElement(tagName, {
  attributes = {},
  children = [],
  text = "",
  value,
  visible = true,
  disabled = false,
} = {}) {
  const element = {
    tagName: tagName.toUpperCase(),
    attributes: { ...attributes },
    children: [],
    parentElement: null,
    ownerDocument: null,
    textContent: text,
    innerText: text,
    disabled,
    visible,
    clickCount: 0,
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    getBoundingClientRect() {
      return this.visible ? { width: 200, height: 40 } : { width: 0, height: 0 };
    },
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    matches(selector) {
      const alternatives = selector.split(",").map((part) => part.trim()).filter(Boolean);
      return alternatives.some((part) => {
        const tag = /^[a-z0-9-]+/iu.exec(part)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const attributesInSelector = [...part.matchAll(/\[([^\]=*]+)(?:(\*=|=)"([^"]*)")?\]/gu)];
        return attributesInSelector.every((match) => {
          const [, name, operator, expected] = match;
          const actual = this.getAttribute(name);
          if (!operator) return actual !== null;
          if (actual === null) return false;
          return operator === "=" ? actual === expected : actual.includes(expected);
        });
      });
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    focus() {
      this.ownerDocument.activeElement = this;
    },
    click() {
      this.clickCount += 1;
    },
  };
  if (value !== undefined) element.value = value;
  for (const child of children) {
    child.parentElement = element;
    element.children.push(child);
  }
  return element;
}

function createDomHarness(children, {
  href = "app://-/index.html",
} = {}) {
  const document = createDomElement("document", { children });
  document.activeElement = null;
  const assignDocument = (node) => {
    node.ownerDocument = document;
    for (const child of node.children) assignDocument(child);
  };
  assignDocument(document);
  return {
    document,
    evaluate(expression) {
      return vm.runInNewContext(expression, {
        document,
        location: { href },
        getComputedStyle(node) {
          return {
            display: node.visible ? "block" : "none",
            visibility: node.visible ? "visible" : "hidden",
          };
        },
        Set,
        URL,
      });
    },
  };
}

function createComposer(text = "", attributes = {}) {
  return createDomElement("div", {
    attributes: {
      contenteditable: "true",
      role: "textbox",
      ...attributes,
    },
    text,
  });
}

function createSendButton(attributes = {}) {
  return createDomElement("button", {
    attributes: {
      "data-testid": "send-button",
      "aria-label": "Send",
      ...attributes,
    },
  });
}

function createExactDialog(conversationId, composer, send) {
  const rawIdentity = conversationId.startsWith("local-chatgpt:") ?
    `chatgpt:${conversationId}` :
    conversationId.slice("local:".length);
  const identityRoot = createDomElement("div", {
    attributes: { "data-above-composer-conversation-id": rawIdentity },
    children: [composer, send],
  });
  return createDomElement("div", {
    attributes: { role: "dialog", "data-pip-obstacle": "quick-chat" },
    children: [identityRoot],
  });
}

function quickChatAppUrl(conversationId) {
  const route = `/chatgpt/quick-chat/${conversationId}`;
  return `app://-/index.html?initialRoute=${encodeURIComponent(route)}`;
}

test("annotates bridge evaluation failures with the exact recovery stage", () => {
  const error = annotateBridgeStageError("history-title-list", new Error("CDP command timed out: Runtime.evaluate"));
  assert.equal(error.message, "history-title-list: CDP command timed out: Runtime.evaluate");
  assert.equal(error.cause?.message, "CDP command timed out: Runtime.evaluate");
});

test("requires exact conversation routes except for blank marker-guarded history fallback", () => {
  assert.equal(shouldRequireExpectedConversationRoute("generation"), true);
  assert.equal(shouldRequireExpectedConversationRoute("direct-recovery"), true);
  assert.equal(shouldRequireExpectedConversationRoute("history-fallback"), false);
  assert.throws(() => shouldRequireExpectedConversationRoute("unknown"), /route mode/i);
});

test("handoff approval prefers the exact native route for local ChatGPT identities", () => {
  assert.equal(
    approvalConversationRoute("local-chatgpt:4c172155-0408-4417-b253-145d3e80a9d1"),
    "native-direct",
  );
  assert.equal(
    approvalConversationRoute("local:019f8955-8d91-7da1-93e3-8f3a900160c4"),
    "main-active",
  );
});

test("handoff approval reuses an exact active main surface before reopening a route", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function openHandoffApprovalConversation");
  const activeMain = source.indexOf("handoff-approve-active-main", start);
  const nativeDirect = source.indexOf("openNativeQuickChat(", start);
  assert.ok(start >= 0 && activeMain > start && nativeDirect > start);
  assert.ok(activeMain < nativeDirect);
});

test("native quick-chat lifecycle RPCs can be dispatched without awaiting renderer promises", () => {
  assert.deepEqual(buildDetachedEvaluateParams("Promise.resolve(true)", true), {
    expression: "Promise.resolve(true)",
    awaitPromise: false,
    returnByValue: false,
    userGesture: true,
  });
});

test("tracks native quick-chat lifecycle dispatch before releasing the controlling renderer", () => {
  const conversationId = "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc";
  const status = buildQuickChatOperationStatusExpression("open", conversationId);
  assert.match(status, /__codexChatBridgeLifecycle/);
  assert.match(status, /open:local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc/);
  assert.throws(() => buildQuickChatOperationStatusExpression("unknown", conversationId), /operation/i);
});

test("uses detached open, owned target, and completion as the fresh quick-chat lifecycle gate", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function openNativeQuickChat");
  const nativeOpen = source.indexOf("buildQuickChatOpenDispatchExpression(", start);
  const nativeOpenAck = source.indexOf('waitForQuickChatOperationDispatch(mainSession, "open"', start);
  const ownedTarget = source.indexOf("native quick-chat owned target after open", start);
  const openCompletion = source.indexOf('waitForQuickChatOperationCompletion(mainSession, "open"', start);
  const conversationOpen = source.indexOf("quick-chat-conversation-session-open", start);
  assert.ok(start >= 0 && nativeOpen > start && nativeOpenAck > nativeOpen && ownedTarget > nativeOpenAck);
  assert.ok(openCompletion > ownedTarget);
  assert.ok(openCompletion < conversationOpen, "native open completion must precede conversation websocket open");
  assert.doesNotMatch(source.slice(start, conversationOpen), /buildQuickChatRendererReadyExpression/);
});

test("fresh native quick-chat prepares an attributable prewarm before calling open", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function openNativeQuickChat");
  const prewarm = source.indexOf("buildQuickChatPrewarmExpression(", start);
  const prewarmTarget = source.indexOf("selectNewOrUniquePrewarmQuickChatTarget", start);
  const nativeOpen = source.indexOf("buildQuickChatOpenDispatchExpression(", start);
  assert.ok(start >= 0 && prewarm > start && prewarmTarget > prewarm && nativeOpen > prewarmTarget);
  assert.ok(prewarm < prewarmTarget && prewarmTarget < nativeOpen,
    "the official open call must consume a prewarm owned by this controlling renderer");
});

test("native open can be dispatched before the official renderer-ready acknowledgement", () => {
  const conversationId = "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc";
  const expression = buildQuickChatOpenDispatchExpression("26.715.10079.0", conversationId, {
    x: 480,
    y: 60,
    width: 960,
    height: 900,
  });
  assert.match(expression, /__codexChatBridgeLifecycle/);
  assert.match(expression, /service\.open/);
  assert.match(expression, /state: 'dispatched'/);
  assert.match(expression, /await service\.open/);
});

test("records native-to-main fallback reasons without confusing the report surface", () => {
  assert.deepEqual(buildJobRouting("chatgpt-quick-chat"), {
    requestedSurface: "chatgpt-quick-chat",
    selectedSurface: "chatgpt-quick-chat",
    fallbackReason: null,
  });
  const reason = "quick-chat-conversation-session-open: No attributable CDP target became connectable";
  assert.deepEqual(buildJobRouting("chatgpt-main-chat", reason), {
    requestedSurface: "chatgpt-quick-chat",
    selectedSurface: "chatgpt-main-chat",
    fallbackReason: reason,
  });
  assert.equal(isNativeQuickChatFallbackError(new Error(reason)), true);
  assert.equal(isNativeQuickChatFallbackError(new Error(
    "native quick-chat owned target after open timed out",
  )), true);
  assert.equal(isNativeQuickChatFallbackError(new Error(
    "native quick-chat open completion timed out",
  )), true);
  assert.equal(isNativeQuickChatFallbackError(new Error("submission acknowledgement timed out")), false);
  assert.equal(summarizeBatchSurface([{ surface: "chatgpt-quick-chat" }]), "chatgpt-quick-chat");
  assert.equal(summarizeBatchSurface([{ surface: "chatgpt-main-chat" }, { surface: "chatgpt-quick-chat" }]), "mixed");
  assert.equal(summarizeBatchSurface([]), "unknown");
  assert.throws(() => buildJobRouting("mixed"), /surface/i);
});

test("parses read-only and explicitly authorized bridge commands", () => {
  assert.deepEqual(parseBridgeArgs(["discover"]), {
    command: "discover",
    allowSend: false,
    allowDelete: false,
    input: null,
    output: null,
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 600000,
  });

  assert.deepEqual(parseBridgeArgs([
    "batch",
    "--input", "C:\\jobs\\batch.json",
    "--output", "C:\\jobs\\report.json",
    "--timeout-ms", "240000",
    "--allow-send",
  ]), {
    command: "batch",
    allowSend: true,
    allowDelete: false,
    input: "C:\\jobs\\batch.json",
    output: "C:\\jobs\\report.json",
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 240000,
  });

  assert.throws(() => parseBridgeArgs(["batch", "--input", "jobs.json"]), /input path.*absolute/i);
  assert.throws(() => parseBridgeArgs(["batch", "--input", "C:\\jobs.json", "--output", "C:\\out.json"]), /allow-send/i);
  assert.throws(() => parseBridgeArgs(["unknown"]), /command/i);
  assert.throws(() => parseBridgeArgs(["probe", "--unexpected"]), /unknown argument/i);
  assert.deepEqual(parseBridgeArgs([
    "resume",
    "--input", "C:\\jobs\\resume.json",
    "--output", "C:\\jobs\\recovered.json",
  ]), {
    command: "resume",
    allowSend: false,
    allowDelete: false,
    input: "C:\\jobs\\resume.json",
    output: "C:\\jobs\\recovered.json",
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 600000,
  });
  assert.throws(() => parseBridgeArgs([
    "resume", "--input", "C:\\in.json", "--output", "C:\\out.json", "--allow-send",
  ]), /allow-send|send/i);
  assert.deepEqual(parseBridgeArgs([
    "cleanup",
    "--input", "C:\\state\\conversations.json",
    "--output", "C:\\reports\\cleanup.json",
    "--allow-delete",
  ]), {
    command: "cleanup",
    allowSend: false,
    allowDelete: true,
    input: "C:\\state\\conversations.json",
    output: "C:\\reports\\cleanup.json",
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 600000,
  });
  assert.throws(() => parseBridgeArgs([
    "cleanup", "--input", "C:\\in.json", "--output", "C:\\out.json",
  ]), /allow-delete|delete/i);
  assert.deepEqual(parseBridgeArgs([
    "watch",
    "--input", "C:\\handoff\\watch.json",
    "--output", "C:\\handoff\\report.json",
    "--timeout-ms", "5000",
    "--poll-ms", "1000",
  ]), {
    command: "watch",
    allowSend: false,
    allowDelete: false,
    input: "C:\\handoff\\watch.json",
    output: "C:\\handoff\\report.json",
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 5000,
    pollMs: 1000,
  });
  assert.throws(() => parseBridgeArgs([
    "watch", "--input", "C:\\in.json", "--output", "C:\\out.json", "--allow-send",
  ]), /read-only|allow-send|send/i);
  assert.deepEqual(parseBridgeArgs([
    "approve",
    "--input", "C:\\handoff\\approve.json",
    "--output", "C:\\handoff\\approve-report.json",
    "--allow-send",
  ]), {
    command: "approve",
    allowSend: true,
    allowDelete: false,
    input: "C:\\handoff\\approve.json",
    output: "C:\\handoff\\approve-report.json",
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 600000,
  });
  assert.throws(() => parseBridgeArgs([
    "approve", "--input", "C:\\in.json", "--output", "C:\\out.json",
  ]), /allow-send|authorization/i);
  assert.deepEqual(parseBridgeArgs([
    "plan",
    "--input", "C:\\jobs\\batch.json",
    "--output", "C:\\jobs\\plan.json",
  ]), {
    command: "plan",
    allowSend: false,
    allowDelete: false,
    input: "C:\\jobs\\batch.json",
    output: "C:\\jobs\\plan.json",
    statePath: null,
    experimentalQuickChat: false,
    timeoutMs: 600000,
  });
  assert.equal(parseBridgeArgs([
    "plan",
    "--input", "C:\\jobs\\batch.json",
    "--output", "C:\\jobs\\plan.json",
    "--experimental-quick-chat",
  ]).experimentalQuickChat, true);
  assert.equal(parseBridgeArgs([
    "batch",
    "--input", "C:\\jobs\\batch.json",
    "--output", "C:\\jobs\\report.json",
    "--experimental-quick-chat",
    "--allow-send",
  ]).experimentalQuickChat, true);
  assert.throws(() => parseBridgeArgs([
    "resume",
    "--input", "C:\\jobs\\resume.json",
    "--output", "C:\\jobs\\report.json",
    "--experimental-quick-chat",
  ]), /experimental.*Quick Chat|quick chat/i);
});

test("validates strict unique batch jobs without rewriting prompts", () => {
  const source = {
    schemaVersion: 1,
    jobs: [
      { id: "concept-a", prompt: "生成第一张图：保留  两个空格。" },
      { id: "concept-b", prompt: "Generate image B\nsecond line" },
    ],
  };
  const batch = validateBridgeBatch(source);
  assert.deepEqual(batch, source);
  assert.ok(Object.isFrozen(batch));
  assert.ok(Object.isFrozen(batch.jobs));
  assert.ok(Object.isFrozen(batch.jobs[0]));

  const invalid = [
    null,
    [],
    { schemaVersion: 2, jobs: [] },
    { schemaVersion: 1, jobs: [] },
    { schemaVersion: 1, jobs: [{ id: "a", prompt: "x", extra: true }] },
    { schemaVersion: 1, jobs: [{ id: "A", prompt: "x" }] },
    { schemaVersion: 1, jobs: [{ id: "a", prompt: "" }] },
    { schemaVersion: 1, jobs: [{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }] },
  ];
  for (const value of invalid) {
    assert.throws(() => validateBridgeBatch(value), /batch|schema|jobs|job|id|prompt|duplicate/i);
  }
});

test("validates generation batches that require fresh chats and a lifecycle ledger", () => {
  const source = {
    schemaVersion: 2,
    jobType: "image-generation",
    conversationMode: "fresh-per-job",
    retentionDays: 7,
    lifecycleLedgerPath: "C:\\生图项目\\state\\chatgpt-generation-conversations.json",
    jobs: [
      { id: "candidate-a", prompt: "生成候选 A。", references: [{ path: "C:\\refs\\a.png", sha256: "a".repeat(64) }] },
      { id: "candidate-b", prompt: "生成候选 B。", references: [{ path: "C:\\refs\\b.jpg", sha256: "b".repeat(64) }] },
    ],
  };
  assert.deepEqual(validateBridgeBatch(source), source);
  assert.throws(() => validateBridgeBatch({ ...source, conversationMode: "reuse" }), /fresh|conversation/i);
  assert.throws(() => validateBridgeBatch({ ...source, retentionDays: 0 }), /retention/i);
  assert.throws(() => validateBridgeBatch({ ...source, lifecycleLedgerPath: "relative.json" }), /ledger|absolute/i);
  assert.throws(() => validateBridgeBatch({ ...source, jobType: "text" }), /jobType|image/i);
  assert.throws(() => validateBridgeBatch({ ...source, jobs: [{ id: "candidate-a", prompt: "x" }] }), /reference|attachment/i);
  assert.throws(() => validateBridgeBatch({
    ...source,
    jobs: [{ id: "candidate-a", prompt: "x", references: [{ path: "relative.png", sha256: "a".repeat(64) }] }],
  }), /reference|absolute/i);
});

test("allows original image generation without references while image edit still requires them", () => {
  const originalGeneration = {
    schemaVersion: 2,
    jobType: "image-generation",
    conversationMode: "fresh-per-job",
    retentionDays: 7,
    lifecycleLedgerPath: "C:\\state\\chatgpt-generation-conversations.json",
    jobs: [{
      id: "original-a",
      prompt: "Generate one original portrait without using a reference image.",
      references: [],
    }],
  };
  const validatedGeneration = validateBridgeBatch(originalGeneration);
  assert.deepEqual(validatedGeneration, originalGeneration);
  assert.ok(Object.isFrozen(validatedGeneration.jobs[0].references));

  const imageEdit = {
    ...originalGeneration,
    jobType: "image-edit",
    jobs: [{
      id: "edit-a",
      prompt: "Edit the supplied reference image.",
      references: [{ path: "C:\\refs\\edit-a.webp", sha256: "e".repeat(64) }],
    }],
  };
  assert.deepEqual(validateBridgeBatch(imageEdit), imageEdit);
  assert.throws(() => validateBridgeBatch({
    ...imageEdit,
    jobs: [{ ...imageEdit.jobs[0], references: [] }],
  }), /image-edit.*1-8.*reference|reference.*1-8/i);
  assert.throws(() => validateBridgeBatch({
    ...imageEdit,
    jobs: [{ id: "edit-a", prompt: "Edit the supplied reference image." }],
  }), /image-edit.*1-8.*reference|reference.*1-8/i);
  assert.throws(() => validateBridgeBatch({
    ...originalGeneration,
    jobs: [{
      ...originalGeneration.jobs[0],
      references: Array.from({ length: 9 }, (_, index) => ({
        path: `C:\\refs\\generation-${index}.png`,
        sha256: "f".repeat(64),
      })),
    }],
  }), /image-generation.*0-8.*reference|reference.*0-8/i);
});

test("zero-reference generation skips attachment upload and preserves an empty reference list", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const attachmentStart = source.indexOf("async function attachJobReferences");
  const submissionStart = source.indexOf("async function submitJob", attachmentStart);
  const collectionStart = source.indexOf("async function collectJob", submissionStart);
  assert.ok(attachmentStart >= 0 && submissionStart > attachmentStart && collectionStart > submissionStart);

  const attachmentSource = source.slice(attachmentStart, submissionStart);
  const noReferences = attachmentSource.indexOf("if (!job.references?.length) return;");
  const referenceVerification = attachmentSource.indexOf("await verifyJobReferences(job);");
  assert.ok(noReferences >= 0 && referenceVerification > noReferences);

  const submissionSource = source.slice(submissionStart, collectionStart);
  assert.match(submissionSource, /references:\s*job\.references\s*\|\|\s*\[\]/);
});

test("attachment discovery uses visible upload controls without private APIs", () => {
  const expression = buildAttachmentButtonExpression();
  assert.match(expression, /Attach|添加|上传|文件/i);
  assert.match(expression, /click/);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);
});

test("attachment acknowledgement recognizes rendered attachment cards", () => {
  const expression = buildAttachmentAcknowledgementExpression(["reference-a.jpg", "reference-b.png"]);
  assert.match(expression, /aria-label/);
  assert.match(expression, /title/);
  assert.match(expression, /alt/);
  assert.match(expression, /reference-a\.jpg/);
  assert.match(expression, /reference-b\.png/);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);
});

test("composer focus selects only the exact leased ChatGPT root", () => {
  const codexComposer = createComposer();
  const codexSend = createSendButton();
  const codexRoot = createDomElement("main", { children: [codexComposer, codexSend] });
  const chatComposer = createComposer();
  const chatSend = createSendButton();
  const chatRoot = createExactDialog(EXACT_CHATGPT_ID, chatComposer, chatSend);
  const harness = createDomHarness([codexRoot, chatRoot]);

  const result = harness.evaluate(buildComposerFocusExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
  ));

  assert.equal(result.ok, true);
  assert.equal(harness.document.activeElement, chatComposer);
  assert.notEqual(harness.document.activeElement, codexComposer);
});

test("send click ignores an earlier Codex send button", () => {
  const codexComposer = createComposer(EXACT_MARKER);
  const codexSend = createSendButton();
  const codexRoot = createDomElement("main", { children: [codexComposer, codexSend] });
  const chatComposer = createComposer(EXACT_MARKER);
  const chatSend = createSendButton();
  const chatRoot = createExactDialog(EXACT_CHATGPT_ID, chatComposer, chatSend);
  const harness = createDomHarness([codexRoot, chatRoot]);

  const result = harness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));

  assert.equal(result.clicked, true);
  assert.equal(codexSend.clickCount, 0);
  assert.equal(chatSend.clickCount, 1);
});

test("send click rejects zero or multiple exact roots before submission", () => {
  const missingComposer = createComposer(EXACT_MARKER);
  const missingSend = createSendButton();
  const missingHarness = createDomHarness([
    createExactDialog(
      "local-chatgpt:33333333-3333-4333-8333-333333333333",
      missingComposer,
      missingSend,
    ),
  ]);
  const missingResult = missingHarness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));
  assert.equal(missingResult.clicked, false);
  assert.equal(missingSend.clickCount, 0);

  const composerA = createComposer(EXACT_MARKER);
  const sendA = createSendButton();
  const composerB = createComposer(EXACT_MARKER);
  const sendB = createSendButton();
  const multipleHarness = createDomHarness([
    createExactDialog(EXACT_CHATGPT_ID, composerA, sendA),
    createExactDialog(EXACT_CHATGPT_ID, composerB, sendB),
  ]);
  const multipleResult = multipleHarness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));
  assert.equal(multipleResult.clicked, false);
  assert.equal(sendA.clickCount + sendB.clickCount, 0);
});

test("send click revalidates exact conversation identity and marker atomically", () => {
  const wrongMarkerComposer = createComposer("different marker");
  const wrongMarkerSend = createSendButton();
  const markerHarness = createDomHarness([
    createExactDialog(EXACT_CHATGPT_ID, wrongMarkerComposer, wrongMarkerSend),
  ]);
  const markerResult = markerHarness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));
  assert.equal(markerResult.clicked, false);
  assert.equal(wrongMarkerSend.clickCount, 0);

  const wrongIdentityComposer = createComposer(EXACT_MARKER);
  const wrongIdentitySend = createSendButton();
  const identityHarness = createDomHarness([
    createExactDialog(
      "local-chatgpt:44444444-4444-4444-8444-444444444444",
      wrongIdentityComposer,
      wrongIdentitySend,
    ),
  ]);
  const identityResult = identityHarness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));
  assert.equal(identityResult.clicked, false);
  assert.equal(wrongIdentitySend.clickCount, 0);
});

test("quick-chat send refuses a stale renderer route after preparation", () => {
  const composer = createComposer(EXACT_MARKER);
  const send = createSendButton();
  const staleId = "local-chatgpt:55555555-5555-4555-8555-555555555555";
  const harness = createDomHarness([composer, send], {
    href: quickChatAppUrl(staleId),
  });

  const result = harness.evaluate(buildSendClickExpression(
    "chatgpt-quick-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));

  assert.equal(result.clicked, false);
  assert.equal(send.clickCount, 0);
});

test("quick-chat send succeeds only on the current expected app route", () => {
  const composer = createComposer(EXACT_MARKER);
  const send = createSendButton();
  const harness = createDomHarness([composer, send], {
    href: quickChatAppUrl(EXACT_CHATGPT_ID),
  });

  const result = harness.evaluate(buildSendClickExpression(
    "chatgpt-quick-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));

  assert.equal(result.clicked, true);
  assert.equal(send.clickCount, 1);
});

test("malformed prewarm and non-app quick-chat routes fail before click", () => {
  const invalidRoutes = [
    "app://-/index.html",
    "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
    "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Fbad%2Fextra",
    `https://example.com/?initialRoute=${encodeURIComponent(`/chatgpt/quick-chat/${EXACT_CHATGPT_ID}`)}`,
    `app://user:password@-/index.html?initialRoute=${encodeURIComponent(`/chatgpt/quick-chat/${EXACT_CHATGPT_ID}`)}`,
  ];

  for (const href of invalidRoutes) {
    const composer = createComposer(EXACT_MARKER);
    const send = createSendButton();
    const harness = createDomHarness([composer, send], { href });
    const result = harness.evaluate(buildSendClickExpression(
      "chatgpt-quick-chat",
      EXACT_CHATGPT_ID,
      EXACT_MARKER,
    ));
    assert.equal(result.clicked, false, href);
    assert.equal(send.clickCount, 0, href);
  }
});

test("quick-chat focus and readiness fail when the current route is not expected", () => {
  const composer = createComposer(EXACT_MARKER);
  const send = createSendButton();
  const staleId = "local-chatgpt:66666666-6666-4666-8666-666666666666";
  const harness = createDomHarness([composer, send], {
    href: quickChatAppUrl(staleId),
  });

  const focus = harness.evaluate(buildComposerFocusExpression(
    "chatgpt-quick-chat",
    EXACT_CHATGPT_ID,
  ));
  const readiness = harness.evaluate(buildComposerReadinessExpression(
    "chatgpt-quick-chat",
    EXACT_CHATGPT_ID,
    EXACT_MARKER,
  ));

  assert.equal(focus.ok, false);
  assert.equal(readiness.ok, false);
  assert.equal(harness.document.activeElement, null);
});

test("main local thread identity cannot authorize a Codex composer", () => {
  const codexComposer = createComposer(EXACT_MARKER);
  const codexSend = createSendButton();
  const modeControl = createDomElement("button", {
    attributes: { "aria-label": "当前模式：ChatGPT" },
  });
  const codexRoot = createDomElement("main", {
    children: [modeControl, codexComposer, codexSend],
  });
  const activeThread = createDomElement("button", {
    attributes: {
      "data-app-action-sidebar-thread-id": EXACT_LOCAL_ID,
      "aria-current": "page",
    },
  });
  const harness = createDomHarness([activeThread, codexRoot]);

  const result = harness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_LOCAL_ID,
    EXACT_MARKER,
  ));

  assert.equal(result.clicked, false);
  assert.equal(codexSend.clickCount, 0);
});

test("main active sidebar identity authorizes only an explicit ChatGPT mode root", () => {
  const activeThread = createDomElement("button", {
    attributes: {
      "data-app-action-sidebar-thread-id": EXACT_LOCAL_ID,
      "aria-current": "page",
    },
  });
  const modeControl = createDomElement("button", {
    attributes: { "aria-label": "当前模式：ChatGPT" },
  });
  const chatComposer = createComposer(EXACT_MARKER, {
    "aria-label": "给 ChatGPT 发消息",
  });
  const chatSend = createSendButton();
  const chatRoot = createDomElement("main", {
    children: [modeControl, chatComposer, chatSend],
  });
  const harness = createDomHarness([activeThread, chatRoot]);

  const focus = harness.evaluate(buildComposerFocusExpression(
    "chatgpt-main-chat",
    EXACT_LOCAL_ID,
  ));
  const readiness = harness.evaluate(buildComposerReadinessExpression(
    "chatgpt-main-chat",
    EXACT_LOCAL_ID,
    EXACT_MARKER,
  ));
  const clicked = harness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_LOCAL_ID,
    EXACT_MARKER,
  ));

  assert.equal(focus.ok, true);
  assert.equal(readiness.ok, true);
  assert.equal(clicked.clicked, true);
  assert.equal(harness.document.activeElement, chatComposer);
  assert.equal(chatSend.clickCount, 1);
});

test("main local thread identity submits only through its bound ChatGPT root", () => {
  const chatComposer = createComposer(EXACT_MARKER);
  const chatSend = createSendButton();
  const chatRoot = createExactDialog(EXACT_LOCAL_ID, chatComposer, chatSend);
  const harness = createDomHarness([chatRoot]);

  const result = harness.evaluate(buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_LOCAL_ID,
    EXACT_MARKER,
  ));

  assert.equal(result.clicked, true);
  assert.equal(chatSend.clickCount, 1);
});

test("CDP loss during the click attempt seals unknown-after-submit", async () => {
  assert.equal(typeof bridgeRuntime.attemptExactSendClick, "function");
  const session = {
    async evaluate() {
      throw new Error("CDP websocket closed");
    },
  };
  const result = await bridgeRuntime.attemptExactSendClick(
    session,
    {
      surface: "chatgpt-main-chat",
      conversationId: EXACT_CHATGPT_ID,
    },
    EXACT_MARKER,
    () => "2026-07-28T12:00:00.000Z",
  );

  assert.equal(result.status, "unknown-after-submit");
  assert.equal(result.attemptedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(result.submittedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(result.expectedConversationId, EXACT_CHATGPT_ID);
  assert.equal(result.marker, EXACT_MARKER);
});

test("explicit clicked false remains not-submitted", async () => {
  assert.equal(typeof bridgeRuntime.attemptExactSendClick, "function");
  const session = {
    async evaluate() {
      return { clicked: false, reason: "exact-root-count" };
    },
  };
  const result = await bridgeRuntime.attemptExactSendClick(
    session,
    {
      surface: "chatgpt-main-chat",
      conversationId: EXACT_CHATGPT_ID,
    },
    EXACT_MARKER,
    () => "2026-07-28T12:01:00.000Z",
  );

  assert.equal(result.status, "not-submitted");
  assert.equal(result.submittedAt, null);
  assert.equal(result.expectedConversationId, EXACT_CHATGPT_ID);
  assert.equal(result.marker, EXACT_MARKER);
});

test("quick-chat send attempt requires an externally verified exact route", async () => {
  await assert.rejects(
    bridgeRuntime.attemptExactSendClick(
      { async evaluate() { return { clicked: true }; } },
      {
        surface: "chatgpt-quick-chat",
        conversationId: EXACT_CHATGPT_ID,
        exactRouteVerified: false,
      },
      EXACT_MARKER,
    ),
    /route was not exactly verified/i,
  );
});

test("submission expressions reject invalid identity inputs at build time", () => {
  assert.throws(
    () => buildComposerFocusExpression("chatgpt-main-chat", "not-a-conversation"),
    /conversation identity is invalid/i,
  );
  assert.throws(
    () => buildComposerReadinessExpression("chatgpt-quick-chat", EXACT_LOCAL_ID, EXACT_MARKER),
    /conversation identity is invalid/i,
  );
  assert.throws(
    () => buildSendClickExpression("unknown-surface", EXACT_CHATGPT_ID, EXACT_MARKER),
    /surface is invalid/i,
  );
});

test("composer discovery tolerates ChatGPT editor and send-control selector drift", () => {
  const focus = buildComposerFocusExpression("chatgpt-main-chat", EXACT_CHATGPT_ID);
  const blank = buildComposerAvailabilityExpression(true);
  const ready = buildComposerReadinessExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    "CODEX-BRIDGE-test-marker",
  );
  const send = buildSendClickExpression(
    "chatgpt-main-chat",
    EXACT_CHATGPT_ID,
    "CODEX-BRIDGE-test-marker",
  );

  for (const expression of [focus, blank, ready]) {
    assert.match(expression, /data-lexical-editor/);
    assert.match(expression, /role=.textbox|role=\"textbox\"/);
    assert.match(expression, /textarea/);
    assert.match(expression, /getBoundingClientRect|getClientRects/);
  }
  assert.match(ready, /data-testid=.send-button|data-testid=\"send-button\"/);
  assert.match(ready, /Send|发送/i);
  assert.match(ready, /CODEX-BRIDGE-test-marker/);
  assert.match(blank, /data-content-search-unit-key/);
  assert.doesNotMatch(ready, /querySelector\('\[contenteditable="true"\]\[aria-label="给 ChatGPT 发消息"\]'\)/);
  assert.match(send, /data-testid=.send-button|data-testid=\"send-button\"/);
  assert.match(send, /Send|发送/i);
  assert.match(send, /\.click\(\)/);
});

test("main ChatGPT fallback uses only visible new-chat and blank-surface gates", () => {
  const entry = buildMainChatEntryExpression();
  const newConversation = buildMainChatNewConversationExpression();
  const blank = buildMainChatBlankExpression();
  for (const expression of [entry, newConversation, blank]) {
    assert.match(expression, /getBoundingClientRect|getClientRects/);
  }
  assert.match(entry, /聊天/);
  assert.match(entry, /Quick chat/);
  assert.match(entry, /role="dialog"/);
  assert.match(newConversation, /新聊天/);
  assert.match(newConversation, /role="dialog"/);
  assert.match(newConversation, /header|h1|h2|h3/);
  assert.match(blank, /role="dialog"/);
  assert.match(blank, /data-content-search-unit-key/);
  assert.match(blank, /querySelectorAll/);
  assert.match(blank, /停止|Stop/);
  assert.match(entry, /当前模式|current mode/i);
  assert.match(newConversation, /document/);
  assert.match(blank, /document/);
  assert.doesNotMatch(entry + newConversation + blank, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);
});

test("main ChatGPT entry is idempotent when the owned chat dialog is already visible", () => {
  let clicks = 0;
  const visibleRect = { width: 800, height: 600 };
  const button = {
    disabled: false,
    innerText: "Quick chat",
    textContent: "Quick chat",
    getAttribute(name) {
      if (name === "aria-label") return "Quick chat";
      return null;
    },
    getBoundingClientRect() {
      return visibleRect;
    },
    getClientRects() {
      return [visibleRect];
    },
    click() {
      clicks += 1;
    },
  };
  const dialog = {
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return visibleRect;
    },
    getClientRects() {
      return [visibleRect];
    },
    querySelector(selector) {
      if (selector === "[data-above-composer-conversation-id]") return {};
      return null;
    },
  };
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === "button, [role=\"button\"]") return [button];
      if (selector === "[data-pip-obstacle=\"quick-chat\"]") return [dialog];
      if (selector === "[role=\"dialog\"]") return [dialog];
      return [];
    },
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  try {
    assert.equal(eval(buildMainChatEntryExpression()), true);
    assert.equal(clicks, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test("main new-chat gate accepts an aria-only localized control", () => {
  let clicks = 0;
  const visibleRect = { width: 80, height: 40 };
  const button = {
    disabled: false,
    innerText: "",
    textContent: "",
    getAttribute(name) {
      if (name === "aria-label") return "新聊天";
      return null;
    },
    getBoundingClientRect() {
      return visibleRect;
    },
    getClientRects() {
      return [visibleRect];
    },
    click() {
      clicks += 1;
    },
  };
  const dialog = {
    disabled: false,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return visibleRect;
    },
    getClientRects() {
      return [visibleRect];
    },
    querySelectorAll(selector) {
      if (selector === "button, [role=\"button\"]") return [button];
      return [];
    },
  };
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === "button, [role=\"button\"]") return [button];
      if (selector === "[data-pip-obstacle=\"quick-chat\"]") return [dialog];
      if (selector === "[role=\"dialog\"]") return [dialog];
      return [];
    },
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  try {
    assert.equal(eval(buildMainChatNewConversationExpression()), true);
    assert.equal(clicks, 1);
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test("retained main-surface fallback is collected before the next job can replace its dialog", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function runBatch");
  const end = source.indexOf("async function runResume", start);
  const runBatchSource = source.slice(start, end);
  assert.match(runBatchSource, /opened\.prepared\.surface\s*===\s*"chatgpt-main-chat"/);
  assert.match(runBatchSource, /await collectJob\(session,\s*submission,\s*options\.timeoutMs\)/);
  const immediateCollection = runBatchSource.indexOf("await collectJob(session, submission, options.timeoutMs)");
  const deferredCollection = runBatchSource.indexOf("const collected = await Promise.all");
  assert.ok(immediateCollection >= 0 && immediateCollection < deferredCollection);
  const collectStart = source.indexOf("async function collectJob");
  const collectionEntry = source.indexOf("main-chat-collection-entry-open", collectStart);
  const navigate = source.indexOf("await navigateToConversation", collectStart);
  assert.ok(collectionEntry >= 0 && collectionEntry < navigate);
});

test("main collection verifies the submitted lease before touching the entry toggle", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const submitStart = source.indexOf("async function submitJob");
  const collectStart = source.indexOf("async function collectJob", submitStart);
  const closeStart = source.indexOf("async function closeOwnedQuickChat", collectStart);
  const submitSource = source.slice(submitStart, collectStart);
  const collectSource = source.slice(collectStart, closeStart);

  assert.match(submitSource, /buildMainChatSubmissionLeaseExpression/);
  assert.match(collectSource, /main-chat-current-submission-lease/);
  const lease = collectSource.indexOf("buildMainChatSubmissionLeaseExpression");
  const entry = collectSource.indexOf("buildMainChatEntryExpression");
  assert.ok(lease >= 0 && entry > lease);
  assert.doesNotMatch(
    collectSource,
    /currentConversationId\s*=\s*submission\.surface\s*===\s*"chatgpt-main-chat"\s*\?\s*submission\.conversationId/,
  );
  assert.match(collectSource, /main-chat-collection-lease-lost/);
});

test("product batch defaults to a long image-generation window and writes durable progress", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(
    batchProgressPath("C:\\reports\\batch.json"),
    "C:\\reports\\batch.json.progress.json",
  );
  const progress = buildBatchProgress({
    runId: "run-progress",
    reportPath: "C:\\reports\\batch.json",
    startedAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
    state: "running",
    requestedJobs: 2,
    currentJobId: "shot-1",
    jobs: [
      {
        id: "shot-1",
        promptHash: "a".repeat(64),
        marker: "CODEX-BRIDGE-run-progress-shot-1",
        conversationId: "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de",
        expectedConversationId: "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de",
        surface: "chatgpt-main-chat",
        attemptedAt: "2026-07-27T00:00:29.000Z",
        submittedAt: "2026-07-27T00:00:30.000Z",
        status: "submitted",
      },
      {
        id: "shot-2",
        promptHash: "b".repeat(64),
        marker: "CODEX-BRIDGE-run-progress-shot-2",
        status: "pending",
      },
    ],
  });
  assert.equal(progress.state, "running");
  assert.equal(progress.currentJobId, "shot-1");
  assert.equal(progress.submittedJobs, 1);
  assert.equal(progress.completedJobs, 0);
  assert.equal(progress.jobs[0].conversationId, "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de");
  assert.equal(progress.jobs[0].expectedConversationId, "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de");
  assert.equal(progress.jobs[0].attemptedAt, "2026-07-27T00:00:29.000Z");
  assert.equal(progress.jobs[0].marker, "CODEX-BRIDGE-run-progress-shot-1");
  assert.equal(progress.jobs[1].status, "pending");
  assert.equal(
    summarizeBatchError(null, [{ id: "shot-1", status: "timeout-after-submit" }]),
    "shot-1: timeout-after-submit",
  );
});

test("batch fallback trips a per-batch native Quick chat circuit breaker and persists checkpoints", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function runBatch");
  const end = source.indexOf("async function runResume", start);
  const runBatchSource = source.slice(start, end);
  assert.match(runBatchSource, /nativeQuickChatDisabledReason/);
  assert.match(runBatchSource, /batchProgressPath\(options\.output\)/);
  assert.match(runBatchSource, /await persistBatchProgress\(/);
  assert.match(runBatchSource, /buildBatchProgress\(/);
  assert.match(runBatchSource, /recordGenerationCheckpoint\(/);
  assert.match(runBatchSource, /assertNoRunningBatchProgress\(/);
  const beforeSubmit = runBatchSource.indexOf("await persistBatchProgress");
  const submit = runBatchSource.indexOf("await submitJob", beforeSubmit);
  assert.ok(beforeSubmit >= 0 && submit > beforeSubmit);
});

test("production batch uses a precomputed route plan, persistent health, and the global controller", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /chatgpt-bridge-product-control\.mjs/);
  assert.match(source, /buildDispatchPlan/);
  assert.match(source, /readQuickChatHealth/);
  assert.match(source, /recordQuickChatHealth/);
  assert.match(source, /acquireBridgeControllerLock/);
  assert.match(source, /releaseBridgeControllerLock/);
  const runBatchStart = source.indexOf("async function runBatch");
  const runBatchEnd = source.indexOf("async function runResume", runBatchStart);
  const runBatchSource = source.slice(runBatchStart, runBatchEnd);
  assert.match(runBatchSource, /dispatchPlan/);
  assert.match(runBatchSource, /quickChat\.attempt/);
});

test("embedded Quick chat uses its visible DOM conversation identity and snapshot root", () => {
  const identity = buildMainChatConversationIdExpression();
  const snapshot = buildConversationSnapshotExpression("CODEX-BRIDGE-test-job", "main-chat");
  assert.match(identity, /data-above-composer-conversation-id/);
  assert.match(identity, /local-chatgpt/);
  assert.match(identity, /data-app-action-sidebar-thread-id/);
  assert.match(identity, /local:/);
  assert.match(snapshot, /data-pip-obstacle="quick-chat"/);
  assert.match(snapshot, /当前模式|current mode/i);
});

test("main-surface recovery falls back to marker- and identity-guarded history scanning", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function openMainChatSubmittedConversation");
  const end = source.indexOf("async function selectHistoryConversation", start);
  const recovery = source.slice(start, end);
  assert.match(recovery, /main ChatGPT submitted marker/);
  assert.match(recovery, /discoverHistoryConversation\(session/);
  assert.match(recovery, /main-chat/);
  assert.match(recovery, /15000/);
});

test("validates explicit read-only resume manifests", () => {
  const manifest = {
    schemaVersion: 1,
    jobs: [{
      id: "image-a",
      conversationId: "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de",
      marker: "CODEX-BRIDGE-c39c8a08-image-a",
      title: "二次元背景设计",
      surface: "chatgpt-quick-chat",
    }],
  };
  assert.deepEqual(validateResumeManifest(manifest), manifest);
  const mainSurfaceManifest = {
    ...manifest,
    jobs: [{
      ...manifest.jobs[0],
      conversationId: "local:019f8955-8d91-7da1-93e3-8f3a900160c4",
      surface: "chatgpt-main-chat",
    }],
  };
  assert.deepEqual(validateResumeManifest(mainSurfaceManifest), mainSurfaceManifest);
  const directManifest = {
    ...manifest,
    jobs: [{
      id: manifest.jobs[0].id,
      conversationId: manifest.jobs[0].conversationId,
      marker: manifest.jobs[0].marker,
      surface: "chatgpt-quick-chat",
    }],
  };
  assert.deepEqual(validateResumeManifest(directManifest), directManifest);
  const mainManifest = {
    ...manifest,
    jobs: [{ ...manifest.jobs[0], surface: "chatgpt-main-chat" }],
  };
  assert.deepEqual(validateResumeManifest(mainManifest), mainManifest);
  const lifecycleManifest = {
    ...mainManifest,
    jobType: "image-generation",
    retentionDays: 7,
    lifecycleLedgerPath: "C:\\Users\\HP\\Documents\\生图项目\\state\\chatgpt-generation-conversations.json",
    jobs: [{ ...mainManifest.jobs[0], promptHash: "a".repeat(64) }],
  };
  assert.deepEqual(validateResumeManifest(lifecycleManifest), lifecycleManifest);
  assert.throws(() => validateResumeManifest({
    ...manifest,
    jobs: [{ ...manifest.jobs[0], surface: undefined }],
  }), /surface|resume/i);
  assert.throws(() => validateResumeManifest({
    ...manifest,
    jobs: [{ ...manifest.jobs[0], title: "" }],
  }), /title|resume/i);
  assert.throws(() => validateResumeManifest({
    ...manifest,
    jobs: [{ ...manifest.jobs[0], conversationId: "server-id" }],
  }), /conversation|resume/i);
});

test("handoff watch accepts only a later exact user approval", () => {
  const manifest = {
    schemaVersion: 1,
    conversationId: "local:019f8955-8d91-7da1-93e3-8f3a900160c4",
    surface: "chatgpt-main-chat",
    checkpointPath: "C:\\state\\bridge-handoff-checkpoint.json",
  };
  assert.deepEqual(validateHandoffWatchManifest(manifest), manifest);

  const units = [
    {
      key: "turn-1:assistant",
      role: "assistant",
      text: `CODEX_HANDOFF
\`\`\`json
{"schemaVersion":1,"type":"CODEX_HANDOFF","taskId":"login-page-001","status":"proposed","objective":"实现登录页","acceptance":["测试通过"],"constraints":["不发布生产"]}
\`\`\``,
    },
    { key: "turn-2:user", role: "user", text: "方案再讨论一下" },
  ];
  const checkpoint = createEmptyHandoffCheckpoint(manifest.conversationId);
  assert.equal(selectNextApprovedHandoff(units, checkpoint), null);

  units.push({ key: "turn-3:user", role: "user", text: "确认执行 login-page-001" });
  const selected = selectNextApprovedHandoff(units, checkpoint);
  assert.equal(selected.taskId, "login-page-001");
  assert.equal(selected.objective, "实现登录页");
  assert.match(selected.planHash, /^[a-f0-9]{64}$/);
  assert.equal(selected.proposalUnitKey, "turn-1:assistant");
  assert.equal(selected.approvalUnitKey, "turn-3:user");
});

test("handoff accepts one rendered assistant JSON code block after Markdown fences are stripped", () => {
  const conversationId = "local-chatgpt:6a81b412-c16a-41f2-8912-0772fdc61256";
  const units = [{
    key: "turn-1:assistant",
    role: "assistant",
    text: "CODEX_HANDOFF\n\njson\n{\n  \"taskId\": \"rendered-task-001\"\n}",
    codeBlocks: [JSON.stringify({
      schemaVersion: 1,
      type: "CODEX_HANDOFF",
      taskId: "rendered-task-001",
      status: "proposed",
      objective: "验证真实渲染任务块",
      acceptance: ["只交付一次"],
      constraints: ["不删除对话"],
    }, null, 2).replaceAll(" ", "\u00a0")],
  }, {
    key: "turn-2:user",
    role: "user",
    text: "CODEX_APPROVE rendered-task-001",
    codeBlocks: [],
  }];
  const selected = selectNextApprovedHandoff(
    units,
    createEmptyHandoffCheckpoint(conversationId),
  );
  assert.equal(selected.taskId, "rendered-task-001");
  assert.equal(selected.objective, "验证真实渲染任务块");
});

test("validates exact handoff approval and scopes visible UI submission to its conversation", () => {
  const manifest = {
    schemaVersion: 1,
    conversationId: "local-chatgpt:4c172155-0408-4417-b253-145d3e80a9d1",
    surface: "chatgpt-main-chat",
    marker: "CODEX-BRIDGE-798d860e-handoff-live-conversation-20260724",
    taskId: "live-handoff-test-20260724",
  };
  assert.deepEqual(validateHandoffApprovalManifest(manifest), manifest);
  assert.throws(
    () => validateHandoffApprovalManifest({ ...manifest, taskId: "changed task" }),
    /taskId|approval/i,
  );
  const focus = buildHandoffApprovalFocusExpression(manifest.conversationId);
  const submit = buildHandoffApprovalSubmitExpression(manifest.conversationId, manifest.taskId);
  assert.match(focus, /data-above-composer-conversation-id/);
  assert.match(focus, /composer-not-empty/);
  assert.match(focus, /aria-label="给 ChatGPT 发消息"/);
  assert.match(submit, /CODEX_APPROVE live-handoff-test-20260724/);
  assert.match(submit, /data-above-composer-conversation-id/);
  assert.match(submit, /aria-label\*="ChatGPT"/);
  assert.doesNotMatch(focus + submit, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);
});

test("handoff checkpoint prevents duplicate delivery and task rebinding", () => {
  const conversationId = "local-chatgpt:6a81b412-c16a-41f2-8912-0772fdc61256";
  const units = [
    {
      key: "turn-1:assistant",
      role: "assistant",
      text: `CODEX_HANDOFF
\`\`\`json
{"schemaVersion":1,"type":"CODEX_HANDOFF","taskId":"task-001","status":"proposed","objective":"执行任务","acceptance":["完成"],"constraints":[]}
\`\`\``,
    },
    { key: "turn-2:user", role: "user", text: "CODEX_APPROVE task-001" },
  ];
  const empty = createEmptyHandoffCheckpoint(conversationId);
  const selected = selectNextApprovedHandoff(units, empty);
  const delivered = recordDeliveredHandoff(empty, selected, "2026-07-24T01:00:00.000Z");
  assert.deepEqual(validateHandoffCheckpoint(delivered, conversationId), delivered);
  assert.equal(selectNextApprovedHandoff(units, delivered), null);

  const rebound = [
    {
      ...units[0],
      key: "turn-3:assistant",
      text: units[0].text.replace("执行任务", "执行另一个任务"),
    },
    { key: "turn-4:user", role: "user", text: "CODEX_APPROVE task-001" },
  ];
  assert.throws(() => selectNextApprovedHandoff(rebound, delivered), /rebound|reused/i);
});

test("handoff DOM collection is read-only and scoped to rendered conversation units", () => {
  const expression = buildHandoffUnitsExpression();
  const nativeExpression = buildHandoffUnitsExpression(
    "local-chatgpt:4c172155-0408-4417-b253-145d3e80a9d1",
  );
  assert.match(expression, /readable/);
  assert.match(expression, /data-content-search-unit-key/);
  assert.match(expression, /data-pip-obstacle="quick-chat"/);
  assert.match(expression, /当前模式|current mode/i);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);
  assert.doesNotMatch(expression, /\.click\(|dispatchEvent/i);
  assert.match(nativeExpression, /local-chatgpt:4c172155-0408-4417-b253-145d3e80a9d1/);
});

test("handoff watch passes its expected conversation identity into DOM collection", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function readHandoffObservation");
  const end = source.indexOf("async function runWatch", start);
  const observationSource = source.slice(start, end);
  assert.match(observationSource, /buildHandoffUnitsExpression\(expectedConversationId\)/);
  assert.doesNotMatch(observationSource, /manifest\\./);
});

test("validates exact-marker cleanup manifests", () => {
  const manifest = {
    schemaVersion: 1,
    jobs: [{
      id: "candidate-a",
      conversationId: "local-chatgpt:160a7a9e-a491-455c-bc68-d007dd7230de",
      marker: "CODEX-BRIDGE-c39c8a08-candidate-a",
      title: "桥接生图 candidate-a",
      artifacts: [{ path: "C:\\outputs\\candidate-a.png", sha256: "b".repeat(64), bytes: 100 }],
    }],
  };
  assert.deepEqual(validateCleanupManifest(manifest), manifest);
  assert.throws(() => validateCleanupManifest({ ...manifest, jobs: [{ ...manifest.jobs[0], title: "" }] }), /title/i);
  assert.throws(() => validateCleanupManifest({ ...manifest, jobs: [{ ...manifest.jobs[0], artifacts: [] }] }), /artifact/i);
});

test("history title and delete expressions use visible UI and exact identity", () => {
  const titleExpression = buildHistoryTitleExpression();
  assert.match(titleExpression, /aria-current|aria-selected|data-state/);
  assert.doesNotMatch(titleExpression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);

  const titleListExpression = buildHistoryTitleListExpression();
  assert.match(titleListExpression, /更多|More|菜单|menu/i);
  assert.match(titleListExpression, /button\[aria-label\]/);
  assert.doesNotMatch(titleListExpression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);

  const markerExpression = buildMarkerPresenceExpression("CODEX-BRIDGE-c39c8a08-candidate-a");
  assert.match(markerExpression, /data-content-search-unit-key/);
  assert.match(markerExpression, /CODEX-BRIDGE-c39c8a08-candidate-a/);
  assert.doesNotMatch(markerExpression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);

  const deleteExpression = buildHistoryDeleteStartExpression("桥接生图 candidate-a");
  assert.match(deleteExpression, /桥接生图 candidate-a/);
  assert.match(deleteExpression, /更多|More|menu/i);
  assert.doesNotMatch(deleteExpression, /cookie|localStorage|sessionStorage|indexedDB|fetch\(/i);
  assert.throws(() => buildHistoryDeleteStartExpression(""), /title/i);
});

test("accepts only the standalone bridge state identity", () => {
  const state = {
    schemaVersion: 1,
    platform: "windows",
    port: 9345,
    browserId: "browser-123",
    codexVersion: "26.707.9564.0",
    codexExe: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe",
    codexPackageRoot: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test",
    codexPackageFullName: "OpenAI.Codex_26.707.9564.0_x64__test",
    codexPackageFamilyName: "OpenAI.Codex_test",
    createdAt: "2026-07-25T00:00:00.000Z",
  };
  assert.deepEqual(validateBridgeState(state), state);

  for (const value of [
    { ...state, schemaVersion: 3 },
    { ...state, platform: "macos" },
    { ...state, port: 80 },
    { ...state, browserId: "browser 123" },
    { ...state, codexExe: "C:\\Other\\ChatGPT.exe" },
    { ...state, codexPackageRoot: "C:\\Program Files\\WindowsApps\\Other" },
    { ...state, createdAt: "not-a-date" },
    { ...state, extra: true },
  ]) {
    assert.throws(() => validateBridgeState(value), /state|schema|platform|port|browser|package|executable|unknown/i);
  }
});

test("rejects CDP websocket targets outside the saved loopback endpoint", () => {
  const target = {
    id: "page-123",
    type: "page",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/page-123",
  };
  assert.equal(validatedDebuggerUrl(target, 9345), target.webSocketDebuggerUrl);

  for (const unsafe of [
    { ...target, type: "worker" },
    { ...target, url: "https://chatgpt.com/" },
    { ...target, webSocketDebuggerUrl: "ws://example.com:9345/devtools/page/page-123" },
    { ...target, webSocketDebuggerUrl: "ws://127.0.0.1:9346/devtools/page/page-123" },
    { ...target, webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/other" },
    { ...target, webSocketDebuggerUrl: "ws://user@127.0.0.1:9345/devtools/page/page-123" },
    { ...target, webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/page-123?x=1" },
  ]) {
    assert.throws(() => validatedDebuggerUrl(unsafe, 9345), /CDP|target|loopback|identity/i);
  }
});

test("pins browser and page discovery to the saved CDP identity", () => {
  assert.equal(browserIdFromVersion({
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/browser/browser-123",
  }, 9345), "browser-123");
  assert.throws(() => browserIdFromVersion({
    webSocketDebuggerUrl: "ws://127.0.0.1:9346/devtools/browser/browser-123",
  }, 9345), /browser|loopback|identity/i);

  const safe = {
    id: "page-123",
    type: "page",
    title: "Codex",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/page-123",
  };
  assert.deepEqual(selectAppTarget([safe], 9345), safe);
  const quick = {
    ...safe,
    id: "quick-123",
    url: "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Flocal-chatgpt%253Aabc-123",
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/quick-123",
  };
  assert.deepEqual(selectAppTarget([quick, safe], 9345), safe);
  assert.deepEqual(selectQuickChatTarget([safe, quick], 9345), quick);
  assert.deepEqual(selectQuickChatTarget([safe, quick], 9345, "local-chatgpt:abc-123"), quick);
  assert.equal(selectQuickChatTarget([safe], 9345), null);
  const quickOther = {
    ...quick,
    id: "quick-456",
    url: "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Flocal-chatgpt%253Adef-456",
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/quick-456",
  };
  assert.deepEqual(selectQuickChatTarget([quickOther, quick], 9345, "local-chatgpt:abc-123"), quick);
  assert.equal(selectQuickChatTarget([quickOther], 9345, "local-chatgpt:abc-123"), null);
  const reusedPrewarm = {
    ...quick,
    url: "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
  };
  assert.deepEqual(selectCdpPageTargetById([safe, reusedPrewarm], 9345, "quick-123"), reusedPrewarm);
  assert.equal(selectCdpPageTargetById([safe], 9345, "quick-123"), null);
  assert.throws(() => selectCdpPageTargetById([{
    ...reusedPrewarm,
    webSocketDebuggerUrl: "ws://127.0.0.1:9346/devtools/page/quick-123",
  }], 9345, "quick-123"), /identity|loopback|target/i);
  const rebuiltQuickChat = {
    ...reusedPrewarm,
    id: "quick-rebuilt",
    title: "ChatGPT",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/quick-rebuilt",
  };
  assert.deepEqual(selectReusedQuickChatTarget([safe, reusedPrewarm], 9345, "quick-123"), reusedPrewarm);
  assert.deepEqual(selectReusedQuickChatTarget([safe, rebuiltQuickChat], 9345, "quick-123"), rebuiltQuickChat);
  const initializingQuickChat = {
    ...rebuiltQuickChat,
    title: "",
  };
  assert.deepEqual(
    selectReusedQuickChatTarget([safe, initializingQuickChat], 9345, "quick-123", "page-123"),
    initializingQuickChat,
  );
  assert.equal(selectReusedQuickChatTarget([safe], 9345, "quick-123"), null);
  assert.deepEqual(selectAppTarget([
    { ...safe, id: "worker", type: "worker", webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/worker" },
    safe,
  ], 9345), safe);
  assert.throws(() => selectAppTarget([], 9345), /renderer|target/i);
  assert.throws(() => selectAppTarget([safe, {
    ...safe,
    id: "page-456",
    webSocketDebuggerUrl: "ws://127.0.0.1:9345/devtools/page/page-456",
  }], 9345), /multiple|renderer/i);
});

test("selects the uniquely new prewarm renderer without confusing stale quick-chat windows", () => {
  const target = (id, route) => ({
    id,
    title: "ChatGPT",
    type: "page",
    url: `app://-/index.html?initialRoute=${encodeURIComponent(route)}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9345/devtools/page/${id}`,
  });
  const stale = target("stale-1", "/chatgpt/quick-chat/local-chatgpt%3A11111111-1111-4111-8111-111111111111");
  const created = target("created-2", "/chatgpt/quick-chat-prewarm");
  assert.equal(selectNewOrUniquePrewarmQuickChatTarget([stale, created], 9345, new Set(["stale-1"]))?.id, "created-2");
  assert.equal(selectNewOrUniquePrewarmQuickChatTarget([created], 9345, new Set(["created-2"]))?.id, "created-2");
  assert.throws(() => selectNewOrUniquePrewarmQuickChatTarget(
    [target("stale-a", "/chatgpt/quick-chat-prewarm"), target("stale-b", "/chatgpt/quick-chat-prewarm")],
    9345,
    new Set(["stale-a", "stale-b"]),
  ), /multiple.*prewarm/i);
});

test("reselects only an attributable quick-chat target after a websocket-open race", () => {
  const port = 9345;
  const expectedConversationId = "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc";
  const stale = {
    id: "A".repeat(32),
    type: "page",
    title: "ChatGPT",
    url: "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Flocal-chatgpt%253Astale-id",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${"A".repeat(32)}`,
  };
  const rebuilt = {
    id: "B".repeat(32),
    type: "page",
    title: "ChatGPT",
    url: `app://-/index.html?initialRoute=${encodeURIComponent(`/chatgpt/quick-chat/${expectedConversationId}`)}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${"B".repeat(32)}`,
  };
  const knownIds = new Set([stale.id]);
  assert.equal(selectOwnedQuickChatTarget(
    [stale, rebuilt], port, expectedConversationId, stale.id, knownIds, new Set([stale.id]),
  ).id, rebuilt.id);
  assert.equal(selectOwnedQuickChatTarget(
    [stale], port, expectedConversationId, stale.id, knownIds, new Set([stale.id]),
  ), null);
  assert.throws(() => selectOwnedQuickChatTarget(
    [rebuilt, { ...rebuilt, id: "C".repeat(32), webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${"C".repeat(32)}` }],
    port, expectedConversationId, stale.id, knownIds, new Set([stale.id]),
  ), /multiple|ambiguous/i);
});

test("retries only websocket-open transport failures", () => {
  assert.equal(isRetryableCdpOpenError(new Error("CDP websocket open failed")), true);
  assert.equal(isRetryableCdpOpenError(new Error(`CDP websocket open failed for target ${"A".repeat(32)}`)), true);
  assert.equal(isRetryableCdpOpenError(new Error("CDP websocket open timed out")), true);
  assert.equal(isRetryableCdpOpenError(new Error("CDP websocket closed")), false);
  assert.equal(isRetryableCdpOpenError(new Error("Runtime.enable failed")), false);
});

test("failed renderer targets cool down temporarily instead of being excluded forever", () => {
  const targetA = "A".repeat(32);
  const targetB = "B".repeat(32);
  const cooldowns = new Map([[targetA, 2000], [targetB, 999]]);
  assert.deepEqual(activeCdpOpenCooldownTargets(cooldowns, 1000), new Set([targetA]));
  assert.deepEqual(activeCdpOpenCooldownTargets(cooldowns, 2500), new Set());
  assert.throws(() => activeCdpOpenCooldownTargets(new Map([["bad id", 2000]]), 1000), /target|cooldown/i);
});

test("builds a version-pinned native quick-chat open call", () => {
  const conversationId = "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc";
  const expression = buildQuickChatOpenExpression("26.707.9564.0", conversationId, {
    x: 560,
    y: 80,
    width: 900,
    height: 900,
  });
  assert.match(expression, /rpc-BfVaZKPC\.js/);
  assert.match(expression, /quickChatWindow/);
  assert.match(expression, /service\.open/);
  assert.match(expression, /await service\.open/);
  assert.match(expression, /3da06710-f874-437a-8ab1-71bc25e58afc/);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB/i);
  assert.throws(() => buildQuickChatOpenExpression("26.999.0.0", conversationId, {
    x: 0, y: 0, width: 900, height: 900,
  }), /unsupported|version/i);
  assert.throws(() => buildQuickChatOpenExpression("26.707.9564.0", "local-chatgpt:../bad", {
    x: 0, y: 0, width: 900, height: 900,
  }), /conversation/i);
});

test("supports the current Codex quick-chat service export", () => {
  const conversationId = "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc";
  const expression = buildQuickChatOpenExpression("26.715.10079.0", conversationId, {
    x: 560,
    y: 80,
    width: 900,
    height: 900,
  });
  assert.match(expression, /rpc-Ci0K2syu\.js/);
  assert.match(expression, /rpc\[\"appServices\"\]/);
  assert.match(expression, /service\.open/);
  assert.equal(quickChatWaveSize("26.715.10079.0", 0), 2);
});

test("leaves renderer-ready to the owned Quick chat renderer after the prewarm gate", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function openNativeQuickChat");
  const end = source.indexOf("async function selectHistoryConversation", start);
  const freshOpenPath = source.slice(start, end);
  assert.match(freshOpenPath, /buildQuickChatPrewarmExpression/);
  assert.match(freshOpenPath, /selectCdpPageTargetById/);
  assert.match(freshOpenPath, /selectOwnedQuickChatTarget/);
  assert.doesNotMatch(freshOpenPath, /buildQuickChatRendererReadyExpression/);
  assert.throws(() => buildQuickChatPrewarmExpression("26.999.0.0"), /unsupported|version/i);
  assert.throws(() => buildQuickChatRendererReadyExpression("26.999.0.0", "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc"), /unsupported|version/i);
});

test("limits native quick-chat fan-out to available client windows", () => {
  assert.equal(quickChatWaveSize("26.707.9564.0", 0), 2);
  assert.equal(quickChatWaveSize("26.707.9564.0", 1), 1);
  assert.throws(() => quickChatWaveSize("26.707.9564.0", 2), /close|window|capacity/i);
  assert.throws(() => quickChatWaveSize("26.999.0.0", 0), /unsupported|version/i);
});

test("extracts only explicit quick-chat conversation identities", () => {
  const localUrl = "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Flocal-chatgpt%253A50b66343-af73-4c20-96e1-63b4a7565329";
  assert.equal(conversationIdFromAppUrl(localUrl), "local-chatgpt:50b66343-af73-4c20-96e1-63b4a7565329");
  assert.equal(conversationIdFromAppUrl("app://-/index.html"), null);
  assert.throws(() => conversationIdFromAppUrl("https://example.com/?initialRoute=%2Fchatgpt%2Fquick-chat%2Fbad"), /app|conversation/i);
  assert.throws(() => conversationIdFromAppUrl("app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2F..%252Fbad"), /conversation/i);
});

test("distinguishes a prewarm route from the expected quick-chat conversation", () => {
  const expected = "local-chatgpt:3da06710-f874-437a-8ab1-71bc25e58afc";
  assert.equal(isExpectedConversationAppUrl(
    "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
    expected,
  ), false);
  assert.equal(isExpectedConversationAppUrl(
    "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Flocal-chatgpt%253A3da06710-f874-437a-8ab1-71bc25e58afc",
    expected,
  ), true);
});

test("probe expression is read-only and does not inspect credentials or chat history", () => {
  const expression = buildChatProbeExpression();
  assert.match(expression, /聊天/);
  assert.match(expression, /Quick chat/);
  assert.match(expression, /当前模式|current mode/i);
  assert.match(expression, /location\.href/);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(expression, /querySelectorAll\(['"]p|querySelectorAll\(['"]article/i);
  assert.doesNotMatch(expression, /\.click\(|dispatchEvent|fetch\(/i);
});

test("snapshot expression scopes collection to rendered conversation units", () => {
  const expression = buildConversationSnapshotExpression("BRIDGE-MARKER-A");
  const mainExpression = buildConversationSnapshotExpression("BRIDGE-MARKER-A", "main-chat");
  assert.match(expression, /data-content-search-unit-key/);
  assert.match(expression, /BRIDGE-MARKER-A/);
  assert.match(expression, /assistant/);
  assert.match(expression, /querySelectorAll\('img'\)/);
  assert.match(expression, /generated image|生成图像/i);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(expression, /fetch\(|XMLHttpRequest|querySelectorAll\(['"]p/i);
  assert.match(mainExpression, /role="dialog"/);
  assert.match(mainExpression, /root\.querySelectorAll/);
});

test("materializes only app-local rendered blob images", () => {
  const expression = buildBlobImageDataExpression("blob:app://-/4d5ed762-c249-4e31-9d57-3c12e4596c06");
  assert.match(expression, /createElement\('canvas'\)/);
  assert.match(expression, /drawImage/);
  assert.doesNotMatch(expression, /fetch|FileReader/);
  assert.match(expression, /4d5ed762-c249-4e31-9d57-3c12e4596c06/);
  assert.doesNotMatch(expression, /cookie|localStorage|sessionStorage|indexedDB/i);
  assert.throws(() => buildBlobImageDataExpression("https://example.com/image.png"), /blob|image/i);
  assert.throws(() => buildBlobImageDataExpression("blob:https://example.com/id"), /blob|image/i);
  const chunk = buildBlobImageChunkExpression("blob:app://-/4d5ed762-c249-4e31-9d57-3c12e4596c06", 0);
  assert.match(chunk, /slice/);
  assert.match(chunk, /nextOffset|done|total/);
  assert.throws(() => buildBlobImageChunkExpression("blob:app://-/id", -1), /offset|image/i);
});

test("classifies completed, waiting, navigated-away, and ambiguous post-submit observations", () => {
  const base = {
    submitted: true,
    expectedConversationId: "conv-a",
    currentConversationId: "conv-a",
    composerBusy: false,
    assistantMessageCount: 1,
    baselineAssistantMessageCount: 0,
    hasStopButton: false,
    stablePolls: 2,
  };
  assert.equal(classifyJobObservation(base), "complete");
  assert.equal(classifyJobObservation({ ...base, composerBusy: true, stablePolls: 0 }), "waiting");
  assert.equal(classifyJobObservation({ ...base, hasStopButton: true, stablePolls: 0 }), "waiting");
  assert.equal(classifyJobObservation({ ...base, currentConversationId: "conv-b" }), "unknown-after-submit");
  assert.equal(classifyJobObservation({ ...base, currentConversationId: null }), "unknown-after-submit");
  assert.equal(classifyJobObservation({ ...base, submitted: false }), "not-submitted");
  assert.equal(classifyJobObservation({ ...base, assistantMessageCount: 0 }), "waiting");
  assert.equal(classifyJobObservation({
    ...base,
    assistantMessageCount: 0,
    hasGeneratedImages: true,
  }), "complete");
});

test("normalizes only the target result and strips unsafe or non-image URLs", () => {
  const normalized = normalizeCollectedResult({
    conversationId: "conv-a",
    url: "app://-/chat/conv-a",
    assistantText: "完成。",
    images: [
      { src: "https://files.oaiusercontent.com/image.png", width: 1024, height: 1024, alt: "generated" },
      { src: "data:image/png;base64,AAA=", width: 2, height: 2, alt: "inline" },
      { src: "javascript:alert(1)", width: 1, height: 1, alt: "bad" },
    ],
  });
  assert.deepEqual(normalized, {
    conversationId: "conv-a",
    url: "app://-/chat/conv-a",
    assistantText: "完成。",
    images: [
      { src: "https://files.oaiusercontent.com/image.png", width: 1024, height: 1024, alt: "generated" },
      { src: "data:image/png;base64,AAA=", width: 2, height: 2, alt: "inline" },
    ],
  });
  assert.ok(Object.isFrozen(normalized));
  assert.equal(normalizeCollectedResult({
    ...normalized,
    conversationId: "local-chatgpt:50b66343-af73-4c20-96e1-63b4a7565329",
  }).conversationId, "local-chatgpt:50b66343-af73-4c20-96e1-63b4a7565329");
  assert.throws(() => normalizeCollectedResult({ ...normalized, conversationId: "../bad" }), /conversation/i);
});

test("keeps image metadata in reports without embedding image bytes", () => {
  assert.deepEqual(summarizeCollectedImages([
    { src: "data:image/png;base64,AAA=", width: 1672, height: 941, alt: "已生成图像 1" },
    { src: "https://files.oaiusercontent.com/image.png", width: 1024, height: 1024, alt: "generated" },
  ]), [
    { sourceType: "materialized-app-blob", width: 1672, height: 941, alt: "已生成图像 1" },
    { sourceType: "remote-image", width: 1024, height: 1024, alt: "generated" },
  ]);
});
