$ErrorActionPreference = 'Stop'
$projectRef = 'vhtbmdizugnxkgocmruq'

Write-Host 'Supabase database restart helper' -ForegroundColor Cyan
Write-Host '1. In the browser page, create a temporary personal access token.'
Write-Host '2. Paste it below. Input is masked and will not be saved.'
Start-Process 'https://supabase.com/dashboard/account/tokens'

$secureToken = Read-Host 'Temporary Supabase access token' -AsSecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
    $headers = @{ Authorization = "Bearer $token" }
    $project = Invoke-RestMethod `
        -Method Get `
        -Uri "https://api.supabase.com/v1/projects/$projectRef" `
        -Headers $headers

    Write-Host ("Verified project: " + $project.name) -ForegroundColor Green

    Invoke-RestMethod `
        -Method Post `
        -Uri "https://api.supabase.com/v1/projects/$projectRef/restart" `
        -Headers $headers | Out-Null

    Write-Host 'Restart request accepted by Supabase.' -ForegroundColor Green
    Write-Host 'You can revoke the temporary token after the database is healthy.' -ForegroundColor Yellow
}
catch {
    Write-Host ("Restart failed: " + $_.Exception.Message) -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message -ForegroundColor Red
    }
}
finally {
    if ($tokenPtr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
    }
    Remove-Variable token, secureToken -ErrorAction SilentlyContinue
}

Read-Host 'Press Enter to close'
