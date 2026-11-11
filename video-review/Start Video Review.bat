@echo off
rem Double-click this file to start Video Review (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed yet. Installing it with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Couldn't install Node.js automatically. Install it from https://nodejs.org then run this file again.
    start https://nodejs.org
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
echo Starting Video Review... keep this window open while you work.
node server.js
pause
