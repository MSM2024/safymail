export interface RequiredDnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: string | number;
  priority?: number;
}
export interface ExistingDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number | null;
}
export interface DnsPlanItem {
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  action: "present" | "create" | "manual";
  reason?: string;
}

function normalizeName(value: string, domain: string): string {
  const name = value.trim().replace(/\.$/, "").toLowerCase();
  if (!name || name === "@") return domain;
  if (name === domain || name.endsWith("." + domain)) return name;
  return name + "." + domain;
}
function normalizeContent(type: string, value: string): string {
  const content = value.trim();
  if (type === "TXT") return content.replace(/^"(.*)"$/s, "$1");
  if (["MX", "CNAME", "NS", "PTR"].includes(type)) return content.replace(/\.$/, "").toLowerCase();
  return content;
}
function recordTtl(value: string | number | undefined): number {
  if (value === undefined || value === "" || String(value).toLowerCase() === "auto") return 1;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error("Invalid DNS record TTL.");
  return ttl;
}

/**
 * Produces a strictly non-destructive DNS plan. It never edits or deletes an
 * existing record. Conflicts involving MX, SPF, DKIM, DMARC or CNAME require
 * an operator to reconcile them manually before applying any changes.
 */
export function buildDnsPlan(
  domainInput: string,
  requiredRecords: RequiredDnsRecord[],
  existingRecords: ExistingDnsRecord[]
): DnsPlanItem[] {
  const domain = domainInput.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("Invalid DNS plan domain.");
  }
  if (!Array.isArray(requiredRecords) || !Array.isArray(existingRecords)) {
    throw new Error("Invalid DNS plan records.");
  }

  const existing = existingRecords.map(record => ({
    type: String(record.type || "").toUpperCase(),
    name: normalizeName(String(record.name || ""), domain),
    content: normalizeContent(String(record.type || "").toUpperCase(), String(record.content || "")),
    priority: record.priority == null ? undefined : Number(record.priority)
  }));

  return requiredRecords.map(record => {
    const type = String(record.type || "").toUpperCase();
    const name = normalizeName(String(record.name || ""), domain);
    const content = normalizeContent(type, String(record.value || ""));
    if (!/^(A|AAAA|CNAME|MX|TXT|SRV|CAA|NS)$/.test(type) || !content) {
      throw new Error("Unsupported or empty required DNS record.");
    }
    const matches = existing.filter(item => item.type === type && item.name === name);
    const exact = matches.find(item =>
      item.content === content &&
      (type !== "MX" || item.priority === (record.priority == null ? undefined : Number(record.priority)))
    );
    const ttl = recordTtl(record.ttl);
    const priority = record.priority == null ? undefined : Number(record.priority);
    if (exact) return { type, name, content, ttl, ...(priority === undefined ? {} : { priority }), action: "present" as const };

    const cnameConflict = existing.find(item => item.name === name && (type === "CNAME" || item.type === "CNAME"));
    if (cnameConflict) {
      return { type, name, content, ttl, ...(priority === undefined ? {} : { priority }), action: "manual" as const, reason: "A CNAME cannot safely coexist with another record at this hostname. Existing DNS was not changed." };
    }

    const isSpf = type === "TXT" && name === domain && content.toLowerCase().startsWith("v=spf1");
    const isDmarc = type === "TXT" && name === "_dmarc." + domain;
    const isDkim = type === "TXT" && name.includes("._domainkey.");
    if (matches.length && (type === "MX" || type === "CNAME" || isSpf || isDmarc || isDkim)) {
      const label = type === "MX" ? "MX" : isSpf ? "SPF" : isDmarc ? "DMARC" : type === "CNAME" ? "CNAME" : "DKIM";
      return { type, name, content, ttl, ...(priority === undefined ? {} : { priority }), action: "manual" as const, reason: "A different " + label + " record already exists at this hostname. Merge or reconcile it manually; no existing DNS was changed." };
    }

    return { type, name, content, ttl, ...(priority === undefined ? {} : { priority }), action: "create" as const };
  });
}
