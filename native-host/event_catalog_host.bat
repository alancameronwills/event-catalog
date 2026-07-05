@echo off
REM Chrome native-messaging host wrapper. Chrome can only launch an executable
REM by path on Windows, so this batch file runs the actual host (host.mjs).
REM Nothing may be printed to stdout except node's framed output, so keep this
REM file quiet (echo is off and node inherits the stdin/stdout pipes).
node "%~dp0host.mjs"
