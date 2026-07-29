const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_COUNT = 20;
const MAX_AGGREGATE_IMAGE_BYTES = 120 * 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const MAX_AGGREGATE_DATA_URL_LENGTH = 4 * Math.ceil(MAX_AGGREGATE_IMAGE_BYTES / 3) + MAX_IMAGE_COUNT * 32;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: MAX_IMAGE_BYTES,
  maxPixels: MAX_IMAGE_PIXELS,
  maxDimension: MAX_IMAGE_DIMENSION,
  maxImages: MAX_IMAGE_COUNT,
  maxAggregateBytes: MAX_AGGREGATE_IMAGE_BYTES,
  maxBase64Length: MAX_BASE64_LENGTH,
  maxAggregateDataUrlLength: MAX_AGGREGATE_DATA_URL_LENGTH,
});

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/u;

function fail(message) {
  throw new Error(message);
}

function validDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    fail("image dimensions exceed the safety limits");
  }
  return { width, height };
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc >>> 0;
});

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function equalBytes(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function pngDimensions(bytes) {
  if (bytes.length < 33 || !equalBytes(bytes, PNG_SIGNATURE)) fail("PNG magic or length is invalid");
  let offset = 8;
  let dimensions = null;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + 4;
    if (length > MAX_IMAGE_BYTES || chunkEnd > bytes.length) fail("PNG chunk is truncated");
    const type = String.fromCharCode(...bytes.slice(typeStart, typeStart + 4));
    const storedCrc = new DataView(bytes.buffer, bytes.byteOffset + dataStart + length, 4).getUint32(0);
    if (crc32(bytes, typeStart, dataStart + length) !== storedCrc) fail("PNG chunk checksum is invalid");
    if (offset === 8 && (type !== "IHDR" || length !== 13)) fail("PNG IHDR is invalid");
    if (type === "IHDR") {
      if (dimensions) fail("PNG has multiple IHDR chunks");
      const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, 13);
      dimensions = validDimensions(view.getUint32(0), view.getUint32(4));
    }
    if (type === "IDAT") sawImageData = true;
    offset = chunkEnd;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) fail("PNG IEND or trailing data is invalid");
      sawEnd = true;
      break;
    }
  }
  if (!dimensions || !sawImageData || !sawEnd) fail("PNG is incomplete");
  return dimensions;
}

function isJpegSof(marker) {
  return (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail("JPEG magic or length is invalid");
  let offset = 2;
  let dimensions = null;
  let frameComponentIds = null;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail("JPEG marker is invalid");
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail("JPEG marker is truncated");
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      fail("JPEG marker sequence is invalid");
    }
    if (offset + 2 > bytes.length) fail("JPEG segment length is truncated");
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) fail("JPEG segment is truncated");
    if (isJpegSof(marker)) {
      if (segmentLength < 11 || dimensions) fail("JPEG frame header is invalid");
      const precision = bytes[offset + 2];
      const componentCount = bytes[offset + 7];
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 8 + 3 * componentCount) {
        fail("JPEG frame component structure is invalid");
      }
      frameComponentIds = new Set();
      for (let index = 0; index < componentCount; index += 1) {
        const componentId = bytes[offset + 8 + 3 * index];
        if (frameComponentIds.has(componentId)) fail("JPEG frame component IDs are invalid");
        frameComponentIds.add(componentId);
      }
      if (precision < 1) fail("JPEG precision is invalid");
      dimensions = validDimensions(
        (bytes[offset + 5] << 8) | bytes[offset + 6],
        (bytes[offset + 3] << 8) | bytes[offset + 4],
      );
    }
    if (marker === 0xda) {
      const componentCount = bytes[offset + 2];
      if (!frameComponentIds || componentCount < 1 || componentCount > 4 ||
          segmentLength !== 6 + 2 * componentCount) {
        fail("JPEG scan component structure is invalid");
      }
      for (let index = 0; index < componentCount; index += 1) {
        if (!frameComponentIds.has(bytes[offset + 3 + 2 * index])) {
          fail("JPEG scan component ID is invalid");
        }
      }
      sawScan = true;
      offset += segmentLength;
      break;
    }
    offset += segmentLength;
  }
  if (!dimensions || !sawScan || bytes.length < 2 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    fail("JPEG is incomplete or has no frame dimensions");
  }
  return dimensions;
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes) {
  if (bytes.length < 20 || !equalBytes(bytes, [0x52, 0x49, 0x46, 0x46]) ||
      !equalBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    fail("WebP RIFF magic or length is invalid");
  }
  const riffSize = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  if (riffSize !== bytes.length - 8) fail("WebP RIFF is truncated or has trailing data");
  let offset = 12;
  let canvasDimensions = null;
  let payloadDimensions = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail("WebP chunk header is truncated");
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const paddedSize = size + (size & 1);
    const dataStart = offset + 8;
    const chunkEnd = dataStart + paddedSize;
    if (size < 1 || chunkEnd > bytes.length) fail("WebP chunk is truncated");
    if (type === "ANIM" || type === "ANMF") {
      fail("animated WebP is unsupported");
    }
    if (type === "VP8 ") {
      if (size < 11 || bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
        fail("WebP VP8 frame header is invalid");
      }
      payloadDimensions = validDimensions(
        new DataView(bytes.buffer, bytes.byteOffset + dataStart + 6, 2).getUint16(0, true) & 0x3fff,
        new DataView(bytes.buffer, bytes.byteOffset + dataStart + 8, 2).getUint16(0, true) & 0x3fff,
      );
    } else if (type === "VP8L") {
      if (size < 6 || bytes[dataStart] !== 0x2f) fail("WebP VP8L frame header is invalid");
      const width = 1 + (bytes[dataStart + 1] | ((bytes[dataStart + 2] & 0x3f) << 8));
      const height = 1 + ((bytes[dataStart + 2] >> 6) | (bytes[dataStart + 3] << 2) |
        ((bytes[dataStart + 4] & 0x0f) << 10));
      payloadDimensions = validDimensions(width, height);
    } else if (type === "VP8X") {
      if (size < 10) fail("WebP VP8X frame header is invalid");
      canvasDimensions = validDimensions(
        1 + readUint24LE(bytes, dataStart + 4),
        1 + readUint24LE(bytes, dataStart + 7),
      );
    }
    offset = chunkEnd;
  }
  if (!payloadDimensions) fail("WebP has no supported image payload");
  return canvasDimensions || payloadDimensions;
}

export function inspectImageBytes(mime, input) {
  if (!/^image\/(?:png|jpeg|webp)$/u.test(mime) || !input || !Number.isInteger(input.length)) {
    fail("image MIME or bytes are invalid");
  }
  if (input.length < 1 || input.length > MAX_IMAGE_BYTES) fail("image byte size exceeds the safety limits");
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const dimensions = mime === "image/png" ? pngDimensions(bytes) :
    mime === "image/jpeg" ? jpegDimensions(bytes) : webpDimensions(bytes);
  return Object.freeze({ mime, bytes, ...dimensions });
}

export function parseStrictImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") fail("image data URL is invalid");
  const match = DATA_URL.exec(dataUrl);
  if (!match) fail("image data URL MIME, encoding or characters are invalid");
  const encoded = match[2];
  if (!encoded || encoded.length > MAX_BASE64_LENGTH || encoded.length % 4 !== 0) {
    fail("image base64 length exceeds the safety limits");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength < 1 || decodedLength > MAX_IMAGE_BYTES) fail("decoded image size exceeds the safety limits");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== decodedLength || bytes.toString("base64") !== encoded) {
    fail("image base64 padding or encoding is invalid");
  }
  return Object.freeze({ ...inspectImageBytes(match[1], bytes), dataUrl });
}

export function isStrictAppBlobSource(source) {
  return typeof source === "string" && /^blob:app:\/\/-\/[A-Za-z0-9._-]{1,200}$/u.test(source);
}

export function isMetadataOnlyImageSource(source) {
  if (typeof source !== "string") return false;
  if (/^https?:\/\//iu.test(source)) return true;
  return /^blob:https?:\/\//iu.test(source);
}
