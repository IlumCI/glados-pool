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
#
# Written for every PowerShell from Windows PowerShell 3.0 up to PowerShell 7:
# no syntax newer than 3.0, hashing through .NET rather than Get-FileHash (4.0),
# TLS 1.2 switched on where the old .NET Framework would not offer it, and no
# `exit`, which under `irm | iex` would close the window it is running in.
param(
    [string]$Address,
    [string]$Reward = "glados",
    [int]$Duty = 100,
    [int]$Threads = 0,
    [switch]$NoGpu
)

& {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue" # the progress bar makes downloads many times slower on 5.1

    function Say([string]$m) { Write-Host "glados: $m" }
    function Fail([string]$m) { Write-Host "glados: $m" -ForegroundColor Red }

    $Ps = $PSVersionTable.PSVersion
    if ($Ps.Major -lt 3) {
        Fail "PowerShell $Ps is too old for this installer. Install PowerShell 7 (https://aka.ms/powershell) or Windows Management Framework 5.1, then run it again."
        return
    }
    # Windows PowerShell runs on .NET Framework, which on older Windows offers
    # only TLS 1.0/1.1 unless told otherwise -- and GitHub refuses both.
    if ($PSVersionTable.PSEdition -ne "Core") {
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch {
            Fail "this Windows cannot turn on TLS 1.2, which the download needs. Install the latest Windows updates, or PowerShell 7 (https://aka.ms/powershell)."
            return
        }
    }

    $Version = "miner-v0.2.0"
    $Base = if ($env:GLADOS_MINER_BASE) { $env:GLADOS_MINER_BASE } else { "https://github.com/IlumCI/GLaDOS/releases/download/$Version" }
    $Pool = if ($env:GLADOS_POOL) { $env:GLADOS_POOL } else { "wss://pool.aperture.institute" }

    if (-not $Address) {
        $Address = Read-Host "glados: your wallet address (0x...)"
        if ($Address) { $Address = $Address.Trim() }
    }
    if ($Address -notmatch '^0x[0-9a-fA-F]{40}$') { Fail "'$Address' is not a 0x address of 40 hex digits."; return }
    if ($Duty -lt 10 -or $Duty -gt 100) { Fail "-Duty wants a percentage from 10 to 100."; return }
    if ($Threads -lt 0) { Fail "-Threads wants a positive number."; return }
    if (-not [Environment]::Is64BitOperatingSystem) { Fail "only 64-bit Windows has a build."; return }
    if (-not $env:LOCALAPPDATA) { Fail "LOCALAPPDATA is not set, so there is nowhere to install to."; return }

    $Dir = Join-Path $env:LOCALAPPDATA "glados-miner"
    try { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
    catch { Fail "could not create $Dir ($($_.Exception.Message))."; return }

    Say "fetching $Version into $Dir (PowerShell $Ps)"
    $Sums = Join-Path $Dir "SHA256SUMS"
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $Sums }
    catch { Fail "could not download SHA256SUMS from $Base ($($_.Exception.Message))."; return }

    function Sha256([string]$Path) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $fs = [System.IO.File]::OpenRead($Path)
        try { return (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString("x2") }) -join "") }
        finally { $fs.Dispose(); $sha.Dispose() }
    }

    # Download one release file under a local name, and refuse it unless it
    # matches its line in SHA256SUMS. $true when it is in place.
    function Fetch([string]$File, [string]$As) {
        $Out = Join-Path $Dir $As
        try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$File" -OutFile "$Out.part" }
        catch { Fail "could not download $File ($($_.Exception.Message))."; return $false }
        $Want = $null
        foreach ($l in (Get-Content $Sums)) {
            $p = $l -split '\s+'
            if ($p.Count -ge 2 -and ($p[1] -eq $File -or $p[1] -eq "*$File")) { $Want = $p[0].ToLower(); break }
        }
        if (-not $Want) { Remove-Item -Force "$Out.part"; Fail "$File is not listed in SHA256SUMS."; return $false }
        if ((Sha256 "$Out.part") -ne $Want) { Remove-Item -Force "$Out.part"; Fail "$File does not match its checksum; not running it."; return $false }
        try { Move-Item -Force "$Out.part" $Out }
        catch { Fail "could not put $As in place ($($_.Exception.Message)) -- is the miner still running? Stop it and try again."; return $false }
        Say "$File checks out"
        return $true
    }

    if (-not (Fetch "glados-miner-windows-x86_64.exe" "glados-miner.exe")) { return }

    # The GPU helper is for NVIDIA cards, found by the driver's own tool. Its
    # absence is not an error: the CPU miner runs either way.
    $Gpu = $false
    if (-not $NoGpu -and (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
        $ok = $false
        try { & nvidia-smi -L *> $null; $ok = ($LASTEXITCODE -eq 0) } catch { }
        if ($ok) {
            if (Fetch "xpu-windows-x86_64.exe" "xpu.exe") { $Gpu = $true }
            else { Say "carrying on with the CPU only" }
        }
    }
    if (-not $Gpu) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Dir "xpu.exe") }

    $T = if ($Threads -gt 0) { "--threads $Threads" } else { "" }
    # A .cmd rather than a .ps1, so the default execution policy does not stop
    # it. Both processes share this console, so Ctrl+C reaches both.
    $Cmd = @"
@echo off
rem Start mining again with the settings install.ps1 was given. Ctrl+C stops it.
cd /d "%~dp0"
if exist xpu.exe start "" /b glados-miner.exe --pool $Pool/mine/gpu --worker $Address --reward $Reward --duty $Duty --gpu --xpu xpu.exe
glados-miner.exe --pool $Pool/mine --worker $Address --reward $Reward --duty $Duty --cpu $T
"@
    $Mine = Join-Path $Dir "mine.cmd"
    Set-Content -Path $Mine -Value $Cmd -Encoding ASCII

    $What = if ($Gpu) { "CPU + NVIDIA GPU" } else { "CPU" }
    Say "installed. paid to $Address in $Reward, $Duty% load, $What"
    Say "Ctrl+C stops it. To start again later: `"$Mine`""
    Say "to remove it: delete $Dir"
    if ($env:GLADOS_NO_START) { return } # for testing the install without mining
    & $Mine
}
