import test from "node:test";
import assert from "node:assert/strict";
import { consumeMfaRecoveryCode } from "./recovery";

function fakeDb(changes: number[]) {
  const prepared:Array<{sql:string;args:unknown[]}>=[], batches:unknown[][]=[];
  const db={
    prepare(sql:string) {
      return { bind(...args:unknown[]) {const row={sql,args};prepared.push(row);return row;} };
    },
    async batch(statements:unknown[]) {
      batches.push(statements);
      return changes.map(n=>({meta:{changes:n}}));
    }
  } as unknown as Pick<D1Database,"prepare"|"batch">;
  return {db,prepared,batches};
}
const params={userId:"user",codeHash:"hash",challengeId:"challenge",tokenHash:"token",now:"2026-11-05T03:00:00.000Z"};
test("MFA recovery code and live challenge are consumed together in one D1 transaction", async()=>{
  const {db,prepared,batches}=fakeDb([1,1]);
  assert.equal(await consumeMfaRecoveryCode(db,params),true);
  assert.equal(batches.length,1);
  assert.equal(batches[0].length,2);
  assert.match(prepared[0].sql,/used_at IS NULL/);
  assert.match(prepared[0].sql,/auth_mfa_challenges/);
  assert.match(prepared[0].sql,/expires_at>\?/);
  assert.match(prepared[0].sql,/attempts<5/);
  assert.match(prepared[1].sql,/DELETE FROM auth_mfa_challenges/);
  assert.match(prepared[1].sql,/auth_backup_codes/);
  assert.deepEqual(prepared[0].args,[params.now,params.userId,params.codeHash,params.challengeId,params.tokenHash,params.now]);
});
test("MFA recovery never authenticates on partial or failed consumption",async()=>{
  for(const changes of [[0,0],[1,0],[0,1]]) {
    const {db}=fakeDb(changes);
    assert.equal(await consumeMfaRecoveryCode(db,params),false);
  }
});
