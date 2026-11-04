ALTER TABLE domains ADD COLUMN resend_domain_id TEXT;
ALTER TABLE domains ADD COLUMN resend_records_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE domains ADD COLUMN resend_status TEXT NOT NULL DEFAULT 'not_configured'
  CHECK (resend_status IN ('not_configured','pending','verified','failed'));
ALTER TABLE domains ADD COLUMN inbound_dns_checked_at TEXT;
CREATE UNIQUE INDEX idx_domains_resend_domain_id ON domains(resend_domain_id) WHERE resend_domain_id IS NOT NULL;
