@echo off
chcp 65001 >nul
title ZJMUD Web Window

REM ============================================================
REM  Open the web client in a small app-mode browser window.
REM  Run START_WEB.bat first (it serves the page + WS bridge),
REM  then run this. Usage: START_WEB_WINDOW.bat [host] [port] [WxH]
REM  Defaults: localhost 8080 1100x740
REM
REM  NOTE on window size: the layout switches to a single column
REM  below 900 CSS px. At 960 wide the three columns still fit but
REM  the centre message pane is only ~330px, which is cramped for
REM  MUD text. 1100x740 keeps it a small floating window while
REM  giving the centre pane ~480px. Pass a size to override.
REM ============================================================

cd /d "%~dp0"
setlocal enabledelayedexpansion

set "HOST=%~1"
if "%HOST%"=="" set "HOST=localhost"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8080"
set "WINSIZE=%~3"
if "%WINSIZE%"=="" set "WINSIZE=1100,740"
set "WINSIZE=%WINSIZE:x=,%"

REM --- is the bridge actually listening? ---
set "UP="
for /f "delims=" %%p in ('netstat -ano -p tcp ^| findstr LISTENING ^| findstr ":%PORT% "') do set "UP=1"
if not defined UP (
    echo.
    echo   [警告] 連接埠 %PORT% 沒有程式在聽 —— 請先執行 START_WEB.bat，再重新整理頁面。
    echo.
)

echo   本機：    http://%HOST%:%PORT%/
echo   區域網路（手機／其他電腦連這個，需允許 %PORT% 通過防火牆）：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    set "IP=%%a"
    set "IP=!IP: =!"
    echo             http://!IP!:%PORT%/
)
echo.

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
    echo   找不到 Chrome/Edge，改用系統預設瀏覽器開啟 ...
    start "" "http://%HOST%:%PORT%/"
    goto :done
)

REM --- app mode: no tabs, no address bar; separate profile so it is a fresh window ---
echo   開啟視窗（%WINSIZE%）...
start "" "!BROWSER!" --new-window --window-position=80,60 --window-size=%WINSIZE% --no-first-run --user-data-dir="%TEMP%\zjmud_web_%RANDOM%" --app=http://%HOST%:%PORT%/

:done
endlocal
