import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const code=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
test("P1 native Spam includes new spam and historical Mailu junk only",()=>{
  const list=code.split('app.get("/api/messages"')[1]?.split('app.get("/api/messages/:id"')[0] || "";
  assert.match(list,/folder = 'spam' OR \(folder = 'trash' AND spam_reasons_json LIKE '%legacy_mailu_junk%'\)/);
  assert.match(list,/folder = 'trash' AND spam_reasons_json NOT LIKE '%legacy_mailu_junk%'/);
  assert.match(list,/\? NOT IN \('spam','trash'\) AND folder = \?/);
  assert.match(list,/\.bind\(accountId, folder, folder, folder, folder, query/);
  assert.doesNotMatch(list,/folder === "spam" \? "trash" : folder/);
});
test("P1 user folder move stores native Spam and clears legacy marker",()=>{
  const route=code.split('app.patch("/api/messages/:id"')[1]?.split('function isValidDomain')[0] || "";
  assert.match(route,/values\.push\(body\.folder\)/);
  assert.doesNotMatch(route,/body\.folder === "spam" \? "trash"/);
  assert.match(route,/spam_reasons_json = CASE WHEN spam_reasons_json LIKE '%legacy_mailu_junk%'/);
  assert.match(route,/ap\.permission = 'read_write'/);
});
test("historical Mailu junk still appears as Spam in message detail",()=>{
  const route=code.split('app.get("/api/messages/:id"')[1]?.split('app.get("/api/attachments/:id"')[0] || "";
  assert.match(route,/folder === "trash"/);
  assert.match(route,/includes\("legacy_mailu_junk"\)/);
});
