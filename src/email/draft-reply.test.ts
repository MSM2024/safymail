import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDraftReplyHeaders } from "./draft-reply";

test("drafts preserve valid reply message ids and References",()=>{
 assert.deepEqual(parseDraftReplyHeaders({in_reply_to:" <first@example.com> ",references:["<root@example.com>","<first@example.com>"]}),{
  inReplyTo:"<first@example.com>",references:"<root@example.com> <first@example.com>"
 });
});
test("draft headers reject injection or malformed references",()=>{
 assert.equal(parseDraftReplyHeaders({in_reply_to:"<yes@example.com>\r\nBcc: attacker@example.com"}),null);
 assert.equal(parseDraftReplyHeaders({references:["not-an-id"]}),null);
 assert.equal(parseDraftReplyHeaders({references:"<not-an-array@example.com>"}),null);
});
test("new standalone drafts have null threading references",()=>{
 assert.deepEqual(parseDraftReplyHeaders({}),{inReplyTo:null,references:null});
});
test("draft read/create/update endpoints preserve threading fields",()=>{
 const api=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
 const routes=api.split("async function authorizeDraft(")[1]?.split('app.get("/api/contacts"')[0]||"";
 assert.match(routes,/m\.in_reply_to,m\.references_header/);
 assert.match(routes,/parseDraftReplyHeaders\(body\)/);
 assert.match(routes,/in_reply_to, references_header, is_read/);
 assert.match(routes,/sets\.push\("in_reply_to = \?"\)/);
 assert.match(routes,/sets\.push\("references_header = \?"\)/);
});
test("composer includes reply headers in autosaved drafts and restores them",()=>{
 const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
 const save=html.split("const draftPayload=()=>")[1]?.split("async function refreshSendReadiness")[0]||"";
 const edit=html.split("async function editDraft(")[1]?.split("async function readOutboundAttachments")[0]||"";
 assert.match(save,/state\.replyHeaders/);
 assert.match(edit,/draft\.references_header/);
 assert.match(edit,/draft\.in_reply_to/);
});
