import { Hono } from "hono";
import { receiveEmail } from "./email/inbound";
import { arrayBufferToBase64, isAllowedAttachment, parseOutboundAttachments } from "./email/attachments";
import { releaseMailStorage, reserveMailStorage } from "./email/storage";
import { verifyResendWebhook } from "./email/webhooks";
import { sendViaResendRelay, diagnoseRelayConnectivity } from "./email/resend-relay";
import { getOutboundPreflight } from "./email/outbound-preflight";
import { requireSession, getUserCompanies, hashPassword } from "./middleware/auth";
import { authRoutes } from "./auth/routes";
import { securityRoutes } from "./auth/security";
import { adminRoutes } from "./admin/routes";
import type { Env, AppVariables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get("/api/health", (c) => c.json({
  status: "ok",
  service: c.env.APP_NAME || "Mail Center",
  environment: c.env.ENVIRONMENT || "unknown"
}));

// Public, hostname-scoped identity used by the login and webmail shell.
app.get("/api/branding", async (c) => {
  const hostname = new URL(c.req.url).hostname.toLowerCase();
  const company = await c.env.DB.prepare(
    `SELECT co.name FROM company_access_hosts h
     JOIN companies co ON co.id = h.company_id
     WHERE h.hostname = ? COLLATE NOCASE AND h.status = 'active' AND co.status = 'active'
     LIMIT 1`
  ).bind(hostname).first<{ name: string }>();
  if (!company) return c.json({ company_name: null, product_name: "Mail Center" });
  return c.json({ company_name: company.name, product_name: company.name + " Mail" });
});

app.route("/api/auth", authRoutes);

app.post("/api/internal/maintenance", async c => {
  const expected = c.env.MAINTENANCE_TOKEN || "";
  const supplied = c.req.header("Authorization") || "";
  const token = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(supplied)?.[1] || "";
  const left = new TextEncoder().encode(expected), right = new TextEncoder().encode(token);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) mismatch |= (left[i] || 0) ^ (right[i] || 0);
  if (!expected || mismatch !== 0) return c.json({ error: "unauthorized" }, 401);
  const slot = c.req.header("X-Mail-Center-Scheduler-Slot") || "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|15|30|45):00\.000Z$/.test(slot)) return c.json({ error: "invalid_scheduler_slot" }, 400);
  const lockToken = crypto.randomUUID(), now = new Date().toISOString();
  const lock = await c.env.DB.prepare(
    "UPDATE mail_maintenance_lock SET lock_token=?,lock_expires_at=? WHERE id=1 AND (last_completed_slot IS NULL OR last_completed_slot<>?) AND (lock_expires_at IS NULL OR lock_expires_at<=?)"
  ).bind(lockToken, new Date(Date.now() + 10 * 60 * 1000).toISOString(), slot, now).run();
  if ((lock.meta.changes ?? 0) !== 1) {
    const state = await c.env.DB.prepare("SELECT last_completed_slot FROM mail_maintenance_lock WHERE id=1").first<{ last_completed_slot: string | null }>();
    if (state?.last_completed_slot === slot) return c.json({ ok: true, duplicate: true });
    return c.json({ error: "maintenance_already_running" }, 409);
  }
  let completed = false;
  try {
    await runMailMaintenance(c.env);
    completed = true;
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "maintenance_failed" }, 503);
  } finally {
    if (completed) {
      await c.env.DB.prepare("UPDATE mail_maintenance_lock SET last_completed_slot=?,lock_token=NULL,lock_expires_at=NULL WHERE id=1 AND lock_token=?").bind(slot, lockToken).run();
    } else {
      await c.env.DB.prepare("UPDATE mail_maintenance_lock SET lock_token=NULL,lock_expires_at=NULL WHERE id=1 AND lock_token=?").bind(lockToken).run();
    }
  }
});

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  const path = c.req.path;
  if (path === "/api/health" || path === "/api/webhooks/resend" || path.startsWith("/api/auth/")) return next();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: "csrf_origin_rejected" }, 403);
  }
  return requireSession(c, next);
});

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/health" || path === "/api/webhooks/resend" || path.startsWith("/api/auth/")) {
    return next();
  }
  const user = c.get("user");
  let hostCompanyId: string | null = null;
  if (!user.isSuperadmin) {
    const hostname = new URL(c.req.url).hostname.toLowerCase();
    const mapping = await c.env.DB.prepare(
      "SELECT h.company_id,h.status,c.status AS company_status FROM company_access_hosts h JOIN companies c ON c.id=h.company_id WHERE h.hostname=? COLLATE NOCASE LIMIT 1"
    ).bind(hostname).first<{ company_id: string; status: string; company_status: string }>();
    if (!mapping) {
      return c.json({ error: "host_not_configured" }, 403);
    }
    if (mapping.status !== "active") {
      return c.json({ error: "host_access_suspended" }, 403);
    }
    if (mapping.company_status !== "active") {
      return c.json({ error: "company_access_suspended" }, 403);
    }
    hostCompanyId = mapping.company_id;
  }
  c.set("hostCompanyId", hostCompanyId);
  await next();
});

const requireSuperadminMfaForMail = async (c: any, next: () => Promise<void>) => {
  const user=c.get("user");
  if(user.isSuperadmin&&!user.mfaVerified)return c.json({error:"mfa_required",message:"Activa y verifica MFA antes de acceder a los buzones."},403);
  await next();
};
app.use("/api/accounts",requireSuperadminMfaForMail);
app.use("/api/messages",requireSuperadminMfaForMail);
app.use("/api/messages/*",requireSuperadminMfaForMail);
app.use("/api/drafts",requireSuperadminMfaForMail);
app.use("/api/drafts/*",requireSuperadminMfaForMail);
app.use("/api/attachments/*",requireSuperadminMfaForMail);
app.use("/api/contacts",requireSuperadminMfaForMail);
app.use("/api/contacts/*",requireSuperadminMfaForMail);

app.route("/api/security", securityRoutes);

app.use("/api/admin/*", async (c, next) => {
  if (!c.get("user").isSuperadmin) return c.json({ error: "forbidden" }, 403);
  if (!c.get("user").mfaVerified) return c.json({ error: "mfa_required", message: "Verifica MFA para acceder a la administración." }, 403);
  await next();
});

app.route("/api/admin", adminRoutes);

app.post("/api/webhooks/resend", async (c) => {
  if (!c.env.RESEND_WEBHOOK_SECRET) return c.json({ error: "webhook_not_configured" }, 503);
  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 1024 * 1024) return c.json({ error: "payload_too_large" }, 413);
  if (!await verifyResendWebhook(rawBody, c.req.raw, c.env.RESEND_WEBHOOK_SECRET)) {
    return c.json({ error: "invalid_webhook_signature" }, 401);
  }

  let event: {
    type?: string; created_at?: string;
    data?: { email_id?: string; message_id?: string };
  };
  try { event = JSON.parse(rawBody); }
  catch { return c.json({ error: "invalid_payload" }, 400); }
  const eventId = c.req.header("svix-id") || "";
  if (!eventId || eventId.length > 200 || typeof event.type !== "string" || !event.type || event.type.length > 120) {
    return c.json({ error: "invalid_event" }, 400);
  }
  const replay = await c.env.DB.prepare("SELECT id FROM webhook_events WHERE provider = 'resend' AND provider_event_id = ? LIMIT 1").bind(eventId).first();
  if (replay) return c.body(null, 204);
  const emailId = typeof event.data?.email_id === "string" && event.data.email_id.length <= 200
    ? event.data.email_id : null;
  const occurredAt = typeof event.created_at === "string" && event.created_at.length <= 64
    ? event.created_at : null;
  const statusByType: Record<string, string> = {
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.failed": "failed"
  };
  const newStatus = statusByType[event.type];
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_events (id, provider, provider_event_id, payload_json, processed_at) VALUES (?, 'resend', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    ).bind(newId(), eventId, rawBody)
  ];
  if (emailId) {
    statements.push(c.env.DB.prepare(
      `INSERT OR IGNORE INTO message_events
       (id, message_id, provider, provider_event_id, event_type, payload_json, occurred_at)
       SELECT ?, id, 'resend', ?, ?, ?, ? FROM messages WHERE provider_message_id = ?`
    ).bind(newId(), eventId, event.type, rawBody, occurredAt, emailId));
    if (newStatus) {
      // Webhook delivery is asynchronous and may arrive out of order.
      // Never let a late "sent" event regress a message already delivered,
      // bounced, or failed.
      statements.push(c.env.DB.prepare(
        "UPDATE messages SET delivery_status = ?, send_next_attempt_at = NULL, send_last_error = CASE WHEN ? IN ('sent','delivered') THEN NULL ELSE send_last_error END WHERE provider_message_id = ? AND delivery_status IN ('queued','sent')"
      ).bind(newStatus, newStatus, emailId));
    }
  }
  await c.env.DB.batch(statements);
  return c.body(null, 204);
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const companies = await getUserCompanies(c, user);
  const hostCompanyId = c.get("hostCompanyId");
  const visibleCompanies = hostCompanyId
    ? companies.filter((company: any) => company.id === hostCompanyId)
    : companies;
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isSuperadmin: user.isSuperadmin,
      mfaVerified: user.mfaVerified
    },
    companies: visibleCompanies
  });
});

app.use("/api/notifications", requireSuperadminMfaForMail);

app.get("/api/notifications", async (c) => {
  const user = c.get("user");
  const hostCompanyId = c.get("hostCompanyId");
  const permissionScope = user.isSuperadmin ? "" : `
    AND EXISTS (
      SELECT 1 FROM company_memberships cm
      JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = cm.user_id
        AND ap.permission IN ('read_only','read_write')
      WHERE cm.company_id = ea.company_id AND cm.user_id = ?
    )`;
  const bindings = user.isSuperadmin
    ? [hostCompanyId, hostCompanyId]
    : [hostCompanyId, hostCompanyId, user.id];
  const base = `
    FROM messages m
    JOIN email_accounts ea ON ea.id = m.account_id
    JOIN companies co ON co.id = ea.company_id AND co.status = 'active'
    WHERE m.direction = 'inbound' AND m.folder = 'inbox'
      AND ea.status = 'active' AND (? IS NULL OR ea.company_id = ?)
      ${permissionScope}`;
  const unread = await c.env.DB.prepare("SELECT COUNT(*) AS unread_count " + base + " AND m.is_read = 0")
    .bind(...bindings).first<{ unread_count: number }>();
  const latest = await c.env.DB.prepare(`
    SELECT m.id, m.account_id, m.subject, m.from_address,
           COALESCE(m.received_at,m.created_at) AS received_at, m.is_read
    ${base}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  `).bind(...bindings).first<{
    id: string; account_id: string; subject: string; from_address: string;
    received_at: string; is_read: number;
  }>();
  return c.json({ unread_count: unread?.unread_count || 0, latest_inbound: latest || null });
});
app.get("/api/accounts", async (c) => {
  const user = c.get("user");
  const scopedCompanyId = c.get("hostCompanyId");
  const accounts = user.isSuperadmin
    ? await c.env.DB.prepare(
        `SELECT ea.id, ea.company_id, co.name AS company_name, d.domain,
                ea.local_part, ea.display_name, ea.status
         FROM email_accounts ea
         JOIN companies co ON co.id = ea.company_id AND co.status = 'active'
         JOIN domains d ON d.id = ea.domain_id
         WHERE ea.status = 'active'
         ORDER BY co.name, ea.local_part`
      ).all()
    : await c.env.DB.prepare(
        `SELECT ea.id, ea.company_id, co.name AS company_name, d.domain,
                ea.local_part, ea.display_name, ea.status
         FROM email_accounts ea
         JOIN companies co ON co.id = ea.company_id
         JOIN domains d ON d.id = ea.domain_id
         JOIN company_memberships cm ON cm.company_id = ea.company_id AND cm.user_id = ?
         JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = ? AND ap.permission IN ('read_only','read_write')
         WHERE ea.status = 'active' AND co.status = 'active'
           AND (? IS NULL OR ea.company_id = ?)
         ORDER BY co.name, ea.local_part`
      ).bind(user.id, user.id, scopedCompanyId, scopedCompanyId).all();

  return c.json({ accounts: accounts.results });
});

app.get("/api/messages", async (c) => {
  const user = c.get("user");
  const accountId = c.req.query("account_id");
  const folder = c.req.query("folder") || "inbox";
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 30), 1), 100);
  const query = (c.req.query("q") || "").trim().slice(0, 120);
  const filter = c.req.query("filter") || "all";
  const cursorDate = c.req.query("cursor_date") || null;
  const cursorId = c.req.query("cursor_id") || "";
  const allowedFolders = ["inbox", "sent", "drafts", "archive", "trash", "spam"]; // MSM_LEGACY_SPAM_VIEW_V1
  if (!accountId || !allowedFolders.includes(folder) || !["all", "unread", "starred", "important"].includes(filter)) {
    return c.json({ error: "invalid_query" }, 400);
  }

  const permission = user.isSuperadmin
    ? await c.env.DB.prepare("SELECT ea.id FROM email_accounts ea JOIN companies co ON co.id = ea.company_id WHERE ea.id = ? AND ea.status = 'active' AND co.status = 'active'").bind(accountId).first()
    : await c.env.DB.prepare(
        `SELECT ea.id FROM email_accounts ea
         JOIN companies co ON co.id = ea.company_id
         JOIN company_memberships cm ON cm.company_id = ea.company_id AND cm.user_id = ?
         JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = ? AND ap.permission IN ('read_only','read_write')
         WHERE ea.id = ? AND ea.status = 'active' AND co.status = 'active' AND cm.company_id = ea.company_id
           AND (? IS NULL OR ea.company_id = ?)`
      ).bind(user.id, user.id, accountId, c.get("hostCompanyId"), c.get("hostCompanyId")).first();

  if (!permission) return c.json({ error: "not_found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT id, conversation_id, direction, from_address, to_addresses,
            subject, substr(text_body, 1, 180) AS preview, is_read, is_starred, is_important, received_at, sent_at, delivery_status,
            COALESCE(received_at, sent_at, created_at) AS sort_at
     FROM messages
     WHERE account_id = ?
       AND ((? = 'spam' AND (folder = 'spam' OR (folder = 'trash' AND spam_reasons_json LIKE '%legacy_mailu_junk%')))
         OR (? = 'trash' AND folder = 'trash' AND spam_reasons_json NOT LIKE '%legacy_mailu_junk%')
         OR (? NOT IN ('spam','trash') AND folder = ?))
       AND (? = '' OR subject LIKE ? OR from_address LIKE ? OR to_addresses LIKE ?)
       AND (? != 'unread' OR is_read = 0)
       AND (? != 'starred' OR is_starred = 1)
       AND (? != 'important' OR is_important = 1)
       AND (? IS NULL OR COALESCE(received_at, sent_at, created_at) < ?
         OR (COALESCE(received_at, sent_at, created_at) = ? AND id < ?))
     ORDER BY COALESCE(received_at, sent_at, created_at) DESC, id DESC
     LIMIT ?`
  ).bind(accountId, folder, folder, folder, folder, query, "%"+query+"%", "%"+query+"%", "%"+query+"%",
    filter, filter, filter, cursorDate, cursorDate, cursorDate, cursorId, limit).all();

  const last = rows.results.length ? rows.results[rows.results.length - 1] as any : null;
  return c.json({ messages: rows.results, has_more: rows.results.length === limit,
    next_cursor_date: last?.sort_at || null, next_cursor_id: last?.id || null });
});



app.get("/api/messages/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const baseSql = `SELECT m.id, m.company_id, m.account_id, m.conversation_id, m.direction,
      m.folder, m.from_address, m.to_addresses, m.cc_addresses, m.subject,
      m.text_body, m.html_body, m.authentication_results, m.spam_score, m.spam_reasons_json,
      m.message_id_header, m.in_reply_to, m.references_header, m.is_read, m.is_starred, m.is_important,
      m.received_at, m.sent_at, m.delivery_status, m.send_attempts,
      m.send_next_attempt_at, m.send_last_error
    FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
    JOIN companies co ON co.id = ea.company_id
    WHERE m.id = ? AND ea.status = 'active' AND co.status = 'active'`;
  const row = user.isSuperadmin
    ? await c.env.DB.prepare(baseSql).bind(id).first()
    : await c.env.DB.prepare(
        baseSql + ` AND co.status = 'active' AND EXISTS (
          SELECT 1 FROM company_memberships cm
          JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = cm.user_id AND ap.permission IN ('read_only','read_write')
          WHERE cm.company_id = ea.company_id AND cm.user_id = ?
        ) AND (? IS NULL OR ea.company_id = ?)`
      ).bind(id, user.id, c.get("hostCompanyId"), c.get("hostCompanyId")).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  const attachments = await c.env.DB.prepare(
    "SELECT id, filename, content_type, size_bytes FROM attachments WHERE message_id = ? ORDER BY filename"
  ).bind(id).all();
  const visibleMessage = (row as any).folder === "trash" &&
    String((row as any).spam_reasons_json || "").includes("legacy_mailu_junk")
    ? { ...(row as any), folder: "spam" } : row;
  return c.json({ message: visibleMessage, attachments: attachments.results });
});

app.get("/api/attachments/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const sql = `SELECT a.storage_key, a.filename, a.content_type, a.size_bytes
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN email_accounts ea ON ea.id = m.account_id
    JOIN companies co ON co.id = ea.company_id
    WHERE a.id = ? AND ea.status = 'active' AND co.status = 'active'`;
  const attachment = user.isSuperadmin
    ? await c.env.DB.prepare(sql).bind(id).first<{
        storage_key: string; filename: string; content_type: string; size_bytes: number;
      }>()
    : await c.env.DB.prepare(sql + ` AND EXISTS (
        SELECT 1 FROM company_memberships cm
        JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = cm.user_id
        WHERE cm.company_id = ea.company_id AND cm.user_id = ?
          AND ap.permission IN ('read_only','read_write')
      ) AND (? IS NULL OR ea.company_id = ?)`).bind(id, user.id, c.get("hostCompanyId"), c.get("hostCompanyId")).first<{
        storage_key: string; filename: string; content_type: string; size_bytes: number;
      }>();
  if (!attachment) return c.json({ error: "not_found" }, 404);

  const object = await c.env.MAIL_STORAGE.get(attachment.storage_key, "arrayBuffer");
  if (!object) return c.json({ error: "attachment_missing" }, 404);
  if (!isAllowedAttachment(attachment.filename, attachment.content_type, object)) {
    return c.json({ error: "unsupported_attachment_type" }, 415);
  }
  const filename = Array.from(attachment.filename).map((char) =>
    char.charCodeAt(0) < 32 || char === '"' || char.charCodeAt(0) === 92 ? "_" : char
  ).join("").slice(0, 180) || "attachment";
  const asciiFilename = Array.from(filename).map((char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126 ? "_" : char
  ).join("");
  const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.content_type)
    ? attachment.content_type : "application/octet-stream";
  return c.body(object, 200, {
    "Content-Type": contentType,
    "Content-Disposition": "attachment; filename=\"" + asciiFilename + "\"; filename*=UTF-8''" + encodeURIComponent(filename),
    "Content-Length": String(attachment.size_bytes),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store"
  });
});
app.patch("/api/messages/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{ is_read?: boolean; is_starred?: boolean; is_important?: boolean; folder?: string }>().catch(() => ({} as any));
  const allowedMoveFolders = ["inbox", "archive", "trash", "spam"];
  if (typeof body.is_read !== "boolean" && typeof body.is_starred !== "boolean" && typeof body.is_important !== "boolean" &&
      !(typeof body.folder === "string" && allowedMoveFolders.includes(body.folder))) {
    return c.json({ error: "no_supported_changes" }, 400);
  }
  const access = user.isSuperadmin
    ? await c.env.DB.prepare(
        "SELECT m.id FROM messages m JOIN email_accounts ea ON ea.id = m.account_id JOIN companies co ON co.id = ea.company_id WHERE m.id = ? AND ea.status = 'active' AND co.status = 'active'"
      ).bind(id).first()
    : await c.env.DB.prepare(
        `SELECT m.id FROM messages m
         JOIN email_accounts ea ON ea.id = m.account_id
         JOIN companies co ON co.id = ea.company_id
         JOIN company_memberships cm ON cm.company_id = ea.company_id AND cm.user_id = ?
         JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = ? AND ap.permission = 'read_write'
         WHERE m.id = ? AND ea.status = 'active' AND co.status = 'active'
           AND (? IS NULL OR ea.company_id = ?)`
      ).bind(user.id, user.id, id, c.get("hostCompanyId"), c.get("hostCompanyId")).first();
  if (!access) return c.json({ error: "not_found" }, 404);
  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (typeof body.is_read === "boolean") { updates.push("is_read = ?"); values.push(body.is_read ? 1 : 0); }
  if (typeof body.is_starred === "boolean") { updates.push("is_starred = ?"); values.push(body.is_starred ? 1 : 0); }
  if (typeof body.is_important === "boolean") { updates.push("is_important = ?"); values.push(body.is_important ? 1 : 0); }
  if (typeof body.folder === "string" && allowedMoveFolders.includes(body.folder)) {
    updates.push("folder = ?");
    values.push(body.folder);
    // Legacy Mailu junk stored in trash is still readable as Spam, but
    // all newly moved Spam messages live in their own native folder.
    updates.push("spam_reasons_json = CASE WHEN spam_reasons_json LIKE '%legacy_mailu_junk%' THEN '[]' ELSE spam_reasons_json END");
  }
  values.push(id);
  // Recheck permissions in the write itself so revoked access cannot race
  // between the preliminary SELECT and UPDATE.
  const userScopedWrite = ` AND EXISTS (
    SELECT 1 FROM email_accounts ea
    JOIN companies co ON co.id = ea.company_id AND co.status = 'active'
    JOIN company_memberships cm ON cm.company_id = ea.company_id AND cm.user_id = ?
    JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = ?
      AND ap.permission = 'read_write'
    WHERE ea.id = messages.account_id AND ea.status = 'active'
      AND ea.company_id = ?
  )`;
  const writeSql = `UPDATE messages SET ${updates.join(", ")} WHERE id = ?`
    + (user.isSuperadmin ? "" : userScopedWrite);
  const writeValues = user.isSuperadmin
    ? values : [...values, user.id, user.id, c.get("hostCompanyId")];
  const changed = await c.env.DB.prepare(writeSql).bind(...writeValues).run();
  if ((changed.meta.changes ?? 0) !== 1) return c.json({ error: "not_found" }, 404);
  return c.json({ id, updated: true });
});

function isValidDomain(value: string) {
  return value.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}
function isValidLocalPart(value: string) {
  return value.length <= 64 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(value) && !value.startsWith(".") && !value.endsWith(".") && !value.includes("..");
}
function newId() { return crypto.randomUUID(); }


app.post("/api/admin/users", async (c) => {
  const actor = c.get("user");
  if (!actor.isSuperadmin) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{
    email?: string; display_name?: string; company_ids?: string[];
    is_superadmin?: boolean; password?: string;
  }>().catch(() => ({} as any));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const companyIds = Array.isArray(body.company_ids)
    ? [...new Set(body.company_ids.filter((id: unknown): id is string => typeof id === "string"))]
    : [];
  const isSuperadmin = body.is_superadmin === true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !displayName || displayName.length > 120 || companyIds.length > 50 ||
      typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256 ||
      isSuperadmin) {
    return c.json({ error: "invalid_user" }, 400);
  }
  if (companyIds.length) {
    const placeholders = companyIds.map(() => "?").join(",");
    const result = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM companies WHERE status != 'suspended' AND id IN (${placeholders})`
    ).bind(...companyIds).first<{ total: number }>();
    if ((result?.total ?? 0) !== companyIds.length) return c.json({ error: "invalid_company_assignment" }, 400);
  }
  const id = newId();
  const credentials = await hashPassword(body.password);
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO users (id, email, display_name, is_superadmin, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, email, displayName, isSuperadmin ? 1 : 0, credentials.hash, credentials.salt),
    ...companyIds.map((companyId) => c.env.DB.prepare(
      "INSERT INTO company_memberships (user_id, company_id, role) VALUES (?, ?, 'member')"
    ).bind(id, companyId)),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id) VALUES (?, ?, 'user.created', 'user', ?)"
    ).bind(newId(), actor.id, id)
  ];
  try { await c.env.DB.batch(statements); }
  catch { return c.json({ error: "user_conflict" }, 409); }
  return c.json({ user: { id, email, displayName, isSuperadmin, companyIds, status: "active" } }, 201);
});

app.post("/api/admin/companies", async (c) => {
  const actor = c.get("user");
  if (!actor.isSuperadmin) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ name?: string; slug?: string }>().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!name || !slug || name.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return c.json({ error: "invalid_company" }, 400);
  }
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)").bind(id, name, slug),
      c.env.DB.prepare("INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id) VALUES (?, ?, 'company.created', 'company', ?)").bind(newId(), actor.id, id)
    ]);
  } catch {
    return c.json({ error: "company_conflict" }, 409);
  }
  return c.json({ company: { id, name, slug, status: "pending" } }, 201);
});


app.patch("/api/admin/companies/:id", async (c) => {
  const actor = c.get("user");
  if (!actor.isSuperadmin) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ name?: string; status?: string }>().catch(() => ({} as any));
  const id = c.req.param("id");
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const status = body.status;
  if (name === "" || (name && name.length > 120) ||
      (status !== undefined && status !== "active" && status !== "suspended" && status !== "pending")) {
    return c.json({ error: "invalid_company_update" }, 400);
  }
  const existing = await c.env.DB.prepare("SELECT id FROM companies WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ error: "company_not_found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE companies SET name = COALESCE(?, name), status = COALESCE(?, status), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).bind(name ?? null, status ?? null, id),
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, metadata_json) VALUES (?, ?, 'company.updated', 'company', ?, ?)"
    ).bind(newId(), actor.id, id, JSON.stringify({ name: name ?? null, status: status ?? null }))
  ]);
  return c.json({ id, updated: true });
});

app.post("/api/admin/domains", async (c) => {
  const actor = c.get("user");
  if (!actor.isSuperadmin) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ company_id?: string; domain?: string }>().catch(() => ({} as any));
  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
  if (!companyId || !domain || !isValidDomain(domain)) return c.json({ error: "invalid_domain" }, 400);
  const company = await c.env.DB.prepare("SELECT id FROM companies WHERE id = ? AND status != 'suspended'").bind(companyId).first();
  if (!company) return c.json({ error: "company_not_found" }, 404);
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO domains (id, company_id, domain) VALUES (?, ?, ?)").bind(id, companyId, domain),
      c.env.DB.prepare("INSERT INTO audit_logs (id, actor_user_id, company_id, action, resource_type, resource_id) VALUES (?, ?, ?, 'domain.created', 'domain', ?)").bind(newId(), actor.id, companyId, id)
    ]);
  } catch {
    return c.json({ error: "domain_conflict" }, 409);
  }
  return c.json({ domain: { id, companyId, domain, status: "pending" } }, 201);
});

async function refreshDomainStatus(db: D1Database, domainId: string) {
  const row = await db.prepare("SELECT status,inbound_verified_at,outbound_verified_at FROM domains WHERE id=?")
    .bind(domainId).first<{status:string;inbound_verified_at:string|null;outbound_verified_at:string|null}>();
  if (!row) return null;
  if (row.status === "suspended") return "suspended";
  const status = row.inbound_verified_at && row.outbound_verified_at ? "active"
    : row.inbound_verified_at ? "receiving_ready"
    : row.outbound_verified_at ? "sending_ready" : "pending";
  await db.prepare("UPDATE domains SET status=? WHERE id=?").bind(status,domainId).run();
  return status;
}

app.get("/api/admin/domains/:id/dns", async (c) => {
  const id=c.req.param("id");
  const row=await c.env.DB.prepare("SELECT domain,resend_records_json,resend_status,inbound_verified_at,outbound_verified_at FROM domains WHERE id=?")
    .bind(id).first<{domain:string;resend_records_json:string;resend_status:string;inbound_verified_at:string|null;outbound_verified_at:string|null}>();
  if(!row)return c.json({error:"domain_not_found"},404);
  let resendRecords:unknown[]=[];
  try{const parsed=JSON.parse(row.resend_records_json);if(Array.isArray(parsed))resendRecords=parsed;}catch{}
  const required=["route1.mx.cloudflare.net","route2.mx.cloudflare.net","route3.mx.cloudflare.net"];
  const lookup=async(name:string,type:"MX"|"TXT")=>{
    const url="https://cloudflare-dns.com/dns-query?name="+encodeURIComponent(name)+"&type="+type;
    const response=await fetch(url,{headers:{Accept:"application/dns-json"}});
    if(!response.ok)throw new Error("dns_lookup_failed");
    return await response.json() as {Status?:number;Answer?:Array<{type?:number;data?:string;TTL?:number}>};
  };
  try{
    const [mxResult,spfResult,dmarcResult]=await Promise.all([
      lookup(row.domain,"MX"),lookup(row.domain,"TXT"),lookup("_dmarc."+row.domain,"TXT")
    ]);
    const mxRecords=(mxResult.Answer||[]).filter(record=>record.type===15).map(record=>{
      const parts=(record.data||"").trim().split(/\s+/);
      return {priority:Number(parts.shift()),host:parts.join("").replace(/\.$/,"").toLowerCase(),ttl:record.TTL||null};
    }).filter(record=>record.host);
    const mxHosts=mxRecords.map(record=>record.host);
    const missingMx=required.filter(host=>!mxHosts.includes(host));
    const unexpectedMx=mxHosts.filter(host=>!required.includes(host));
    const duplicateMx=required.filter(requiredHost=>mxHosts.filter(host=>host===requiredHost).length>1);
    const mxOk=missingMx.length===0&&unexpectedMx.length===0&&mxHosts.length===required.length&&duplicateMx.length===0;
    const spfRecords=(spfResult.Answer||[]).map(record=>(record.data||"").replace(/^"|"$/g,"")).filter(value=>/^v=spf1(?:\s|$)/i.test(value));
    const dmarcRecords=(dmarcResult.Answer||[]).map(record=>(record.data||"").replace(/^"|"$/g,"")).filter(value=>/^v=DMARC1(?:\s|$)/i.test(value));
    return c.json({domain:row.domain,resend_status:row.resend_status,resend_records:resendRecords,
      mx_records:mxRecords,mx_ok:mxOk,mx_missing:missingMx,mx_unexpected:unexpectedMx,mx_duplicates:duplicateMx,
      spf_records:spfRecords,spf_ok:spfRecords.length===1,spf_multiple:spfRecords.length>1,
      dmarc_records:dmarcRecords,dmarc_ok:dmarcRecords.length===1,
      inbound_verified:Boolean(row.inbound_verified_at),outbound_verified:Boolean(row.outbound_verified_at),
      inbound_mx_required:required,
      note:"MX identifica el proveedor receptor; no demuestra que la regla Email Routing esté activa. SPF debe existir como un único TXT v=spf1. Revisa los valores exactos de DKIM/Return-Path en los registros de Resend antes de modificar DNS."});
  }catch{return c.json({error:"dns_lookup_failed"},502);}
});

app.post("/api/admin/domains/:id/suspend", async (c) => {
  const actor=c.get("user"),id=c.req.param("id");
  const row=await c.env.DB.prepare("SELECT id,company_id FROM domains WHERE id=?").bind(id).first<{id:string;company_id:string}>();
  if(!row)return c.json({error:"domain_not_found"},404);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE domains SET status='suspended' WHERE id=?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'domain.suspended','domain',?)")
      .bind(newId(),actor.id,row.company_id,id)
  ]);
  return c.json({id,status:"suspended"});
});
app.post("/api/admin/domains/:id/reactivate", async (c) => {
  const actor=c.get("user"),id=c.req.param("id");
  const row=await c.env.DB.prepare("SELECT id,company_id,inbound_verified_at,outbound_verified_at FROM domains WHERE id=?")
    .bind(id).first<{id:string;company_id:string;inbound_verified_at:string|null;outbound_verified_at:string|null}>();
  if(!row)return c.json({error:"domain_not_found"},404);
  const status=row.inbound_verified_at&&row.outbound_verified_at?"active":row.inbound_verified_at?"receiving_ready":row.outbound_verified_at?"sending_ready":"pending";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE domains SET status=? WHERE id=?").bind(status,id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'domain.reactivated','domain',?)")
      .bind(newId(),actor.id,row.company_id,id)
  ]);
  return c.json({id,status});
});
app.post("/api/admin/aliases/:id/:action", async (c) => {
  const actor=c.get("user"),id=c.req.param("id"),action=c.req.param("action");
  if(action!=="suspend"&&action!=="reactivate")return c.json({error:"invalid_action"},400);
  const row=await c.env.DB.prepare("SELECT id,company_id FROM email_aliases WHERE id=?").bind(id).first<{id:string;company_id:string}>();
  if(!row)return c.json({error:"alias_not_found"},404);
  const status=action==="suspend"?"suspended":"active";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE email_aliases SET status=? WHERE id=?").bind(status,id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,?, 'email_alias',?)")
      .bind(newId(),actor.id,row.company_id,action==="suspend"?"alias.suspended":"alias.reactivated",id)
  ]);
  return c.json({id,status});
});

app.get("/api/admin/resend/domains", async (c) => {
  if (!c.env.RESEND_API_KEY) return c.json({ error: "resend_not_configured" }, 503);
  const headers = { "Authorization": "Bearer " + c.env.RESEND_API_KEY };
  const domains: { id?: string; name?: string; status?: string; region?: string }[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const url = new URL("https://api.resend.com/domains");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after", cursor);
    let response: Response;
    try {
      response = await fetch(url.toString(), { headers });
    } catch {
      return c.json({ error: "resend_unavailable" }, 502);
    }
    const result = await response.json().catch(() => ({} as any)) as {
      data?: { id?: string; name?: string; status?: string; region?: string }[];
      has_more?: boolean; message?: string;
    };
    if (!response.ok) {
      return c.json({
        error: "resend_domain_lookup_failed",
        provider_status: response.status,
        provider_message: typeof result.message === "string" ? result.message.slice(0, 240) : undefined
      }, 502);
    }
    const items = Array.isArray(result.data) ? result.data : [];
    domains.push(...items);
    if (result.has_more !== true || !items.length) break;
    cursor = items[items.length - 1].id;
    if (!cursor) break;
  }
  return c.json({
    accessible: true,
    count: domains.length,
    domains: domains.map(({ id, name, status, region }) => ({ id, name, status, region }))
  });
});

app.post("/api/admin/domains/:id/resend/setup", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  if (!c.env.RESEND_API_KEY) return c.json({ error: "resend_not_configured" }, 503);

  const row = await c.env.DB.prepare(
    "SELECT id,company_id,domain,resend_domain_id FROM domains WHERE id=?"
  ).bind(id).first<{
    id: string; company_id: string; domain: string; resend_domain_id: string | null;
  }>();
  if (!row) return c.json({ error: "domain_not_found" }, 404);

  const headers = {
    "Authorization": "Bearer " + c.env.RESEND_API_KEY,
    "Content-Type": "application/json"
  };
  type ResendDomain = {
    id?: string; name?: string; status?: string; records?: unknown[]; message?: string;
  };
  let selected: ResendDomain | undefined;
  const source = "existing" as const;

  // Si ya existe un ID guardado, SIEMPRE consultamos el detalle actual.
  // Así reparamos registros DNS vacíos o desactualizados de intentos anteriores.
  if (row.resend_domain_id) {
    let detailResponse: Response;
    try {
      detailResponse = await fetch(
        "https://api.resend.com/domains/" + encodeURIComponent(row.resend_domain_id),
        { headers }
      );
    } catch {
      return c.json({ error: "resend_unavailable", stage: "get_domain" }, 502);
    }
    const detail = await detailResponse.json().catch(() => ({} as any)) as ResendDomain;
    if (!detailResponse.ok) {
      return c.json({
        error: "resend_domain_details_failed",
        provider_status: detailResponse.status,
        provider_message: typeof detail.message === "string" ? detail.message.slice(0, 240) : undefined
      }, 502);
    }
    selected = detail;
  } else {
    // El dominio puede haberse creado manualmente en el panel de Resend.
    let listResponse: Response;
    try {
      listResponse = await fetch("https://api.resend.com/domains?limit=100", { headers });
    } catch {
      return c.json({ error: "resend_unavailable", stage: "list_domains" }, 502);
    }
    const listResult = await listResponse.json().catch(() => ({} as any)) as {
      data?: ResendDomain[]; message?: string; has_more?: boolean;
    };
    if (!listResponse.ok) {
      return c.json({
        error: "resend_domain_lookup_failed",
        provider_status: listResponse.status,
        provider_message: typeof listResult.message === "string" ? listResult.message.slice(0, 240) : undefined
      }, 502);
    }

    // Resend admite paginación; recorremos todas las páginas para evitar
    // crear un duplicado cuando el dominio existente no está en la primera.
    const listedDomains: ResendDomain[] = Array.isArray(listResult.data) ? [...listResult.data] : [];
    let hasMore = listResult.has_more === true;
    let cursor = listedDomains.length ? listedDomains[listedDomains.length - 1].id : undefined;
    let pages = 1;
    while (hasMore && cursor && pages < 10) {
      let pageResponse: Response;
      try {
        pageResponse = await fetch(
          "https://api.resend.com/domains?limit=100&after=" + encodeURIComponent(cursor),
          { headers }
        );
      } catch {
        return c.json({ error: "resend_unavailable", stage: "list_domains_pagination" }, 502);
      }
      const page = await pageResponse.json().catch(() => ({} as any)) as {
        data?: ResendDomain[]; message?: string; has_more?: boolean;
      };
      if (!pageResponse.ok) {
        return c.json({
          error: "resend_domain_lookup_failed",
          provider_status: pageResponse.status,
          provider_message: typeof page.message === "string" ? page.message.slice(0, 240) : undefined
        }, 502);
      }
      const items = Array.isArray(page.data) ? page.data : [];
      listedDomains.push(...items);
      hasMore = page.has_more === true;
      cursor = items.length ? items[items.length - 1].id : undefined;
      pages++;
    }

    selected = listedDomains.find(item =>
      typeof item.name === "string" &&
      item.name.trim().toLowerCase() === row.domain.trim().toLowerCase()
    );

    if (selected?.id) {
      // El listado no incluye records: recuperar el objeto completo del dominio.
      let detailResponse: Response;
      try {
        detailResponse = await fetch(
          "https://api.resend.com/domains/" + encodeURIComponent(selected.id),
          { headers }
        );
      } catch {
        return c.json({ error: "resend_unavailable", stage: "get_domain" }, 502);
      }
      const detail = await detailResponse.json().catch(() => ({} as any)) as ResendDomain;
      if (!detailResponse.ok) {
        return c.json({
          error: "resend_domain_details_failed",
          provider_status: detailResponse.status,
          provider_message: typeof detail.message === "string" ? detail.message.slice(0, 240) : undefined
        }, 502);
      }
      selected = detail;
    } else {
      // Los dominios deben crearse manualmente en Resend. Este endpoint solo
      // vincula dominios existentes y nunca consume el límite de creación.
      return c.json({
        error: "resend_domain_not_found_in_workspace",
        requested_domain: row.domain,
        resend_domains_visible: listedDomains
          .map(item => item.name)
          .filter((name): name is string => typeof name === "string")
      }, 409);
    }
  }

  if (!selected?.id || typeof selected.name !== "string") {
    return c.json({ error: "resend_domain_lookup_invalid_response" }, 502);
  }
  if (selected.name.trim().toLowerCase() !== row.domain.trim().toLowerCase()) {
    return c.json({
      error: "resend_domain_id_mismatch",
      requested_domain: row.domain,
      provider_domain: selected.name
    }, 409);
  }
  const records = Array.isArray(selected.records) ? selected.records : [];
  const providerStatus = selected.status === "verified"
    ? "verified"
    : selected.status === "failed" ? "failed" : "pending";
  const verified = providerStatus === "verified";

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE domains SET resend_domain_id=?,resend_records_json=?,resend_status=?,outbound_verified_at=? WHERE id=?"
    ).bind(
      selected.id,
      JSON.stringify(records),
      providerStatus,
      verified ? new Date().toISOString() : null,
      id
    ),
    c.env.DB.prepare(
      "INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,?,'domain.resend_configured','domain',?,?)"
    ).bind(
      newId(), actor.id, row.company_id, id,
      JSON.stringify({ resend_domain_id: selected.id, source, provider_status: providerStatus, records_count: records.length })
    )
  ]);

  const domainStatus = await refreshDomainStatus(c.env.DB, id);
  return c.json({
    domain_id: selected.id,
    records,
    records_count: records.length,
    status: providerStatus,
    domain_status: domainStatus,
    linked_existing: source === "existing"
  }, 200);
});

app.post("/api/admin/domains/:id/verify-outbound", async (c) => {
  const actor=c.get("user"),id=c.req.param("id");
  if(!c.env.RESEND_API_KEY)return c.json({error:"resend_not_configured"},503);
  const row=await c.env.DB.prepare("SELECT id,company_id,domain,resend_domain_id FROM domains WHERE id=?")
    .bind(id).first<{id:string;company_id:string;domain:string;resend_domain_id:string|null}>();
  if(!row)return c.json({error:"domain_not_found"},404);
  if(!row.resend_domain_id)return c.json({error:"resend_domain_not_configured"},409);
  try{
    await fetch("https://api.resend.com/domains/"+encodeURIComponent(row.resend_domain_id)+"/verify",{
      method:"POST",headers:{"Authorization":"Bearer "+c.env.RESEND_API_KEY}
    });
    const response=await fetch("https://api.resend.com/domains/"+encodeURIComponent(row.resend_domain_id),{
      headers:{"Authorization":"Bearer "+c.env.RESEND_API_KEY}
    });
    const result=await response.json().catch(()=>({} as any)) as {name?:string;status?:string;records?:unknown[]};
    if(!response.ok)return c.json({error:"resend_status_unavailable"},502);
    if(typeof result.name!=="string" || result.name.trim().toLowerCase()!==row.domain.trim().toLowerCase()){
      return c.json({error:"resend_domain_id_mismatch",requested_domain:row.domain,provider_domain:result.name||null},409);
    }
    const verified=result.status==="verified",providerStatus=verified?"verified":result.status==="failed"?"failed":"pending";
    await c.env.DB.prepare("UPDATE domains SET resend_status=?,resend_records_json=COALESCE(?,resend_records_json),outbound_verified_at=? WHERE id=?")
      .bind(providerStatus,Array.isArray(result.records)?JSON.stringify(result.records):null,verified?new Date().toISOString():null,id).run();
    const status=await refreshDomainStatus(c.env.DB,id);
    await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,?,?,'domain',?,?)")
      .bind(newId(),actor.id,row.company_id,verified?"domain.outbound_verified":"domain.outbound_verification_checked",id,JSON.stringify({provider_status:providerStatus})).run();
    return c.json({id,provider_status:providerStatus,status,outbound_verified:verified},verified?200:202);
  }catch{return c.json({error:"resend_unavailable"},502);}
});

app.post("/api/admin/domains/:id/verify-inbound", async (c) => {
  const actor=c.get("user"),id=c.req.param("id");
  const row=await c.env.DB.prepare("SELECT id,company_id,domain FROM domains WHERE id=?")
    .bind(id).first<{id:string;company_id:string;domain:string}>();
  if(!row)return c.json({error:"domain_not_found"},404);
  try{
    const dnsUrl="https://cloudflare-dns.com/dns-query?name="+encodeURIComponent(row.domain)+"&type=MX";
    const response=await fetch(dnsUrl,{headers:{Accept:"application/dns-json"}});
    if(!response.ok)return c.json({error:"dns_lookup_failed"},502);
    const result=await response.json() as {Answer?:Array<{data?:string}>};
    const mx=(result.Answer||[]).map(record=>(record.data||"").toLowerCase().trim());
    const required=["route1.mx.cloudflare.net","route2.mx.cloudflare.net","route3.mx.cloudflare.net"];
    const observed=mx.map(value=>value.split(/\s+/).slice(1).join("").replace(/\.$/,""));
    const missing=required.filter(host=>!observed.includes(host));
    const unexpected=observed.filter(host=>!required.includes(host));
    const duplicates=required.filter(host=>observed.filter(value=>value===host).length!==1);
    const verified=missing.length===0&&unexpected.length===0&&duplicates.length===0&&observed.length===required.length;
    if(!verified){
      await c.env.DB.prepare("UPDATE domains SET inbound_verified_at=NULL,inbound_dns_checked_at=? WHERE id=?")
        .bind(new Date().toISOString(),id).run();
      await refreshDomainStatus(c.env.DB,id);
      return c.json({error:"cloudflare_mx_mismatch",observed_mx:mx,missing_mx:missing,unexpected_mx:unexpected,invalid_or_duplicate_mx:duplicates},409);
    }
    await c.env.DB.prepare("UPDATE domains SET inbound_verified_at=?,inbound_dns_checked_at=? WHERE id=?")
      .bind(new Date().toISOString(),new Date().toISOString(),id).run();
    const status=await refreshDomainStatus(c.env.DB,id);
    await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'domain.inbound_verified','domain',?)")
      .bind(newId(),actor.id,row.company_id,id).run();
    return c.json({id,inbound_verified:true,status,observed_mx:mx});
  }catch{return c.json({error:"dns_lookup_failed"},502);}
});

// Domain verification is never manually asserted by an administrator.
app.post("/api/admin/domains/:id/confirm", async (c) => c.json({error:"manual_verification_disabled",message:"Utiliza la verificación real de DNS y Resend."},410));

app.post("/api/admin/accounts", async (c) => {
  const actor = c.get("user");
  const body = await c.req.json<{
    company_id?: string; domain_id?: string; local_part?: string;
    display_name?: string; password?: string;
  }>().catch(() => ({} as any));
  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  const domainId = typeof body.domain_id === "string" ? body.domain_id.trim() : "";
  const localPart = typeof body.local_part === "string" ? body.local_part.trim().toLowerCase() : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!companyId || !domainId || !localPart || !isValidLocalPart(localPart) ||
      displayName.length > 120 || password.length < 12 || password.length > 256) {
    return c.json({ error: "invalid_account", message: "Indica empresa, dominio, nombre válido y contraseña de al menos 12 caracteres." }, 400);
  }
  const domain = await c.env.DB.prepare(
    "SELECT d.id, d.company_id, d.domain FROM domains d JOIN companies co ON co.id = d.company_id AND co.status = 'active' WHERE d.id = ? AND d.company_id = ? AND d.status != 'suspended'"
  ).bind(domainId, companyId).first<{ id: string; company_id: string; domain: string }>();
  if (!domain) return c.json({ error: "domain_not_available" }, 409);
  const address = localPart + "@" + domain.domain.toLowerCase();
  const conflict = await c.env.DB.prepare(
    "SELECT id FROM email_accounts WHERE domain_id = ? AND local_part = ? UNION SELECT id FROM email_aliases WHERE domain_id = ? AND local_part = ? LIMIT 1"
  ).bind(domainId, localPart, domainId, localPart).first();
  if (conflict) return c.json({ error: "address_already_exists" }, 409);
  const existingIdentity = await c.env.DB.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1").bind(address).first();
  if (existingIdentity) return c.json({ error: "mailbox_identity_exists", message: "Ya existe una identidad de acceso con esa dirección." }, 409);

  const accountId = newId(), userId = newId();
  const credentials = await hashPassword(password);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO email_accounts (id, company_id, domain_id, local_part, display_name) VALUES (?, ?, ?, ?, ?)")
        .bind(accountId, companyId, domainId, localPart, displayName || null),
      c.env.DB.prepare("INSERT INTO users (id,email,display_name,password_hash,password_salt,status,is_superadmin) VALUES (?,?,?,?,?,'active',0)")
        .bind(userId, address, displayName || address, credentials.hash, credentials.salt),
      c.env.DB.prepare("INSERT INTO company_memberships (user_id,company_id,role) VALUES (?,?,'member')").bind(userId, companyId),
      c.env.DB.prepare("INSERT INTO account_permissions (account_id,user_id,permission) VALUES (?,?,'read_write')").bind(accountId, userId),
      c.env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,company_id,action,resource_type,resource_id,metadata_json) VALUES (?, ?, ?, 'account.created', 'email_account', ?, ?)")
        .bind(newId(), actor.id, companyId, accountId, JSON.stringify({ address, mailbox_user_id: userId }))
    ]);
  } catch {
    return c.json({ error: "account_conflict", message: "No se pudo crear el buzón. Comprueba que la dirección no esté registrada." }, 409);
  }
  return c.json({ account: { id: accountId, company_id: companyId, domain_id: domainId,
    address, display_name: displayName || null, status: "active", login_email: address } }, 201);
});

app.put("/api/admin/accounts/:id", async (c) => {
  const actor = c.get("user"), id = c.req.param("id");
  const body = await c.req.json<{ display_name?: string }>().catch(() => ({} as any));
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (displayName.length > 120) return c.json({ error: "invalid_display_name" }, 400);
  const account = await c.env.DB.prepare(
    "SELECT ea.id,ea.company_id,ea.local_part,d.domain FROM email_accounts ea JOIN domains d ON d.id=ea.domain_id WHERE ea.id=?"
  ).bind(id).first<{id:string;company_id:string;local_part:string;domain:string}>();
  if (!account) return c.json({ error: "account_not_found" }, 404);
  const address = account.local_part + "@" + account.domain;
  const identity = await c.env.DB.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE").bind(address).first<{id:string}>();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE email_accounts SET display_name=? WHERE id=?").bind(displayName || null,id)
  ];
  if (identity) statements.push(c.env.DB.prepare("UPDATE users SET display_name=? WHERE id=?").bind(displayName || address,identity.id));
  statements.push(c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,?,'account.updated','email_account',?,?)")
    .bind(newId(),actor.id,account.company_id,id,JSON.stringify({display_name:displayName})));
  await c.env.DB.batch(statements);
  return c.json({id,display_name:displayName || null});
});

app.post("/api/admin/accounts/:id/password", async (c) => {
  const actor=c.get("user"), id=c.req.param("id");
  const body=await c.req.json<{password?:string}>().catch(()=>({} as any));
  if(typeof body.password!=="string"||body.password.length<12||body.password.length>256)
    return c.json({error:"invalid_password",message:"La contraseña debe tener entre 12 y 256 caracteres."},400);
  const account=await c.env.DB.prepare(
    "SELECT ea.id,ea.company_id,ea.local_part,ea.status,d.domain FROM email_accounts ea JOIN domains d ON d.id=ea.domain_id WHERE ea.id=?"
  ).bind(id).first<{id:string;company_id:string;local_part:string;status:string;domain:string}>();
  if(!account)return c.json({error:"account_not_found"},404);
  const address=account.local_part+"@"+account.domain;
  const identity=await c.env.DB.prepare("SELECT id,is_superadmin FROM users WHERE email=? COLLATE NOCASE").bind(address).first<{id:string;is_superadmin:number}>();
  if(identity?.is_superadmin===1)return c.json({error:"mailbox_identity_conflict",message:"La dirección está reservada por una cuenta administrativa."},409);
  const userId=identity?.id||newId(), credentials=await hashPassword(body.password);
  const statements:D1PreparedStatement[]=[];
  if(!identity)statements.push(c.env.DB.prepare(
    "INSERT INTO users(id,email,display_name,password_hash,password_salt,status,is_superadmin) VALUES(?,?,?,?,?,?,0)"
  ).bind(userId,address,address,credentials.hash,credentials.salt,account.status));
  else statements.push(c.env.DB.prepare("UPDATE users SET password_hash=?,password_salt=?,status=? WHERE id=?")
    .bind(credentials.hash,credentials.salt,account.status,userId));
  statements.push(
    c.env.DB.prepare("INSERT OR IGNORE INTO company_memberships(user_id,company_id,role) VALUES(?,?,'member')").bind(userId,account.company_id),
    c.env.DB.prepare("DELETE FROM account_permissions WHERE account_id=? AND user_id<>?").bind(id,userId),
    c.env.DB.prepare("INSERT OR IGNORE INTO account_permissions(account_id,user_id,permission) VALUES(?,?,'read_write')").bind(id,userId),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(userId),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'account.password_reset','email_account',?)")
      .bind(newId(),actor.id,account.company_id,id)
  );
  await c.env.DB.batch(statements);
  return c.json({id,password_updated:true,sessions_revoked:true,login_email:address});
});

app.post("/api/admin/aliases", async (c) => {
  const actor = c.get("user");
  if (!actor.isSuperadmin) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ domain_id?: string; local_part?: string; target_account_id?: string }>().catch(() => ({} as any));
  const domainId = typeof body.domain_id === "string" ? body.domain_id.trim() : "";
  const localPart = typeof body.local_part === "string" ? body.local_part.trim().toLowerCase() : "";
  const targetId = typeof body.target_account_id === "string" ? body.target_account_id.trim() : "";
  if (!domainId || !localPart || !targetId || !isValidLocalPart(localPart)) return c.json({ error: "invalid_alias" }, 400);
  const target = await c.env.DB.prepare(
    `SELECT ea.id, ea.company_id, d.id AS domain_id, d.domain
     FROM email_accounts ea JOIN domains d ON d.id = ?
     JOIN companies co ON co.id = ea.company_id AND co.status = 'active'
     WHERE ea.id = ? AND ea.company_id = d.company_id AND ea.status = 'active' AND d.status != 'suspended'`
  ).bind(domainId, targetId).first<{ id: string; company_id: string; domain_id: string; domain: string }>();
  if (!target) return c.json({ error: "target_account_not_found" }, 404);
  const conflict = await c.env.DB.prepare(
    "SELECT id FROM email_accounts WHERE domain_id = ? AND local_part = ? UNION SELECT id FROM email_aliases WHERE domain_id = ? AND local_part = ? LIMIT 1"
  ).bind(domainId, localPart, domainId, localPart).first();
  if (conflict) return c.json({ error: "address_already_exists" }, 409);
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO email_aliases (id, company_id, domain_id, local_part, target_account_id) VALUES (?, ?, ?, ?, ?)")
        .bind(id, target.company_id, domainId, localPart, targetId),
      c.env.DB.prepare("INSERT INTO audit_logs (id, actor_user_id, company_id, action, resource_type, resource_id) VALUES (?, ?, ?, 'alias.created', 'email_alias', ?)")
        .bind(newId(), actor.id, target.company_id, id)
    ]);
  } catch { return c.json({ error: "alias_conflict" }, 409); }
  return c.json({ alias: { id, address: `${localPart}@${target.domain}`, targetAccountId: targetId } }, 201);
});

app.get("/api/admin/accounts/:id/permissions", async (c) => {
  const id=c.req.param("id");
  const account=await c.env.DB.prepare("SELECT id FROM email_accounts WHERE id=?").bind(id).first();
  if(!account)return c.json({error:"account_not_found"},404);
  const rows=await c.env.DB.prepare("SELECT ap.user_id,u.email,ap.permission FROM account_permissions ap JOIN users u ON u.id=ap.user_id WHERE ap.account_id=? ORDER BY u.email")
    .bind(id).all();
  return c.json({permissions:rows.results});
});

app.put("/api/admin/accounts/:id/permissions", async (c) => {
  const actor=c.get("user"),id=c.req.param("id");
  const body=await c.req.json<{user_ids?:unknown;permission?:string}>().catch(()=>({} as any));
  const userIds=Array.isArray(body.user_ids)?[...new Set(body.user_ids.filter((value:unknown):value is string=>typeof value==="string"&&value.trim().length>0).map((value:string)=>value.trim()))]:null;
  const permission=body.permission||"read_write";
  if(!userIds||userIds.length>50||!["read_only","read_write","send_only"].includes(permission))return c.json({error:"invalid_permissions"},400);
  const account=await c.env.DB.prepare("SELECT id,company_id FROM email_accounts WHERE id=?").bind(id).first<{id:string;company_id:string}>();
  if(!account)return c.json({error:"account_not_found"},404);
  if(userIds.length){
    const placeholders=userIds.map(()=>"?").join(",");
    const valid=await c.env.DB.prepare(`SELECT COUNT(*) total FROM company_memberships cm JOIN users u ON u.id=cm.user_id
      WHERE cm.company_id=? AND u.status='active' AND cm.user_id IN (${placeholders})`).bind(account.company_id,...userIds).first<{total:number}>();
    if((valid?.total??0)!==userIds.length)return c.json({error:"invalid_user_assignment"},400);
  }
  const statements:D1PreparedStatement[]=[
    c.env.DB.prepare("DELETE FROM account_permissions WHERE account_id=?").bind(id),
    ...userIds.map(userId=>c.env.DB.prepare("INSERT INTO account_permissions(account_id,user_id,permission) VALUES(?,?,?)").bind(id,userId,permission)),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id,metadata_json) VALUES(?,?,?,'account.permissions_updated','email_account',?,?)")
      .bind(newId(),actor.id,account.company_id,id,JSON.stringify({user_ids:userIds,permission}))
  ];
  await c.env.DB.batch(statements);
  return c.json({id,user_ids:userIds,permission});
});

app.post("/api/admin/accounts/:id/:action", async (c) => {
  const actor = c.get("user");
  const action = c.req.param("action");
  if (action !== "suspend" && action !== "reactivate") return c.json({ error: "invalid_action" }, 400);
  const id = c.req.param("id"), status = action === "suspend" ? "suspended" : "active";
  const account = await c.env.DB.prepare(
    "SELECT ea.id,ea.company_id,ea.local_part,d.domain FROM email_accounts ea JOIN domains d ON d.id=ea.domain_id WHERE ea.id=?"
  ).bind(id).first<{id:string;company_id:string;local_part:string;domain:string}>();
  if (!account) return c.json({ error: "account_not_found" }, 404);
  const address=account.local_part+"@"+account.domain;
  const identity=await c.env.DB.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE AND is_superadmin=0").bind(address).first<{id:string}>();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE email_accounts SET status=? WHERE id=?").bind(status,id)
  ];
  if(identity){
    statements.push(c.env.DB.prepare("UPDATE users SET status=? WHERE id=?").bind(status,identity.id));
    if(status==="suspended")statements.push(c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(identity.id));
  }
  statements.push(c.env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,company_id,action,resource_type,resource_id) VALUES (?,?,?,?,'email_account',?)")
    .bind(newId(),actor.id,account.company_id,action==="suspend"?"account.suspended":"account.reactivated",id));
  await c.env.DB.batch(statements);
  return c.json({id,status,sessions_revoked:status==="suspended"});
});


function parseRecipients(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;,]/).flatMap((part) => part.split(String.fromCharCode(10)))
      : null;
  if (!raw || raw.length > 50) return null;
  const emails = raw.map((item) => typeof item === "string" ? item.trim().toLowerCase() : "").filter(Boolean);
  if (emails.length > 50 || emails.some((email) => {
    if (email.length > 254) return true;
    const at = email.lastIndexOf("@");
    return at <= 0 || at !== email.indexOf("@") ||
      !isValidLocalPart(email.slice(0, at)) || !isValidDomain(email.slice(at + 1));
  })) return null;
  return [...new Set(emails)];
}

type DraftAccount = { id: string; company_id: string; local_part: string; domain: string };
async function getDraftAccount(c: any, accountId: string, user: { id: string; isSuperadmin: boolean }): Promise<DraftAccount | null> {
  const sql = `SELECT ea.id, ea.company_id, ea.local_part, d.domain
    FROM email_accounts ea
    JOIN companies co ON co.id = ea.company_id AND co.status = 'active'
    JOIN domains d ON d.id = ea.domain_id AND d.status != 'suspended'
    WHERE ea.id = ? AND ea.status = 'active'`;
  if (user.isSuperadmin) {
    return await c.env.DB.prepare(sql).bind(accountId).first() as DraftAccount | null;
  }
  return c.env.DB.prepare(sql + ` AND EXISTS (
    SELECT 1 FROM company_memberships cm
    JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = cm.user_id
    WHERE cm.user_id = ? AND cm.company_id = ea.company_id
      AND ap.permission = 'read_write'
  ) AND (? IS NULL OR ea.company_id = ?)`).bind(accountId, user.id, c.get("hostCompanyId"), c.get("hostCompanyId")).first() as Promise<DraftAccount | null>;
}

function formatFromAddress(displayName: string | null | undefined, address: string): string {
  const safeName = (displayName || "").trim().replace(/[\r\n\u0000-\u001f\u007f]/g, "").slice(0, 120);
  if (!safeName) return address;
  return '"' + safeName.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '" <' + address + '>';
}

async function getSendAccount(c: any, accountId: string, user: { id: string; isSuperadmin: boolean }) {
  const sql = `SELECT ea.id, ea.company_id, ea.local_part, d.domain, ea.display_name
    FROM email_accounts ea
    JOIN companies co ON co.id = ea.company_id AND co.status = 'active'
    JOIN domains d ON d.id = ea.domain_id AND d.status IN ('sending_ready','active')
    WHERE ea.id = ? AND ea.status = 'active' AND d.outbound_verified_at IS NOT NULL`;
  if (user.isSuperadmin) return c.env.DB.prepare(sql).bind(accountId).first();
  return c.env.DB.prepare(sql + ` AND EXISTS (
    SELECT 1 FROM company_memberships cm
    JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = cm.user_id
    WHERE cm.user_id = ? AND cm.company_id = ea.company_id
      AND ap.permission IN ('read_write','send_only')
  ) AND (? IS NULL OR ea.company_id = ?)`).bind(accountId, user.id, c.get("hostCompanyId"), c.get("hostCompanyId")).first();
}

// Read-only per-mailbox send preflight. Does not contact Resend or disclose secrets.
app.get("/api/sending/readiness", async (c) => {
  const accountId = (c.req.query("account_id") || "").trim();
  if (!accountId || accountId.length > 128) return c.json({error:"invalid_account_id"},400);
  const user = c.get("user");
  const account = await getSendAccount(c,accountId,user);
  if (!account) return c.json({ready:false,transport:"resend_relay",reason:"account_or_domain_not_ready"});
  const preflight = getOutboundPreflight(c.env);
  return c.json({...preflight,account_id:accountId});
});

// Authorized, read-only Worker-to-Worker network diagnostic. Never sends mail.
app.get("/api/sending/diagnostic", async (c) => {
  const accountId = (c.req.query("account_id") || "").trim();
  if (!accountId || accountId.length > 128) return c.json({error:"invalid_account_id"},400);
  const account = await getSendAccount(c,accountId,c.get("user"));
  if (!account) return c.json({error:"account_or_domain_not_ready"},403);
  const diagnostic = await diagnoseRelayConnectivity(c.env);
  return c.json({transport:"resend_relay",...diagnostic});
});

app.post("/api/messages/send", async (c) => {
  const user = c.get("user");
  if (!c.env.CONTROL_PLANE_URL || !c.env.INSTALLATION_ID || !c.env.RESEND_RELAY_TOKEN) return c.json({ error: "sending_not_configured" }, 503);
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > 15 * 1024 * 1024) return c.json({ error: "message_payload_too_large" }, 413);
  const body = await c.req.json<{
    account_id?: string; to?: unknown; cc?: unknown; bcc?: unknown;
    subject?: string; text_body?: string; idempotency_key?: string; in_reply_to?: string; references?: string[]; attachments?: unknown;
  }>().catch(() => ({} as any));
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  const to = parseRecipients(body.to);
  const cc = parseRecipients(body.cc);
  const bcc = parseRecipients(body.bcc);
  const attachments = await parseOutboundAttachments(body.attachments);
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 998) : "";
  const textBody = typeof body.text_body === "string" ? body.text_body : "";
  const requestId = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  const messageIdPattern = /^<[^<>\s\r\n]{1,250}>$/;
  const inReplyTo = typeof body.in_reply_to === "string" && messageIdPattern.test(body.in_reply_to.trim()) ? body.in_reply_to.trim() : "";
  const validReferences = Array.isArray(body.references) && body.references.length <= 20 &&
    body.references.every((v: unknown) => typeof v === "string" && messageIdPattern.test(v.trim()));
  const references = validReferences ? (body.references as string[]).map(v => v.trim()).join(" ").slice(0, 4000) : "";
  if (!accountId || !to || !to.length || !cc || !bcc || !attachments || !textBody.trim() ||
      textBody.length > 200000 || /[\r\n]/.test(subject) || (body.in_reply_to !== undefined && !inReplyTo) || (body.references !== undefined && !validReferences) || !requestId || requestId.length > 128 ||
      !/^[a-zA-Z0-9._:-]+$/.test(requestId)) {
    return c.json({ error: "invalid_message" }, 400);
  }

  const account = await getSendAccount(c, accountId, user) as {
    id: string; company_id: string; local_part: string; domain: string; display_name: string | null;
  } | null;
  if (!account) return c.json({ error: "account_not_found_or_sending_domain_unverified" }, 404);

  const from = account.local_part + "@" + account.domain;
  const existing = await c.env.DB.prepare(
    `SELECT id, delivery_status, provider_message_id, to_addresses, cc_addresses,
            bcc_addresses, subject, text_body, in_reply_to, references_header, attachments_manifest
     FROM messages WHERE account_id = ? AND client_request_id = ? LIMIT 1`
  ).bind(accountId, requestId).first<{
    id: string; delivery_status: string; provider_message_id: string | null;
    to_addresses: string; cc_addresses: string; bcc_addresses: string;
    subject: string; text_body: string; in_reply_to: string | null; references_header: string | null; attachments_manifest: string;
  }>();

  let messageId: string;
  if (existing) {
    if (existing.to_addresses !== JSON.stringify(to) || existing.cc_addresses !== JSON.stringify(cc) ||
        existing.bcc_addresses !== JSON.stringify(bcc) || existing.subject !== subject ||
        existing.text_body !== textBody || existing.in_reply_to !== (inReplyTo || null) || existing.references_header !== (references || null)) {
      return c.json({ error: "idempotency_key_reused_with_different_content" }, 409);
    }
    messageId = existing.id;
  } else {
    messageId = newId();
    const conversationId = newId();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO conversations (id, company_id, account_id, subject, last_message_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      ).bind(conversationId, account.company_id, accountId, subject),
      c.env.DB.prepare(
        `INSERT INTO messages
          (id, company_id, account_id, conversation_id, direction, folder, from_address,
           to_addresses, cc_addresses, bcc_addresses, subject, text_body, in_reply_to, references_header, attachments_manifest, is_read,
           delivery_status, client_request_id)
         VALUES (?, ?, ?, ?, 'outbound', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?)`
      ).bind(messageId, account.company_id, accountId, conversationId, from,
        JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, textBody, inReplyTo || null, references || null, JSON.stringify(attachments.map(item=>item.hash).sort()), requestId)
    ]);
  }


  const existingAttachmentRows = await c.env.DB.prepare("SELECT content_hash FROM attachments WHERE message_id=?")
    .bind(messageId).all<{content_hash:string|null}>();
  const storedHashes = existingAttachmentRows.results.map(row => row.content_hash || "").sort();
  const requestedHashes = attachments.map(item => item.hash).sort();
  if (existing && (existing.attachments_manifest !== JSON.stringify(requestedHashes) ||
      (storedHashes.length > 0 && (storedHashes.length !== requestedHashes.length ||
      storedHashes.some((hash,index) => hash !== requestedHashes[index]))))) {
    return c.json({error:"idempotency_key_reused_with_different_attachments"},409);
  }
  if (existing?.provider_message_id) {
    return c.json({id:existing.id,status:existing.delivery_status,provider_message_id:existing.provider_message_id},200);
  }
  if (!storedHashes.length && attachments.length) {
    const keys:string[]=[];
    const statements:D1PreparedStatement[]=[];
    const reservationId=await reserveMailStorage(c.env.DB,account.company_id,messageId,attachments.reduce((total,item)=>total+item.size,0));
    if(!reservationId){
      await c.env.DB.prepare("UPDATE messages SET delivery_status='failed',send_last_error='KV storage quota reached' WHERE id=? AND delivery_status='queued'").bind(messageId).run();
      return c.json({error:"storage_quota_exceeded"},507);
    }
    try {
      for (const attachment of attachments) {
        const attachmentId=newId();
        const storageKey="attachments/outbound/"+account.company_id+"/"+accountId+"/"+messageId+"/"+attachmentId;
        await c.env.MAIL_STORAGE.put(storageKey,attachment.bytes);
        keys.push(storageKey);
        statements.push(c.env.DB.prepare("INSERT INTO attachments(id,message_id,filename,content_type,size_bytes,storage_key,content_hash) VALUES(?,?,?,?,?,?,?)")
          .bind(attachmentId,messageId,attachment.filename,attachment.contentType,attachment.size,storageKey,attachment.hash));
      }
      statements.push(c.env.DB.prepare("UPDATE mail_storage_reservations SET status='committed',expires_at=NULL WHERE id=? AND status='reserved'").bind(reservationId));
      await c.env.DB.batch(statements);
    } catch {
      await Promise.all(keys.map(key=>c.env.MAIL_STORAGE.delete(key).catch(()=>undefined)));
      await releaseMailStorage(c.env.DB,reservationId);
      await c.env.DB.prepare("UPDATE messages SET delivery_status='failed',send_last_error='Attachment storage unavailable' WHERE id=? AND delivery_status='queued'").bind(messageId).run();
      return c.json({error:"attachment_storage_unavailable"},503);
    }
  }

  await c.env.DB.prepare(
    "UPDATE messages SET delivery_status = 'queued', send_attempts = 0, send_next_attempt_at = NULL, send_last_error = NULL WHERE id = ? AND provider_message_id IS NULL"
  ).bind(messageId).run();

  const payload: Record<string, unknown> = { from: formatFromAddress(account.display_name, from), to, subject, text: textBody };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (attachments.length) payload.attachments = [...attachments].sort((a,b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0).map(item => ({ filename:item.filename, content:item.base64 }));
  if (inReplyTo || references) payload.headers = { ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}), ...(references ? { "References": references } : {}) };
  const relay=await sendViaResendRelay(c.env,payload,requestId);
  if(!relay.ok||!relay.providerId){
    const permanent=relay.status>=400&&relay.status<500&&relay.status!==429;
    if(permanent){await c.env.DB.prepare("UPDATE messages SET delivery_status='failed',send_attempts=1,send_next_attempt_at=NULL,send_last_error=? WHERE id=? AND delivery_status='queued'").bind("Resend relay rejected the message ("+(relay.error||"provider error")+")",messageId).run();return c.json({error:"provider_rejected_message"},502);}
    await c.env.DB.prepare("UPDATE messages SET delivery_status='queued',send_attempts=1,send_next_attempt_at=?,send_last_error=? WHERE id=? AND delivery_status='queued'").bind(new Date(Date.now()+60000).toISOString(),"Temporary Resend relay error ("+(relay.error||"unavailable")+")",messageId).run();return c.json({id:messageId,status:"queued",retry_scheduled:true},202);
  }
  await c.env.DB.prepare("UPDATE messages SET delivery_status='sent',provider_message_id=?,sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),send_attempts=1,send_next_attempt_at=NULL,send_last_error=NULL WHERE id=? AND delivery_status='queued'").bind(relay.providerId,messageId).run();
  return c.json({id:messageId,status:"sent",provider_message_id:relay.providerId},201);
});

// Draft read/delete routes: scoped to the sender's permitted account.
async function authorizeDraft(c: any, id: string) {
  const user = c.get("user");
  if (user.isSuperadmin) {
    return c.env.DB.prepare(
      `SELECT m.id,m.account_id,m.to_addresses,m.cc_addresses,m.bcc_addresses,m.subject,m.text_body
       FROM messages m JOIN email_accounts ea ON ea.id=m.account_id
       JOIN companies co ON co.id=ea.company_id
       WHERE m.id=? AND m.folder='drafts' AND ea.status='active' AND co.status='active'`
    ).bind(id).first();
  }
  return c.env.DB.prepare(
    `SELECT m.id,m.account_id,m.to_addresses,m.cc_addresses,m.bcc_addresses,m.subject,m.text_body
     FROM messages m JOIN email_accounts ea ON ea.id=m.account_id
     JOIN companies co ON co.id=ea.company_id
     JOIN company_memberships cm ON cm.company_id=ea.company_id AND cm.user_id=?
     JOIN account_permissions ap ON ap.account_id=ea.id AND ap.user_id=?
     WHERE m.id=? AND m.folder='drafts' AND ea.status='active' AND co.status='active'
       AND ap.permission = 'read_write'
       AND (? IS NULL OR ea.company_id=?)`
  ).bind(user.id,user.id,id,c.get("hostCompanyId"),c.get("hostCompanyId")).first();
}

app.get("/api/drafts/:id", async (c) => {
  const draft = await authorizeDraft(c,c.req.param("id"));
  if (!draft) return c.json({error:"draft_not_found"},404);
  return c.json({draft});
});

app.delete("/api/drafts/:id", async (c) => {
  const id=c.req.param("id");
  const draft=await authorizeDraft(c,id);
  if (!draft) return c.json({error:"draft_not_found"},404);
  const user = c.get("user");
  const guard = user.isSuperadmin ? "" : ` AND EXISTS (
    SELECT 1 FROM email_accounts ea
    JOIN companies co ON co.id=ea.company_id AND co.status='active'
    JOIN company_memberships cm ON cm.company_id=ea.company_id AND cm.user_id=?
    JOIN account_permissions ap ON ap.account_id=ea.id AND ap.user_id=?
      AND ap.permission='read_write'
    WHERE ea.id=messages.account_id AND ea.status='active'
      AND ea.company_id=?
  )`;
  const args = user.isSuperadmin ? [id] : [id,user.id,user.id,c.get("hostCompanyId")];
  const result=await c.env.DB.prepare("DELETE FROM messages WHERE id=? AND folder='drafts'"+guard).bind(...args).run();
  if((result.meta.changes??0)!==1)return c.json({error:"draft_not_found"},404);
  return c.json({id,deleted:true});
});

app.post("/api/drafts", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    account_id?: string; to?: unknown; cc?: unknown; bcc?: unknown;
    subject?: string; text_body?: string;
  }>().catch(() => ({} as any));
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  const to = parseRecipients(body.to);
  const cc = parseRecipients(body.cc);
  const bcc = parseRecipients(body.bcc);
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 998) : "";
  const textBody = typeof body.text_body === "string" ? body.text_body : "";
  if (!accountId || !to || !cc || !bcc || textBody.length > 200000) {
    return c.json({ error: "invalid_draft" }, 400);
  }
  const account = await getDraftAccount(c, accountId, user);
  if (!account) return c.json({ error: "account_not_found_or_forbidden" }, 404);
  const id = newId();
  const from = `${account.local_part}@${account.domain}`;
  await c.env.DB.prepare(
    `INSERT INTO messages
      (id, company_id, account_id, direction, folder, from_address, to_addresses,
       cc_addresses, bcc_addresses, subject, text_body, is_read)
     VALUES (?, ?, ?, 'outbound', 'drafts', ?, ?, ?, ?, ?, ?, 1)`
  ).bind(id, account.company_id, accountId, from, JSON.stringify(to), JSON.stringify(cc),
    JSON.stringify(bcc), subject, textBody).run();
  return c.json({ draft: { id, accountId, from, to, cc, bcc, subject } }, 201);
});

app.patch("/api/drafts/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{
    to?: unknown; cc?: unknown; bcc?: unknown; subject?: string; text_body?: string;
  }>().catch(() => ({} as any));
  const to = parseRecipients(body.to);
  const cc = parseRecipients(body.cc);
  const bcc = parseRecipients(body.bcc);
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 998) : undefined;
  const textBody = typeof body.text_body === "string" ? body.text_body : undefined;
  if ((body.to !== undefined && !to) || (body.cc !== undefined && !cc) ||
      (body.bcc !== undefined && !bcc) || (textBody !== undefined && textBody.length > 200000) ||
      (subject === undefined && textBody === undefined && body.to === undefined && body.cc === undefined && body.bcc === undefined)) {
    return c.json({ error: "invalid_draft_update" }, 400);
  }
  const access = user.isSuperadmin
    ? await c.env.DB.prepare(
        `SELECT m.id FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
         JOIN companies co ON co.id = ea.company_id
         WHERE m.id = ? AND m.folder = 'drafts' AND ea.status = 'active' AND co.status = 'active'`
      ).bind(id).first()
    : await c.env.DB.prepare(
        `SELECT m.id FROM messages m JOIN email_accounts ea ON ea.id = m.account_id
         JOIN companies co ON co.id = ea.company_id
         JOIN company_memberships cm ON cm.company_id = ea.company_id AND cm.user_id = ?
         JOIN account_permissions ap ON ap.account_id = ea.id AND ap.user_id = ?
         WHERE m.id = ? AND m.folder = 'drafts' AND ea.status = 'active'
           AND co.status = 'active' AND ap.permission = 'read_write'
           AND (? IS NULL OR ea.company_id = ?)`
      ).bind(user.id, user.id, id, c.get("hostCompanyId"), c.get("hostCompanyId")).first();
  if (!access) return c.json({ error: "draft_not_found" }, 404);
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (body.to !== undefined) { sets.push("to_addresses = ?"); values.push(JSON.stringify(to)); }
  if (body.cc !== undefined) { sets.push("cc_addresses = ?"); values.push(JSON.stringify(cc)); }
  if (body.bcc !== undefined) { sets.push("bcc_addresses = ?"); values.push(JSON.stringify(bcc)); }
  if (subject !== undefined) { sets.push("subject = ?"); values.push(subject); }
  if (textBody !== undefined) { sets.push("text_body = ?"); values.push(textBody); }
  values.push(id);
  const guard = user.isSuperadmin ? "" : ` AND EXISTS (
    SELECT 1 FROM email_accounts ea
    JOIN companies co ON co.id=ea.company_id AND co.status='active'
    JOIN company_memberships cm ON cm.company_id=ea.company_id AND cm.user_id=?
    JOIN account_permissions ap ON ap.account_id=ea.id AND ap.user_id=?
      AND ap.permission='read_write'
    WHERE ea.id=messages.account_id AND ea.status='active'
      AND ea.company_id=?
  )`;
  const args = user.isSuperadmin ? values : [...values,user.id,user.id,c.get("hostCompanyId")];
  const result=await c.env.DB.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ? AND folder='drafts'`+guard).bind(...args).run();
  if((result.meta.changes??0)!==1)return c.json({error:"draft_not_found"},404);
  return c.json({ id, updated: true });
});


app.get("/api/contacts", async (c) => {
  const user=c.get("user"), query=(c.req.query("q")||"").trim().slice(0,120), limit=Math.min(Math.max(Number(c.req.query("limit")||50),1),100);
  const requestedCompanyId=(c.req.query("company_id")||"").trim();
  const companyId=user.isSuperadmin?requestedCompanyId:(c.get("hostCompanyId")||requestedCompanyId);
  if(user.isSuperadmin&&!companyId){
    const rows=await c.env.DB.prepare(`SELECT id,company_id,email,display_name,notes,created_at FROM contacts
      WHERE (?='' OR email LIKE ? OR display_name LIKE ?) ORDER BY display_name,email LIMIT ?`)
      .bind(query, "%"+query+"%", "%"+query+"%", limit).all();
    return c.json({contacts:rows.results});
  }
  if(!companyId)return c.json({contacts:[]});
  if(!user.isSuperadmin){
    const member=await c.env.DB.prepare("SELECT 1 FROM company_memberships WHERE user_id=? AND company_id=?")
      .bind(user.id,companyId).first();
    if(!member)return c.json({error:"forbidden"},403);
  }
  const rows=await c.env.DB.prepare(`SELECT id,company_id,email,display_name,notes,created_at FROM contacts
    WHERE company_id=? AND (?='' OR email LIKE ? OR display_name LIKE ?) ORDER BY display_name,email LIMIT ?`)
    .bind(companyId,query,"%"+query+"%","%"+query+"%",limit).all();
  return c.json({contacts:rows.results});
});

app.post("/api/contacts", async (c) => {
  const user=c.get("user"), body=await c.req.json<{company_id?:string;email?:string;display_name?:string;notes?:string}>().catch(()=>({} as any));
  const requestedCompanyId=typeof body.company_id==="string"?body.company_id.trim():"";
  const companyId=user.isSuperadmin?requestedCompanyId:(c.get("hostCompanyId")||requestedCompanyId);
  const email=typeof body.email==="string"?body.email.trim().toLowerCase():"";
  const displayName=typeof body.display_name==="string"?body.display_name.trim():"";
  const notes=typeof body.notes==="string"?body.notes.trim():"";
  const at=email.lastIndexOf("@");
  if(!companyId||at<=0||at!==email.indexOf("@")||!isValidLocalPart(email.slice(0,at))||!isValidDomain(email.slice(at+1))||
    email.length>254||displayName.length>120||notes.length>2000)return c.json({error:"invalid_contact"},400);
  const company=await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND status='active'").bind(companyId).first();
  if(!company)return c.json({error:"company_not_found"},404);
  if(!user.isSuperadmin){
    const member=await c.env.DB.prepare("SELECT 1 FROM company_memberships WHERE user_id=? AND company_id=?")
      .bind(user.id,companyId).first();
    if(!member)return c.json({error:"forbidden"},403);
  }
  const id=newId();
  try{
    await c.env.DB.prepare("INSERT INTO contacts(id,company_id,email,display_name,notes) VALUES(?,?,?,?,?)")
      .bind(id,companyId,email,displayName||null,notes||null).run();
  }catch{return c.json({error:"contact_already_exists"},409);}
  await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'contact.created','contact',?)")
    .bind(newId(),user.id,companyId,id).run();
  return c.json({contact:{id,company_id:companyId,email,display_name:displayName,notes}},201);
});

app.patch("/api/contacts/:id", async (c) => {
  const user=c.get("user"),id=c.req.param("id"),body=await c.req.json<{email?:string;display_name?:string;notes?:string}>().catch(()=>({} as any));
  const current=user.isSuperadmin
    ? await c.env.DB.prepare("SELECT id,company_id FROM contacts WHERE id=?").bind(id).first<{id:string;company_id:string}>()
    : await c.env.DB.prepare("SELECT id,company_id FROM contacts WHERE id=? AND company_id=? AND EXISTS(SELECT 1 FROM company_memberships WHERE user_id=? AND company_id=?)")
      .bind(id,c.get("hostCompanyId"),user.id,c.get("hostCompanyId")).first<{id:string;company_id:string}>();
  if(!current)return c.json({error:"contact_not_found"},404);
  const sets:string[]=[],values:(string|null)[]=[];
  if(body.email!==undefined){const email=typeof body.email==="string"?body.email.trim().toLowerCase():"",at=email.lastIndexOf("@");
    if(at<=0||at!==email.indexOf("@")||email.length>254||!isValidLocalPart(email.slice(0,at))||!isValidDomain(email.slice(at+1)))return c.json({error:"invalid_email"},400);
    sets.push("email=?");values.push(email);}
  if(body.display_name!==undefined){if(typeof body.display_name!=="string"||body.display_name.trim().length>120)return c.json({error:"invalid_display_name"},400);sets.push("display_name=?");values.push(body.display_name.trim()||null);}
  if(body.notes!==undefined){if(typeof body.notes!=="string"||body.notes.length>2000)return c.json({error:"invalid_notes"},400);sets.push("notes=?");values.push(body.notes.trim()||null);}
  if(!sets.length)return c.json({error:"no_supported_changes"},400);
  values.push(id);
  const guard = user.isSuperadmin ? "" : ` AND company_id=?
    AND EXISTS(SELECT 1 FROM company_memberships
      WHERE user_id=? AND company_id=contacts.company_id)`;
  const writeValues = user.isSuperadmin
    ? values : [...values,c.get("hostCompanyId"),user.id];
  let changed;
  try{changed=await c.env.DB.prepare("UPDATE contacts SET "+sets.join(", ")+" WHERE id=?"+guard).bind(...writeValues).run();}
  catch{return c.json({error:"contact_conflict"},409);}
  if((changed.meta.changes??0)!==1)return c.json({error:"contact_not_found"},404);
  await c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'contact.updated','contact',?)")
    .bind(newId(),user.id,current.company_id,id).run();
  return c.json({id,updated:true});
});

app.delete("/api/contacts/:id", async (c) => {
  const user=c.get("user"),id=c.req.param("id");
  const row=user.isSuperadmin
    ? await c.env.DB.prepare("SELECT id,company_id FROM contacts WHERE id=?").bind(id).first<{id:string;company_id:string}>()
    : await c.env.DB.prepare("SELECT id,company_id FROM contacts WHERE id=? AND company_id=? AND EXISTS(SELECT 1 FROM company_memberships WHERE user_id=? AND company_id=?)")
      .bind(id,c.get("hostCompanyId"),user.id,c.get("hostCompanyId")).first<{id:string;company_id:string}>();
  if(!row)return c.json({error:"contact_not_found"},404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,company_id,action,resource_type,resource_id) VALUES(?,?,?,'contact.deleted','contact',?)").bind(newId(),user.id,row.company_id,id)
  ]);
  return c.json({id,deleted:true});
});


async function processOutboundRetries(env: Env): Promise<void> {
  if (!env.CONTROL_PLANE_URL || !env.INSTALLATION_ID || !env.RESEND_RELAY_TOKEN) return;
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(`SELECT m.id,m.client_request_id,m.from_address,m.to_addresses,m.cc_addresses,m.bcc_addresses,
      m.subject,m.text_body,m.in_reply_to,m.references_header,m.attachments_manifest,m.send_attempts,
      ea.display_name sender_display_name,ea.status account_status,d.status domain_status,d.outbound_verified_at
    FROM messages m JOIN email_accounts ea ON ea.id=m.account_id
    JOIN companies co ON co.id=ea.company_id AND co.status='active'
    JOIN domains d ON d.id=ea.domain_id
    WHERE m.direction='outbound' AND m.delivery_status='queued'
      AND (m.send_next_attempt_at IS NULL OR m.send_next_attempt_at<=?)
      AND ea.status='active' AND d.status IN ('sending_ready','active') AND d.outbound_verified_at IS NOT NULL
    ORDER BY m.created_at LIMIT 10`).bind(now).all<{
      id:string;client_request_id:string|null;from_address:string;to_addresses:string;cc_addresses:string;bcc_addresses:string;
      subject:string;text_body:string|null;in_reply_to:string|null;references_header:string|null;attachments_manifest:string;send_attempts:number;
      sender_display_name:string|null;account_status:string;domain_status:string;outbound_verified_at:string|null;
    }>();
  for (const row of rows.results) {
    const attempt=row.send_attempts+1;
    try {
      const payload:Record<string,unknown>={from:formatFromAddress(row.sender_display_name,row.from_address),to:JSON.parse(row.to_addresses),subject:row.subject,text:row.text_body||""};
      const cc=JSON.parse(row.cc_addresses||"[]"),bcc=JSON.parse(row.bcc_addresses||"[]");
      if(cc.length)payload.cc=cc;if(bcc.length)payload.bcc=bcc;
      const storedAttachments=await env.DB.prepare("SELECT filename,storage_key,content_hash FROM attachments WHERE message_id=? ORDER BY filename,content_hash")
        .bind(row.id).all<{filename:string;storage_key:string;content_hash:string|null}>();
      const expectedAttachments=JSON.parse(row.attachments_manifest||"[]") as string[];
      if(expectedAttachments.length!==storedAttachments.results.length){
        await env.DB.prepare("UPDATE messages SET delivery_status='failed',send_next_attempt_at=NULL,send_last_error='Attachment metadata incomplete' WHERE id=? AND delivery_status='queued'").bind(row.id).run();
        continue;
      }
      if(storedAttachments.results.length){
        const providerAttachments:{filename:string;content:string}[]=[];
        for(const attachment of storedAttachments.results){
          const object=await env.MAIL_STORAGE.get(attachment.storage_key,"arrayBuffer");
          if(!object){await env.DB.prepare("UPDATE messages SET delivery_status='failed',send_next_attempt_at=NULL,send_last_error='Attachment missing from storage' WHERE id=? AND delivery_status='queued'").bind(row.id).run();providerAttachments.length=0;break;}
          providerAttachments.push({filename:attachment.filename,content:arrayBufferToBase64(object)});
        }
        if(providerAttachments.length!==storedAttachments.results.length)continue;
        payload.attachments=providerAttachments;
      }
      if(row.in_reply_to||row.references_header)payload.headers={...(row.in_reply_to?{"In-Reply-To":row.in_reply_to}:{}),...(row.references_header?{"References":row.references_header}:{})};
      const relay=await sendViaResendRelay(env,payload,row.client_request_id||("mailcenter-"+row.id));
      if(relay.ok&&relay.providerId){await env.DB.prepare("UPDATE messages SET delivery_status='sent',provider_message_id=?,sent_at=?,send_attempts=?,send_next_attempt_at=NULL,send_last_error=NULL WHERE id=? AND delivery_status='queued'").bind(relay.providerId,new Date().toISOString(),attempt,row.id).run();continue;}
      const permanent=relay.status>=400&&relay.status<500&&relay.status!==429;
      if(permanent||attempt>=6){await env.DB.prepare("UPDATE messages SET delivery_status='failed',send_attempts=?,send_next_attempt_at=NULL,send_last_error=? WHERE id=? AND delivery_status='queued'").bind(attempt,"Resend relay rejected the message ("+(relay.error||"provider error")+")",row.id).run();}
      else{const delay=Math.min(6*60*60,60*Math.pow(2,attempt-1));await env.DB.prepare("UPDATE messages SET send_attempts=?,send_next_attempt_at=?,send_last_error=? WHERE id=? AND delivery_status='queued'").bind(attempt,new Date(Date.now()+delay*1000).toISOString(),"Resend relay temporarily unavailable ("+(relay.error||"network error")+")",row.id).run();}
    } catch {
      if(attempt>=6){
        await env.DB.prepare("UPDATE messages SET delivery_status='failed',send_attempts=?,send_next_attempt_at=NULL,send_last_error='Provider connection failed' WHERE id=? AND delivery_status='queued'")
          .bind(attempt,row.id).run();
      }else{
        const delay=Math.min(6*60*60,60*Math.pow(2,attempt-1));
        await env.DB.prepare("UPDATE messages SET send_attempts=?,send_next_attempt_at=?,send_last_error='Provider connection failed' WHERE id=? AND delivery_status='queued'")
          .bind(attempt,new Date(Date.now()+delay*1000).toISOString(),row.id).run();
      }
    }
  }
}

async function runMailMaintenance(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mail_storage_reservations WHERE status='reserved' AND expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM auth_mfa_challenges WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM webhook_events WHERE processed_at<=?").bind(new Date(Date.now()-30*24*60*60*1000).toISOString()),
    env.DB.prepare("DELETE FROM auth_login_attempts WHERE window_started_at<=?").bind(new Date(Date.now()-24*60*60*1000).toISOString())
  ]);
  await processOutboundRetries(env);
}

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname === "/admin/") return Response.redirect(new URL("/admin.html", url.origin), 302);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request).then((response) => {
      const headers = new Headers(response.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "DENY");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      if (url.pathname === "/" || url.pathname.endsWith(".html")) headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
  },
  email: async (message: ForwardableEmailMessage, env: Env) => {
    await receiveEmail(message, env);
  },
};