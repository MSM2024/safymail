export const MAIL_STORAGE_LIMIT_BYTES = 600 * 1024 * 1024;

export async function reserveMailStorage(
  db: D1Database,
  companyId: string,
  messageId: string,
  sizeBytes: number
): Promise<string | null> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAIL_STORAGE_LIMIT_BYTES) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const result = await db.prepare(`INSERT INTO mail_storage_reservations
      (id,company_id,message_id,size_bytes,status,expires_at)
    SELECT ?,?,?,?,'reserved',?
    WHERE COALESCE((
      SELECT SUM(size_bytes) FROM mail_storage_reservations
      WHERE status='committed' OR (status='reserved' AND expires_at>?)
    ),0) + ? <= ?`)
    .bind(id,companyId,messageId,sizeBytes,expiresAt,now,sizeBytes,MAIL_STORAGE_LIMIT_BYTES).run();
  return (result.meta.changes ?? 0) === 1 ? id : null;
}

export async function commitMailStorage(db: D1Database, reservationId: string): Promise<void> {
  await db.prepare("UPDATE mail_storage_reservations SET status='committed',expires_at=NULL WHERE id=? AND status='reserved'")
    .bind(reservationId).run();
}

export async function releaseMailStorage(db: D1Database, reservationId: string): Promise<void> {
  await db.prepare("DELETE FROM mail_storage_reservations WHERE id=? AND status='reserved'")
    .bind(reservationId).run();
}

export async function getMailStorageUsage(db: D1Database): Promise<number> {
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT COALESCE(SUM(size_bytes),0) AS used_bytes
    FROM mail_storage_reservations
    WHERE status='committed' OR (status='reserved' AND expires_at>?)`)
    .bind(now).first<{used_bytes:number}>();
  return row?.used_bytes ?? 0;
}
