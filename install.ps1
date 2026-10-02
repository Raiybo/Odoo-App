# Odoo App - installer for Windows.
# Connects Claude (Claude Desktop and Claude Code) to your Odoo.
#
# Run it in PowerShell with:
#   irm https://odoo-app.netlify.app/install.ps1 | iex
#
# Remove it with:
#   $env:ODOO_CLAUDE_UNINSTALL='1'; irm https://odoo-app.netlify.app/install.ps1 | iex
#
# Unattended use (for IT): set $env:ODOO_URL, $env:ODOO_LOGIN, $env:ODOO_PASSWORD (optionally $env:ODOO_DB,
# $env:ODOO_READ_ONLY='true') before running; no questions are asked then.
#
# Other knobs: ODOO_CLAUDE_HOME (install folder, default %LOCALAPPDATA%\OdooClaude), ODOO_CLAUDE_BASE_URL,
#              ODOO_CLAUDE_NODE (use this node.exe instead of downloading one).
#
# What it does: 1) gets a private Node.js runtime if needed  2) downloads the Odoo connector  3) asks for your Odoo
# address, email and password and checks that they work  4) registers the connector in Claude Desktop and Claude Code
# 5) restarts Claude Desktop. Nothing else on your PC is changed. Works in Windows PowerShell 5.1 and PowerShell 7.

function Install-OdooApp {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    $BaseUrl = if ($env:ODOO_CLAUDE_BASE_URL) { $env:ODOO_CLAUDE_BASE_URL } else { 'https://odoo-app.netlify.app' }
    $AppDir = if ($env:ODOO_CLAUDE_HOME) { $env:ODOO_CLAUDE_HOME } else { Join-Path $env:LOCALAPPDATA 'OdooClaude' }
    $NodeSeries = 'v22'
    $ReadOnly = if ($env:ODOO_READ_ONLY) { $env:ODOO_READ_ONLY } else { 'false' }

    function Write-Step($t) { Write-Host ''; Write-Host $t -ForegroundColor White }
    function Write-Ok($t) { Write-Host "  [ok] $t" -ForegroundColor Green }
    function Write-Warn($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
    function Write-Dim($t) { Write-Host "  $t" -ForegroundColor DarkGray }
    function Ask($prompt, $default) {
        $p = if ($default) { "  $prompt [$default]" } else { "  $prompt" }
        $v = Read-Host $p
        if ([string]::IsNullOrWhiteSpace($v)) { return $default }
        return $v.Trim()
    }
    function Ask-Secret($prompt) {
        $s = Read-Host "  $prompt" -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
        try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    function Get-NodeMajor($exe) {
        try { $v = & $exe -p "process.versions.node.split('.')[0]"; return [int]$v } catch { return 0 }
    }
    function Find-Node {
        if ($env:ODOO_CLAUDE_NODE -and (Test-Path $env:ODOO_CLAUDE_NODE)) { return $env:ODOO_CLAUDE_NODE }
        $private = Join-Path $AppDir 'node\node.exe'
        if (Test-Path $private) { return $private }
        $sys = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($sys -and (Get-NodeMajor $sys.Source) -ge 18) { return $sys.Source }
        return $null
    }
    function Install-Node {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        Write-Host "  Downloading a private copy of Node.js $NodeSeries for Windows $arch (about 30 MB, only once)..."
        $shasums = Invoke-RestMethod "https://nodejs.org/dist/latest-$NodeSeries.x/SHASUMS256.txt"
        $m = [regex]::Match($shasums, "([0-9a-f]{64})\s+(node-$NodeSeries[\d.]+-win-$arch\.zip)")
        if (-not $m.Success) { throw "No Node.js download found for win-$arch." }
        $sum = $m.Groups[1].Value; $file = $m.Groups[2].Value
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("odoo-app-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $zip = Join-Path $tmp $file
        Invoke-WebRequest "https://nodejs.org/dist/latest-$NodeSeries.x/$file" -OutFile $zip -UseBasicParsing
        $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
        if ($actual -ne $sum) { throw 'The downloaded Node.js file is corrupted (checksum mismatch). Please run the installer again.' }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $inner = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
        if (-not $inner) { throw 'Could not extract Node.js.' }
        $dest = Join-Path $AppDir 'node'
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Move-Item -Path $inner.FullName -Destination $dest
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        $exe = Join-Path $dest 'node.exe'
        if (-not (Test-Path $exe)) { throw "Node.js was extracted but $exe is missing." }
        return $exe
    }
    function Download($url, $dest) {
        Invoke-WebRequest $url -OutFile "$dest.tmp" -UseBasicParsing
        Move-Item -Force "$dest.tmp" $dest
    }
    function Run-Setup {
        param([string[]]$Arguments)
        # Note: never redirect a native command's stderr here; Windows PowerShell 5.1 turns that into errors.
        $out = & $Node $Setup @Arguments | Out-String
        return @{ Code = $LASTEXITCODE; Out = $out.Trim() }
    }

    # ------------------------------------------------------------------
    if ($env:ODOO_CLAUDE_UNINSTALL -eq '1') {
        Write-Step 'Removing Odoo App'
        $Node = Find-Node
        $Setup = Join-Path $AppDir 'server\setup.js'
        if ($Node -and (Test-Path $Setup)) {
            $r = Run-Setup @('claude-desktop', '--remove'); if ($r.Code -eq 0) { Write-Ok 'Removed from Claude Desktop' }
            $r = Run-Setup @('claude-code', '--remove'); if ($r.Code -eq 0) { Write-Ok 'Removed from Claude Code' }
        }
        if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
        Write-Ok "Deleted $AppDir (including your saved Odoo login)"
        Write-Host '  Restart Claude Desktop to finish. Bye!'
        return
    }

    Write-Host ''
    Write-Host 'Odoo App - connect Claude to Odoo' -ForegroundColor White
    Write-Dim "Install folder: $AppDir"

    Write-Step 'Step 1 of 4 - Preparing'
    New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'server') | Out-Null
    $Node = Find-Node
    if ($Node) { Write-Ok "Node.js found: $Node ($(& $Node --version))" } else { $Node = Install-Node; Write-Ok "Node.js installed privately in $AppDir\node" }
    $Server = Join-Path $AppDir 'server\index.js'
    $Setup = Join-Path $AppDir 'server\setup.js'
    Download "$BaseUrl/server/index.js" $Server
    Download "$BaseUrl/server/setup.js" $Setup
    Write-Ok "Odoo connector $(& $Node $Server --version) downloaded"

    Write-Step 'Step 2 of 4 - Your Odoo login'
    $DefUrl = if ($env:ODOO_URL) { $env:ODOO_URL } else { (Run-Setup @('read-config', '--dir', $AppDir, '--key', 'url')).Out }
    $DefLogin = if ($env:ODOO_LOGIN) { $env:ODOO_LOGIN } else { (Run-Setup @('read-config', '--dir', $AppDir, '--key', 'login')).Out }
    $DefDb = if ($env:ODOO_DB) { $env:ODOO_DB } else { (Run-Setup @('read-config', '--dir', $AppDir, '--key', 'db')).Out }
    $Preset = [bool]($env:ODOO_URL -and $env:ODOO_LOGIN -and $env:ODOO_PASSWORD)
    Write-Host '  Use the same details you type on your Odoo login page.'
    $UrlIn = $env:ODOO_URL; $LoginIn = $env:ODOO_LOGIN; $PassIn = $env:ODOO_PASSWORD; $DbIn = if ($env:ODOO_DB) { $env:ODOO_DB } else { '' }
    while ($true) {
        if (-not $Preset) {
            $UrlIn = Ask 'Odoo address (like https://mycompany.odoo.com)' $DefUrl
            $LoginIn = Ask 'Email you log into Odoo with' $DefLogin
            $PassIn = Ask-Secret 'Odoo password or API key (typing is hidden)'
            $DbIn = Ask 'Database name (just press Enter to detect it automatically)' $DefDb
        }
        Write-Host '  Checking the connection...'
        $env:ODOO_URL = $UrlIn; $env:ODOO_LOGIN = $LoginIn; $env:ODOO_PASSWORD = $PassIn; $env:ODOO_DB = $DbIn
        $env:ODOO_READ_ONLY = $ReadOnly; $env:ODOO_CONFIG_FILE = 'C:\nonexistent\odoo-app.json'; $env:ODOO_QUIET = '1'
        $result = (& $Node $Server --test | Out-String).TrimEnd()
        $rc = $LASTEXITCODE
        Remove-Item Env:ODOO_CONFIG_FILE, Env:ODOO_QUIET -ErrorAction SilentlyContinue
        if ($rc -eq 0) {
            $result -split "`n" | ForEach-Object { Write-Host "  $_" }
            Write-Ok 'Your Odoo login works'
            break
        }
        $result -split "`n" | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        if ($Preset) { throw 'The connection check failed (see above).' }
        $again = Ask 'Try again? (Y/n)' 'Y'
        if ($again -match '^(n|no)$') { throw 'Stopped. Run the installer again whenever you are ready.' }
        $DefUrl = $UrlIn; $DefLogin = $LoginIn; $DefDb = $DbIn
    }

    Write-Step 'Step 3 of 4 - Saving'
    $r = Run-Setup @('save-config', '--dir', $AppDir)
    Remove-Item Env:ODOO_PASSWORD -ErrorAction SilentlyContinue
    $PassIn = $null
    if ($r.Code -ne 0) { throw "Could not save the configuration. $($r.Out)" }
    $ConfigFile = $r.Out
    Write-Ok "Saved to $ConfigFile (in your private user folder)"

    Write-Step 'Step 4 of 4 - Connecting Claude'
    $NoLaunch = ($env:ODOO_CLAUDE_NO_LAUNCH -eq '1')   # never open apps or web pages (unattended installs)
    $detect = (Run-Setup @('detect')).Out | ConvertFrom-Json
    if (-not $detect.claudeDesktop.installed -and -not $NoLaunch) {
        Write-Warn 'Claude Desktop is not installed on this PC.'
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        $doInstall = 'n'
        if ($winget -and -not $Preset) { $doInstall = Ask 'Install Claude Desktop now (free, from Anthropic)? (Y/n)' 'Y' }
        if ($doInstall -match '^(y|yes)$') {
            & winget install --id Anthropic.Claude -e --accept-source-agreements --accept-package-agreements --disable-interactivity
            if ($LASTEXITCODE -eq 0) { Write-Ok 'Claude Desktop installed' } else { Write-Warn 'winget could not install Claude Desktop. Get it from https://claude.ai/download' }
        } else {
            Write-Host '  Get it from https://claude.ai/download - the Odoo connector is already set up for it.'
            try { Start-Process 'https://claude.ai/download' } catch { }
        }
        $detect = (Run-Setup @('detect')).Out | ConvertFrom-Json
    }
    $r = Run-Setup @('claude-desktop', '--force', '--node', $Node, '--server', $Server, '--config', $ConfigFile)
    if ($r.Code -eq 0) { Write-Ok "Claude Desktop: Odoo connector registered ($($r.Out))" } else { Write-Warn "Claude Desktop: $($r.Out)" }

    $r = Run-Setup @('claude-code', '--node', $Node, '--server', $Server, '--config', $ConfigFile)
    if ($r.Code -eq 0) { Write-Ok 'Claude Code: Odoo connector registered (user scope)' }
    elseif ($r.Code -eq 2) { Write-Dim 'Claude Code is not installed - skipped (install it later and run this installer again).' }
    else { Write-Warn "Claude Code: $($r.Out)" }

    $running = Get-Process -Name 'Claude' -ErrorAction SilentlyContinue
    # How to start Claude Desktop: Start menu entry (covers the Microsoft Store / MSIX build and classic installs),
    # otherwise the executable or shortcut found by setup.js.
    $startApp = $null
    try { $startApp = Get-StartApps -ErrorAction Stop | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1 } catch { }
    $launch = $null
    if ($startApp) { $launch = { Start-Process 'explorer.exe' -ArgumentList "shell:AppsFolder\$($startApp.AppID)" } }
    elseif ($detect.claudeDesktop.executable) { $exe = $detect.claudeDesktop.executable; $launch = { Start-Process $exe } }
    elseif ($detect.claudeDesktop.shortcut) { $lnk = $detect.claudeDesktop.shortcut; $launch = { Start-Process $lnk } }
    if ($NoLaunch) {
        if ($running) { Write-Dim 'Restart Claude Desktop to load the Odoo connector.' }
    } elseif ($running) {
        Write-Host '  Restarting Claude Desktop so it picks up the Odoo connector...'
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        if ($launch) { try { & $launch; Write-Ok 'Claude Desktop restarted' } catch { Write-Warn 'Please open Claude Desktop again yourself.' } }
        else { Write-Warn 'Please open Claude Desktop again yourself.' }
    } elseif ($launch) {
        try { & $launch } catch { }
    }

    Write-Host ''
    Write-Host 'All set!' -ForegroundColor Green
    Write-Host '  1. Open Claude.'
    Write-Host '  2. Ask:  "Check my Odoo connection"  - then ask anything about your Odoo data.'
    Write-Host ''
    Write-Dim "Change the login later: run this installer again.  Remove: `$env:ODOO_CLAUDE_UNINSTALL='1' then run it again."
}

try {
    Install-OdooApp
} catch {
    Write-Host ''
    Write-Host "[error] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '        Nothing was broken. Fix the problem above and run the installer again.' -ForegroundColor Red
} finally {
    Remove-Item Env:ODOO_PASSWORD, Env:ODOO_CONFIG_FILE, Env:ODOO_QUIET -ErrorAction SilentlyContinue
}
