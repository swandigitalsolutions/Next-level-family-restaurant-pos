# Next Level Family Restaurant - Postgres backup
#
# Dumps the restaurant database to a timestamped, compressed file and deletes
# backups older than $RetentionDays. Safe to run unattended (Task Scheduler,
# cron via pwsh, etc.) - it never touches the live database, only reads it.
#
# Usage:
#   pwsh -File scripts/backup_db.ps1
#   pwsh -File scripts/backup_db.ps1 -DatabaseUrl "postgresql://user:pass@host:5432/db" -BackupDir "D:\backups" -RetentionDays 30

param(
    [string]$DatabaseUrl = $env:DATABASE_URL,
    [string]$BackupDir = (Join-Path $PSScriptRoot "..\backups"),
    [int]$RetentionDays = 14,
    [string]$PgDumpPath = "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
)

if (-not $DatabaseUrl) {
    Write-Error "DATABASE_URL is not set and -DatabaseUrl was not passed. Nothing to back up (SQLite installs don't need this - just copy the .db file)."
    exit 1
}

if (-not (Test-Path $PgDumpPath)) {
    Write-Error "pg_dump not found at '$PgDumpPath'. Pass -PgDumpPath to point at your PostgreSQL bin directory."
    exit 1
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $BackupDir "nextlevel-pos-$stamp.backup"

Write-Host "Backing up to $outFile ..."
& $PgDumpPath --format=custom --compress=6 --file="$outFile" --dbname="$DatabaseUrl"

if ($LASTEXITCODE -ne 0) {
    Write-Error "pg_dump exited with code $LASTEXITCODE - backup may be incomplete."
    exit $LASTEXITCODE
}

$sizeKb = [math]::Round((Get-Item $outFile).Length / 1KB, 1)
Write-Host "Backup complete: $outFile ($sizeKb KB)"

$cutoff = (Get-Date).AddDays(-$RetentionDays)
Get-ChildItem -Path $BackupDir -Filter "nextlevel-pos-*.backup" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
        Write-Host "Removing old backup: $($_.Name)"
        Remove-Item $_.FullName -Force
    }
