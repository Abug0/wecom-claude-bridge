@echo off
rem ============================================
rem wecom-claude-bridge watchdog
rem Checks port 8787 every 30s; starts bridge if down.
rem Put a shortcut/copy in Startup folder for auto-run:
rem   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
rem ============================================
title wecom-bridge-watchdog

:loop
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] bridge not running, starting...
  cd /d "/path\projects\wecom-claude-bridge"
  start "wecom-bridge" /min node src\index.js
)
timeout /t 30 /nobreak >nul 2>&1
goto loop
