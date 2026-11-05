import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "route boundaries must exist");
  return source.slice(a, b);
}

test("message changes recheck mailbox and tenant permissions within UPDATE", () => {
  const code = section('app.patch("/api/messages/:id"', "function isValidDomain");
  assert.match(code, /UPDATE messages SET/);
  assert.match(code, /WHERE ea\.id = messages\.account_id/);
  assert.match(code, /ap\.account_id = ea\.id/);
  assert.match(code, /ap\.permission = 'read_write'/);
  assert.match(code, /ea\.company_id = \?/);
  assert.match(code, /\[\.\.\.values, user\.id, user\.id, c\.get\("hostCompanyId"\)\]/);
  assert.match(code, /changed\.meta\.changes \?\? 0/);
});

test("contact changes recheck company membership during UPDATE", () => {
  const code = section('app.patch("/api/contacts/:id"', 'app.delete("/api/contacts/:id"');
  assert.match(code, /UPDATE contacts SET/);
  assert.match(code, /AND company_id=\?/);
  assert.match(code, /EXISTS\(SELECT 1 FROM company_memberships/);
  assert.match(code, /user_id=\? AND company_id=contacts\.company_id/);
  assert.match(code, /\[\.\.\.values,c\.get\("hostCompanyId"\),user\.id\]/);
  assert.match(code, /changed\.meta\.changes\?\?0/);
});
