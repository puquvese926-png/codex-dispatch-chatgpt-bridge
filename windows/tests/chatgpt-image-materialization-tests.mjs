import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as bridgeRuntime from "../scripts/chatgpt-bridge.mjs";
import {
  IMAGE_LIMITS,
  inspectImageBytes,
  parseStrictImageDataUrl,
} from "../scripts/chatgpt-image-materialization.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const APP_BLOB = "blob:app://-/4d5ed762-c249-4e31-9d57-3c12e4596c06";

function jpegBytes(width = 1, height = 1) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    0xff, 0xda, 0, 8, 3, 1, 0, 2, 0x11, 3, 0x11, 0,
    0xff, 0xd9,
  ]);
}

function webpBytes(width = 1, height = 1) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-image-p0-"));
}

test("strict PNG/JPEG/WebP fixtures materialize with header dimensions and safe extensions", async () => {
  const root = await makeTempRoot();
  const output = path.join(root, "report.json");
  const jpeg = jpegBytes();
  const webp = webpBytes();
  try {
    const artifacts = await bridgeRuntime.materializeJobImages({
      id: "valid-formats",
      result: { images: [
        { src: `data:image/png;base64,${PNG_1X1}`, width: 999, height: 999, alt: "png" },
        { src: dataUrl("image/jpeg", jpeg), width: 999, height: 999, alt: "jpeg" },
        { src: dataUrl("image/webp", webp), width: 999, height: 999, alt: "webp" },
      ] },
    }, output);
    assert.deepEqual(artifacts.map((item) => [item.status, item.contentType, item.width, item.height]), [
      ["downloaded", "image/png", 1, 1],
      ["downloaded", "image/jpeg", 1, 1],
      ["downloaded", "image/webp", 1, 1],
    ]);
    assert.deepEqual((await fs.readdir(path.join(root, "report.assets", "valid-formats"))).sort(), [
      "image-1.png", "image-2.jpg", "image-3.webp",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote HTTP(S), loopback, metadata and blob:https sources never fetch or create files", async () => {
  const root = await makeTempRoot();
  const output = path.join(root, "remote-report.json");
  const sources = [
    "https://files.example.invalid/image.png",
    "http://127.0.0.1:9/private",
    "https://localhost/admin",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/private",
    "https://example.invalid/redirect?to=http%3A%2F%2F127.0.0.1%2F",
    "blob:https://example.invalid/renderer-id",
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network trap fired");
  };
  try {
    const artifacts = await bridgeRuntime.materializeJobImages({
      id: "remote-only",
      result: { images: sources.map((src, index) => ({ src, width: 100 + index, height: 200, alt: `remote-${index}` })) },
    }, output);
    assert.equal(fetchCalls, 0);
    assert.equal(artifacts.length, sources.length);
    assert.ok(artifacts.every((item) => item.status === "metadata-only" && item.sourceType === "remote-image"));
    assert.equal(artifacts.at(-1).width, 106);
    assert.equal(artifacts.at(-1).height, 200);
    assert.equal(await fs.stat(path.join(root, "remote-report.assets")).then(() => true).catch(() => false), false);
    assert.equal(JSON.stringify(artifacts).includes("example.invalid"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("long or non-canonical base64 is rejected before Buffer decoding", () => {
  const originalFrom = Buffer.from;
  let called = false;
  Buffer.from = (...args) => {
    called = true;
    return originalFrom(...args);
  };
  try {
    const oversized = `data:image/png;base64,${"A".repeat(IMAGE_LIMITS.maxBase64Length + 4)}`;
    assert.throws(() => parseStrictImageDataUrl(oversized), /length|size|limit/i);
    assert.equal(called, false);
  } finally {
    Buffer.from = originalFrom;
  }
  assert.throws(() => parseStrictImageDataUrl("data:image/png;base64,AAA"), /base64|length/i);
  assert.throws(() => parseStrictImageDataUrl("data:image/png;base64,AAAA="), /base64|length|encoding/i);
  assert.throws(() => parseStrictImageDataUrl("data:image/png;base64,AA?="), /base64|character/i);
  assert.throws(() => parseStrictImageDataUrl("data:image/png,%89PNG"), /data URL|encoding|MIME/i);
  assert.throws(() => parseStrictImageDataUrl(`data:image/gif;base64,${PNG_1X1}`), /data URL|MIME/i);
  assert.throws(() => parseStrictImageDataUrl(`data:image/svg+xml;base64,${PNG_1X1}`), /data URL|MIME/i);
});

test("magic, MIME, malformed headers and pixel limits fail closed", () => {
  const pngBytes = Buffer.from(PNG_1X1, "base64");
  const jpeg = jpegBytes();
  const webp = webpBytes();
  assert.throws(() => inspectImageBytes("image/jpeg", pngBytes), /JPEG|magic|invalid/i);
  assert.throws(() => inspectImageBytes("image/webp", jpeg), /WebP|RIFF|invalid/i);
  assert.throws(() => inspectImageBytes("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 2, 0xff, 0xd9])), /JPEG|truncated|invalid/i);
  assert.throws(() => inspectImageBytes("image/webp", Buffer.from("524946460000000057454250565038580a000000", "hex")), /WebP|truncated|invalid/i);
  assert.throws(() => inspectImageBytes("image/webp", webpBytes(20_000, 1)), /dimensions|limits/i);
  assert.throws(() => inspectImageBytes("image/webp", webpBytes(10_000, 5_000)), /dimensions|limits/i);
  assert.throws(() => inspectImageBytes("image/png", Buffer.alloc(IMAGE_LIMITS.maxBytes + 1)), /size|limits/i);
});

test("image persistence path contains no URL fetch or redirect fallback", () => {
  const source = readFileSync(new URL("../scripts/chatgpt-bridge.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function materializeJobImages");
  const end = source.indexOf("async function readLifecycleLedgerOrEmpty", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /\bfetch\s*\(|\bredirect\s*:/u);
});

test("blob materialization validates every chunk and never accepts remote blob URLs", async () => {
  const data = `data:image/png;base64,${PNG_1X1}`;
  let call = 0;
  const validSession = {
    async evaluate() {
      const offset = call === 0 ? 0 : data.length - 5;
      const chunk = data.slice(offset);
      call += 1;
      return { chunk, offset, nextOffset: data.length, total: data.length, done: true };
    },
  };
  const valid = await bridgeRuntime.materializeRenderedImages(validSession, [{ src: APP_BLOB }]);
  assert.equal(valid[0].src, data);

  const invalidCases = [
    { chunk: "A".repeat(1024 * 1024 + 1), offset: 0, nextOffset: 1024 * 1024 + 1, total: data.length, done: false },
    { chunk: data.slice(0, 5), offset: 1, nextOffset: 6, total: data.length, done: false },
    { chunk: data.slice(0, 5), offset: 0, nextOffset: 5, total: data.length + 1, done: true },
  ];
  for (const part of invalidCases) {
    await assert.rejects(
      bridgeRuntime.materializeRenderedImages({ evaluate: async () => part }, [{ src: APP_BLOB }]),
      /chunk|incomplete|invalid/i,
    );
  }
  let changingTotalCall = 0;
  await assert.rejects(
    bridgeRuntime.materializeRenderedImages({ evaluate: async () => {
      changingTotalCall += 1;
      return changingTotalCall === 1 ?
        { chunk: data.slice(0, 5), offset: 0, nextOffset: 5, total: data.length, done: false } :
        { chunk: data.slice(5), offset: 5, nextOffset: data.length, total: data.length + 1, done: true };
    } }, [{ src: APP_BLOB }]),
    /chunk|invalid/i,
  );
  await assert.doesNotReject(bridgeRuntime.materializeRenderedImages({
    evaluate: async () => { throw new Error("remote blob must not be evaluated"); },
  }, [{ src: "blob:https://example.invalid/id" }]));
});

test("materialization and normalization assign provenance without preserving signed URLs", async () => {
  const remote = bridgeRuntime.normalizeCollectedResult({
    conversationId: "local-chatgpt:50b66343-af73-4c20-96e1-63b4a7565329",
    url: "app://-/chat/local-chatgpt:50b66343-af73-4c20-96e1-63b4a7565329",
    assistantText: "done",
    images: [{
      src: "https://signed.example.invalid/image?token=secret",
      width: 1200,
      height: 800,
      alt: "remote",
      sourceType: "materialized-app-blob",
    }],
  });
  const summary = bridgeRuntime.summarizeCollectedImages(remote.images);
  assert.deepEqual(summary, [{
    sourceType: "remote-image",
    materializationStatus: "metadata-only",
    width: 1200,
    height: 800,
    alt: "remote",
  }]);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});
