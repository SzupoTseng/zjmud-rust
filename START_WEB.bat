@echo off
chcp 65001 >nul
title ZJMUD

REM ============================================================
REM WebSocket  +
REM transport
REM localhost  IP
REM ============================================================

set "ROOT=%~dp0"
set "WEB_PORT=8080"

where node >nul 2>nul || ( echo   [錯誤] 找不到 node，請安裝 Node.js：https://nodejs.org & pause & exit /b 1 )

cd /d "%ROOT%webclient"
if not exist "node_modules\ws" (
    echo   安裝橋接相依套件 ...
    call npm install --no-fund --no-audit
)

echo.
echo   本機 IP（手機用這個連）：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do echo       http://%%a:%WEB_PORT%
echo   本機瀏覽器：  http://localhost:%WEB_PORT%
echo.
echo   關閉此視窗即停止橋接。
echo   ------------------------------------------------------------
echo.

start "" "http://localhost:%WEB_PORT%"
node bridge\server.mjs --port %WEB_PORT% --mud-host 127.0.0.1 --mud-port 5001