@echo off
REM Register the native-messaging host with Chrome (current user). Optionally
REM pass the extension ID as the first argument; otherwise you'll be prompted.
REM Double-clickable: bypasses execution policy just for this script.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
