# Win UI Smoke Tests

Counterpart to `voiceink/Tests/VoiceInkTests/SmokeUITests.swift` and
`/tmp/qa-2026-05-03/ui/run_mac_ui.py`. Drives the installed `TiTiTalk.exe`
through System.Windows.Automation (UIA) — no extra deps beyond what ships
with Windows PowerShell 5.1 / PowerShell 7.

## Quick run

Copy `tests/win-ui/Smoke.ps1` to a Windows machine where the latest NSIS
build is already installed, then:

```powershell
pwsh -ExecutionPolicy Bypass -File .\tests\win-ui\Smoke.ps1
```

Exit codes:
- `0` — no FAIL results
- `1` — one or more FAIL
- `2` — installer not found (precondition failure)

## What it covers

| ID                 | Check                                                            |
| ------------------ | ---------------------------------------------------------------- |
| T1 install         | `TiTiTalk.exe` exists in known install roots                     |
| T2 metadata        | exe `FileVersion`/`ProductName` match `tauri.conf.json`          |
| T3 cold launch     | process appears + `MainWindowHandle` within 5s, ≤3.5s budget     |
| T4 main window     | UIA finds `AutomationElement` Name="TiTiTalk", size ≥ min config |
| T5 log signals     | `tititalk.log` tail has hotkey/tray/deeplink lines, no panic     |
| T6 settings sheet  | UIA Invoke on Settings/⚙️/设置 button + descendant pane appears  |
| T7 network         | `https://tititalk.com/api/health` returns 200                    |
| T8 graceful quit   | `WM_CLOSE` resolves in <3s — F9 regression assertion             |

## Output layout

```
tests/win-ui/logs/
├── report.json          machine-readable {counts, results[]}
├── runner.log           human transcript with timestamps
└── screens/
    ├── t4_main.png
    └── t6_settings.png
```

## Why not WinAppDriver / FlaUI?

- WinAppDriver requires Visual Studio + WebDriver setup + admin install of
  WinAppDriver service. UIA via `Add-Type -AssemblyName UIAutomationClient`
  is built into every Windows since 7 and needs nothing else installed.
- FlaUI is the better choice if/when these tests grow past smoke-level —
  it wraps UIA + UIA3 with proper element waits, condition factories, and
  multi-window coordination. For now, smoke = "process up, no panics, key
  buttons reachable" and stock UIA fits.

## Caveats

- Must run as the *interactive* logged-in user. UIA can't see windows in
  another session (so RDP works but `psexec -s` does not).
- Some Tauri 2 elements expose blank `Name` because the React JSX uses
  emoji-only buttons. T6 falls back to `NEEDS_REVIEW` rather than FAIL —
  fix on the JSX side by adding `aria-label` on the relevant buttons.
- Pill window (`label="pill"` in tauri.conf) is intentionally
  `skipTaskbar=true` + `transparent=true` + `decorations=false`; a
  full-screen capture catches it but UIA does not, by design.
- F9 (T8) is the same defect this suite is designed to *catch* — if it
  starts FAILing again after a release, look first at recent changes to
  the updater plugin, network shutdown ordering, or any blocking sync
  call inside `on_window_event(CloseRequested)`.
