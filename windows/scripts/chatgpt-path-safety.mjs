import fs from "node:fs/promises";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function requireWindowsAbsolute(value, label = "path") {
  if (typeof value !== "string" || value.includes("\0")) {
    fail(`${label} must be an absolute Windows path`);
  }
  const normalized = path.win32.normalize(value);
  if (!path.win32.isAbsolute(normalized) || !/^(?:[A-Za-z]:\\|\\\\)/u.test(normalized)) {
    fail(`${label} must be an absolute Windows path`);
  }
  return normalized;
}

function lexicalIdentity(value, label) {
  return requireWindowsAbsolute(value, label).toLowerCase();
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function realpathApi(fsApi) {
  return typeof fsApi.realpath?.native === "function" ? fsApi.realpath.native.bind(fsApi.realpath) : fsApi.realpath.bind(fsApi);
}

function physicalIdentity(stats, label) {
  if (typeof stats.dev !== "bigint" || typeof stats.ino !== "bigint" ||
      (stats.dev === 0n && stats.ino === 0n)) {
    fail(`${label} has no trustworthy physical file identity`);
  }
  return `${stats.dev.toString(16)}:${stats.ino.toString(16)}`;
}

async function findExistingAncestor(lexicalPath, fsApi) {
  const missing = [];
  let candidate = lexicalPath;
  while (true) {
    try {
      const lstat = await fsApi.lstat(candidate);
      return { candidate, lstat, missing };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.win32.dirname(candidate);
      if (parent === candidate) fail(`no existing ancestor for ${lexicalPath}`);
      missing.push(path.win32.basename(candidate));
      candidate = parent;
    }
  }
}

export async function inspectPathIdentity(value, {
  label = "path",
  allowMissing = true,
  fsApi = fs,
} = {}) {
  const lexicalPath = requireWindowsAbsolute(value, label);
  const lexical = lexicalPath.toLowerCase();
  let existing;
  try {
    existing = await fsApi.lstat(lexicalPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!allowMissing) fail(`${label} does not exist: ${lexicalPath}`);
  }

  if (existing) {
    const canonicalPath = await realpathApi(fsApi)(lexicalPath);
    const canonical = path.win32.normalize(canonicalPath).toLowerCase();
    const stats = await fsApi.stat(lexicalPath, { bigint: true });
    return Object.freeze({
      label,
      path: lexicalPath,
      lexical,
      canonical,
      physical: physicalIdentity(stats, label),
      exists: true,
      reparsePoint: existing.isSymbolicLink(),
      alias: canonical !== lexical,
    });
  }

  const ancestor = await findExistingAncestor(lexicalPath, fsApi);
  const canonicalAncestor = path.win32.normalize(await realpathApi(fsApi)(ancestor.candidate));
  const canonicalPath = ancestor.missing.reduceRight(
    (current, segment) => path.win32.join(current, segment),
    canonicalAncestor,
  );
  return Object.freeze({
    label,
    path: lexicalPath,
    lexical,
    canonical: canonicalPath.toLowerCase(),
    physical: null,
    exists: false,
    reparsePoint: ancestor.lstat.isSymbolicLink(),
    alias: canonicalPath.toLowerCase() !== lexical,
    nearestExistingAncestor: path.win32.normalize(ancestor.candidate).toLowerCase(),
  });
}

function collisionKind(left, right) {
  const kinds = [];
  if (left.lexical === right.lexical) kinds.push("lexical");
  if (left.canonical === right.canonical) kinds.push("canonical");
  if (left.physical && right.physical && left.physical === right.physical) kinds.push("physical");
  return kinds;
}

export async function auditPathSet(entries, { fsApi = fs } = {}) {
  if (!Array.isArray(entries)) fail("path audit entries must be an array");
  const normalizedEntries = entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof entry.role !== "string" ||
        !entry.role.trim() || typeof entry.path !== "string") {
      fail(`path audit entry ${index} is invalid`);
    }
    return { role: entry.role.trim(), path: entry.path, allowMissing: entry.allowMissing !== false };
  });
  const identities = [];
  for (const entry of normalizedEntries) {
    identities.push(await inspectPathIdentity(entry.path, {
      label: entry.role,
      allowMissing: entry.allowMissing,
      fsApi,
    }));
  }
  const collisions = [];
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const kinds = collisionKind(identities[leftIndex], identities[rightIndex]);
      if (kinds.length) {
        collisions.push({
          left: identities[leftIndex].label,
          right: identities[rightIndex].label,
          kinds,
        });
      }
    }
  }
  if (collisions.length) {
    const details = collisions.map((collision) =>
      `${collision.left} <-> ${collision.right} (${collision.kinds.join(", ")})`).join("; ");
    const error = new Error(`path identity collision: ${details}`);
    error.code = "EPATHCOLLISION";
    error.collisions = collisions;
    throw error;
  }
  return Object.freeze({
    entries: Object.freeze(identities),
    collisions: Object.freeze([]),
  });
}
