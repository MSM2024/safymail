/**
 * Spend one recovery code only when the same MFA challenge can be consumed.
 * Both writes execute in one D1 transaction.
 */
export async function consumeMfaRecoveryCode(
  db: Pick<D1Database,"prepare"|"batch">,
  input:{userId:string;codeHash:string;challengeId:string;tokenHash:string;now:string}
):Promise<boolean>{
  const {userId,codeHash,challengeId,tokenHash,now}=input;
  const results=await db.batch([
    db.prepare(`UPDATE auth_backup_codes SET used_at=?
      WHERE user_id=? AND code_hash=? AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM auth_mfa_challenges WHERE id=? AND token_hash=? AND expires_at>? AND attempts<5)`)
      .bind(now,userId,codeHash,challengeId,tokenHash,now),
    db.prepare(`DELETE FROM auth_mfa_challenges WHERE id=? AND token_hash=? AND expires_at>?
      AND EXISTS (SELECT 1 FROM auth_backup_codes WHERE user_id=? AND code_hash=? AND used_at=?)`)
      .bind(challengeId,tokenHash,now,userId,codeHash,now)
  ]);
  return (results[0]?.meta.changes??0)===1 && (results[1]?.meta.changes??0)===1;
}
