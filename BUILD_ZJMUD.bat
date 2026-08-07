@echo off
chcp 65001 >nul
title ZJMUD

set "ROOT=%~dp0"
cd /d "%ROOT%webclient"

echo.
echo   建置 ZJMUD 客戶端（release）
echo   ============================================================
echo.

where npm >nul 2>nul
if errorlevel 1 ( echo   [錯誤] 找不到 npm，請安裝 Node.js。& pause & exit /b 1 )
where cargo >nul 2>nul
if errorlevel 1 ( echo   [錯誤] 找不到 cargo，請安裝 Rust：https://rustup.rs & pause & exit /b 1 )

REM *  Windows  npm install
REM WSL  Linux  Tauri  binary
echo   [1/3] 安裝相依套件 ...
call npm install --no-fund --no-audit
if errorlevel 1 ( echo   [錯誤] npm install 失敗 & pause & exit /b 1 )

echo   [2/3] 執行測試 ...
call npm test
if errorlevel 1 ( echo   [警告] 有測試未通過，仍繼續建置。 )

echo   [3/3] 建置 release ...
call npx tauri build
if errorlevel 1 ( echo   [錯誤] 建置失敗 & pause & exit /b 1 )

echo.
echo   完成。產出位置：
echo     webclient\src-tauri\target\release\zjmud-client.exe
echo     webclient\src-tauri\target\release\bundle\
echo.
pause