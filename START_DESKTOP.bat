@echo off
chcp 65001 >nul
title ZJMUD

REM ============================================================
REM TauriRust  TCP
REM *  release debug  dev server
REM URL ERR_CONNECTION_REFUSED
REM ============================================================

set "ROOT=%~dp0"
set "EXE=%ROOT%webclient\src-tauri\target\release\zjmud-client.exe"

call "%ROOT%START_SERVER.bat" < nul >nul 2>nul

tasklist /FI "IMAGENAME eq zjmud-client.exe" 2>nul | find /I "zjmud-client.exe" >nul
if not errorlevel 1 (
    echo   桌面版客戶端已在執行。
    pause & exit /b 0
)

if exist "%EXE%" (
    echo   啟動桌面版客戶端 ...
    start "" "%EXE%"
    echo.
    echo   已啟動。連線面板預設 127.0.0.1:5001，會自動連線。
    echo.
    pause & exit /b 0
)

echo   尚未建置 release 版，改用 tauri dev（首次約 3-5 分鐘）...
where cargo >nul 2>nul || ( echo   [錯誤] 找不到 cargo，請安裝 Rust：https://rustup.rs & pause & exit /b 1 )
cd /d "%ROOT%webclient"
if not exist node_modules call npm install --no-fund --no-audit
call npx tauri dev