import { createHash } from "node:crypto";
import path from "node:path";

const TASK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CONVERSATION_ID = /^(?:local-chatgpt|local):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const UNIT_KEY = /^[^\u0000-\u001f\u007f]{1,300}$/u;
const HANDOFF_FIELDS = new Set([
  "schemaVersion",
  "type",
  "taskId",
  "status",
  "objective",
  "acceptance",
  "constraints",
  "context",
]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function knownFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${label} contains unknown field: ${field}`);
  }
}

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be non-empty bounded text`);
  }
  return value.trim();
}

function textList(value, label, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  return value.map((item, index) => text(item, `${label}[${index}]`, 2000));
}

function validateConversationId(value, label = "conversationId") {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateHandoff(value) {
  const handoff = plainObject(value, "CODEX_HANDOFF");
  knownFields(handoff, HANDOFF_FIELDS, "CODEX_HANDOFF");
  if (handoff.schemaVersion !== 1 || handoff.type !== "CODEX_HANDOFF" || handoff.status !== "proposed") {
    throw new Error("CODEX_HANDOFF schema, type, or status is invalid");
  }
  if (typeof handoff.taskId !== "string" || !TASK_ID.test(handoff.taskId)) {
    throw new Error("CODEX_HANDOFF taskId is invalid");
  }
  const normalized = {
    schemaVersion: 1,
    type: "CODEX_HANDOFF",
    taskId: handoff.taskId,
    status: "proposed",
    objective: text(handoff.objective, "CODEX_HANDOFF objective", 4000),
    acceptance: textList(handoff.acceptance, "CODEX_HANDOFF acceptance", { min: 1 }),
    constraints: textList(handoff.constraints, "CODEX_HANDOFF constraints"),
    ...(handoff.context === undefined ? {} : {
      context: text(handoff.context, "CODEX_HANDOFF context", 10000),
    }),
  };
  const canonical = JSON.stringify(normalized);
  return {
    ...normalized,
    planHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

function parseAssistantHandoff(unit) {
  if (!unit.text.includes("CODEX_HANDOFF")) return null;
  const matches = [...unit.text.matchAll(
    /(?:^|\r?\n)CODEX_HANDOFF[ \t]*\r?\n```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gu,
  )];
  let source = null;
  if (matches.length === 1 && unit.codeBlocks.length === 0) {
    source = matches[0][1];
  } else if (matches.length === 0 && unit.codeBlocks.length === 1) {
    source = unit.codeBlocks[0].replaceAll("\u00a0", " ");
  } else {
    throw new Error(`assistant unit ${unit.key} must contain exactly one CODEX_HANDOFF JSON block`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`assistant unit ${unit.key} CODEX_HANDOFF JSON is invalid: ${error.message}`);
  }
  return validateHandoff(parsed);
}

function normalizeUnits(value) {
  if (!Array.isArray(value) || value.length > 500) throw new Error("handoff units are invalid");
  const seen = new Set();
  return value.map((raw, index) => {
    const unit = plainObject(raw, `handoff unit ${index}`);
    knownFields(unit, new Set(["key", "role", "text", "codeBlocks"]), `handoff unit ${index}`);
    if (typeof unit.key !== "string" || !UNIT_KEY.test(unit.key) || seen.has(unit.key)) {
      throw new Error(`handoff unit ${index} key is invalid or duplicated`);
    }
    seen.add(unit.key);
    if (!["assistant", "user"].includes(unit.role)) throw new Error(`handoff unit ${index} role is invalid`);
    if (typeof unit.text !== "string" || unit.text.length > 30000) {
      throw new Error(`handoff unit ${index} text is invalid`);
    }
    const codeBlocks = unit.codeBlocks ?? [];
    if (!Array.isArray(codeBlocks) || codeBlocks.length > 20 ||
        codeBlocks.some((item) => typeof item !== "string" || item.length > 30000)) {
      throw new Error(`handoff unit ${index} codeBlocks are invalid`);
    }
    return { key: unit.key, role: unit.role, text: unit.text, codeBlocks };
  });
}

export function validateHandoffWatchManifest(value) {
  const manifest = plainObject(value, "handoff watch manifest");
  knownFields(
    manifest,
    new Set(["schemaVersion", "conversationId", "surface", "checkpointPath"]),
    "handoff watch manifest",
  );
  if (manifest.schemaVersion !== 1 || manifest.surface !== "chatgpt-main-chat") {
    throw new Error("handoff watch manifest schema or surface is invalid");
  }
  validateConversationId(manifest.conversationId);
  if (typeof manifest.checkpointPath !== "string" || !path.win32.isAbsolute(manifest.checkpointPath) ||
      manifest.checkpointPath.includes("\0")) {
    throw new Error("handoff watch checkpointPath must be absolute");
  }
  return {
    schemaVersion: 1,
    conversationId: manifest.conversationId,
    surface: "chatgpt-main-chat",
    checkpointPath: path.win32.normalize(manifest.checkpointPath),
  };
}

export function validateHandoffApprovalManifest(value) {
  const manifest = plainObject(value, "handoff approval manifest");
  knownFields(
    manifest,
    new Set(["schemaVersion", "conversationId", "surface", "marker", "taskId"]),
    "handoff approval manifest",
  );
  if (manifest.schemaVersion !== 1 || manifest.surface !== "chatgpt-main-chat") {
    throw new Error("handoff approval manifest schema or surface is invalid");
  }
  validateConversationId(manifest.conversationId);
  if (typeof manifest.marker !== "string" || !/^CODEX-BRIDGE-[A-Za-z0-9-]{1,180}$/u.test(manifest.marker)) {
    throw new Error("handoff approval marker is invalid");
  }
  if (typeof manifest.taskId !== "string" || !TASK_ID.test(manifest.taskId)) {
    throw new Error("handoff approval taskId is invalid");
  }
  return {
    schemaVersion: 1,
    conversationId: manifest.conversationId,
    surface: "chatgpt-main-chat",
    marker: manifest.marker,
    taskId: manifest.taskId,
  };
}

export function createEmptyHandoffCheckpoint(conversationId) {
  return {
    schemaVersion: 1,
    conversationId: validateConversationId(conversationId),
    delivered: [],
  };
}

export function validateHandoffCheckpoint(value, expectedConversationId) {
  const checkpoint = plainObject(value, "handoff checkpoint");
  knownFields(checkpoint, new Set(["schemaVersion", "conversationId", "delivered"]), "handoff checkpoint");
  if (checkpoint.schemaVersion !== 1 || !Array.isArray(checkpoint.delivered) || checkpoint.delivered.length > 1000) {
    throw new Error("handoff checkpoint schema is invalid");
  }
  const conversationId = validateConversationId(checkpoint.conversationId, "checkpoint conversationId");
  if (expectedConversationId !== undefined && conversationId !== expectedConversationId) {
    throw new Error("handoff checkpoint conversation identity changed");
  }
  const taskIds = new Set();
  const delivered = checkpoint.delivered.map((raw, index) => {
    const item = plainObject(raw, `handoff checkpoint delivered[${index}]`);
    knownFields(
      item,
      new Set(["taskId", "planHash", "proposalUnitKey", "approvalUnitKey", "deliveredAt"]),
      `handoff checkpoint delivered[${index}]`,
    );
    if (typeof item.taskId !== "string" || !TASK_ID.test(item.taskId) || taskIds.has(item.taskId)) {
      throw new Error("handoff checkpoint taskId is invalid or duplicated");
    }
    taskIds.add(item.taskId);
    if (typeof item.planHash !== "string" || !SHA256.test(item.planHash)) {
      throw new Error("handoff checkpoint planHash is invalid");
    }
    for (const field of ["proposalUnitKey", "approvalUnitKey"]) {
      if (typeof item[field] !== "string" || !UNIT_KEY.test(item[field])) {
        throw new Error(`handoff checkpoint ${field} is invalid`);
      }
    }
    if (typeof item.deliveredAt !== "string" || Number.isNaN(Date.parse(item.deliveredAt))) {
      throw new Error("handoff checkpoint deliveredAt is invalid");
    }
    return {
      taskId: item.taskId,
      planHash: item.planHash,
      proposalUnitKey: item.proposalUnitKey,
      approvalUnitKey: item.approvalUnitKey,
      deliveredAt: new Date(item.deliveredAt).toISOString(),
    };
  });
  return { schemaVersion: 1, conversationId, delivered };
}

export function selectNextApprovedHandoff(unitsValue, checkpointValue) {
  const units = normalizeUnits(unitsValue);
  const checkpoint = validateHandoffCheckpoint(checkpointValue);
  const deliveredByTaskId = new Map(checkpoint.delivered.map((item) => [item.taskId, item]));
  for (let proposalIndex = 0; proposalIndex < units.length; proposalIndex += 1) {
    const proposalUnit = units[proposalIndex];
    if (proposalUnit.role !== "assistant") continue;
    const handoff = parseAssistantHandoff(proposalUnit);
    if (!handoff) continue;
    const delivered = deliveredByTaskId.get(handoff.taskId);
    if (delivered) {
      if (delivered.planHash !== handoff.planHash) {
        throw new Error(`CODEX_HANDOFF taskId ${handoff.taskId} was reused or rebound to another plan`);
      }
      continue;
    }
    const approvalPattern = new RegExp(`^(?:CODEX_APPROVE|确认执行)\\s+${handoff.taskId}$`, "u");
    const approvalUnit = units.slice(proposalIndex + 1)
      .find((unit) => unit.role === "user" && approvalPattern.test(unit.text.trim()));
    if (!approvalUnit) continue;
    return {
      ...handoff,
      proposalUnitKey: proposalUnit.key,
      approvalUnitKey: approvalUnit.key,
    };
  }
  return null;
}

export function recordDeliveredHandoff(checkpointValue, handoffValue, deliveredAtValue = new Date().toISOString()) {
  const checkpoint = validateHandoffCheckpoint(checkpointValue);
  const handoff = plainObject(handoffValue, "delivered handoff");
  if (typeof handoff.taskId !== "string" || !TASK_ID.test(handoff.taskId) ||
      typeof handoff.planHash !== "string" || !SHA256.test(handoff.planHash) ||
      typeof handoff.proposalUnitKey !== "string" || !UNIT_KEY.test(handoff.proposalUnitKey) ||
      typeof handoff.approvalUnitKey !== "string" || !UNIT_KEY.test(handoff.approvalUnitKey)) {
    throw new Error("delivered handoff identity is invalid");
  }
  if (checkpoint.delivered.some((item) => item.taskId === handoff.taskId)) {
    throw new Error(`CODEX_HANDOFF taskId ${handoff.taskId} was already delivered`);
  }
  if (typeof deliveredAtValue !== "string" || Number.isNaN(Date.parse(deliveredAtValue))) {
    throw new Error("handoff deliveredAt is invalid");
  }
  return validateHandoffCheckpoint({
    ...checkpoint,
    delivered: [...checkpoint.delivered, {
      taskId: handoff.taskId,
      planHash: handoff.planHash,
      proposalUnitKey: handoff.proposalUnitKey,
      approvalUnitKey: handoff.approvalUnitKey,
      deliveredAt: new Date(deliveredAtValue).toISOString(),
    }],
  }, checkpoint.conversationId);
}
