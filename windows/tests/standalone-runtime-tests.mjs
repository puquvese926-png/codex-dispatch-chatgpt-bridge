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

function assertPowerShellSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
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
    .update(JSON.stringify(canonicalize(withoutHash)), "utf8")
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
