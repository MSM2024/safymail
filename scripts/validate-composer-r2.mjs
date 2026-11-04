import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const backend=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
const scripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length>=1,"inline webmail script missing");
for(const match of scripts)new Script(match[1],{filename:"public/index.html inline script"});
const expected=[
  'async function editDraft(message)',
  'async function saveDraft(closeAfter=false)',
  'function scheduleDraftSave()',
  'draftWrite=operation.catch(()=>{})',
  'method:"PATCH"',
  'method:"DELETE"',
  'addEventListener("input"',
  'edit.textContent="Editar borrador"',
  'if(draftId){try{await api("/api/drafts/"'
];
for(const str of expected)assert.ok(html.includes(str),"Missing composer behavior: "+str);
for(const route of ['app.get("/api/drafts/:id"','app.delete("/api/drafts/:id"']){
  assert.ok(backend.includes(route),"Missing draft API route: "+route);
}
assert.ok(backend.includes("ap.permission IN ('read_write','send_only')"),"Draft authorizations missing");
assert.ok(backend.includes("m.folder='drafts'"),"Draft folder restriction missing");
assert.ok(backend.includes("DELETE FROM messages WHERE id=? AND folder='drafts'"),"Draft deletion must be folder-scoped");
console.log("MSM MAIL Composer R2: static contract and inline JS syntax PASS");
