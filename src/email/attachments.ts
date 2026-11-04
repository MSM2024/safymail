export interface OutboundAttachment {
  filename: string;
  contentType: string;
  base64: string;
  bytes: Uint8Array;
  size: number;
  hash: string;
}

const ALLOWED_ATTACHMENT_TYPES: Record<string, { mime: string[]; signature: (bytes: Uint8Array) => boolean }> = {
  pdf: { mime: ["application/pdf"], signature: bytes => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  docx: {
    mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    signature: bytes => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && containsAscii(bytes, "word/document.xml")
  },
  jpg: { mime: ["image/jpeg", "image/pjpeg"], signature: bytes => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: ["image/jpeg", "image/pjpeg"], signature: bytes => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  png: { mime: ["image/png"], signature: bytes => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  gif: { mime: ["image/gif"], signature: bytes => startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) },
  webp: { mime: ["image/webp"], signature: bytes => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && startsWith(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50]) }
};

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  let index = bytes.indexOf(needle[0]);
  while (index !== -1 && index <= bytes.length - needle.length) {
    let matches = true;
    for (let offset = 1; offset < needle.length; offset++) {
      if (bytes[index + offset] !== needle[offset]) { matches = false; break; }
    }
    if (matches) return true;
    index = bytes.indexOf(needle[0], index + 1);
  }
  return false;
}

export function isAllowedAttachment(filename: string, contentType: string, content: ArrayBuffer | Uint8Array): boolean {
  const extension = filename.trim().toLowerCase().split(".").pop() || "";
  const definition = ALLOWED_ATTACHMENT_TYPES[extension];
  if (!definition) return false;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (!definition.mime.includes(mime)) return false;
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return definition.signature(bytes);
}

export async function parseOutboundAttachments(value: unknown): Promise<OutboundAttachment[] | null> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 5) return null;
  const result: OutboundAttachment[] = [];
  let totalBytes = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as { filename?: unknown; content_type?: unknown; content_base64?: unknown };
    if (typeof item.filename !== "string" || typeof item.content_type !== "string" || typeof item.content_base64 !== "string") return null;
    const filename = Array.from(item.filename.trim())
      .map(char => char === "/" || char === "\\" || char.charCodeAt(0) < 32 ? "_" : char)
      .join("").slice(0, 180);
    const contentType = item.content_type.trim().toLowerCase();
    const base64 = item.content_base64;
    if (!filename || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType) || contentType.length > 120 ||
        !base64 || base64.length > 7 * 1024 * 1024 || base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); }
    catch { return null; }
    if (!bytes.length || bytes.byteLength > 5 * 1024 * 1024 ||
        !isAllowedAttachment(filename, contentType, bytes)) return null;
    totalBytes += bytes.byteLength;
    if (totalBytes > 10 * 1024 * 1024) return null;
    const hashBuffer = new Uint8Array(bytes.byteLength);
    hashBuffer.set(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", hashBuffer.buffer));
    const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    result.push({ filename, contentType, base64, bytes, size: bytes.byteLength, hash });
  }
  return result;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
