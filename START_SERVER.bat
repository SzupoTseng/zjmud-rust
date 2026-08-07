@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title ZJMUD

REM ============================================================
REM MUD LPMud-Name /
REM telnet 5001 = UTF-8  <--
REM telnet 5003 = GBK     telnet
REM ws     5004 = driver  websocket
REM ============================================================

set "SERVER_DIR=%~dp0LPMud-Name\world"

if not exist "%SERVER_DIR%\driver.exe" (
    echo   [錯誤] 找不到 %SERVER_DIR%\driver.exe
    pause & exit /b 1
)

tasklist /FI "IMAGENAME eq driver.exe" 2>nul | find /I "driver.exe" >nul
if not errorlevel 1 (
    echo   MUD 伺服器已在執行。
    goto :ok
)

echo   啟動 MUD 伺服器 ...
start "ZJMUD Server" /D "%SERVER_DIR%" driver.exe config.ini

set /a N=0
:wait
netstat -an | findstr /C:":5001 " | findstr /I "LISTENING" >nul
if not errorlevel 1 goto :ok
ping -n 2 127.0.0.1 >nul
set /a N+=1
if %N% LSS 30 goto :wait
echo   [錯誤] 伺服器未能在 30 秒內監聽 5001，請看 "ZJMUD Server" 視窗。
pause & exit /b 1

:ok
echo.
echo   伺服器就緒：127.0.0.1:5001 ^(UTF-8^)
echo.
pause