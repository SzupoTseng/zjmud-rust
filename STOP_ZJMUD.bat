@echo off
chcp 65001 >nul
title ZJMUD

echo.
echo   停止 ZJMUD ...
echo.

set "STOPPED=0"

tasklist /FI "IMAGENAME eq zjmud-client.exe" 2>nul | find /I "zjmud-client.exe" >nul
if not errorlevel 1 (
    taskkill /F /IM zjmud-client.exe >nul 2>nul
    echo   [x] 客戶端已停止
    set "STOPPED=1"
)

REM tauri dev  cargo/node
tasklist /FI "IMAGENAME eq cargo.exe" 2>nul | find /I "cargo.exe" >nul
if not errorlevel 1 (
    taskkill /F /IM cargo.exe >nul 2>nul
    echo   [x] tauri dev 監看行程已停止
)

REM node  bridge\server.mjs
REM node.exe   node
wmic process where "name='node.exe' and commandline like '%bridge%'" delete >nul 2>nul
if not errorlevel 1 echo   [x] Web 橋接已停止（若有）

tasklist /FI "IMAGENAME eq driver.exe" 2>nul | find /I "driver.exe" >nul
if not errorlevel 1 (
    taskkill /F /IM driver.exe >nul 2>nul
    echo   [x] MUD 伺服器已停止
    set "STOPPED=1"
)

if "%STOPPED%"=="0" echo   沒有執行中的 ZJMUD 行程。

echo.
echo   注意：直接砍掉 driver.exe 不會做正常存檔流程。
echo         若在意玩家資料，請先在遊戲內用 quit 登出。
echo.
pause