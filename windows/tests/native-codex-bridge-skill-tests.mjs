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
