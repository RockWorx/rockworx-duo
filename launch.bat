@echo off
REM Re-launch RockWorx Duo (Windows). Run install.bat first (creates .venv + installs deps).
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" server.py %*
) else (
  echo No environment found -- run install.bat first. Falling back to system Python...
  python server.py %*
)
pause
