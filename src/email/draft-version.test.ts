import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDraftVersion,DRAFT_FIELDS,type DraftVersionFields } from "./draft-version";

const base:DraftVersionFields={
 to_addresses:'["client@example.com"]',cc_addresses:"[]",bcc_addresses:"[]",
 subject:"Reply",text_body:"Hello",in_reply_to:"<reply@example.com>",
 references_header:"<root@example.com> <reply@example.com>"
};

test("draft version is deterministic and detects changed body, recipients and threading",async()=>{
 const token=await getDraftVersion(base);
 assert.match(token,/^[a-f0-9]{64}$/);
 assert.equal(await getDraftVersion({...base}),token);
 for(const variant of [
  {...base,text_body:"Hello modified"},
  {...base,to_addresses:'["other@example.com"]'},
  {...base,references_header:"<other@example.com>"}
 ])assert.notEqual(await getDraftVersion(variant),token);
 assert.equal(DRAFT_FIELDS.length,7);
});

test("draft update uses version precondition AND atomic original-field compare-and-swap",()=>{
 const src=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
 const patch=src.split('app.patch("/api/drafts/:id"')[1]?.split('app.get("/api/contacts"')[0]||"";
 assert.match(patch,/body\.if_match!==await getDraftVersion/);
 assert.match(patch,/const fieldsGuard=DRAFT_FIELDS\.map/);
 assert.match(patch,/WHERE id = \? AND folder='drafts' AND /);
 assert.match(patch,/\.\.\.values,\.\.\.originalValues/);
 assert.match(patch,/if\(\(result\.meta\.changes\?\?0\)!==1\)return c\.json\(\{error:"draft_conflict"/);
 assert.match(patch,/getDraftVersion\(nextFields\)/);
});

test("draft get and creation return versions; client carries and refreshes version on autosave",()=>{
 const api=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
 const drafts=api.split('app.get("/api/drafts/:id"')[1]?.split('app.patch("/api/drafts/:id"')[0]||"";
 assert.match(drafts,/version:await getDraftVersion/);
 const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
 assert.match(html,/draftVersion=draft\.version/);
 assert.match(html,/if_match:draftVersion/);
 assert.match(html,/draftVersion=response\.draft\?\.version\|\|response\.version/);
});
