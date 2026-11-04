import PostalMime from "postal-mime";
import type { Env } from "../types";
import { isAllowedAttachment } from "./attachments";
import { releaseMailStorage, reserveMailStorage } from "./storage";

type IncomingMessage = {
  from: string;
  to: string;
  raw: ReadableStream;
  rawSize: number;
  headers: Headers;
  setReject(reason: string): void;
};

type ParsedAttachment = {
  filename?: string;
  mimeType?: string;
  content: ArrayBuffer | Uint8Array;
  disposition?: string;
  contentId?: string;
};

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: any) => {
    if (typeof entry?.address === "string") return [entry.address.toLowerCase()];
    if (Array.isArray(entry?.group)) return addressList(entry.group);
    return [];
  }).slice(0, 50);
}

function headerValue(headers: Array<{ key: string; value: string }> | undefined, name: string) {
  return headers?.find((header) => header.key.toLowerCase() === name.toLowerCase())?.value?.trim() || null;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(?:address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\s*>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => {
      const code = Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => {
      const code = Number.parseInt(value, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 200000);
}

export type InboundRiskAssessment = { score: number; reasons: string[] };

export function assessInboundRisk(input: {
  subject: string;
  text: string;
  html: string;
  authenticationResults: string | null;
}): InboundRiskAssessment {
  let score = 0;
  const reasons: string[] = [];
  const auth = input.authenticationResults || "";
  if (/^mx\.cloudflare\.net\s*;/i.test(auth)) {
    const checks = [...auth.matchAll(/\b(spf|dkim|dmarc)=(fail|softfail|neutral|none|temperror|permerror)\b/gi)];
    for (const [, mechanism, result] of checks) {
      const name = mechanism.toUpperCase();
      if (result.toLowerCase() === "fail") {
        score += name === "DMARC" ? 3 : 2;
        reasons.push(name + " no superó la autenticación");
      } else if (result.toLowerCase() === "softfail" || result.toLowerCase() === "permerror") {
        score += 1;
        reasons.push(name + " presenta un resultado de autenticación débil");
      }
    }
  }

  const links = [...input.html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
  const shorteners = /(^|\.)((bit\.ly)|(tinyurl\.com)|(t\.co)|(goo\.gl)|(cutt\.ly)|(is\.gd)|(ow\.ly))$/i;
  if (links.some(link => {
    try { return shorteners.test(new URL(link).hostname); } catch { return false; }
  })) {
    score += 2;
    reasons.push("Incluye enlaces acortados que ocultan el destino");
  }
  if (links.length > 8) {
    score += 1;
    reasons.push("Contiene una cantidad inusual de enlaces");
  }

  const content = (input.subject + " " + input.text + " " + input.html.replace(/<[^>]*>/g, " ")).toLowerCase();
  const urgencyTerms = ["verify your account", "account suspended", "urgent payment", "wire transfer", "gift card", "seed phrase", "reset your password", "unusual activity", "verify your identity", "confirme su cuenta", "cuenta suspendida", "pago urgente", "restablezca su contraseña", "verifique su identidad"];
  const matchedTerms = urgencyTerms.filter(term => content.includes(term));
  if (matchedTerms.length >= 2) {
    score += 1;
    reasons.push("El contenido combina varias expresiones frecuentes en intentos de suplantación");
  }

  return { score: Math.min(10, score), reasons: [...new Set(reasons)].slice(0, 6) };
}

function safeFilename(value: string | undefined, index: number) {
  const name = Array.from(value || `attachment-${index + 1}`).map((char) => char === "/" || char.charCodeAt(0) === 92 || char.charCodeAt(0) < 32 ? "_" : char).join("").slice(0, 180);
  return name || `attachment-${index + 1}`;
}

export async function receiveEmail(message: IncomingMessage, env: Env): Promise<void> {
  if (!env.MAIL_STORAGE) throw new Error("Workers KV binding MAIL_STORAGE is not configured");
  if (message.rawSize > 25 * 1024 * 1024 - 1024) {
    message.setReject("Message exceeds the supported size limit");
    return;
  }

  const recipient = message.to.trim().toLowerCase();
  const at = recipient.lastIndexOf("@");
  if (at <= 0) {
    message.setReject("Invalid recipient");
    return;
  }
  const localPart = recipient.slice(0, at);
  const domainName = recipient.slice(at + 1);

  const destination = await env.DB.prepare(
    `SELECT ea.id AS account_id, ea.company_id, ea.local_part, d.domain
     FROM domains d
     JOIN companies co ON co.id = d.company_id AND co.status = 'active'
     LEFT JOIN email_accounts direct ON direct.domain_id = d.id
       AND direct.local_part = ? COLLATE NOCASE AND direct.status = 'active'
       AND direct.company_id = d.company_id
     LEFT JOIN email_aliases alias ON alias.domain_id = d.id
       AND alias.local_part = ? COLLATE NOCASE AND alias.status = 'active'
       AND alias.company_id = d.company_id
     LEFT JOIN email_accounts target ON target.id = alias.target_account_id
       AND target.status = 'active' AND target.company_id = d.company_id
     JOIN email_accounts ea ON ea.id = COALESCE(direct.id, target.id)
       AND ea.status = 'active' AND ea.company_id = d.company_id
     WHERE d.domain = ? COLLATE NOCASE AND d.status IN ('receiving_ready','active')
     LIMIT 1`
  ).bind(localPart, localPart, domainName).first<{
    account_id: string; company_id: string; local_part: string; domain: string;
  }>();

  if (!destination) {
    message.setReject("Recipient is not an active mailbox");
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > 25 * 1024 * 1024 - 1024) { message.setReject("Message exceeds the supported size limit"); return; }
  const parsed = await PostalMime.parse(raw, {
    maxNestingDepth: 50,
    maxPartCount: 500,
    maxRfc822NestingDepth: 3
  }) as any;

  const headers = parsed.headers as Array<{ key: string; value: string }> | undefined;
  const messageId = String(parsed.messageId || headerValue(headers, "message-id") || "").slice(0, 998) || null;
  if (messageId) {
    const duplicate = await env.DB.prepare(
      "SELECT id FROM messages WHERE account_id = ? AND message_id_header = ? LIMIT 1"
    ).bind(destination.account_id, messageId).first();
    if (duplicate) return;
  }

  const id = crypto.randomUUID();
  const rawKey = `raw/${destination.company_id}/${destination.account_id}/${id}.eml`;
  const fromAddress = String(parsed.from?.address || message.from || "unknown@invalid").toLowerCase().slice(0, 320);
  const htmlBody = typeof parsed.html === "string" ? parsed.html.slice(0, 200000) : null;
  const textBody = String(parsed.text || htmlToPlainText(htmlBody || "")).slice(0, 200000);
  // Cloudflare Email Service prepends its own Authentication-Results header.
  // Trust only that service identifier; never score sender-supplied auth headers.
  const rawAuthResults = message.headers.get("Authentication-Results") || "";
  const authenticationResults = /^mx\.cloudflare\.net\s*;/i.test(rawAuthResults)
    ? rawAuthResults.slice(0, 2000) : null;
  const risk = assessInboundRisk({
    subject: String(parsed.subject || "").slice(0, 998),
    text: textBody,
    html: htmlBody || "",
    authenticationResults
  });
  const toAddresses = addressList(parsed.to);
  if (!toAddresses.includes(recipient)) toAddresses.push(recipient);
  const ccAddresses = addressList(parsed.cc);
  const bccAddresses = addressList(parsed.bcc);
  const references = (Array.isArray(parsed.references) ? parsed.references.join(" ") : typeof parsed.references === "string" ? parsed.references : null)?.slice(0, 4000) || null;
  const inReplyTo = parsed.inReplyTo || headerValue(headers, "in-reply-to");
  const threadCandidates = [inReplyTo, ...(references || "").split(" ")].filter(Boolean).slice(-20);

  let conversationId: string | null = null;
  if (threadCandidates.length) {
    const placeholders = threadCandidates.map(() => "?").join(",");
    const prior = await env.DB.prepare(
      `SELECT conversation_id FROM messages
       WHERE account_id = ? AND message_id_header IN (${placeholders})
         AND conversation_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`
    ).bind(destination.account_id, ...threadCandidates).first<{ conversation_id: string }>();
    conversationId = prior?.conversation_id || null;
  }
  if (!conversationId) conversationId = crypto.randomUUID();

  const attachments = (parsed.attachments || []) as ParsedAttachment[];
  const attachmentBytesTotal = attachments.reduce((total, item) => total + item.content.byteLength, 0);
  if (attachments.length > 20 || attachmentBytesTotal > 20 * 1024 * 1024) {
    message.setReject("Inbound attachments exceed supported limits");
    return;
  }
  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const filename = safeFilename(attachment.filename, index);
    const contentType = (attachment.mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
    if (!isAllowedAttachment(filename, contentType, attachment.content)) {
      message.setReject("An attachment uses an unsupported or invalid file format");
      return;
    }
  }
  const reservationId = await reserveMailStorage(env.DB, destination.company_id, id, raw.byteLength + attachmentBytesTotal);
  if (!reservationId) {
    message.setReject("Mailbox storage quota reached");
    return;
  }
  const storedKeys: string[] = [];
  try {
    // KV values are limited to 25 MiB. Each generated key is immutable.
    await env.MAIL_STORAGE.put(rawKey, raw);
    storedKeys.push(rawKey);

    const statements: D1PreparedStatement[] = [];
    const existingConversation = await env.DB.prepare(
      "SELECT id FROM conversations WHERE id = ?"
    ).bind(conversationId).first();

    if (!existingConversation) {
      statements.push(env.DB.prepare(
        "INSERT INTO conversations (id, company_id, account_id, subject, last_message_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(conversationId, destination.company_id, destination.account_id, String(parsed.subject || "").slice(0, 998), parsed.date || new Date().toISOString()));
    }

    statements.push(env.DB.prepare(
      `INSERT INTO messages
       (id, company_id, account_id, conversation_id, direction, folder, from_address,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body,
        authentication_results, spam_score, spam_reasons_json, message_id_header,
        in_reply_to, references_header, raw_storage_key, received_at, is_read, delivery_status)
       VALUES (?, ?, ?, ?, 'inbound', 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'received')`
    ).bind(
      id, destination.company_id, destination.account_id, conversationId, fromAddress,
      JSON.stringify(toAddresses), JSON.stringify(ccAddresses), JSON.stringify(bccAddresses), String(parsed.subject || "").slice(0, 998),
      textBody, htmlBody, authenticationResults, risk.score, JSON.stringify(risk.reasons), messageId,
      String(inReplyTo || "").slice(0, 998) || null, references, rawKey, parsed.date || new Date().toISOString()
    ));

    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      const attachmentId = crypto.randomUUID();
      const key = `attachments/${destination.company_id}/${destination.account_id}/${id}/${attachmentId}`;
      const filename = safeFilename(attachment.filename, index);
      const rawContentType = (attachment.mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 160);
      const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawContentType) ? rawContentType : "application/octet-stream";
      const attachmentBytes = attachment.content instanceof ArrayBuffer
        ? attachment.content
        : attachment.content.buffer.slice(
            attachment.content.byteOffset,
            attachment.content.byteOffset + attachment.content.byteLength
          ) as ArrayBuffer;
      await env.MAIL_STORAGE.put(key, attachmentBytes);
      storedKeys.push(key);
      const size = attachment.content instanceof ArrayBuffer
        ? attachment.content.byteLength : attachment.content.byteLength;
      statements.push(env.DB.prepare(
        "INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, storage_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(attachmentId, id, filename, contentType, size, key));
    }

    statements.push(env.DB.prepare(
      "UPDATE conversations SET last_message_at = ? WHERE id = ?"
    ).bind(parsed.date || new Date().toISOString(), conversationId));
    statements.push(env.DB.prepare("UPDATE mail_storage_reservations SET status='committed',expires_at=NULL WHERE id=? AND status='reserved'")
      .bind(reservationId));
    await env.DB.batch(statements);
  } catch (error) {
    await Promise.all(storedKeys.map((key) => env.MAIL_STORAGE.delete(key).catch(() => undefined)));
    await releaseMailStorage(env.DB, reservationId);
    throw error;
  }
}
