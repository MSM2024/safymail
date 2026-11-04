import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedAttachment, parseOutboundAttachments } from "./attachments";

const pdf = btoa("%PDF-1.7\\nsample attachment");

test("validates, sanitizes and hashes an allowed outbound PDF", async () => {
  const parsed = await parseOutboundAttachments([{
    filename: "..\\\\report.pdf",
    content_type: "application/pdf",
    content_base64: pdf
  }]);
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0].filename.includes("/"), false);
  assert.equal(parsed?.[0].size, atob(pdf).length);
  assert.match(parsed?.[0].hash || "", /^[a-f0-9]{64}$/);
});

test("accepts supported formats only when extension, MIME and file signature agree", () => {
  assert.equal(isAllowedAttachment("report.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7")), true);
  assert.equal(isAllowedAttachment("photo.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0x00])), true);
  assert.equal(isAllowedAttachment("photo.png", "image/png", new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), true);
  assert.equal(isAllowedAttachment("scan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Uint8Array([0x50,0x4b,0x03,0x04,...new TextEncoder().encode("word/document.xml")])), true);
  assert.equal(isAllowedAttachment("animation.gif", "image/gif", new TextEncoder().encode("GIF89a")), true);
  assert.equal(isAllowedAttachment("graphic.webp", "image/webp", new Uint8Array([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50])), true);
  assert.equal(isAllowedAttachment("image.svg", "image/svg+xml", new TextEncoder().encode("<svg/>")), false);
  assert.equal(isAllowedAttachment("report.pdf", "text/plain", new TextEncoder().encode("%PDF-1.7")), false);
  assert.equal(isAllowedAttachment("report.pdf", "application/pdf", new TextEncoder().encode("not a PDF")), false);
  assert.equal(isAllowedAttachment("photo.jpg", "image/png", new Uint8Array([0xff,0xd8,0xff])), false);
});

test("rejects malformed, unsupported and excessive outbound attachments", async () => {
  assert.equal(await parseOutboundAttachments([{ filename: "x.txt", content_type: "text/plain", content_base64: btoa("plain text") }]), null);
  assert.equal(await parseOutboundAttachments([{ filename: "x.pdf", content_type: "application/pdf", content_base64: btoa("not a pdf") }]), null);
  assert.equal(await parseOutboundAttachments([{ filename: "x.pdf", content_type: "application/pdf", content_base64: "not base64!" }]), null);
  assert.equal(await parseOutboundAttachments(Array.from({ length: 6 }, () => ({ filename: "x.pdf", content_type: "application/pdf", content_base64: pdf }))), null);
});
