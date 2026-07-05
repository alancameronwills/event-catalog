@echo off
REM Ensure the Event Catalog server is running on 127.0.0.1:3777.
REM
REM Idempotent: if the server already answers /health it does nothing, so this
REM is safe to double-click anytime, or to drop into Windows startup
REM (Win+R -> shell:startup -> put a shortcut to this file there) so the panel
REM always has its backend.

setlocal
set "PORT=3777"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/health'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel%==0 (
  echo Event Catalog server already running on 127.0.0.1:%PORT%.
  "%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
  exit /b 0
)

echo Starting Event Catalog server...
REM Launch in its own minimized window so logs stay visible and it keeps
REM running after this launcher exits. The server does not hot-reload; close
REM that window to stop it.
start "Event Catalog server" /min /D "%~dp0server" node server.js
endlocal
