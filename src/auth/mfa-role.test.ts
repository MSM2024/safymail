import test from "node:test";
import assert from "node:assert/strict";
import { mfaAuthenticatedUser } from "./mfa-role";
import { readFileSync } from "node:fs";

test("MFA verification never elevates regular users in the response",()=>{
  const user=mfaAuthenticatedUser({user_id:"u",email:"user@example.com",display_name:"User",is_superadmin:0});
  assert.equal(user.isSuperadmin,false);
  assert.equal(user.mfaEnabled,true);
});
test("MFA verification reflects genuine superadmin state",()=>{
  const user=mfaAuthenticatedUser({user_id:"a",email:"admin@example.com",display_name:"Admin",is_superadmin:1});
  assert.equal(user.isSuperadmin,true);
});
test("MFA challenge selects database role and uses the verified identity payload",()=>{
  const source=readFileSync(new URL("./routes.ts",import.meta.url),"utf8");
  const section=source.split('auth.post("/mfa/verify"')[1]?.split('auth.post("/logout"')[0] || "";
  assert.match(section,/u\.is_superadmin/);
  assert.match(section,/user:mfaAuthenticatedUser\(challenge\)/);
  assert.doesNotMatch(section,/isSuperadmin:true/);
});
