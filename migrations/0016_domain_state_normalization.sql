UPDATE domains
SET status = CASE
  WHEN inbound_verified_at IS NOT NULL AND outbound_verified_at IS NOT NULL THEN 'active'
  WHEN inbound_verified_at IS NOT NULL THEN 'receiving_ready'
  WHEN outbound_verified_at IS NOT NULL THEN 'sending_ready'
  ELSE 'pending'
END
WHERE status = 'active';
