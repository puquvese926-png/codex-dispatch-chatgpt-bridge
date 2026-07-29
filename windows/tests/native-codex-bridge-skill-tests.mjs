import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const skillRoot = path.join(projectRoot, "skills", "dispatch-chatgpt-bridge");

test("skill defines distinct native Codex and ChatGPT bridge routes", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const native = await fs.readFile(
    path.join(skillRoot, "references", "native-codex-bridge.md"),
    "utf8",
  );

  for (const route of [
    "codex-subagent",
    "codex-conversation",
    "codex-to-gpt",
    "gpt-to-codex",
  ]) {
    assert.match(skill, new RegExp(route));
    assert.match(native, new RegExp(route));
  }
  assert.match(native, /子智能体/);
  assert.match(native, /Codex 对话转交/);
  assert.match(native, /quick-watch|quick.?watch/i);
});

test("skill frontmatter covers bridge-specific Chinese trigger phrases without becoming a generic chat trigger", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] || "";
  assert.match(frontmatter, /^description:/m);
  for (const phrase of ["子智能体", "子代理", "桥接对话", "ChatGPT桥接", "跨对话", "生图分发", "CODEX_HANDOFF"]) {
    assert.match(frontmatter, new RegExp(phrase));
  }
  assert.doesNotMatch(frontmatter, /所有聊天|任意聊天|普通聊天都触发/);
});

test("installation and unknown-after-submit guidance does not promise a daemon or automatic resend", async () => {
  const installer = await fs.readFile(path.join(projectRoot, "scripts", "install-global.ps1"), "utf8");
  const guide = await fs.readFile(
    path.join(projectRoot, "docs", "dispatch-chatgpt-bridge-guide.md"),
    "utf8",
  );
  const playbook = await fs.readFile(
    path.join(skillRoot, "references", "failure-playbook.md"),
    "utf8",
  );
  assert.doesNotMatch(installer, /AGENTS\.md/);
  assert.match(guide, /安装器.*修改.*AGENTS\.md/s);
  assert.match(guide, /BRIDGE_BATCH_UNKNOWN_AFTER_SUBMIT/);
  assert.match(guide, /not-recovered/);
  assert.match(guide, /不.*自动重发/);
  assert.match(playbook, /BRIDGE_BATCH_UNKNOWN_AFTER_SUBMIT/);
  assert.match(playbook, /without `-AllowSend`/);
  assert.match(playbook, /not a persistent daemon/);
});

test("native route contract prevents delegation metadata spoofing and route drift", async () => {
  const native = await fs.readFile(
    path.join(skillRoot, "references", "native-codex-bridge.md"),
    "utf8",
  );

  assert.match(native, /不要手写|never write|do not write/i);
  assert.match(native, /codex_delegation/);
  assert.match(native, /source_thread_id/);
  assert.match(native, /codex_app__create_thread/);
  assert.match(native, /codex_app__send_message_to_thread/);
  assert.match(native, /multi_agent_v1__spawn_agent/);
  assert.match(native, /exact|精确/);
  assert.match(native, /fail closed|fail-closed|失败即停止/i);
});

test("skill metadata exposes the three bridge families without ambiguous child-agent wording", async () => {
  const metadata = await fs.readFile(
    path.join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(metadata, /子智能体/);
  assert.match(metadata, /子代理/);
  assert.match(metadata, /codex-conversation/);
  assert.match(metadata, /Codex.*GPT|GPT.*Codex/s);
  assert.doesNotMatch(metadata, /子代理（对话之前传递）/);
});

test("maps 子智能体 to ephemeral workers and 子代理 to durable Codex conversations", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const native = await fs.readFile(
    path.join(skillRoot, "references", "native-codex-bridge.md"),
    "utf8",
  );
  const guide = await fs.readFile(
    path.join(projectRoot, "docs", "dispatch-chatgpt-bridge-guide.md"),
    "utf8",
  );
  const playbook = await fs.readFile(
    path.join(skillRoot, "references", "failure-playbook.md"),
    "utf8",
  );

  assert.match(skill, /子智能体[\s\S]{0,120}codex-subagent/);
  assert.match(skill, /子代理[\s\S]{0,160}codex-conversation/);
  assert.match(native, /子智能体[\s\S]{0,120}codex-subagent/);
  assert.match(native, /子代理[\s\S]{0,160}codex-conversation/);
  assert.match(guide, /子智能体[\s\S]{0,160}临时|子代理[\s\S]{0,160}长期/);
  assert.match(playbook, /子代理[\s\S]{0,240}codex-conversation/);
  assert.doesNotMatch(skill, /子代理.*歧义|Do not silently interpret “子代理”/s);
  assert.doesNotMatch(native, /“子代理” is ambiguous|子代理.*二选一/i);
});

test("ChatGPT product route plans before send and keeps Quick Chat experimental", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const contract = await fs.readFile(
    path.join(skillRoot, "references", "bridge-contract.md"),
    "utf8",
  );
  const guide = await fs.readFile(
    path.join(projectRoot, "docs", "dispatch-chatgpt-bridge-guide.md"),
    "utf8",
  );

  for (const source of [skill, contract, guide]) {
    assert.match(source, /plan/);
    assert.match(source, /serial-main-chat|串行/);
    assert.match(source, /ExperimentalQuickChat|实验/i);
    assert.match(source, /全局控制锁|controller\s+lock/i);
  }
});
