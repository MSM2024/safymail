#Requires -Version 5.1
param(
 [string]$Domain = "msmmystore.com",
 [Nullable[int]]$ProviderDaily = $null,
 [Nullable[int]]$ProviderMonthly = $null,
 [string]$ProviderObservedAtUtc = ""
)
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host "MSM MAIL - RESEND READ-ONLY AUDIT" -ForegroundColor Cyan
Write-Host "Domain: $Domain | No keys, tokens, emails or private data are printed"
Write-Host ""
function Check-Dns([string]$Name,[string]$Type){
 try {
   $records = @(Resolve-DnsName -Name $Name -Type $Type -ErrorAction Stop)
   if($Type -eq "MX"){
     $mx = @($records | Where-Object { $_.Type -eq "MX" } | ForEach-Object { $_.NameExchange.TrimEnd('.') })
     Write-Host ("DNS MX [{0}]: {1}" -f $Name,($mx -join ", "))
   } elseif($Type -eq "TXT"){
     $txt = @($records | Where-Object { $_.Type -eq "TXT" } | ForEach-Object { $_.Strings -join "" })
     $spf=@($txt|Where-Object { $_ -match '^v=spf1(?:\s|$)' })
     $dmarc=@($txt|Where-Object { $_ -match '^v=DMARC1(?:;|\s|$)' })
     if($Name.StartsWith("_dmarc.")){Write-Host ("DNS DMARC [{0}]: {1} record(s)" -f $Name,$dmarc.Count)}
     else{Write-Host ("DNS SPF [{0}]: {1} record(s)" -f $Name,$spf.Count)}
   }
 } catch {
   Write-Host ("DNS {0} [{1}]: lookup unavailable ({2})" -f $Type,$Name,$_.Exception.Message) -ForegroundColor Yellow
 }
}
Check-Dns $Domain "MX"
Check-Dns $Domain "TXT"
Check-Dns ("_dmarc."+$Domain) "TXT"
Write-Host ""
if(-not (Test-Path "./wrangler.toml")){Write-Host "MISSING local wrangler.toml" -ForegroundColor Yellow;exit 1}
if(-not (Test-Path "./wrangler.control-plane.toml")){Write-Host "MISSING local wrangler.control-plane.toml" -ForegroundColor Yellow;exit 1}
Write-Host "=== WORKER SECRET NAMES ONLY ==="
foreach($worker in @("msm-mail-preview","msm-mail-control-plane")){
 try{
   $raw=& npx --no-install wrangler secret list --name $worker --format json 2>$null
   if($LASTEXITCODE -ne 0){Write-Host "$worker : unable to query secrets" -ForegroundColor Yellow;continue}
   $secrets=@($raw|Out-String|ConvertFrom-Json)
   $names=@($secrets|ForEach-Object { $_.name })
   if($worker -eq "msm-mail-preview"){
     $required=@("RESEND_RELAY_TOKEN")
   }else{
     $required=@("CONTROL_PLANE_VAULT_KEY")
   }
   foreach($name in $required){
     Write-Host ("{0} / {1}: {2}" -f $worker,$name,$(if($names -contains $name){"PRESENT"}else{"MISSING"}))
   }
 }catch{Write-Host "$worker : secrets query error (values never printed)" -ForegroundColor Yellow}
}
Write-Host ""
Write-Host "=== REMOTE D1: DOMAIN STATUS (READ-ONLY) ==="
$domainSafe=$Domain.Replace("'","''")
$sql="SELECT domain,status,resend_status,CASE WHEN outbound_verified_at IS NULL THEN 0 ELSE 1 END AS outbound_verified,CASE WHEN inbound_verified_at IS NULL THEN 0 ELSE 1 END AS inbound_verified FROM domains WHERE domain='$domainSafe';"
try{
 $result=& npx --no-install wrangler d1 execute msm-mail-preview-db --config wrangler.toml --remote --json --command $sql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "D1 domain query unavailable" -ForegroundColor Yellow}
 else{
   $parsed=$result|Out-String|ConvertFrom-Json
   @($parsed)[0].results | Format-Table domain,status,resend_status,outbound_verified,inbound_verified -AutoSize
 }
}catch{Write-Host "D1 domain query failed" -ForegroundColor Yellow}
Write-Host ""
Write-Host "=== REMOTE D1: CONTROL PLANE INSTALLATION STATUS (READ-ONLY) ==="
try{
 $query="SELECT i.domain,i.status,COALESCE(p.status,'not_attached') AS provider_status FROM control_installations i LEFT JOIN control_provider_accounts p ON p.id=i.provider_account_id WHERE i.domain='$domainSafe';"
 $out=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $query 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Control D1 query unavailable" -ForegroundColor Yellow}
 else{
   $parsed=$out|Out-String|ConvertFrom-Json
   @($parsed)[0].results | Format-Table domain,status,provider_status -AutoSize
 }
}catch{Write-Host "Control D1 query failed" -ForegroundColor Yellow}
Write-Host ""
Write-Host "=== RESEND FREE QUOTA: CONTROL PLANE LOCAL COUNTS (READ-ONLY) ==="
Write-Host "Limits: 100/day, 3000/month (UTC), shared by provider account."
Write-Host "Counts include reserved, sent and uncertain; external Resend sends are NOT included."
try {
 $quotaSql="SELECT COALESCE(SUM(CASE WHEN r.day_key=date('now') AND r.status IN ('reserved','sent','uncertain') THEN 1 ELSE 0 END),0) AS daily_used, COALESCE(SUM(CASE WHEN r.month_key=strftime('%Y-%m','now') AND r.status IN ('reserved','sent','uncertain') THEN 1 ELSE 0 END),0) AS monthly_used FROM control_installations i LEFT JOIN control_resend_send_requests r ON r.provider_account_id=i.provider_account_id WHERE i.domain='$domainSafe' AND i.provider_account_id IS NOT NULL;"
 $quotaOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $quotaSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Resend quota counters unavailable" -ForegroundColor Yellow}
 else {
   $quotaJson=$quotaOut|Out-String|ConvertFrom-Json
   $quotaRow=@(@($quotaJson)[0].results)[0]
   if($null -eq $quotaRow -or $null -eq $quotaRow.daily_used -or $null -eq $quotaRow.monthly_used){
     Write-Host "Resend quota counters could not be parsed" -ForegroundColor Yellow
   } else {
     $daily=[int]$quotaRow.daily_used
     $monthly=[int]$quotaRow.monthly_used
     Write-Host ("Today UTC: {0}/100 | Current month UTC: {1}/3000" -f $daily,$monthly)
     Write-Host ("Local observation UTC: {0}" -f ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")))
     $quotaArgs=@("./scripts/p2-resend-quota-reconcile.mjs",("--local-daily="+$daily),("--local-monthly="+$monthly))
     if($PSBoundParameters.ContainsKey("ProviderDaily")){$quotaArgs+=("--provider-daily="+$ProviderDaily)}
     if($PSBoundParameters.ContainsKey("ProviderMonthly")){$quotaArgs+=("--provider-monthly="+$ProviderMonthly)}
     if($ProviderObservedAtUtc -ne ""){$quotaArgs+=("--provider-observed-at="+$ProviderObservedAtUtc)}
     Write-Host "=== P2 ACCOUNT QUOTA RECONCILIATION (READ-ONLY) ==="
     & node @quotaArgs
     if($LASTEXITCODE -ne 0){Write-Host "P2 quota reconciliation could not certify provider observation." -ForegroundColor Yellow}
     if($daily -ge 100 -or $monthly -ge 3000){Write-Host "ALERT: LOCAL QUOTA EXHAUSTED - do not send more tests." -ForegroundColor Red}
     elseif($daily -ge 80 -or $monthly -ge 2400){Write-Host "CAUTION: 80 percent local quota reached - reserve capacity for real mail." -ForegroundColor Yellow}
     else{Write-Host "Local quota below 80 percent; account-wide quota remains UNKNOWN until provider counters are supplied." -ForegroundColor Yellow}
   }
 }
}catch{Write-Host "Resend quota read-only query failed" -ForegroundColor Yellow}
Write-Host ""
Write-Host "=== P2 WEBHOOK DELIVERY COUNTS (READ-ONLY, NO MESSAGE DATA) ==="
try {
 $webhookSql="SELECT COALESCE(SUM(CASE WHEN d.status='pending' THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN d.status='delivered' THEN 1 ELSE 0 END),0) AS delivered,COALESCE(SUM(CASE WHEN d.attempts>1 THEN 1 ELSE 0 END),0) AS retried,COALESCE(MAX(d.attempts),0) AS max_attempts FROM control_webhook_deliveries d JOIN control_installations i ON i.id=d.installation_id WHERE i.domain='$domainSafe';"
 $webhookOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $webhookSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Webhook counters unavailable" -ForegroundColor Yellow}
 else {
   $webhookJson=$webhookOut|Out-String|ConvertFrom-Json
   $webhookRow=@(@($webhookJson)[0].results)[0]
   if($null -eq $webhookRow -or $null -eq $webhookRow.pending){Write-Host "Webhook counters not parseable" -ForegroundColor Yellow}
   else{
     Write-Host ("Pending: {0} | Delivered to Worker: {1} | Retried: {2} | Max attempts: {3}" -f $webhookRow.pending,$webhookRow.delivered,$webhookRow.retried,$webhookRow.max_attempts)
     Write-Host "Delivered here means webhook forwarded to Worker, not email delivered to recipient."
     if([int]$webhookRow.pending -gt 0){Write-Host "CAUTION: inspect pending webhook deliveries without changing them." -ForegroundColor Yellow}
   }
 }
}catch{Write-Host "Webhook aggregate query unavailable" -ForegroundColor Yellow}
Write-Host ""
Write-Host "=== P2 WEBHOOK EVENT LINEAGE (READ-ONLY, AGGREGATED) ==="
try {
 $lineageSql="SELECT COUNT(*) AS delivery_rows,COALESCE(SUM(CASE WHEN e.provider_event_id IS NULL THEN 1 ELSE 0 END),0) AS orphan_deliveries,COALESCE(SUM(CASE WHEN d.status NOT IN ('pending','delivered') OR d.status IS NULL THEN 1 ELSE 0 END),0) AS unexpected_statuses,COALESCE(SUM(CASE WHEN d.status='pending' AND d.attempts>0 THEN 1 ELSE 0 END),0) AS pending_after_attempt,COALESCE(SUM(CASE WHEN d.status='pending' AND d.last_attempt_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') THEN 1 ELSE 0 END),0) AS pending_stale_1h,COALESCE(SUM(CASE WHEN d.status='delivered' AND d.delivered_at IS NULL THEN 1 ELSE 0 END),0) AS delivered_without_timestamp,COUNT(DISTINCT CASE WHEN d.status='delivered' THEN d.provider_event_id END) AS distinct_forwarded_events FROM control_webhook_deliveries d JOIN control_installations i ON i.id=d.installation_id LEFT JOIN control_webhook_events e ON e.provider_account_id=d.provider_account_id AND e.provider_event_id=d.provider_event_id WHERE i.domain='$domainSafe';"
 $lineageOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $lineageSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Webhook lineage counters unavailable" -ForegroundColor Yellow}
 else {
   $lineageJson=$lineageOut|Out-String|ConvertFrom-Json
   $lineageRow=@(@($lineageJson)[0].results)[0]
   if($null -eq $lineageRow -or $null -eq $lineageRow.delivery_rows){Write-Host "Webhook lineage counters not parseable" -ForegroundColor Yellow}
   else{
     Write-Host ("Delivery rows: {0} | Distinct forwarded events: {1}" -f $lineageRow.delivery_rows,$lineageRow.distinct_forwarded_events)
     Write-Host ("Orphan deliveries: {0} | Unexpected states: {1} | Pending after attempts: {2} | Pending stale >1h: {3} | Forwarded without timestamp: {4}" -f $lineageRow.orphan_deliveries,$lineageRow.unexpected_statuses,$lineageRow.pending_after_attempt,$lineageRow.pending_stale_1h,$lineageRow.delivered_without_timestamp)
     if([int]$lineageRow.orphan_deliveries -gt 0 -or [int]$lineageRow.unexpected_statuses -gt 0 -or [int]$lineageRow.pending_stale_1h -gt 0 -or [int]$lineageRow.delivered_without_timestamp -gt 0){
       Write-Host "ALERT: webhook event lineage requires private operator investigation; no message contents shown." -ForegroundColor Yellow
     }
   }
 }
}catch{Write-Host "Webhook lineage remote audit unavailable" -ForegroundColor Yellow}
try{
 $duplicateSql="SELECT COUNT(*) AS duplicate_groups FROM (SELECT e.provider_account_id,e.provider_event_id FROM control_webhook_events e JOIN control_installations i ON i.provider_account_id=e.provider_account_id WHERE i.domain='$domainSafe' GROUP BY e.provider_account_id,e.provider_event_id HAVING COUNT(*)>1);"
 $duplicateOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $duplicateSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Webhook duplicate event audit unavailable" -ForegroundColor Yellow}
 else{
   $duplicateJson=$duplicateOut|Out-String|ConvertFrom-Json
   $duplicateRow=@(@($duplicateJson)[0].results)[0]
   if($null -eq $duplicateRow -or $null -eq $duplicateRow.duplicate_groups){Write-Host "Webhook duplicate count unavailable" -ForegroundColor Yellow}
   else{
     Write-Host ("Duplicate provider event keys: {0}" -f $duplicateRow.duplicate_groups)
     if([int]$duplicateRow.duplicate_groups -gt 0){Write-Host "ALERT: unexpected duplicate webhook event keys" -ForegroundColor Yellow}
   }
 }
}catch{Write-Host "Webhook duplicate audit unavailable" -ForegroundColor Yellow}
Write-Host "Webhook event-key dedup is checked against stored events only; repeat HTTP deliveries may be suppressed before storage."
Write-Host "Delivery forwarded to Worker is NOT proof of recipient mail delivery."
Write-Host ""
Write-Host "=== P2 MAINTENANCE DISPATCH AND LOCK (READ-ONLY) ==="
$lastDispatchedSlot=""
$lastCompletedSlot=""
$lockFlag=-1
try{
 $dispatchSql="SELECT COUNT(*) AS dispatched_24h,MAX(m.scheduled_slot) AS last_dispatched_slot FROM control_maintenance_dispatches m JOIN control_installations i ON i.id=m.installation_id WHERE i.domain='$domainSafe' AND m.scheduled_slot>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours');"
 $dispatchOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $dispatchSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Maintenance dispatch query unavailable" -ForegroundColor Yellow}
 else{
   $dispatchJson=$dispatchOut|Out-String|ConvertFrom-Json
   $dispatchRow=@(@($dispatchJson)[0].results)[0]
   if($null -eq $dispatchRow -or $null -eq $dispatchRow.dispatched_24h){Write-Host "Maintenance dispatch not parseable" -ForegroundColor Yellow}
   else{
     $lastDispatchedSlot=[string]$dispatchRow.last_dispatched_slot
     Write-Host ("Dispatches last 24h: {0} | Last dispatched slot: {1}" -f $dispatchRow.dispatched_24h,$dispatchRow.last_dispatched_slot)
   }
 }
}catch{Write-Host "Maintenance dispatch unavailable" -ForegroundColor Yellow}
try{
 $lockSql="SELECT COALESCE(last_completed_slot,'not-recorded') AS last_completed_slot,CASE WHEN lock_token IS NOT NULL AND lock_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END AS lock_active FROM mail_maintenance_lock WHERE id=1;"
 $lockOut=& npx --no-install wrangler d1 execute msm-mail-preview-db --config wrangler.toml --remote --json --command $lockSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Mail maintenance lock query unavailable" -ForegroundColor Yellow}
 else{
   $lockJson=$lockOut|Out-String|ConvertFrom-Json
   $lockRow=@(@($lockJson)[0].results)[0]
   if($null -eq $lockRow){Write-Host "Mail maintenance lock not found" -ForegroundColor Yellow}
   else{
     $lastCompletedSlot=[string]$lockRow.last_completed_slot
     $lockFlag=[int]$lockRow.lock_active
     Write-Host ("Last completed slot: {0} | Lock active: {1}" -f $lockRow.last_completed_slot,$lockRow.lock_active)
   }
 }
}catch{Write-Host "Mail maintenance lock unavailable" -ForegroundColor Yellow}
Write-Host ""
Write-Host "=== P2 SCHEDULER LAG AND COMPLETION EVIDENCE (READ-ONLY) ==="
try {
 $lagSql="SELECT COUNT(*) AS dispatch_rows_24h,COUNT(DISTINCT m.scheduled_slot) AS distinct_slots_24h,COALESCE(SUM(CASE WHEN m.scheduled_slot < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') THEN 1 ELSE 0 END),0) AS historical_dispatches_30m,ROUND((julianday('now')-julianday(MAX(m.scheduled_slot)))*1440,1) AS newest_dispatch_age_minutes FROM control_maintenance_dispatches m JOIN control_installations i ON i.id=m.installation_id WHERE i.domain='$domainSafe' AND m.scheduled_slot>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours');"
 $lagOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $lagSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Scheduler lag query unavailable" -ForegroundColor Yellow}
 else {
   $lagJson=$lagOut|Out-String|ConvertFrom-Json
   $lagRow=@(@($lagJson)[0].results)[0]
   if($null -eq $lagRow -or $null -eq $lagRow.dispatch_rows_24h){Write-Host "Scheduler lag not parseable" -ForegroundColor Yellow}
   else {
     Write-Host ("Dispatch rows 24h: {0} | Distinct slots 24h: {1} | Historical dispatches >30m: {2}" -f $lagRow.dispatch_rows_24h,$lagRow.distinct_slots_24h,$lagRow.historical_dispatches_30m)
     if($null -eq $lagRow.newest_dispatch_age_minutes){Write-Host "Last dispatch age: UNKNOWN (no dispatch in 24h)" -ForegroundColor Yellow}
     else{
       Write-Host ("Last dispatch age: {0} minutes" -f $lagRow.newest_dispatch_age_minutes)
       if([double]$lagRow.newest_dispatch_age_minutes -gt 30){Write-Host "ALERT: most recent maintenance dispatch is older than 30 minutes." -ForegroundColor Yellow}
     }
   }
 }
}catch{Write-Host "Scheduler lag query unavailable" -ForegroundColor Yellow}
Write-Host "=== P2 LATEST SLOT COMPLETION (READ-ONLY) ==="
& node ./scripts/p2-maintenance-completion.mjs $lastDispatchedSlot $lastCompletedSlot $lockFlag
if($LASTEXITCODE -ne 0){Write-Host "P2 latest completion: ALERT or UNKNOWN; inspect slots and Cloudflare metrics." -ForegroundColor Yellow}
Write-Host "Queue pending, retries and DLQ depth: UNKNOWN from D1 dispatch records; inspect Cloudflare Queues metrics privately."
Write-Host "A dispatch record is an enqueue claim, not proof of queue delivery or task completion."
Write-Host "A dispatch record does not prove maintenance completion; review both slots."
Write-Host "AUDIT COMPLETE - No changes or email sends were performed." -ForegroundColor Green
