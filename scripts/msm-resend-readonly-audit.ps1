#Requires -Version 5.1
param([string]$Domain = "msmmystore.com")
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
     $dmarc=@($txt|Where-Object { $_ -match '^v=DMARC1(?:\s|$)' })
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
     if($daily -ge 100 -or $monthly -ge 3000){Write-Host "ALERT: LOCAL QUOTA EXHAUSTED - do not send more tests." -ForegroundColor Red}
     elseif($daily -ge 80 -or $monthly -ge 2400){Write-Host "CAUTION: 80 percent local quota reached - reserve capacity for real mail." -ForegroundColor Yellow}
     else{Write-Host "Local quota below 80 percent; still confirm account-wide usage in Resend." -ForegroundColor Green}
   }
 }
}catch{Write-Host "Resend quota read-only query failed" -ForegroundColor Yellow}
Write-Host "AUDIT COMPLETE - No changes or email sends were performed." -ForegroundColor Green
