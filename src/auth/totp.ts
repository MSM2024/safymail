const encoder = new TextEncoder();
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
}
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0, value = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function decodeBase32(input: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/g, "").replace(/\s/g, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid_totp_secret");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
export async function encryptTotpSecret(secret: string, configuredKey: string | undefined): Promise<string> {
  if (!configuredKey) throw new Error("totp_encryption_key_missing");
  let raw: Uint8Array;
  try { raw = fromBase64Url(configuredKey); } catch { throw new Error("totp_encryption_key_invalid"); }
  if (raw.length !== 32) throw new Error("totp_encryption_key_invalid");
  const key = await crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(iv) }, key, encoder.encode(secret));
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv); packed.set(new Uint8Array(ciphertext), iv.length);
  return base64Url(packed);
}
export async function decryptTotpSecret(value: string, configuredKey: string | undefined): Promise<string> {
  if (!configuredKey) throw new Error("totp_encryption_key_missing");
  const raw = fromBase64Url(configuredKey);
  if (raw.length !== 32) throw new Error("totp_encryption_key_invalid");
  const packed = fromBase64Url(value);
  if (packed.length < 29) throw new Error("invalid_totp_ciphertext");
  const key = await crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asArrayBuffer(packed.slice(0, 12)) }, key, asArrayBuffer(packed.slice(12)));
  return new TextDecoder().decode(clear);
}
export function generateTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
}
export function generateBackupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  });
}
export async function hashBackupCode(code: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code.replace(/[-\s]/g, "").toUpperCase())));
  return base64Url(bytes);
}
export async function matchTotpCounter(secret: string, supplied: string, now = Date.now(), lastAcceptedCounter = -1): Promise<number | null> {
  if (!/^\d{6}$/.test(supplied)) return null;
  const key = await crypto.subtle.importKey("raw", asArrayBuffer(decodeBase32(secret)), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = Math.floor(now / 30000);
  for (let offset = -1; offset <= 1; offset++) {
    const value = counter + offset;
    if (value <= lastAcceptedCounter) continue;
    const msg = new Uint8Array(8);
    let n = value;
    for (let i = 7; i >= 0; i--) { msg[i] = n & 255; n = Math.floor(n / 256); }
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, asArrayBuffer(msg)));
    const index = mac[mac.length - 1] & 15;
    const binary = ((mac[index] & 127) << 24) | ((mac[index + 1] & 255) << 16) | ((mac[index + 2] & 255) << 8) | (mac[index + 3] & 255);
    const expected = String(binary % 1000000).padStart(6, "0");
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
    if (diff === 0) return value;
  }
  return null;
}
export async function verifyTotp(secret: string, supplied: string, now = Date.now()): Promise<boolean> {
  return (await matchTotpCounter(secret, supplied, now)) !== null;
}

export function createOtpAuthUri(secret: string, email: string): string {
  const label = encodeURIComponent("Europe Mail Center:" + email);
  return "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" + encodeURIComponent("Europe Mail Center") + "&algorithm=SHA1&digits=6&period=30";
}
