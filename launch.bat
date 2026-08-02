@echo off
REM Launch RockWorx Duo (Windows). Requires: python 3.10+ and "pip install pywinpty".
cd /d "%~dp0"
python server.py %*
