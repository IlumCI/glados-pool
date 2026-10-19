# GLaDOS native miner for Windows: download it, check it, run it here.
#
#   irm https://mine.aperture.institute/install.ps1 | iex
#
# That asks for your wallet address. To give it (and options) up front:
#
#   & ([scriptblock]::Create((irm https://mine.aperture.institute/install.ps1))) -Address 0xYOURADDRESS
#
# Options: -Reward ASSET (default glados), -Duty PERCENT (10-100, default 100),
# -Threads N (default all but one), -NoGpu (CPU only).
#
# What it does, all of it: puts two files (three with an NVIDIA GPU) in
# %LOCALAPPDATA%\glados-miner, checks each against the release's SHA256SUMS,
# writes a mine.cmd there so you can start again later, and starts mining in
# this window. Nothing runs in the background, nothing starts at boot, no admin.
# Ctrl+C stops it; deleting that folder removes it.
#
# Windows Defender may flag it: it is a cryptocurrency miner, the one you asked
# for. The miner is open source: https://github.com/IlumCI/GLaDOS (miner/, cuda/).
param(
    [string]$Address,
    [string]$Reward = "glados",
    [ValidateRange(10, 100)][int]$Duty = 100,
    [int]$Threads = 0,
    [switch]$NoGpu
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # the progress bar makes Invoke-WebRequest many times slower

$Version = "miner-v0.2.0"
$Base = if ($env:GLADOS_MINER_BASE) { $env:GLADOS_MINER_BASE } else { "https://github.com/IlumCI/GLaDOS/releases/download/$Version" }
$Pool = if ($env:GLADOS_POOL) { $env:GLADOS_POOL } else { "wss://pool.aperture.institute" }

function Say($m) { Write-Host "glados: $m" }

if (-not $Address) { $Address = (Read-Host "glados: your wallet address (0x...)").Trim() }
if ($Address -notmatch '^0x[0-9a-fA-F]{40}$') { throw "glados: '$Address' is not a 0x address of 40 hex digits" }
if (-not [Environment]::Is64BitOperatingSystem) { throw "glados: only 64-bit Windows has a build" }

$Dir = Join-Path $env:LOCALAPPDATA "glados-miner"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Say "fetching $Version into $Dir"
$Sums = Join-Path $Dir "SHA256SUMS"
Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $Sums

# Download one release file under a local name, and refuse it unless it
# matches its line in SHA256SUMS.
function Fetch($File, $As) {
    $Out = Join-Path $Dir $As
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$File" -OutFile "$Out.part"
    $Line = Get-Content $Sums | Where-Object { ($_ -split '\s+')[1] -in @($File, "*$File") } | Select-Object -First 1
    if (-not $Line) { throw "glados: $File is not listed in SHA256SUMS" }
    $Want = ($Line -split '\s+')[0].ToLower()
    $Have = (Get-FileHash -Algorithm SHA256 "$Out.part").Hash.ToLower()
    if ($Want -ne $Have) { Remove-Item "$Out.part"; throw "glados: $File does not match its checksum; not running it" }
    Move-Item -Force "$Out.part" $Out
    Say "$File checks out"
}

Fetch "glados-miner-windows-x86_64.exe" "glados-miner.exe"

$Gpu = $false
if (-not $NoGpu -and (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    & nvidia-smi -L *> $null
    if ($LASTEXITCODE -eq 0) { Fetch "xpu-windows-x86_64.exe" "xpu.exe"; $Gpu = $true }
}
if (-not $Gpu) { Remove-Item -ErrorAction SilentlyContinue (Join-Path $Dir "xpu.exe") }

$T = if ($Threads -gt 0) { "--threads $Threads" } else { "" }
# A .cmd rather than a .ps1, so the default execution policy does not stop it.
# Both processes share this console, so Ctrl+C reaches both.
$Cmd = @"
@echo off
rem Start mining again with the settings install.ps1 was given. Ctrl+C stops it.
cd /d "%~dp0"
if exist xpu.exe start "" /b glados-miner.exe --pool $Pool/mine/gpu --worker $Address --reward $Reward --duty $Duty --gpu --xpu xpu.exe
glados-miner.exe --pool $Pool/mine --worker $Address --reward $Reward --duty $Duty --cpu $T
"@
Set-Content -Path (Join-Path $Dir "mine.cmd") -Value $Cmd -Encoding ASCII

$What = if ($Gpu) { "CPU + NVIDIA GPU" } else { "CPU" }
Say "installed. paid to $Address in $Reward, $Duty% load, $What"
Say "Ctrl+C stops it. To start again later: `"$Dir\mine.cmd`""
Say "to remove it: delete $Dir"
& (Join-Path $Dir "mine.cmd")
