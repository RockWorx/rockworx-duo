@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title RockWorx Duo installer
echo.
echo   ============================================================
echo    RockWorx Duo -- installer
echo   ------------------------------------------------------------
echo    This sets up RockWorx Duo on your PC and starts it.
echo    Nothing leaves your machine -- every file here is readable.
echo    It takes about a minute. Here we go.
echo   ============================================================
echo.

echo [1/4] Looking for Python...
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY ( python --version >nul 2>&1 && set "PY=python" )

if not defined PY (
  echo       Python is not installed on this PC.
  where winget >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   Please install Python 3.10 or newer from:
    echo       https://www.python.org/downloads/
    echo   During setup, TICK the box that says "Add python.exe to PATH".
    echo   Then double-click install.bat again.
    echo.
    pause
    exit /b 1
  )
  echo       Installing Python for you via winget ^(you may see a Windows prompt^)...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  echo.
  echo   ------------------------------------------------------------
  echo    Python is installed. Just one more step:
  echo    please CLOSE this window and double-click install.bat again
  echo    to finish setting up.
  echo   ------------------------------------------------------------
  echo.
  pause
  exit /b 0
)
echo       Found Python ^(!PY!^). Good.
echo.

echo [2/4] Creating a private environment ^(.venv^) just for RockWorx Duo...
if exist ".venv\Scripts\python.exe" (
  echo       It already exists -- reusing it.
) else (
  !PY! -m venv .venv
  if errorlevel 1 ( echo       Could not create the environment. & pause & exit /b 1 )
  echo       Done.
)
echo.

echo [3/4] Downloading the small components it needs ^(this can take a minute^)...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>&1
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 ( echo       Install failed -- see the messages above. & pause & exit /b 1 )
echo       Done.
echo.

echo [4/4] Adding a "RockWorx Duo" shortcut to your Desktop...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $l=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\RockWorx Duo.lnk'); $l.TargetPath='%~dp0launch.bat'; $l.WorkingDirectory='%~dp0'; if (Test-Path '%~dp0favicon.ico'){$l.IconLocation='%~dp0favicon.ico'}; $l.Save()" 2>nul && echo       Done -- look for "RockWorx Duo" on your Desktop. || echo       ^(Could not create the shortcut -- use launch.bat instead.^)
echo.

echo   ============================================================
echo    All set! Starting RockWorx Duo now...
echo      * Your web browser will open in a moment.
echo      * KEEP THIS WINDOW OPEN while you use it.
echo      * To stop RockWorx Duo: close this window.
echo      * To start it again later: double-click "RockWorx Duo" on
echo        your Desktop (or launch.bat in this folder).
echo   ============================================================
echo.
".venv\Scripts\python.exe" server.py
echo.
echo RockWorx Duo has stopped. You can close this window.
pause
