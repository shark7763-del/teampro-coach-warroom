$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$secureToken = Read-Host 'Paste the Supabase access token (input is hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'No access token was entered.' }
  & npx supabase login --agent no --output-format text --name TeamProCLI --token $token
  if ($LASTEXITCODE -ne 0) { throw 'Supabase login failed.' }
  Write-Host 'Supabase login completed. You may close this window.' -ForegroundColor Green
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $token = $null
  $secureToken = $null
}

Read-Host 'Press Enter to close'
