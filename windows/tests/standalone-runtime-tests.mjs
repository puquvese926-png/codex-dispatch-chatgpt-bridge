import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");
const runtimeScript = path.join(repositoryRoot, "windows", "scripts", "chatgpt-bridge.mjs");
const runnerScript = path.join(
  repositoryRoot,
  "skills",
  "dispatch-chatgpt-bridge",
  "scripts",
  "run-bridge.ps1",
);
const installScript = path.join(repositoryRoot, "scripts", "install-global.ps1");
const startScript = path.join(
  repositoryRoot,
  "windows",
  "scripts",
  "start-chatgpt-bridge.ps1",
);

test("repository bundles a generic bridge runtime with no Dream Skin state dependency", async () => {
  assert.equal(existsSync(runtimeScript), true, "standalone chatgpt-bridge.mjs is missing");

  const source = readFileSync(runtimeScript, "utf8");
  assert.doesNotMatch(source, /CodexDreamSkin|Dream Skin state/);
  assert.match(source, /CodexChatGPTBridge/);

  const { validateBridgeState } = await import(pathToFileURL(runtimeScript).href);
  assert.doesNotThrow(() => validateBridgeState({
    schemaVersion: 1,
    platform: "windows",
    port: 9335,
    browserId: "browser-123",
    codexExe: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.4_x64__test\\app\\ChatGPT.exe",
    codexPackageRoot: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.4_x64__test",
    codexPackageFullName: "OpenAI.Codex_1.2.3.4_x64__test",
    codexPackageFamilyName: "OpenAI.Codex_test",
    codexVersion: "1.2.3.4",
    createdAt: "2026-07-25T00:00:00.000Z",
  }));
});

test("runner supports an explicit detached mode with a durable progress path", () => {
  const source = readFileSync(runnerScript, "utf8");
  assert.match(source, /'plan'/);
  assert.match(source, /\[switch\]\$ExperimentalQuickChat/);
  assert.match(source, /\[switch\]\$Detach/);
  assert.match(source, /Start-Process/);
  assert.match(source, /WindowStyle Hidden/);
  assert.match(source, /progress\.json/);
  assert.match(source, /stdoutPath/);
  assert.match(source, /stderrPath/);
});

test("runner exposes a read-only route plan and makes Quick Chat opt-in", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plan-"));
  try {
    const fakeRuntime = path.join(temporaryRoot, "runtime");
    const fakeScript = path.join(fakeRuntime, "windows", "scripts", "chatgpt-bridge.mjs");
    mkdirSync(path.dirname(fakeScript), { recursive: true });
    writeFileSync(
      fakeScript,
      "console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n",
      "utf8",
    );
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "plan.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runnerScript,
      "-Root",
      fakeRuntime,
      "-Action",
      "plan",
      "-InputPath",
      inputPath,
      "-OutputPath",
      outputPath,
      "-ExperimentalQuickChat",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const invocation = JSON.parse(result.stdout);
    assert.equal(invocation.argv[0], "plan");
    assert.equal(invocation.argv.includes("--experimental-quick-chat"), true);
    assert.equal(invocation.argv.includes("--allow-send"), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("detached runner returns a launch record without waiting for the child", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-detach-"));
  try {
    const fakeRuntime = path.join(temporaryRoot, "runtime");
    const fakeScript = path.join(fakeRuntime, "windows", "scripts", "chatgpt-bridge.mjs");
    mkdirSync(path.dirname(fakeScript), { recursive: true });
    writeFileSync(fakeScript, "setTimeout(() => process.exit(0), 1500);\n", "utf8");
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runnerScript,
      "-Root",
      fakeRuntime,
      "-Action",
      "batch",
      "-InputPath",
      inputPath,
      "-OutputPath",
      outputPath,
      "-Detach",
      "-AllowSend",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const launch = JSON.parse(result.stdout);
    assert.equal(launch.pass, true);
    assert.equal(launch.state, "running");
    assert.equal(launch.reportPath, outputPath);
    assert.equal(launch.progressPath, `${outputPath}.progress.json`);
    assert.ok(Number.isInteger(launch.pid) && launch.pid > 0);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("global runner ignores legacy Dream Skin roots and selects the installed standalone runtime", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-runner-"));
  try {
    const standaloneRoot = path.join(
      temporaryRoot,
      ".codex",
      "bridge-runtime",
      "dispatch-chatgpt-bridge",
    );
    const legacyRoot = path.join(temporaryRoot, "legacy-dream-skin");
    const standaloneScript = path.join(standaloneRoot, "windows", "scripts", "chatgpt-bridge.mjs");
    const legacyScript = path.join(legacyRoot, "windows", "scripts", "chatgpt-bridge.mjs");
    mkdirSync(path.dirname(standaloneScript), { recursive: true });
    mkdirSync(path.dirname(legacyScript), { recursive: true });
    writeFileSync(
      standaloneScript,
      'console.log(JSON.stringify({ pass: true, runtime: "standalone" }));\n',
      "utf8",
    );
    writeFileSync(
      legacyScript,
      'console.log(JSON.stringify({ pass: true, runtime: "dream-skin" }));\n',
      "utf8",
    );

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runnerScript,
      "-Action",
      "discover",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        USERPROFILE: temporaryRoot,
        CODEX_BRIDGE_ROOT: "",
        CODEX_DREAM_SKIN_ROOT: legacyRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).runtime, "standalone");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("global installer deploys both the Skill and standalone runtime", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-install-"));
  try {
    const globalSkillsRoot = path.join(temporaryRoot, "skills");
    const globalRuntimeRoot = path.join(temporaryRoot, "runtime");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installScript,
      "-GlobalSkillsRoot",
      globalSkillsRoot,
      "-GlobalRuntimeRoot",
      globalRuntimeRoot,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      existsSync(path.join(globalSkillsRoot, "dispatch-chatgpt-bridge", "SKILL.md")),
      true,
    );
    assert.equal(
      existsSync(path.join(globalRuntimeRoot, "windows", "scripts", "chatgpt-bridge.mjs")),
      true,
    );
    assert.equal(
      existsSync(path.join(
        globalRuntimeRoot,
        "windows",
        "scripts",
        "chatgpt-bridge-product-control.mjs",
      )),
      true,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("standalone bootstrap owns Codex CDP state without theme or Dream Skin dependencies", () => {
  assert.equal(existsSync(startScript), true, "standalone bootstrap script is missing");
  const source = readFileSync(startScript, "utf8");
  assert.doesNotMatch(source, /DreamSkin|Dream Skin|theme|injector/i);
  assert.match(source, /CodexChatGPTBridge/);
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(source, /--remote-debugging-port/);
  assert.match(source, /RestartExisting/);
  assert.match(
    source,
    /Invoke-CimMethod[\s\S]*Win32_Process[\s\S]*Create/,
    "restart must be created by the Windows process service so it survives Codex shutdown",
  );
  assert.match(source, /restart-dispatched/);
  assert.match(source, /restart-report\.json/);

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    startScript,
    "-SelfTest",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const desktopResult = JSON.parse(result.stdout);
  assert.equal(desktopResult.pass, true);
  assert.equal(desktopResult.hostEdition, "Desktop");
  assert.equal(desktopResult.restartStrategy, "cim-detached-worker");
  assert.equal(desktopResult.durableRestartReport, true);

  const coreResult = spawnSync("pwsh.exe", [
    "-NoProfile",
    "-File",
    startScript,
    "-SelfTest",
  ], { encoding: "utf8" });
  if (coreResult.error?.code !== "ENOENT") {
    assert.equal(coreResult.status, 0, coreResult.stderr || coreResult.stdout);
    assert.equal(JSON.parse(coreResult.stdout).hostEdition, "Desktop");
  }
});
