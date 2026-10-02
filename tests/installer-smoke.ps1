# Smoke test for install.ps1: runs the real Windows installer unattended against the fake Odoo,
# inside an isolated HOME/APPDATA, and checks the files it produces. Nothing on the machine is touched.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\installer-smoke.ps1            (uses the node already on PATH)
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\installer-smoke.ps1 -DownloadNode   (also exercises the Node.js download)
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\installer-smoke.ps1 -Site https://odoo-app.netlify.app
#       (runs the installer exactly as a teammate does: fetched from the live site with irm, downloading from its default address)
param([switch]$DownloadNode, [string]$Site)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$mockPort = 47311; $repoPort = 47312
$testHome = Join-Path ([IO.Path]::GetTempPath()) 'odoo-app-installer-smoke'
if (Test-Path $testHome) { Remove-Item -Recurse -Force $testHome }
New-Item -ItemType Directory -Force -Path (Join-Path $testHome 'appdata') | Out-Null

$saved = @{}
foreach ($k in 'APPDATA', 'LOCALAPPDATA', 'PATH', 'ODOO_CLAUDE_HOME', 'ODOO_CLAUDE_BASE_URL', 'ODOO_CLAUDE_NO_LAUNCH', 'ODOO_SETUP_SKIP_APPX', 'ODOO_URL', 'ODOO_LOGIN', 'ODOO_PASSWORD', 'ODOO_DB', 'MOCK_PORT', 'PORT', 'MOCK_DBS') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }

$env:MOCK_PORT = "$mockPort"; $env:MOCK_DBS = 'smoke-db'
$mock = Start-Process node -ArgumentList 'tests\mock-odoo.mjs' -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $testHome 'mock.log')
$env:PORT = "$repoPort"
$repo = Start-Process node -ArgumentList 'tests\serve-repo.mjs' -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $testHome 'repo.log')
Start-Sleep -Seconds 2
$failed = $false
try {
    $env:APPDATA = Join-Path $testHome 'appdata'
    # Isolated LOCALAPPDATA with a fake Microsoft Store (MSIX) install of Claude Desktop, whose config lives in a virtualised AppData.
    $env:LOCALAPPDATA = Join-Path $testHome 'localappdata'
    $msixRoaming = Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming'
    New-Item -ItemType Directory -Force -Path $msixRoaming | Out-Null
    $env:ODOO_SETUP_SKIP_APPX = '1'   # do not query the real Get-AppxPackage on this machine
    $env:ODOO_CLAUDE_HOME = Join-Path $testHome 'app'
    if ($Site) { Remove-Item Env:ODOO_CLAUDE_BASE_URL -ErrorAction SilentlyContinue } else { $env:ODOO_CLAUDE_BASE_URL = "http://127.0.0.1:$repoPort" }
    $env:ODOO_CLAUDE_NO_LAUNCH = '1'
    $env:ODOO_URL = "http://127.0.0.1:$mockPort"
    $env:ODOO_LOGIN = 'admin@example.com'
    $env:ODOO_PASSWORD = 'secret'
    $env:ODOO_DB = ''
    if ($DownloadNode) {
        $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notmatch 'nodejs|\\node(js)?\\|npm' }) -join ';'
        if (Get-Command node.exe -ErrorAction SilentlyContinue) { throw 'could not hide node.exe from PATH for the download test' }
    }

    Write-Host "=== running install.ps1 unattended (DownloadNode=$DownloadNode, Site=$Site) ===" -ForegroundColor Cyan
    $installer = if ($Site) { Invoke-RestMethod "$($Site.TrimEnd('/'))/install.ps1" } else { Get-Content (Join-Path $root 'install.ps1') -Raw }
    if ($installer -isnot [string]) { throw "the installer did not arrive as text (got $($installer.GetType().Name))" }
    Invoke-Expression $installer

    Write-Host "=== checking results ===" -ForegroundColor Cyan
    $cfg = Get-Content (Join-Path $env:ODOO_CLAUDE_HOME 'config.json') -Raw | ConvertFrom-Json
    if ($cfg.url -ne "http://127.0.0.1:$mockPort" -or $cfg.login -ne 'admin@example.com' -or $cfg.password -ne 'secret') { throw "config.json has unexpected content: $($cfg | ConvertTo-Json -Compress)" }
    Write-Host "  config.json ok"
    $desktop = Get-Content (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json') -Raw | ConvertFrom-Json
    $entry = $desktop.mcpServers.odoo
    if (-not $entry) { throw 'claude_desktop_config.json has no odoo server' }
    if (-not (Test-Path $entry.command)) { throw "node path in claude_desktop_config.json does not exist: $($entry.command)" }
    if (-not (Test-Path $entry.args[0])) { throw "server path in claude_desktop_config.json does not exist: $($entry.args[0])" }
    if ($entry.env.ODOO_CONFIG_FILE -ne (Join-Path $env:ODOO_CLAUDE_HOME 'config.json')) { throw 'ODOO_CONFIG_FILE env is wrong' }
    Write-Host "  claude_desktop_config.json ok: $($entry.command) $($entry.args[0])"
    if ($DownloadNode -and -not ($entry.command -like "$($env:ODOO_CLAUDE_HOME)\node\node.exe")) { throw "expected the private node.exe to be used, got $($entry.command)" }
    $msixCfg = Join-Path $msixRoaming 'Claude\claude_desktop_config.json'
    if (-not (Test-Path $msixCfg)) { throw "config was not written to the MSIX (Microsoft Store build) location $msixCfg" }
    $msixEntry = (Get-Content $msixCfg -Raw | ConvertFrom-Json).mcpServers.odoo
    if ($msixEntry.command -ne $entry.command -or $msixEntry.args[0] -ne $entry.args[0]) { throw 'MSIX config differs from the classic one' }
    Write-Host "  MSIX-location config ok: $msixCfg"

    # The registered command must work exactly as Claude Desktop would run it (config file only, no env vars).
    Remove-Item Env:ODOO_URL, Env:ODOO_LOGIN, Env:ODOO_PASSWORD, Env:ODOO_DB -ErrorAction SilentlyContinue
    $env:ODOO_CONFIG_FILE = $entry.env.ODOO_CONFIG_FILE
    $out = & $entry.command $entry.args[0] --test --json | Out-String
    if ($LASTEXITCODE -ne 0) { throw "registered command failed: $out" }
    $info = $out.Trim() | ConvertFrom-Json
    if (-not $info.ok -or $info.database -ne 'smoke-db') { throw "unexpected --test result: $out" }
    Write-Host "  registered command connects: db=$($info.database) via $($info.transport)"
    Remove-Item Env:ODOO_CONFIG_FILE -ErrorAction SilentlyContinue

    # Uninstall path
    $env:ODOO_CLAUDE_UNINSTALL = '1'
    Invoke-Expression (Get-Content (Join-Path $root 'install.ps1') -Raw)
    Remove-Item Env:ODOO_CLAUDE_UNINSTALL -ErrorAction SilentlyContinue
    if (Test-Path $env:ODOO_CLAUDE_HOME) { throw 'uninstall did not remove the app folder' }
    $desktop2 = Get-Content (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json') -Raw | ConvertFrom-Json
    if ($desktop2.mcpServers.odoo) { throw 'uninstall did not remove the Claude Desktop entry' }
    $msix2 = Get-Content $msixCfg -Raw | ConvertFrom-Json
    if ($msix2.mcpServers.odoo) { throw 'uninstall did not remove the MSIX-location entry' }
    Write-Host "  uninstall ok"
    Write-Host "INSTALLER SMOKE TEST PASSED" -ForegroundColor Green
} catch {
    $failed = $true
    Write-Host "INSTALLER SMOKE TEST FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
} finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    Remove-Item Env:ODOO_CLAUDE_UNINSTALL, Env:ODOO_CONFIG_FILE, Env:ODOO_SETUP_SKIP_APPX -ErrorAction SilentlyContinue
    Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $repo.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $testHome -ErrorAction SilentlyContinue
}
if ($failed) { exit 1 }
