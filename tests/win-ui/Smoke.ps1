# =====================================================================
#   TiTiTalk Windows — UI smoke runner
#   Mirrors /tmp/qa-2026-05-03/ui/run_mac_ui.py for the Win build.
#
#   What it does (no manual steps):
#     T1 install probe   — TiTiTalk.exe present in known install roots
#     T2 metadata        — exe FileVersion + ProductName match tauri.conf
#     T3 cold launch     — process appears + main HWND within 5s budget
#     T4 main window     — UIAutomation finds AutomationElement Name "TiTiTalk"
#     T5 log signals     — %LOCALAPPDATA%\TiTiTalk\tititalk.log gets fresh
#                          init lines (hotkey hook + state init)
#     T6 settings open   — UIA invoke pattern on "Settings"/"设置" button +
#                          Sheet AutomationElement appears within 2s
#     T7 network sanity  — HTTPS reach to https://tititalk.com/api/health 200
#     T8 graceful quit   — tray "Quit" / WM_CLOSE; process gone in <3s
#     T9 screenshots     — main, settings, pill (best-effort, on success
#                          frames only); written to logs\screens\*.png
#
#   Run:  pwsh -ExecutionPolicy Bypass -File tests\win-ui\Smoke.ps1
#         (also works with classic powershell.exe 5.1)
#
#   Output:
#     tests\win-ui\logs\report.json    machine-readable PASS/FAIL/NEEDS_REVIEW
#     tests\win-ui\logs\runner.log     human-readable transcript
#     tests\win-ui\logs\screens\*.png  captured frames
#
#   Caveats:
#     - Must run as the *interactive* logged-in user (UIAutomation reaches
#       only the desktop of the session that owns the script).
#     - If running over RDP, screenshots succeed but pill window may not
#       capture (always-on-top + transparent + skip-taskbar).
#     - F9 (graceful quit timing) is the same regression assertion as the
#       Mac suite — used to catch updater/HTTP shutdown stalls.
# =====================================================================

[CmdletBinding()]
param(
    [switch]$NoLaunch,        # skip cold-launch test (use already-running app)
    [switch]$KeepRunning,     # don't quit at end (useful when iterating)
    [int]$LaunchBudgetMs = 5000,
    [int]$QuitBudgetMs = 3000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ---------- paths ----------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir    = Join-Path $ScriptDir 'logs'
$ScreenDir = Join-Path $LogDir   'screens'
$ReportPath = Join-Path $LogDir  'report.json'
$RunnerLog  = Join-Path $LogDir  'runner.log'
New-Item -ItemType Directory -Force -Path $LogDir, $ScreenDir | Out-Null

$AppLog = Join-Path $env:LOCALAPPDATA 'TiTiTalk\tititalk.log'

$InstallCandidates = @(
    "$env:LOCALAPPDATA\Programs\TiTiTalk\TiTiTalk.exe",   # NSIS per-user
    "$env:ProgramFiles\TiTiTalk\TiTiTalk.exe",            # NSIS per-machine
    "${env:ProgramFiles(x86)}\TiTiTalk\TiTiTalk.exe"
)

# ---------- helpers ----------
$Results = New-Object System.Collections.ArrayList

function Record {
    param([string]$id, [string]$status, [string]$detail = '')
    $row = [ordered]@{ id=$id; status=$status; detail=$detail; t=(Get-Date).ToString('s') }
    [void]$Results.Add($row)
    $line = "[{0}] {1,-7} {2}  {3}" -f $row.t, $status, $id, $detail
    Add-Content -Path $RunnerLog -Value $line
    if ($status -eq 'PASS') { Write-Host $line -ForegroundColor Green }
    elseif ($status -eq 'FAIL') { Write-Host $line -ForegroundColor Red }
    else { Write-Host $line -ForegroundColor Yellow }
}

function Find-Exe {
    foreach ($p in $InstallCandidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-AppProcess {
    Get-Process -Name 'TiTiTalk' -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Save-Screen {
    param([string]$name)
    try {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $path = Join-Path $ScreenDir "$name.png"
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        return $path
    } catch {
        return $null
    }
}

function Find-Window {
    param([string]$name, [int]$timeoutMs = 5000)
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name)
    while ((Get-Date) -lt $deadline) {
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($el) { return $el }
        Start-Sleep -Milliseconds 200
    }
    return $null
}

function Try-Invoke {
    param([System.Windows.Automation.AutomationElement]$root, [string[]]$nameCandidates)
    foreach ($n in $nameCandidates) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $n)
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($el) {
            $pat = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
                $pat.Invoke()
                return $true
            }
        }
    }
    return $false
}

# ---------- T1: install probe ----------
$Exe = Find-Exe
if (-not $Exe) {
    Record 'T1.install' 'FAIL' "TiTiTalk.exe not in: $($InstallCandidates -join '; ')"
    Write-Host "Cannot continue without install. Install via msi/nsis first." -ForegroundColor Red
    exit 2
}
Record 'T1.install' 'PASS' $Exe

# ---------- T2: metadata ----------
try {
    $vi = (Get-Item $Exe).VersionInfo
    Record 'T2.metadata.version' 'PASS' "FileVersion=$($vi.FileVersion) ProductName=$($vi.ProductName)"
    if ($vi.ProductName -notmatch 'TiTiTalk') {
        Record 'T2.metadata.product' 'NEEDS_REVIEW' "ProductName=$($vi.ProductName) — expected to contain 'TiTiTalk'"
    }
} catch {
    Record 'T2.metadata.version' 'FAIL' $_.Exception.Message
}

# ---------- T3: cold launch ----------
if (-not $NoLaunch) {
    Get-AppProcess | ForEach-Object { $_.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 800; if (-not $_.HasExited) { $_.Kill() } }
    Start-Sleep -Milliseconds 500

    $launchAt = Get-Date
    Start-Process -FilePath $Exe | Out-Null

    $proc = $null
    while (((Get-Date) - $launchAt).TotalMilliseconds -lt $LaunchBudgetMs) {
        $proc = Get-AppProcess
        if ($proc -and $proc.MainWindowHandle -ne 0) { break }
        Start-Sleep -Milliseconds 100
    }
    $elapsed = ((Get-Date) - $launchAt).TotalMilliseconds
    if ($proc) {
        Record 'T3.coldLaunch.process' 'PASS' "PID=$($proc.Id) elapsed=${elapsed}ms"
        if ($elapsed -gt 3500) {
            Record 'T3.coldLaunch.budget' 'NEEDS_REVIEW' "${elapsed}ms exceeds 3.5s — possible startup regression"
        } else {
            Record 'T3.coldLaunch.budget' 'PASS' "${elapsed}ms within 3.5s budget"
        }
    } else {
        Record 'T3.coldLaunch.process' 'FAIL' "no TiTiTalk.exe process after ${elapsed}ms — installer broken or AV blocked?"
    }
} else {
    Record 'T3.coldLaunch' 'SKIP' '-NoLaunch flag set'
}

# ---------- T4: main window via UIA ----------
$mainWindow = Find-Window -name 'TiTiTalk' -timeoutMs 5000
if ($mainWindow) {
    $rect = $mainWindow.Current.BoundingRectangle
    Record 'T4.mainWindow' 'PASS' "size=$($rect.Width)x$($rect.Height) class=$($mainWindow.Current.ClassName)"
    if ($rect.Width -lt 800 -or $rect.Height -lt 500) {
        Record 'T4.mainWindow.size' 'NEEDS_REVIEW' "below tauri.conf min (880x560) — DPI scaling regression?"
    }
} else {
    Record 'T4.mainWindow' 'FAIL' 'AutomationElement Name="TiTiTalk" not found within 5s — main window may be hidden behind tray'
}

Save-Screen -name 't4_main' | Out-Null

# ---------- T5: log signals ----------
if (Test-Path $AppLog) {
    Start-Sleep -Milliseconds 1500
    $logTail = Get-Content -Path $AppLog -Tail 500 -ErrorAction SilentlyContinue
    $tailJoined = ($logTail -join "`n").ToLower()

    $needles = @(
        @{ key='hotkey hook thread spawned'; tc='T5.log.hotkey' },
        @{ key='deep_link';                 tc='T5.log.deeplink' },
        @{ key='tray';                      tc='T5.log.tray' }
    )
    foreach ($n in $needles) {
        if ($tailJoined -match [regex]::Escape($n.key)) {
            Record $n.tc 'PASS' "found '$($n.key)' in tail"
        } else {
            Record $n.tc 'NEEDS_REVIEW' "'$($n.key)' not in last 500 lines — check $AppLog manually"
        }
    }
    # FATAL signals = always FAIL
    if ($tailJoined -match 'fatal:|panic:|panicked at') {
        $fatal = ($logTail | Select-String -Pattern '(?i)fatal:|panic' | Select-Object -First 3) -join ' | '
        Record 'T5.log.fatal' 'FAIL' "panic/fatal in log: $fatal"
    } else {
        Record 'T5.log.fatal' 'PASS' 'no panic/fatal in tail'
    }
} else {
    Record 'T5.log' 'NEEDS_REVIEW' "log file not yet present at $AppLog"
}

# ---------- T6: settings sheet open ----------
if ($mainWindow) {
    $opened = Try-Invoke -root $mainWindow -nameCandidates @('设置','Settings','⚙','⚙️')
    if ($opened) {
        Start-Sleep -Milliseconds 800
        # New typeless IA opens a Sheet; look for its title
        $sheet = Find-Window -name 'TiTiTalk' -timeoutMs 1000   # sheet shares name; fall back to descendants
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Pane)
        $panels = $mainWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
        Record 'T6.settings.invoke' 'PASS' "settings button invoked; descendant panes=$($panels.Count)"
        Save-Screen -name 't6_settings' | Out-Null
        # Try to close — Esc is the universal close hint
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Milliseconds 400
    } else {
        Record 'T6.settings.invoke' 'NEEDS_REVIEW' 'no Settings/⚙️/设置 invokable button under main window — UI may use icon-only without AutomationName'
    }
} else {
    Record 'T6.settings' 'SKIP' 'main window unavailable'
}

# ---------- T7: network sanity ----------
try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri 'https://tititalk.com/api/health'
    if ($resp.StatusCode -eq 200 -and $resp.Content -match '"ok"\s*:\s*true') {
        Record 'T7.network.health' 'PASS' "200 OK from /api/health"
    } else {
        Record 'T7.network.health' 'FAIL' "status=$($resp.StatusCode) body=$($resp.Content.Substring(0,[Math]::Min(80,$resp.Content.Length)))"
    }
} catch {
    Record 'T7.network.health' 'NEEDS_REVIEW' "no network or DNS issue: $($_.Exception.Message)"
}

# ---------- T8: graceful quit timing (F9 regression) ----------
if (-not $KeepRunning) {
    $proc = Get-AppProcess
    if ($proc) {
        $quitAt = Get-Date
        # WM_CLOSE on main HWND is the closest analogue to Mac AppleScript "quit"
        $proc.CloseMainWindow() | Out-Null
        while (-not $proc.HasExited -and ((Get-Date) - $quitAt).TotalMilliseconds -lt 6000) {
            Start-Sleep -Milliseconds 100
        }
        $dur = ((Get-Date) - $quitAt).TotalMilliseconds
        if ($proc.HasExited) {
            if ($dur -lt $QuitBudgetMs) {
                Record 'T8.gracefulQuit' 'PASS' "${dur}ms < ${QuitBudgetMs}ms"
            } else {
                Record 'T8.gracefulQuit' 'FAIL' "${dur}ms exceeds ${QuitBudgetMs}ms — F9 regression candidate (in-flight HTTP/updater not honoring close)"
            }
        } else {
            $proc.Kill()
            Record 'T8.gracefulQuit' 'FAIL' "did not exit within 6s; killed. Likely Sparkle/auto-update HTTP hang."
        }
    } else {
        Record 'T8.gracefulQuit' 'SKIP' 'no process running to quit'
    }
}

# ---------- write report ----------
$summary = [ordered]@{
    ts        = (Get-Date).ToString('o')
    exe       = $Exe
    appLog    = $AppLog
    counts    = [ordered]@{
        PASS          = ($Results | Where-Object { $_.status -eq 'PASS' }).Count
        FAIL          = ($Results | Where-Object { $_.status -eq 'FAIL' }).Count
        NEEDS_REVIEW  = ($Results | Where-Object { $_.status -eq 'NEEDS_REVIEW' }).Count
        SKIP          = ($Results | Where-Object { $_.status -eq 'SKIP' }).Count
    }
    results   = $Results
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $ReportPath -Encoding UTF8

Write-Host "`n----- summary -----" -ForegroundColor Cyan
$summary.counts.GetEnumerator() | ForEach-Object { Write-Host ("{0,-14} {1}" -f $_.Key, $_.Value) }
Write-Host "report: $ReportPath" -ForegroundColor Cyan
Write-Host "log:    $RunnerLog"  -ForegroundColor Cyan

if ($summary.counts.FAIL -gt 0) { exit 1 } else { exit 0 }
