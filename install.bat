@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title RockWorx Duo installer
echo ============================================
echo   RockWorx Duo -- installer
echo ============================================
echo.

REM --- find a real Python (prefer the py launcher; the bare "python" may be the Store stub) ---
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY ( python --version >nul 2>&1 && set "PY=python" )

if not defined PY (
  echo Python was not found on this PC.
  where winget >nul 2>&1
  if errorlevel 1 (
    echo Please install Python 3.10+ from https://www.python.org/downloads/
    echo ^(tick "Add python.exe to PATH" during setup^), then double-click install.bat again.
    echo.
    pause
    exit /b 1
  )
  echo Installing Python via winget ^(this may take a minute^)...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  echo.
  echo ---------------------------------------------------------------
  echo  Python is installed. Please CLOSE this window and
  echo  double-click install.bat again to finish setting up.
  echo ---------------------------------------------------------------
  pause
  exit /b 0
)

echo Using Python: !PY!
if not exist ".venv\Scripts\python.exe" (
  echo Creating a private environment ^(.venv^)...
  !PY! -m venv .venv || ( echo Could not create the environment. & pause & exit /b 1 )
)
echo Installing dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt || ( echo Dependency install failed -- see above. & pause & exit /b 1 )

echo.
echo ============================================
echo   Starting RockWorx Duo -- your browser will open automatically.
echo   Keep this window open while you use it; close it to stop.
echo   Next time, just double-click launch.bat.
echo ============================================
echo.
".venv\Scripts\python.exe" server.py
pause
