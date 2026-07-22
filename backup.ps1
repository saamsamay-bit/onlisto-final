# Backup Onlisto to GitHub before deploy
$msg = Read-Host "Type backup note (or press Enter for auto-timestamp)"
if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "Backup " + (Get-Date -Format "yyyy-MM-dd HH:mm") }
cd C:\onlisto-va
git add .
git commit -m "$msg"
git push origin main
Write-Host "✅ BACKUP DONE!" -ForegroundColor Green
