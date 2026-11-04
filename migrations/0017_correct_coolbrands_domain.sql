-- Correct the CoolBrands domain record to the exact domain already present in Resend.
-- Preserve the domain row and all linked accounts/aliases. Clear verification/provider
-- state because it belongs to the previous hostname and must be checked again.
-- The NOT EXISTS guard avoids violating the unique domain constraint if a correct row
-- has already been created separately; in that case this migration is a safe no-op.
UPDATE domains
SET domain = 'coolbrandstech.com',
    resend_domain_id = NULL,
    resend_records_json = '[]',
    resend_status = 'not_configured',
    inbound_verified_at = NULL,
    outbound_verified_at = NULL,
    inbound_dns_checked_at = NULL,
    status = 'pending'
WHERE id = '9d8596bc-6911-47f4-9413-e58e1d973062'
  AND domain = 'mycoolbrands.com'
  AND NOT EXISTS (
    SELECT 1
    FROM domains AS existing
    WHERE existing.domain = 'coolbrandstech.com'
      AND existing.id <> '9d8596bc-6911-47f4-9413-e58e1d973062'
  );
