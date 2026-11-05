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
     if($PSBoundParameters.ContainsKey("ProviderDaily")){$quotaArgs+=("--provider-daily="+$ProviderDaily.Value)}
     if($PSBoundParameters.ContainsKey("ProviderMonthly")){$quotaArgs+=("--provider-monthly="+$ProviderMonthly.Value)}
     if($ProviderObservedAtUtc -ne ""){$quotaArgs+=("--provider-observed-at="+$ProviderObservedAtUtc)}
     Write-Host "=== P2 ACCOUNT QUOTA RECONCILIATION (READ-ONLY) ==="
     & node $quotaArgs
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
Write-Host "=== P2 MAINTENANCE DISPATCH AND LOCK (READ-ONLY) ==="
try{
 $dispatchSql="SELECT COUNT(*) AS dispatched_24h,MAX(m.scheduled_slot) AS last_dispatched_slot FROM control_maintenance_dispatches m JOIN control_installations i ON i.id=m.installation_id WHERE i.domain='$domainSafe' AND m.scheduled_slot>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours');"
 $dispatchOut=& npx --no-install wrangler d1 execute msm-mail-control-db --config wrangler.control-plane.toml --remote --json --command $dispatchSql 2>$null
 if($LASTEXITCODE -ne 0){Write-Host "Maintenance dispatch query unavailable" -ForegroundColor Yellow}
 else{
   $dispatchJson=$dispatchOut|Out-String|ConvertFrom-Json
   $dispatchRow=@(@($dispatchJson)[0].results)[0]
   if($null -eq $dispatchRow -or $null -eq $dispatchRow.dispatched_24h){Write-Host "Maintenance dispatch not parseable" -ForegroundColor Yellow}
   else{Write-Host ("Dispatches last 24h: {0} | Last dispatched slot: {1}" -f $dispatchRow.dispatched_24h,$dispatchRow.last_dispatched_slot)}
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
   else{Write-Host ("Last completed slot: {0} | Lock active: {1}" -f $lockRow.last_completed_slot,$lockRow.lock_active)}
 }
}catch{Write-Host "Mail maintenance lock unavailable" -ForegroundColor Yellow}
Write-Host "A dispatch record does not prove maintenance completion; review both slots."
Write-Host "AUDIT COMPLETE - No changes or email sends were performed." -ForegroundColor Green
