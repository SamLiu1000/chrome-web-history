@echo off
rem Double-click launcher for the cloud-sync guided deployment script.
rem %~dp0 resolves the folder this bat lives in, so the project can sit
rem in any path (including non-ASCII paths) without hardcoding it here.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it first: https://nodejs.org
  pause
  exit /b 1
)

node tools\setup-worker.mjs

echo.
pause
