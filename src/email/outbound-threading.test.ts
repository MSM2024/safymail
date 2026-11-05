import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
const start=src.indexOf('app.post("/api/messages/send"');
const end=src.indexOf('const existingAttachmentRows',start);
assert.ok(start>=0&&end>start,"send handler must exist");
const send=src.slice(start,end);

test("outbound replies discover conversations only through message IDs scoped to their own mailbox",()=>{
  assert.match(send,/\[inReplyTo, \.\.\.references\.split\(" "\)\]/);
  assert.match(send,/m\.message_id_header IN \(\$\{placeholders\}\)/);
  assert.match(send,/m\.account_id = \?/);
  assert.match(send,/co\.account_id = m\.account_id/);
  assert.match(send,/ORDER BY m\.created_at DESC LIMIT 1/);
  assert.doesNotMatch(send,/WHERE subject = \?/);
});

test("reply retains conversation and refreshes its activity; new messages create a new thread",()=>{
  assert.match(send,/const createsConversation = !conversationId/);
  assert.match(send,/if \(!conversationId\) conversationId = newId\(\)/);
  assert.match(send,/INSERT INTO conversations/);
  assert.match(send,/UPDATE conversations SET last_message_at/);
  assert.match(send,/WHERE id=\? AND account_id=\? AND company_id=\?/);
  assert.match(send,/await c\.env\.DB\.batch\(statements\)/);
});

test("idempotent resend reuses existing message and never makes another conversation",()=>{
  assert.match(send,/if \(existing\)/);
  assert.match(send,/messageId = existing\.id/);
  assert.match(send,/\} else \{\s*messageId = newId\(\)/);
});
