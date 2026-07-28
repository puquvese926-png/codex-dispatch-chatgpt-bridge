import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const launchControlScript = path.join(
  repositoryRoot,
  "skills",
  "dispatch-chatgpt-bridge",
  "scripts",
  "launch-control.ps1",
);
const installScript = path.join(repositoryRoot, "scripts", "install-global.ps1");
const verifyScript = path.join(repositoryRoot, "scripts", "verify-global-install.ps1");
const startScript = path.join(
  repositoryRoot,
  "windows",
  "scripts",
  "start-chatgpt-bridge.ps1",
);

function runPowerShell(script, args = [], env = {}) {
  return spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runPowerShellAsync(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function assertPowerShellSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function stopProcess(pid) {
  if (!pid) return;
  spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Stop-Process -Id " + String(pid) + " -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 250",
  ], { encoding: "utf8" });
}

function getProcessStartTime(pid) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "(Get-Process -Id " + String(pid) + ").StartTime.ToUniversalTime().ToString('o')",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function getProcessIdsByCommandToken(token) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$token = '" + token + "'; @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($token, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -ExpandProperty ProcessId)",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
}

function writeRunningLaunchFixture(root, command = "batch") {
  const launchRoot = path.join(root, "launches");
  const launchId = crypto.randomUUID();
  const launchDirectory = path.join(launchRoot, launchId);
  const launchPath = path.join(launchDirectory, "launch.json");
  const reportPath = path.join(root, "report.json");
  const inputPath = path.join(root, "input.json");
  mkdirSync(launchDirectory, { recursive: true });
  writeFileSync(inputPath, "{}\n", "utf8");
  const record = {
    schemaVersion: 1,
    launchId,
    command,
    state: "running",
    pid: process.pid,
    processStartedAt: getProcessStartTime(process.pid),
    launchPath,
    reportPath,
    progressPath: command === "batch" ? reportPath + ".progress.json" : null,
    stdoutPath: path.join(launchDirectory, "stdout.log"),
    stderrPath: path.join(launchDirectory, "stderr.log"),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    authorization: { allowSend: command === "batch", allowDelete: false },
    inputPath,
    statePath: null,
    timeoutMs: 600000,
    pollMs: 5000,
    error: null,
    errorClass: null,
    wrapperPid: null,
  };
  writeFileSync(launchPath, JSON.stringify(record), "utf8");
  return { launchPath, reportPath, record };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function manifestHash(manifest) {
  const { manifestHash: ignored, ...withoutHash } = manifest;
  return crypto.createHash("sha256")
    // PowerShell ConvertTo-Json escapes these HTML-sensitive characters;
    // keep the test-side recomputation byte-identical to the installer.
    .update(JSON.stringify(canonicalize(withoutHash))
      .replaceAll("&", "\\u0026")
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e"), "utf8")
    .digest("hex");
}

function refreshDeployedRuntimeEntry(skills, runtime) {
  const skillManifestPath = path.join(skills, "dispatch-chatgpt-bridge", "deployment-manifest.json");
  const runtimeManifestPath = path.join(runtime, "deployment-manifest.json");
  const runtimeScriptPath = path.join(runtime, "windows", "scripts", "chatgpt-bridge.mjs");
  const runtimeSha256 = crypto.createHash("sha256").update(readFileSync(runtimeScriptPath)).digest("hex");
  for (const manifestPath of [skillManifestPath, runtimeManifestPath]) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.managedFiles.runtime.find(({ path: relativePath }) => relativePath === "windows/scripts/chatgpt-bridge.mjs");
    assert.ok(entry, `runtime manifest entry missing in ${manifestPath}`);
    entry.sha256 = runtimeSha256;
    manifest.manifestHash = manifestHash(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(canonicalize(manifest))}\n`, "utf8");
  }
}

function rewriteManifestPair(skills, runtime, mutate) {
  const manifestPaths = [
    path.join(skills, "dispatch-chatgpt-bridge", "deployment-manifest.json"),
    path.join(runtime, "deployment-manifest.json"),
  ];
  const manifests = manifestPaths.map((manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")));
  for (const manifest of manifests) mutate(manifest);
  for (let index = 0; index < manifests.length; index += 1) {
    manifests[index].manifestHash = manifestHash(manifests[index]);
    writeFileSync(manifestPaths[index], `${JSON.stringify(canonicalize(manifests[index]))}\n`, "utf8");
  }
}

function treeSnapshot(root) {
  const entries = [];
  function visit(directory, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else entries.push({ path: childRelative.replaceAll("\\", "/"), bytes: readFileSync(child).toString("hex") });
    }
  }
  visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function installArgs(skills, runtime, extra = []) {
  return ["-GlobalSkillsRoot", skills, "-GlobalRuntimeRoot", runtime, ...extra];
}

function makeFakeNode(root, markerPath) {
  const bin = path.join(root, "fake-node-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "node.cmd"), [
    "@echo off",
    `echo called>${markerPath}`,
    "echo {\"pass\":true}",
  ].join("\r\n"), "utf8");
  return bin;
}

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
  const launchControl = readFileSync(launchControlScript, "utf8");
  assert.match(source, /'plan'/);
  assert.match(source, /\[switch\]\$ExperimentalQuickChat/);
  assert.match(source, /\[switch\]\$Detach/);
  assert.match(source, /launch-control\.ps1/);
  assert.match(launchControl, /Invoke-CimMethod\s+-ClassName\s+Win32_Process\s+-MethodName\s+Create/);
  assert.match(launchControl, /--bridge-launch-token/);
  assert.match(launchControl, /created-but-unattributed/);
  assert.match(launchControl, /progress\.json/);
  assert.match(launchControl, /stdoutPath/);
  assert.match(launchControl, /stderrPath/);
});

test("runner exposes a read-only route plan and makes Quick Chat opt-in", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-plan-"));
  try {
    const globalSkillsRoot = path.join(temporaryRoot, "skills");
    const fakeRuntime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(globalSkillsRoot, fakeRuntime)));
    const fakeScript = path.join(fakeRuntime, "windows", "scripts", "chatgpt-bridge.mjs");
    writeFileSync(
      fakeScript,
      "console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n",
      "utf8",
    );
    refreshDeployedRuntimeEntry(globalSkillsRoot, fakeRuntime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "plan.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(globalSkillsRoot, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1"),
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
    const globalSkillsRoot = path.join(temporaryRoot, "skills");
    const fakeRuntime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(globalSkillsRoot, fakeRuntime)));
    const fakeScript = path.join(fakeRuntime, "windows", "scripts", "chatgpt-bridge.mjs");
    writeFileSync(fakeScript, "setTimeout(() => process.exit(0), 1500);\n", "utf8");
    refreshDeployedRuntimeEntry(globalSkillsRoot, fakeRuntime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(globalSkillsRoot, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1"),
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

test("clean install creates two byte-identical canonical deployment manifests", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-manifest-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const verification = runPowerShell(verifyScript, installArgs(skills, runtime));
    assertPowerShellSuccess(verification);
    const skillManifest = JSON.parse(readFileSync(
      path.join(skills, "dispatch-chatgpt-bridge", "deployment-manifest.json"),
      "utf8",
    ));
    const runtimeManifest = JSON.parse(readFileSync(path.join(runtime, "deployment-manifest.json"), "utf8"));
    assert.deepEqual(runtimeManifest, skillManifest);
    assert.equal(skillManifest.schemaVersion, 1);
    assert.equal(skillManifest.bridgeVersion, "0.5.0");
    assert.equal(skillManifest.protocolVersion, "2");
    assert.match(skillManifest.sourceCommit, /^(?:[0-9a-f]{40}|unavailable)$/);
    assert.match(skillManifest.sourceCommitStatus, /^(?:exact-clean|dirty-worktree|git-status-unavailable|unavailable)$/);
    assert.equal(skillManifest.manifestHash, manifestHash(skillManifest));
    assert.equal(skillManifest.targets.skill, path.join(skills, "dispatch-chatgpt-bridge").toLowerCase());
    assert.equal(skillManifest.targets.runtime, runtime.toLowerCase());
    assert.equal(JSON.parse(verification.stdout).manifestHash, skillManifest.manifestHash);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("install upgrades a dirty older tree and preserves unrelated extra files", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-upgrade-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const skillTarget = path.join(skills, "dispatch-chatgpt-bridge");
    const runtimeTarget = runtime;
    const extraSkill = path.join(skillTarget, "user-extra.txt");
    const extraRuntime = path.join(runtimeTarget, "user-extra.txt");
    writeFileSync(extraSkill, "keep skill extra", "utf8");
    writeFileSync(extraRuntime, "keep runtime extra", "utf8");
    writeFileSync(path.join(skillTarget, "SKILL.md"), "old-version-content", "utf8");
    writeFileSync(path.join(runtimeTarget, "windows", "scripts", "chatgpt-bridge.mjs"), "old-runtime-content", "utf8");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    assertPowerShellSuccess(runPowerShell(verifyScript, installArgs(skills, runtime)));
    assert.equal(readFileSync(extraSkill, "utf8"), "keep skill extra");
    assert.equal(readFileSync(extraRuntime, "utf8"), "keep runtime extra");
    assert.equal(readFileSync(path.join(skillTarget, "SKILL.md"), "utf8"), readFileSync(
      path.join(repositoryRoot, "skills", "dispatch-chatgpt-bridge", "SKILL.md"), "utf8",
    ));
    assert.equal(readFileSync(path.join(runtimeTarget, "windows", "scripts", "chatgpt-bridge.mjs"), "utf8"), readFileSync(
      path.join(repositoryRoot, "windows", "scripts", "chatgpt-bridge.mjs"), "utf8",
    ));
    const manifest = JSON.parse(readFileSync(path.join(runtimeTarget, "deployment-manifest.json"), "utf8"));
    const runtimeEntry = manifest.managedFiles.runtime.find(({ path: relativePath }) => relativePath === "windows/scripts/chatgpt-bridge.mjs");
    assert.equal(runtimeEntry.sha256, crypto.createHash("sha256").update(readFileSync(
      path.join(runtimeTarget, "windows", "scripts", "chatgpt-bridge.mjs"),
    )).digest("hex"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("test-only switch failures restore both old trees byte-for-byte", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-rollback-"));
  try {
    for (const failureAt of ["BeforeRuntimeSwitch", "AfterRuntimeSwitch", "BeforeCommit"]) {
      const caseRoot = path.join(temporaryRoot, failureAt);
      const skills = path.join(caseRoot, "skills");
      const runtime = path.join(caseRoot, "runtime");
      assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
      const skillTarget = path.join(skills, "dispatch-chatgpt-bridge");
      const beforeSkill = treeSnapshot(skillTarget);
      const beforeRuntime = treeSnapshot(runtime);
      const failure = runPowerShell(installScript, installArgs(skills, runtime, [
        "-TestOnly", "-TestFailureAt", failureAt,
      ]), { CODEX_BRIDGE_INSTALL_TEST_MODE: "1" });
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr + failure.stdout, /previous Skill\/Runtime trees were restored/i);
      assert.deepEqual(treeSnapshot(skillTarget), beforeSkill);
      assert.deepEqual(treeSnapshot(runtime), beforeRuntime);
      assert.equal(readdirSync(skills).some((name) => name.includes("dispatch-chatgpt-bridge-")), false);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("an error after commit never rolls back the newly installed pair", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-commit-boundary-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const failure = runPowerShell(installScript, installArgs(skills, runtime, [
      "-TestOnly", "-TestFailureAt", "AfterCommitBeforeCleanup",
    ]), { CODEX_BRIDGE_INSTALL_TEST_MODE: "1" });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr + failure.stdout, /installation committed/i);
    assert.equal(existsSync(path.join(skills, "dispatch-chatgpt-bridge", "deployment-manifest.json")), true);
    assert.equal(existsSync(path.join(runtime, "deployment-manifest.json")), true);
    assert.equal(readdirSync(skills).some((name) => name.includes("dispatch-chatgpt-bridge-")), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("failure before first install leaves originally absent deployment roots absent", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-rollback-empty-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const failure = runPowerShell(installScript, installArgs(skills, runtime, [
      "-TestOnly", "-TestFailureAt", "BeforeRuntimeSwitch",
    ]), { CODEX_BRIDGE_INSTALL_TEST_MODE: "1" });
    assert.notEqual(failure.status, 0);
    assert.equal(existsSync(path.join(skills, "dispatch-chatgpt-bridge")), false);
    assert.equal(existsSync(runtime), false);
    assert.equal(readdirSync(skills).some((name) => name.includes("dispatch-chatgpt-bridge-")), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("staged manifest tamper fails before switching and the old targets remain unchanged", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-staged-tamper-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const beforeSkill = treeSnapshot(path.join(skills, "dispatch-chatgpt-bridge"));
    const beforeRuntime = treeSnapshot(runtime);
    const failure = runPowerShell(installScript, installArgs(skills, runtime, [
      "-TestOnly", "-TestFailureAt", "CorruptStagedManifest",
    ]), { CODEX_BRIDGE_INSTALL_TEST_MODE: "1" });
    assert.notEqual(failure.status, 0);
    assert.deepEqual(treeSnapshot(path.join(skills, "dispatch-chatgpt-bridge")), beforeSkill);
    assert.deepEqual(treeSnapshot(runtime), beforeRuntime);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner rejects manifest drift before Node for non-diagnostic actions and accepts a matching pair", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-gate-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const marker = path.join(temporaryRoot, "node-called.txt");
    const fakeBin = makeFakeNode(temporaryRoot, marker);
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const input = path.join(temporaryRoot, "input.json");
    const output = path.join(temporaryRoot, "output.json");
    writeFileSync(input, "{}\n", "utf8");
    const runtimeManifestPath = path.join(runtime, "deployment-manifest.json");
    const drifted = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
    drifted.manifestHash = "0".repeat(64);
    writeFileSync(runtimeManifestPath, JSON.stringify(drifted), "utf8");
    const invalid = runPowerShell(runner, [
      "-Root", runtime, "-Action", "plan", "-InputPath", input, "-OutputPath", output,
    ], { PATH: `${fakeBin};${process.env.PATH}`, BRIDGE_NODE_MARKER: marker });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr + invalid.stdout, /Bridge consistency gate failed before Node\/CDP/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(output), false);

    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const valid = runPowerShell(runner, [
      "-Root", runtime, "-Action", "plan", "-InputPath", input, "-OutputPath", output,
    ], { PATH: `${fakeBin};${process.env.PATH}`, BRIDGE_NODE_MARKER: marker });
    assertPowerShellSuccess(valid);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner rejects missing, corrupt, path-bound and managed-file drift before Node", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-gate-failures-"));
  try {
    const scenarios = ["missing-runtime", "corrupt-skill", "path-binding", "managed-file"];
    for (const scenario of scenarios) {
      const caseRoot = path.join(temporaryRoot, scenario);
      const skills = path.join(caseRoot, "skills");
      const runtime = path.join(caseRoot, "runtime");
      assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
      const runtimeManifestPath = path.join(runtime, "deployment-manifest.json");
      const skillManifestPath = path.join(skills, "dispatch-chatgpt-bridge", "deployment-manifest.json");
      if (scenario === "missing-runtime") rmSync(runtimeManifestPath);
      if (scenario === "corrupt-skill") writeFileSync(skillManifestPath, "{broken", "utf8");
      if (scenario === "path-binding") {
        const manifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
        manifest.targets.runtime = path.join(caseRoot, "elsewhere").toLowerCase();
        writeFileSync(runtimeManifestPath, `${JSON.stringify(canonicalize(manifest))}\n`, "utf8");
      }
      if (scenario === "managed-file") writeFileSync(
        path.join(runtime, "windows", "scripts", "chatgpt-bridge.mjs"),
        "changed-after-install",
        "utf8",
      );
      const marker = path.join(caseRoot, "node-called.txt");
      const fakeBin = makeFakeNode(caseRoot, marker);
      const input = path.join(caseRoot, "input.json");
      const output = path.join(caseRoot, "output.json");
      writeFileSync(input, "{}\n", "utf8");
      const result = runPowerShell(path.join(
        skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1",
      ), ["-Root", runtime, "-Action", "plan", "-InputPath", input, "-OutputPath", output], {
        PATH: `${fakeBin};${process.env.PATH}`,
      });
      assert.notEqual(result.status, 0, scenario);
      assert.match(result.stderr + result.stdout, /Bridge consistency gate failed before Node\/CDP/);
      assert.equal(existsSync(marker), false, scenario);
      assert.equal(existsSync(output), false, scenario);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runner and verify reject every non-normalized managed path before reading outside the deployment root", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-managed-paths-"));
  try {
    const cases = [
      { name: "parent-forward", skill: "../outside", runtime: "windows/scripts/../outside" },
      { name: "parent-backslash", skill: "..\\outside", runtime: "windows/scripts/..\\outside" },
      { name: "drive-absolute", skill: "C:\\outside\\file", runtime: "windows/scripts/C:\\outside" },
      { name: "dot-segment", skill: "nested/./file", runtime: "windows/scripts/nested/./file" },
      { name: "empty-segment", skill: "nested//file", runtime: "windows/scripts/nested//file" },
      { name: "leading-slash", skill: "/outside", runtime: "windows/scripts/outside" },
      { name: "trailing-slash", skill: "nested/file/", runtime: "windows/scripts/outside" },
      { name: "runtime-prefix", skill: "SKILL.md", runtime: "not-windows-scripts/file" },
    ];
    for (const testCase of cases) {
      const caseRoot = path.join(temporaryRoot, testCase.name);
      const skills = path.join(caseRoot, "skills");
      const runtime = path.join(caseRoot, "runtime");
      assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
      const external = path.join(caseRoot, "outside");
      writeFileSync(external, "DO_NOT_READ_EXTERNAL_CONTENT", "utf8");
      rewriteManifestPair(skills, runtime, (manifest) => {
        manifest.managedFiles.skill[0].path = testCase.skill;
        manifest.managedFiles.runtime[0].path = testCase.runtime;
      });
      const marker = path.join(caseRoot, "node-called.txt");
      const fakeBin = makeFakeNode(caseRoot, marker);
      const input = path.join(caseRoot, "input.json");
      const output = path.join(caseRoot, "output.json");
      writeFileSync(input, "{}\n", "utf8");
      const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
      const result = runPowerShell(runner, [
        "-Root", runtime, "-Action", "plan", "-InputPath", input, "-OutputPath", output,
      ], { PATH: `${fakeBin};${process.env.PATH}` });
      assert.notEqual(result.status, 0, testCase.name);
      assert.match(result.stderr + result.stdout, /Bridge consistency gate failed before Node\/CDP/);
      assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_READ_EXTERNAL_CONTENT/);
      assert.equal(existsSync(marker), false, testCase.name);
      assert.equal(existsSync(output), false, testCase.name);
      const verification = runPowerShell(verifyScript, installArgs(skills, runtime));
      assert.notEqual(verification.status, 0, testCase.name);
      assert.doesNotMatch(verification.stderr + verification.stdout, /DO_NOT_READ_EXTERNAL_CONTENT/);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("manifest rejects case-insensitive duplicate managed paths with a deterministic error", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-case-duplicate-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    rewriteManifestPair(skills, runtime, (manifest) => {
      const skillEntry = manifest.managedFiles.skill[0];
      const runtimeEntry = manifest.managedFiles.runtime[0];
      manifest.managedFiles.skill.push({ path: skillEntry.path.toUpperCase(), sha256: skillEntry.sha256 });
      manifest.managedFiles.runtime.push({ path: runtimeEntry.path.toUpperCase(), sha256: runtimeEntry.sha256 });
    });
    const result = runPowerShell(verifyScript, installArgs(skills, runtime));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /duplicate/i);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("manifest rejects weak or mistyped version, commit, schema and transaction fields", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-schema-"));
  try {
    const cases = [
      { name: "semver", mutate: (manifest) => { manifest.bridgeVersion = "v0.5"; } },
      { name: "protocol-type", mutate: (manifest) => { manifest.protocolVersion = 2; } },
      { name: "commit-status", mutate: (manifest) => { manifest.sourceCommit = "not-a-commit"; manifest.sourceCommitStatus = "exact-clean"; } },
      { name: "transaction-id", mutate: (manifest) => { manifest.transactionId = "not-a-transaction"; } },
      { name: "schema-type", mutate: (manifest) => { manifest.schemaVersion = "1"; } },
      { name: "unknown-field", mutate: (manifest) => { manifest.unexpected = "reject-me"; } },
    ];
    for (const testCase of cases) {
      const caseRoot = path.join(temporaryRoot, testCase.name);
      const skills = path.join(caseRoot, "skills");
      const runtime = path.join(caseRoot, "runtime");
      assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
      rewriteManifestPair(skills, runtime, testCase.mutate);
      const result = runPowerShell(verifyScript, installArgs(skills, runtime));
      assert.notEqual(result.status, 0, testCase.name);
      assert.match(result.stderr + result.stdout, /invalid|missing|unknown|duplicate|schema|version|commit|transaction/i, testCase.name);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("journal recovery refuses unknown state or typed corruption without deleting residue", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-journal-schema-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    mkdirSync(skills, { recursive: true });
    const id = "a".repeat(32);
    const journal = {
      schemaVersion: 1,
      transactionId: id,
      state: "unknown-state",
      journalPath: path.join(skills, `.dispatch-chatgpt-bridge-install-${id}.journal.json`),
      skillTarget: path.join(skills, "dispatch-chatgpt-bridge"),
      runtimeTarget: runtime,
      skillStage: path.join(skills, `.dispatch-chatgpt-bridge-stage-skill-${id}`),
      runtimeStage: path.join(temporaryRoot, `.dispatch-chatgpt-bridge-stage-runtime-${id}`),
      skillBackup: path.join(skills, `.dispatch-chatgpt-bridge-backup-skill-${id}`),
      runtimeBackup: path.join(temporaryRoot, `.dispatch-chatgpt-bridge-backup-runtime-${id}`),
      skillQuarantine: path.join(skills, `.dispatch-chatgpt-bridge-quarantine-skill-${id}`),
      runtimeQuarantine: path.join(temporaryRoot, `.dispatch-chatgpt-bridge-quarantine-runtime-${id}`),
      manifestHash: "0".repeat(64),
      skillOriginallyPresent: false,
      runtimeOriginallyPresent: false,
    };
    mkdirSync(journal.skillStage, { recursive: true });
    mkdirSync(journal.runtimeStage, { recursive: true });
    writeFileSync(path.join(journal.skillStage, "sentinel.txt"), "keep-me", "utf8");
    writeFileSync(path.join(journal.runtimeStage, "sentinel.txt"), "keep-me", "utf8");
    writeFileSync(journal.journalPath, `${JSON.stringify(journal)}\n`, "utf8");
    const result = runPowerShell(installScript, installArgs(skills, runtime));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /state|journal|invalid|refus/i);
    assert.equal(existsSync(journal.journalPath), true);
    assert.equal(existsSync(path.join(journal.skillStage, "sentinel.txt")), true);
    assert.equal(existsSync(path.join(journal.runtimeStage, "sentinel.txt")), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("journal recovery rejects a non-boolean originally-present field before deleting residue", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-journal-types-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    mkdirSync(skills, { recursive: true });
    const id = "b".repeat(32);
    const journalPath = path.join(skills, `.dispatch-chatgpt-bridge-install-${id}.journal.json`);
    const skillStage = path.join(skills, `.dispatch-chatgpt-bridge-stage-skill-${id}`);
    const runtimeStage = path.join(temporaryRoot, `.dispatch-chatgpt-bridge-stage-runtime-${id}`);
    const journal = {
      schemaVersion: 1,
      transactionId: id,
      state: "prepared",
      journalPath,
      skillTarget: path.join(skills, "dispatch-chatgpt-bridge"),
      runtimeTarget: runtime,
      skillStage,
      runtimeStage,
      skillBackup: path.join(skills, `.dispatch-chatgpt-bridge-backup-skill-${id}`),
      runtimeBackup: path.join(temporaryRoot, `.dispatch-chatgpt-bridge-backup-runtime-${id}`),
      skillQuarantine: path.join(skills, `.dispatch-chatgpt-bridge-quarantine-skill-${id}`),
      runtimeQuarantine: path.join(temporaryRoot, `.dispatch-chatgpt-bridge-quarantine-runtime-${id}`),
      manifestHash: "0".repeat(64),
      skillOriginallyPresent: "false",
      runtimeOriginallyPresent: false,
    };
    mkdirSync(skillStage, { recursive: true });
    mkdirSync(runtimeStage, { recursive: true });
    writeFileSync(path.join(skillStage, "sentinel.txt"), "keep-me", "utf8");
    writeFileSync(path.join(runtimeStage, "sentinel.txt"), "keep-me", "utf8");
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
    const result = runPowerShell(installScript, installArgs(skills, runtime));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /boolean|journal|invalid|refus/i);
    assert.equal(existsSync(journalPath), true);
    assert.equal(existsSync(path.join(skillStage, "sentinel.txt")), true);
    assert.equal(existsSync(path.join(runtimeStage, "sentinel.txt")), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("discover and probe remain explicit read-only diagnostics when manifests are absent", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-diagnostic-"));
  try {
    const runtime = path.join(temporaryRoot, "runtime");
    const fakeScript = path.join(runtime, "windows", "scripts", "chatgpt-bridge.mjs");
    mkdirSync(path.dirname(fakeScript), { recursive: true });
    writeFileSync(fakeScript, "console.log(JSON.stringify({ pass: true, diagnostic: true }));\n", "utf8");
    for (const action of ["discover", "probe"]) {
      const result = runPowerShell(runnerScript, ["-Root", runtime, "-Action", action]);
      assertPowerShellSuccess(result);
      assert.equal(JSON.parse(result.stdout).diagnostic, true, action);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("installer refuses reparse-point target roots before copying outside the requested root", (t) => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-reparse-install-"));
  try {
    const outside = path.join(temporaryRoot, "outside");
    const linkedSkills = path.join(temporaryRoot, "linked-skills");
    const runtime = path.join(temporaryRoot, "runtime");
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, linkedSkills, "junction");
    } catch (error) {
      t.skip(`junction creation is unavailable: ${error.code || error.message}`);
      return;
    }
    const result = runPowerShell(installScript, installArgs(linkedSkills, runtime));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /reparse point/i);
    assert.equal(existsSync(path.join(outside, "dispatch-chatgpt-bridge")), false);
    assert.equal(existsSync(path.join(runtime, "deployment-manifest.json")), false);
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

function makeDetachedReportRuntime(root, delayMs = 250) {
  const fakeScript = path.join(root, "windows", "scripts", "chatgpt-bridge.mjs");
  writeFileSync(fakeScript, [
    'import fs from "node:fs";',
    "const args = process.argv.slice(2);",
    "const command = args[0];",
    "const outputIndex = args.indexOf('--output');",
    "const output = outputIndex >= 0 ? args[outputIndex + 1] : null;",
    "const tokenIndex = args.indexOf('--bridge-launch-token');",
    "const launchId = tokenIndex >= 0 ? args[tokenIndex + 1] : null;",
    "setTimeout(() => {",
    "  if (output) fs.writeFileSync(output, JSON.stringify({ pass: true, command, launchId, jobs: [] }));",
    "  process.exit(0);",
    "}, " + String(delayMs) + ");",
    "",
  ].join("\n"), "utf8");
  return fakeScript;
}

function runDetachedRunner(runner, runtime, action, inputPath, outputPath, launchRoot, extra = []) {
  return runPowerShell(runner, [
    "-Root", runtime,
    "-Action", action,
    "-InputPath", inputPath,
    "-OutputPath", outputPath,
    "-LaunchRoot", launchRoot,
    "-Detach",
    ...extra,
  ]);
}

test("detached batch, resume and watch each receive a durable launch handle with truthful progress", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-handles-"));
  const childPids = [];
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 3000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");

    for (const action of ["batch", "resume", "watch"]) {
      const outputPath = path.join(temporaryRoot, action + ".report.json");
      const result = runDetachedRunner(
        runner,
        runtime,
        action,
        inputPath,
        outputPath,
        launchRoot,
        action === "batch" ? ["-AllowSend"] : [],
      );
      assertPowerShellSuccess(result);
      const launch = JSON.parse(result.stdout);
      childPids.push(launch.pid, launch.wrapperPid);
      assert.equal(launch.pass, true, action);
      assert.match(launch.launchId, /^[0-9a-f-]{36}$/i, action);
      assert.equal(launch.command, action);
      assert.equal(launch.state, "running");
      assert.equal(path.isAbsolute(launch.launchPath), true);
      assert.equal(path.basename(path.dirname(launch.launchPath)), launch.launchId);
      assert.equal(path.dirname(launch.stdoutPath), path.dirname(launch.launchPath));
      assert.equal(path.dirname(launch.stderrPath), path.dirname(launch.launchPath));
      assert.equal(launch.reportPath, outputPath);
      if (action === "batch") {
        assert.equal(launch.progressPath, outputPath + ".progress.json");
      } else {
        assert.equal(launch.progressPath, null);
      }
      assert.equal(existsSync(launch.launchPath), true);
      const persisted = JSON.parse(readFileSync(launch.launchPath, "utf8"));
      assert.equal(persisted.launchId, launch.launchId);
      assert.equal(persisted.launchPath, launch.launchPath);
      assert.equal(persisted.progressPath, launch.progressPath);
    }
  } finally {
    for (const pid of childPids) stopProcess(pid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("detach returns the launch handle before a long child report is written", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-nonblocking-"));
  let childPid = null;
  let wrapperPid = null;
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 8000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const startedAt = Date.now();
    const result = runDetachedRunner(runner, runtime, "batch", inputPath, outputPath, launchRoot, ["-AllowSend"]);
    const elapsedMs = Date.now() - startedAt;
    const launch = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stderr + result.stdout + "\\nworker stderr: " + (existsSync(launch.stderrPath) ? readFileSync(launch.stderrPath, "utf8") : "<missing>"));
    childPid = launch.pid;
    wrapperPid = launch.wrapperPid;
    assert.ok(elapsedMs < 6000, `detach waited for child: ${elapsedMs}ms`);
    assert.ok(getProcessIdsByCommandToken(launch.launchId).includes(launch.pid), "final Node PID is not bound to its unique launch token");
    assert.equal(existsSync(outputPath), false);
  } finally {
    stopProcess(childPid);
    stopProcess(wrapperPid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status and wait are runner-only read-only actions and survive manifest mismatch", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-status-"));
  let childPid = null;
  let wrapperPid = null;
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 3000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const launched = runDetachedRunner(runner, runtime, "batch", inputPath, outputPath, launchRoot, ["-AllowSend"]);
    assertPowerShellSuccess(launched);
    const launch = JSON.parse(launched.stdout);
    childPid = launch.pid;
    wrapperPid = launch.wrapperPid;
    const runtimeManifest = path.join(runtime, "deployment-manifest.json");
    writeFileSync(runtimeManifest, "{broken", "utf8");
    const marker = path.join(temporaryRoot, "node-called.txt");
    const fakeBin = makeFakeNode(temporaryRoot, marker);
    const status = runPowerShell(runner, [
      "-Action", "status", "-LaunchPath", launch.launchPath,
    ], { PATH: fakeBin + ";" + process.env.PATH });
    assertPowerShellSuccess(status);
    const statusValue = JSON.parse(status.stdout);
    assert.equal(statusValue.command, "batch");
    assert.equal(statusValue.launchPath, launch.launchPath);
    assert.equal(["running", "complete"].includes(statusValue.state), true);
    assert.equal(existsSync(marker), false);

    const waited = runPowerShell(runner, [
      "-Action", "wait", "-LaunchPath", launch.launchPath, "-TimeoutMs", "5000", "-PollMs", "250",
    ], { PATH: fakeBin + ";" + process.env.PATH });
    assertPowerShellSuccess(waited);
    const waitedValue = JSON.parse(waited.stdout);
    assert.equal(waitedValue.state, "complete");
    assert.equal(waitedValue.report.pass, true);
    assert.equal(existsSync(marker), false);
  } finally {
    stopProcess(childPid);
    stopProcess(wrapperPid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("launch validation fails closed for path rebound, corrupt and oversized handles", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-validation-"));
  let childPid = null;
  let wrapperPid = null;
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 2000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const launched = runDetachedRunner(runner, runtime, "batch", inputPath, outputPath, launchRoot, ["-AllowSend"]);
    assertPowerShellSuccess(launched);
    const launch = JSON.parse(launched.stdout);
    childPid = launch.pid;
    wrapperPid = launch.wrapperPid;
    const original = readFileSync(launch.launchPath, "utf8");

    const rebound = JSON.parse(original);
    rebound.stdoutPath = path.join(temporaryRoot, "outside.log");
    writeFileSync(launch.launchPath, JSON.stringify(rebound), "utf8");
    let result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", launch.launchPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /launch|path|invalid/i);
    assert.doesNotMatch(result.stderr + result.stdout, /outside.log content/i);

    writeFileSync(launch.launchPath, "{broken", "utf8");
    result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", launch.launchPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /launch|json|invalid/i);

    writeFileSync(launch.launchPath, "x".repeat(1024 * 1024 + 1), "utf8");
    result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", launch.launchPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /size|large|launch/i);
  } finally {
    stopProcess(childPid);
    stopProcess(wrapperPid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status rejects launch schema type and state combinations before Node", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-schema-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const cases = [
      { name: "schema-type", mutate: (record) => { record.schemaVersion = "1"; } },
      { name: "command-type", mutate: (record) => { record.command = 1; } },
      { name: "timeout-type", mutate: (record) => { record.timeoutMs = "600000"; } },
      { name: "pid-type", mutate: (record) => { record.pid = String(record.pid); } },
      { name: "complete-record", mutate: (record) => { record.state = "complete"; } },
      { name: "failed-without-not-created", mutate: (record) => { record.state = "failed"; } },
      { name: "not-created-starting", mutate: (record) => { record.state = "starting"; record.pid = null; record.processStartedAt = null; record.errorClass = "not-created"; } },
      { name: "unattributed-without-wrapper", mutate: (record) => { record.state = "starting"; record.pid = null; record.processStartedAt = null; record.errorClass = "created-but-unattributed"; record.wrapperPid = null; } },
    ];
    for (const testCase of cases) {
      const caseRoot = path.join(temporaryRoot, testCase.name);
      mkdirSync(caseRoot, { recursive: true });
      const fixture = writeRunningLaunchFixture(caseRoot);
      const record = { ...fixture.record };
      testCase.mutate(record);
      writeFileSync(fixture.launchPath, JSON.stringify(record), "utf8");
      const marker = path.join(caseRoot, "node-called.txt");
      const fakeBin = makeFakeNode(caseRoot, marker);
      const result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", fixture.launchPath], {
        PATH: `${fakeBin};${process.env.PATH}`,
      });
      assert.notEqual(result.status, 0, testCase.name);
      assert.match(result.stderr + result.stdout, /launch|schema|state|invalid|type/i, testCase.name);
      assert.equal(existsSync(marker), false, testCase.name);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("starting launch without a durable not-created proof is unknown after launch", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-crash-fixture-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const fixture = writeRunningLaunchFixture(temporaryRoot);
    const record = { ...fixture.record, state: "starting", pid: null, processStartedAt: null };
    writeFileSync(fixture.launchPath, JSON.stringify(record), "utf8");
    const marker = path.join(temporaryRoot, "node-called.txt");
    const fakeBin = makeFakeNode(temporaryRoot, marker);
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", fixture.launchPath], {
      PATH: `${fakeBin};${process.env.PATH}`,
    });
    assertPowerShellSuccess(result);
    const status = JSON.parse(result.stdout);
    assert.equal(status.state, "unknown-after-launch");
    assert.equal(status.reason, "launch-outcome-unknown");
    assert.equal(status.retryAllowed, false);
    assert.equal(status.recoveryRequired, true);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status rejects junction parents for existing files and missing leaves", (t) => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-reparse-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const outside = path.join(temporaryRoot, "outside");
    const junction = path.join(temporaryRoot, "junction-parent");
    mkdirSync(path.join(outside, "existing-child"), { recursive: true });
    try {
      symlinkSync(outside, junction, "junction");
    } catch (error) {
      t.skip(`junction creation is unavailable: ${error.code || error.message}`);
      return;
    }
    const fixture = writeRunningLaunchFixture(outside, "resume");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const aliasedLaunch = path.join(junction, "launches", path.basename(path.dirname(fixture.launchPath)), "launch.json");
    let result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", aliasedLaunch]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /reparse|junction|launch/i);

    const record = { ...fixture.record, reportPath: path.join(junction, "report.json") };
    writeFileSync(fixture.launchPath, JSON.stringify(record), "utf8");
    writeFileSync(record.reportPath, JSON.stringify({ pass: true, command: "resume", launchId: fixture.record.launchId }), "utf8");
    result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", fixture.launchPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /reparse|junction|report/i);

    const missingLeaf = path.join(junction, "existing-child", "missing-leaf", "launch.json");
    result = runPowerShell(runner, ["-Action", "status", "-LaunchPath", missingLeaf]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /reparse|junction|launch/i);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("detached launch keeps legacy output log paths from overwriting input", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-log-isolation-"));
  let childPid = null;
  let wrapperPid = null;
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 3000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const outputPath = path.join(temporaryRoot, "report.json");
    const inputPath = outputPath + ".stdout.log";
    const originalInput = '{"mustRemain":"intact"}\n';
    writeFileSync(inputPath, originalInput, "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const launched = runDetachedRunner(runner, runtime, "batch", inputPath, outputPath, launchRoot, ["-AllowSend"]);
    assertPowerShellSuccess(launched);
    assert.equal(readFileSync(inputPath, "utf8"), originalInput);
    const launch = JSON.parse(launched.stdout);
    childPid = launch.pid;
    wrapperPid = launch.wrapperPid;
    assert.notEqual(launch.stdoutPath, inputPath);
    assert.equal(path.dirname(launch.stdoutPath), path.dirname(launch.launchPath));
  } finally {
    stopProcess(childPid);
    stopProcess(wrapperPid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});


test("wait returns a bounded timeout without resume, resend or launch-record mutation", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-timeout-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const outputPath = path.join(temporaryRoot, "report.json");
    const launchId = crypto.randomUUID();
    const launchDirectory = path.join(launchRoot, launchId);
    const launchPath = path.join(launchDirectory, "launch.json");
    mkdirSync(launchDirectory, { recursive: true });
    const beforeRecord = {
      schemaVersion: 1,
      launchId,
      command: "batch",
      state: "running",
      pid: process.pid,
      processStartedAt: getProcessStartTime(process.pid),
      launchPath,
      reportPath: outputPath,
      progressPath: outputPath + ".progress.json",
      stdoutPath: path.join(launchDirectory, "stdout.log"),
      stderrPath: path.join(launchDirectory, "stderr.log"),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      authorization: { allowSend: true, allowDelete: false },
      inputPath: path.join(temporaryRoot, "input.json"),
      statePath: null,
      timeoutMs: 600000,
      pollMs: 5000,
      error: null,
      errorClass: null,
      wrapperPid: null,
    };
    writeFileSync(launchPath, JSON.stringify(beforeRecord), "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const waited = runPowerShell(runner, [
      "-Action", "wait", "-LaunchPath", launchPath, "-TimeoutMs", "5000", "-PollMs", "250",
    ]);
    assertPowerShellSuccess(waited);
    const result = JSON.parse(waited.stdout);
    assert.equal(result.state, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.observedState, "running");
    assert.equal(readFileSync(launchPath, "utf8"), JSON.stringify(beforeRecord));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status rejects a reused PID start time as unknown after launch", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-pid-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const fixture = writeRunningLaunchFixture(temporaryRoot);
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const rebound = JSON.parse(readFileSync(fixture.launchPath, "utf8"));
    rebound.processStartedAt = "2000-01-01T00:00:00.0000000+00:00";
    writeFileSync(fixture.launchPath, JSON.stringify(rebound), "utf8");
    const status = runPowerShell(runner, ["-Action", "status", "-LaunchPath", fixture.launchPath]);
    assertPowerShellSuccess(status);
    const result = JSON.parse(status.stdout);
    assert.equal(result.state, "unknown-after-launch");
    assert.equal(result.reason, "launch-outcome-unknown");
    assert.equal(result.retryAllowed, false);
    assert.equal(result.recoveryRequired, true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status exposes corrupt report and progress instead of treating them as absent", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-corrupt-artifacts-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");

    const reportFixture = writeRunningLaunchFixture(temporaryRoot, "resume");
    writeFileSync(reportFixture.record.reportPath, "{not-json\n", "utf8");
    const reportStatus = runPowerShell(runner, ["-Action", "status", "-LaunchPath", reportFixture.launchPath]);
    assertPowerShellSuccess(reportStatus);
    const reportResult = JSON.parse(reportStatus.stdout);
    assert.equal(reportResult.state, "failed");
    assert.equal(reportResult.reason, "report-corrupt");
    assert.equal(reportResult.reportCorrupt, true);
    assert.equal(reportResult.report.error, "report-corrupt");
    assert.doesNotMatch(reportStatus.stdout, /not-json/);

    const progressRoot = path.join(temporaryRoot, "progress-case");
    mkdirSync(progressRoot, { recursive: true });
    const progressFixture = writeRunningLaunchFixture(progressRoot, "batch");
    writeFileSync(progressFixture.record.progressPath, "{not-json\n", "utf8");
    const progressStatus = runPowerShell(runner, ["-Action", "status", "-LaunchPath", progressFixture.launchPath]);
    assertPowerShellSuccess(progressStatus);
    const progressResult = JSON.parse(progressStatus.stdout);
    assert.equal(progressResult.state, "running");
    assert.equal(progressResult.reason, "progress-corrupt");
    assert.equal(progressResult.progressCorrupt, true);
    assert.equal(progressResult.progress.error, "progress-corrupt");
    assert.doesNotMatch(progressStatus.stdout, /not-json/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status rejects rebound report and progress identities without exposing their contents", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-rebound-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const reportFixture = writeRunningLaunchFixture(temporaryRoot, "resume");
    writeFileSync(reportFixture.record.reportPath, JSON.stringify({
      pass: true,
      command: "resume",
      launchId: crypto.randomUUID(),
      secret: "DO_NOT_READ_REBOUND_REPORT",
    }), "utf8");
    const reportStatus = runPowerShell(runner, ["-Action", "status", "-LaunchPath", reportFixture.launchPath]);
    assertPowerShellSuccess(reportStatus);
    const reportResult = JSON.parse(reportStatus.stdout);
    assert.equal(reportResult.state, "failed");
    assert.equal(reportResult.reason, "report-rebound");
    assert.equal(reportResult.reportRebound, true);
    assert.doesNotMatch(reportStatus.stdout, /DO_NOT_READ_REBOUND_REPORT/);

    const progressRoot = path.join(temporaryRoot, "progress");
    mkdirSync(progressRoot, { recursive: true });
    const progressFixture = writeRunningLaunchFixture(progressRoot, "batch");
    writeFileSync(progressFixture.record.progressPath, JSON.stringify({
      command: "batch",
      launchId: crypto.randomUUID(),
      secret: "DO_NOT_READ_REBOUND_PROGRESS",
      jobs: [],
    }), "utf8");
    const progressStatus = runPowerShell(runner, ["-Action", "status", "-LaunchPath", progressFixture.launchPath]);
    assertPowerShellSuccess(progressStatus);
    const progressResult = JSON.parse(progressStatus.stdout);
    assert.equal(progressResult.state, "failed");
    assert.equal(progressResult.reason, "progress-rebound");
    assert.equal(progressResult.progressRebound, true);
    assert.doesNotMatch(progressStatus.stdout, /DO_NOT_READ_REBOUND_PROGRESS/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("unattributed launches still expose report and progress corruption explicitly", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-unattributed-artifacts-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const makeUnattributed = (root, command) => {
      const fixture = writeRunningLaunchFixture(root, command);
      const record = {
        ...fixture.record,
        state: "starting",
        pid: null,
        processStartedAt: null,
        wrapperPid: process.pid,
        errorClass: "created-but-unattributed",
      };
      writeFileSync(fixture.launchPath, JSON.stringify(record), "utf8");
      return fixture;
    };

    const corruptRoot = path.join(temporaryRoot, "report-corrupt");
    mkdirSync(corruptRoot, { recursive: true });
    const corrupt = makeUnattributed(corruptRoot, "resume");
    writeFileSync(corrupt.reportPath, "{not-json\\n", "utf8");
    const corruptResult = runPowerShell(runner, ["-Action", "status", "-LaunchPath", corrupt.launchPath]);
    assertPowerShellSuccess(corruptResult);
    const corruptStatus = JSON.parse(corruptResult.stdout);
    assert.equal(corruptStatus.reason, "report-corrupt");
    assert.equal(corruptStatus.reportCorrupt, true);
    assert.equal(corruptStatus.retryAllowed, undefined);
    assert.doesNotMatch(corruptResult.stdout, /not-json/);

    const reboundRoot = path.join(temporaryRoot, "report-rebound");
    mkdirSync(reboundRoot, { recursive: true });
    const rebound = makeUnattributed(reboundRoot, "resume");
    writeFileSync(rebound.reportPath, JSON.stringify({
      pass: true,
      command: "resume",
      launchId: crypto.randomUUID(),
      secret: "DO_NOT_READ_UNATTRIBUTED_REPORT",
    }), "utf8");
    const reboundResult = runPowerShell(runner, ["-Action", "status", "-LaunchPath", rebound.launchPath]);
    assertPowerShellSuccess(reboundResult);
    const reboundStatus = JSON.parse(reboundResult.stdout);
    assert.equal(reboundStatus.reason, "report-rebound");
    assert.equal(reboundStatus.reportRebound, true);
    assert.equal(reboundStatus.retryAllowed, undefined);
    assert.doesNotMatch(reboundResult.stdout, /DO_NOT_READ_UNATTRIBUTED_REPORT/);

    const progressRoot = path.join(temporaryRoot, "progress-rebound");
    mkdirSync(progressRoot, { recursive: true });
    const progress = makeUnattributed(progressRoot, "batch");
    writeFileSync(progress.record.progressPath, JSON.stringify({
      command: "batch",
      launchId: crypto.randomUUID(),
      secret: "DO_NOT_READ_UNATTRIBUTED_PROGRESS",
      jobs: [],
    }), "utf8");
    const progressResult = runPowerShell(runner, ["-Action", "status", "-LaunchPath", progress.launchPath]);
    assertPowerShellSuccess(progressResult);
    const progressStatus = JSON.parse(progressResult.stdout);
    assert.equal(progressStatus.reason, "progress-rebound");
    assert.equal(progressStatus.progressRebound, true);
    assert.equal(progressStatus.retryAllowed, undefined);
    assert.doesNotMatch(progressResult.stdout, /DO_NOT_READ_UNATTRIBUTED_PROGRESS/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("detached worker creation failure leaves a failed launch record under the test-only gate", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-start-fail-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 100);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const result = runPowerShell(runner, [
      "-Root", runtime,
      "-Action", "batch",
      "-InputPath", inputPath,
      "-OutputPath", outputPath,
      "-LaunchRoot", launchRoot,
      "-Detach",
      "-AllowSend",
      "-TestOnlyFailStart",
    ], { CODEX_BRIDGE_P06_TEST_MODE: "1" });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const launch = JSON.parse(result.stdout);
    assert.equal(launch.pass, false);
    assert.equal(launch.state, "failed");
    assert.equal(existsSync(launch.launchPath), true);
    const persisted = JSON.parse(readFileSync(launch.launchPath, "utf8"));
    assert.equal(persisted.state, "failed");
    assert.match(persisted.error, /Start-Process failure/i);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("created but unattributed launch is durable and cannot be treated as retryable", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-unattributed-"));
  let wrapperPid = null;
  let launchToken = null;
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 8000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    const outputPath = path.join(temporaryRoot, "report.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const result = runPowerShell(runner, [
      "-Root", runtime,
      "-Action", "batch",
      "-InputPath", inputPath,
      "-OutputPath", outputPath,
      "-LaunchRoot", launchRoot,
      "-Detach",
      "-AllowSend",
      "-TestOnlyFailAttribution",
    ], { CODEX_BRIDGE_P06_TEST_MODE: "1" });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const launch = JSON.parse(result.stdout);
    launchToken = launch.launchId;
    wrapperPid = launch.wrapperPid;
    assert.equal(launch.state, "starting");
    assert.equal(launch.errorClass, "created-but-unattributed");
    assert.equal(launch.pass, false);
    assert.equal(launch.retryAllowed, undefined);
    assert.ok(wrapperPid > 0);
    const status = runPowerShell(runner, ["-Action", "status", "-LaunchPath", launch.launchPath]);
    assertPowerShellSuccess(status);
    const observed = JSON.parse(status.stdout);
    assert.equal(observed.state, "unknown-after-launch");
    assert.equal(observed.reason, "created-but-unattributed");
    assert.equal(observed.retryAllowed, false);
    assert.equal(observed.recoveryRequired, true);
  } finally {
    if (launchToken) for (const pid of getProcessIdsByCommandToken(launchToken)) stopProcess(pid);
    stopProcess(wrapperPid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("status exposes ambiguous batch recovery facts without constructing a resend", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-recovery-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const fixture = writeRunningLaunchFixture(temporaryRoot);
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    writeFileSync(fixture.record.progressPath, JSON.stringify({
      schemaVersion: 1,
      command: "batch",
      launchId: fixture.record.launchId,
      state: "running",
      runId: "run-ambiguous",
      requestedJobs: 1,
      submittedJobs: 1,
      completedJobs: 0,
      jobs: [{
        id: "shot-1",
        status: "unknown-after-submit",
        conversationId: "local-chatgpt:11111111-1111-4111-8111-111111111111",
        expectedConversationId: "local-chatgpt:22222222-2222-4222-8222-222222222222",
        marker: "CODEX-BRIDGE-run-ambiguous-shot-1",
        historyTitle: "test title",
      }],
    }), "utf8");
    const status = runPowerShell(runner, ["-Action", "status", "-LaunchPath", fixture.launchPath]);
    assertPowerShellSuccess(status);
    const result = JSON.parse(status.stdout);
    assert.equal(result.state, "running");
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.ambiguousJobs[0].conversationId, "local-chatgpt:11111111-1111-4111-8111-111111111111");
    assert.equal(result.ambiguousJobs[0].expectedConversationId, "local-chatgpt:22222222-2222-4222-8222-222222222222");
    assert.equal(result.ambiguousJobs[0].marker, "CODEX-BRIDGE-run-ambiguous-shot-1");
    assert.equal(result.ambiguousJobs[0].historyTitle, "test title");
    assert.equal(result.ambiguousJobs[0].prompt, undefined);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("two concurrent detached launches with one output path still keep token-bound PIDs", async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-concurrent-"));
  const childPids = [];
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    const launchRoot = path.join(temporaryRoot, "launches");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 3000);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(temporaryRoot, "input.json");
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const sharedOutputPath = path.join(temporaryRoot, "shared-report.json");
    const results = await Promise.all([1, 2].map(() => runPowerShellAsync(runner, [
      "-Root", runtime,
      "-Action", "batch",
      "-InputPath", inputPath,
      "-OutputPath", sharedOutputPath,
      "-LaunchRoot", launchRoot,
      "-Detach",
      "-AllowSend",
    ])));
    for (const result of results) assertPowerShellSuccess(result);
    const launches = results.map((result) => JSON.parse(result.stdout));
    childPids.push(...launches.flatMap((launch) => [launch.pid, launch.wrapperPid]));
    assert.notEqual(launches[0].launchId, launches[1].launchId);
    assert.notEqual(launches[0].launchPath, launches[1].launchPath);
    assert.equal(path.dirname(launches[0].stdoutPath) === path.dirname(launches[1].stdoutPath), false);
    for (const launch of launches) {
      assert.ok(getProcessIdsByCommandToken(launch.launchId).includes(launch.pid));
    }
  } finally {
    for (const pid of childPids) stopProcess(pid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("detached worker preserves spaces ampersands and percent signs without cmd expansion", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-launch-quoting-"));
  let childPid = null;
  let wrapperPid = null;
  try {
    const specialRoot = path.join(temporaryRoot, "桥接 & percent %");
    const skills = path.join(specialRoot, "skills & %");
    const runtime = path.join(specialRoot, "runtime & %");
    const launchRoot = path.join(specialRoot, "launches & %");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    makeDetachedReportRuntime(runtime, 1200);
    refreshDeployedRuntimeEntry(skills, runtime);
    const inputPath = path.join(specialRoot, "input & percent %.json");
    const outputPath = path.join(specialRoot, "report & percent %.json");
    mkdirSync(specialRoot, { recursive: true });
    writeFileSync(inputPath, "{}\n", "utf8");
    const runner = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "run-bridge.ps1");
    const launched = runDetachedRunner(runner, runtime, "batch", inputPath, outputPath, launchRoot, ["-AllowSend"]);
    assertPowerShellSuccess(launched);
    const launch = JSON.parse(launched.stdout);
    childPid = launch.pid;
    wrapperPid = launch.wrapperPid;
    const waited = runPowerShell(runner, [
      "-Action", "wait", "-LaunchPath", launch.launchPath, "-TimeoutMs", "15000", "-PollMs", "250",
    ]);
    assertPowerShellSuccess(waited);
    const status = JSON.parse(waited.stdout);
    assert.equal(status.state, "complete");
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).launchId, launch.launchId);
  } finally {
    stopProcess(childPid);
    stopProcess(wrapperPid);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("detached worker rejects unknown config fields before starting Node", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-worker-schema-"));
  try {
    const skills = path.join(temporaryRoot, "skills");
    const runtime = path.join(temporaryRoot, "runtime");
    assertPowerShellSuccess(runPowerShell(installScript, installArgs(skills, runtime)));
    const worker = path.join(skills, "dispatch-chatgpt-bridge", "scripts", "detached-node-worker.ps1");
    const configPath = path.join(temporaryRoot, "worker-config.json");
    const handshakePath = path.join(temporaryRoot, "handshake.json");
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      launchId: "11111111-1111-4111-8111-111111111111",
      nodePath: process.execPath,
      arguments: [],
      stdoutPath: path.join(temporaryRoot, "stdout.log"),
      stderrPath: path.join(temporaryRoot, "stderr.log"),
      handshakePath,
      workerStartedPath: path.join(temporaryRoot, "worker-started.json"),
      workerStdoutPath: path.join(temporaryRoot, "worker-stdout.log"),
      workerStderrPath: path.join(temporaryRoot, "worker-stderr.log"),
      unknown: "reject-me",
    }), "utf8");
    const result = runPowerShell(worker, ["-ConfigPath", configPath, "-Execute"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /unknown|config|invalid/i);
    assert.equal(existsSync(handshakePath), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows CRT quoting preserves trailing backslashes and embedded quotes", () => {
  const launchControl = path.join(repositoryRoot, "skills", "dispatch-chatgpt-bridge", "scripts", "launch-control.ps1");
  const workerLibrary = path.join(repositoryRoot, "skills", "dispatch-chatgpt-bridge", "scripts", "detached-node-worker-library.ps1");
  const command = [
    `. '${launchControl.replaceAll("'", "''")}'`,
    `$one = ConvertTo-WindowsProcessArgument -Value 'C:\\quoted path\\'`,
    `$two = ConvertTo-WindowsProcessArgument -Value ('C:\\quoted path\\' + [char]34 + 'tail')`,
    `. '${workerLibrary.replaceAll("'", "''")}'`,
    `$three = ConvertTo-WindowsProcessArgument -Value 'C:\\quoted path\\'`,
    `$four = ConvertTo-WindowsProcessArgument -Value ('C:\\quoted path\\' + [char]34 + 'tail')`,
    "Write-Output $one; Write-Output $two; Write-Output $three; Write-Output $four",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/);
  const trailing = ['"', "C:", "\\", "quoted path", "\\", "\\", '"'].join("");
  const embedded = ['"', "C:", "\\", "quoted path", "\\", "\\", "\\", '"', "tail", '"'].join("");
  assert.deepEqual(lines, [trailing, embedded, trailing, embedded]);
});
