# Next Level Family Restaurant - Postgres restore
#
# Restores a backup produced by backup_db.ps1 into a database. DESTRUCTIVE:
# --clean drops existing objects before recreating them. Confirms before running.
#
# Usage:
#   pwsh -File scripts/restore_db.ps1 -BackupFile ".\backups\nextlevel-pos-20260101-020000.backup" -DatabaseUrl "postgresql://user:pass@host:5432/db"

param(
    [Parameter(Mandatory = $true)][string]$BackupFile,
    [string]$DatabaseUrl = $env:DATABASE_URL,
    [string]$PgRestorePath = "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe"
)

if (-not (Test-Path $BackupFile)) {
    Write-Error "Backup file not found: $BackupFile"
    exit 1
}
if (-not $DatabaseUrl) {
    Write-Error "DATABASE_URL is not set and -DatabaseUrl was not passed."
    exit 1
}
if (-not (Test-Path $PgRestorePath)) {
    Write-Error "pg_restore not found at '$PgRestorePath'. Pass -PgRestorePath to point at your PostgreSQL bin directory."
    exit 1
}

Write-Host "This will DROP and recreate objects in the target database, then load:" -ForegroundColor Yellow
Write-Host "  $BackupFile" -ForegroundColor Yellow
$confirm = Read-Host "Type YES to continue"
if ($confirm -ne "YES") {
    Write-Host "Cancelled."
    exit 0
}

& $PgRestorePath --clean --if-exists --no-owner --dbname="$DatabaseUrl" "$BackupFile"

if ($LASTEXITCODE -ne 0) {
    Write-Error "pg_restore exited with code $LASTEXITCODE."
    exit $LASTEXITCODE
}
Write-Host "Restore complete."
