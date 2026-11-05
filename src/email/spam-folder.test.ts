import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const code=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
const schema=readFileSync(new URL("../../migrations/0001_initial.sql",import.meta.url),"utf8");

test("Spam stays inside the D1-supported trash folder with a distinct marker",()=>{
  assert.match(schema,/CHECK \(folder IN \('inbox','sent','drafts','archive','trash'\)\)/);
  const route=code.split('app.patch("/api/messages/:id"')[1]?.split('function isValidDomain')[0] || "";
  assert.match(route,/body\.folder === "spam" \? "trash" : body\.folder/);
  assert.match(route,/user_marked_spam/);
  assert.match(route,/ap\.permission = 'read_write'/);
});

test("Spam list includes manual Spam and Mailu-imported junk, but Trash excludes both",()=>{
  const list=code.split('app.get("/api/messages"')[1]?.split('app.get("/api/messages/:id"')[0] || "";
  assert.match(list,/\? = 'spam' AND folder = 'trash'/);
  assert.match(list,/spam_reasons_json LIKE '%legacy_mailu_junk%' OR spam_reasons_json LIKE '%user_marked_spam%'/);
  assert.match(list,/spam_reasons_json NOT LIKE '%legacy_mailu_junk%'/);
  assert.match(list,/spam_reasons_json NOT LIKE '%user_marked_spam%'/);
  assert.match(list,/\.bind\(accountId, folder, folder, folder, folder, query/);
});

test("moving out of Spam clears markers, and message detail reports virtual Spam",()=>{
  const update=code.split('app.patch("/api/messages/:id"')[1]?.split('function isValidDomain')[0] || "";
  assert.match(update,/THEN '\[\]' ELSE spam_reasons_json END/);
  const detail=code.split('app.get("/api/messages/:id"')[1]?.split('app.get("/api/attachments/:id"')[0] || "";
  assert.match(detail,/includes\("legacy_mailu_junk"\)/);
  assert.match(detail,/includes\("user_marked_spam"\)/);
  assert.match(detail,/folder: "spam"/);
});
