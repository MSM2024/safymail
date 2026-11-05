import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
function section(from:string,to:string){
 const start=html.indexOf(from),end=html.indexOf(to,start+from.length);
 assert.ok(start>=0 && end>start,`Missing markers: ${from}`);
 return html.slice(start,end);
}

test("new composer clears previous idempotency key and invalidates draft retrieval",()=>{
 const code=section('function openComposer(title=',"async function editDraft(");
 assert.match(code,/state\.pendingSend=null/);
 assert.match(code,/draftLoadSerial\+\+/);
 assert.match(code,/draftGeneration\+\+/);
});

test("stale draft fetch cannot overwrite composer after mailbox switch or newer request",()=>{
 const code=section("async function editDraft(","async function readOutboundAttachments(");
 assert.match(code,/const accountId=state\.account\.id/);
 assert.match(code,/const requestId=\+\+draftLoadSerial/);
 assert.match(code,/state\.account\?\.id!==accountId/);
 assert.match(code,/generation!==draftGeneration/);
 assert.match(code,/requestId!==draftLoadSerial/);
 assert.ok(code.indexOf("requestId!==draftLoadSerial")<code.indexOf('openComposer("Editar borrador")'));
});

test("changing mailbox never reuses an open composer or its pending send",()=>{
 const code=section("async function selectAccount(a)","async function openMessage(");
 assert.match(code,/if\(\$\("compose-modal"\)\.open\)/);
 assert.match(code,/state\.pendingSend=null/);
 assert.ok(code.indexOf('if($("compose-modal").open)')<code.indexOf("state.account=a"));
});
