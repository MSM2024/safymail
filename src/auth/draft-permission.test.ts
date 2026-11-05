import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.ts",import.meta.url),"utf8");
function segment(from:string,to:string){
  const start=source.indexOf(from),end=source.indexOf(to,start+from.length);
  assert.ok(start>=0 && end>start,`missing route marker: ${from}`);
  return source.slice(start,end);
}
test("send_only can send but cannot read, delete or modify stored drafts",()=>{
  const send=segment("async function getSendAccount(","// Read-only per-mailbox send preflight.");
  assert.match(send,/ap\.permission IN \('read_write','send_only'\)/);
  const draftAccount=segment("async function getDraftAccount(","function formatFromAddress");
  const draftRead=segment("async function authorizeDraft(","app.get(\"/api/drafts/:id\"");
  const draftUpdate=segment("app.patch(\"/api/drafts/:id\"","app.get(\"/api/contacts\"");
  for(const [name,section] of [["draft account",draftAccount],["draft read/delete",draftRead],["draft edit",draftUpdate]] as const){
    assert.match(section,/ap\.permission = 'read_write'/,name);
    assert.doesNotMatch(section,/send_only/,name);
    assert.match(section,/ea\.company_id/,name);
  }
});
