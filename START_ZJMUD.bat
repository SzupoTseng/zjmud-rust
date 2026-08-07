@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title ZJMUD

REM ============================================================
REM ZJMUD MUD  + Web
REM
REM LPMud-NameFluffOS driver.exe
REM telnet 5001 = UTF-8
REM telnet 5003 = GBK  telnet
REM ws     5004 = driver  websocket
REM release  tauri dev
REM ============================================================

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%LPMud-Name\world"
set "CLIENT_DIR=%ROOT%webclient"
set "EXE_RELEASE=%CLIENT_DIR%\src-tauri\target\release\zjmud-client.exe"

echo.
echo   ZJMUD 啟動器
echo   ============================================================
echo.

REM ---------- 1.  ----------
if not exist "%SERVER_DIR%\driver.exe" (
    echo   [錯誤] 找不到伺服器：%SERVER_DIR%\driver.exe
    echo          請確認專案目錄結構完整。
    goto :fail
)

REM ---------- 2.  MUD  ----------
tasklist /FI "IMAGENAME eq driver.exe" 2>nul | find /I "driver.exe" >nul
if errorlevel 1 (
    echo   [1/2] 啟動 MUD 伺服器 ...
    start "ZJMUD Server" /D "%SERVER_DIR%" driver.exe config.ini
    echo         等待伺服器就緒 ^(約 20 秒^) ...
    call :waitport 5001 30
    if errorlevel 1 (
        echo   [錯誤] 伺服器未能在時限內開始監聽 5001。
        echo          請看 "ZJMUD Server" 那個視窗的錯誤訊息。
        goto :fail
    )
    echo         伺服器就緒：127.0.0.1:5001
) else (
    echo   [1/2] MUD 伺服器已在執行，略過。
)

REM ---------- 3.  ----------
tasklist /FI "IMAGENAME eq zjmud-client.exe" 2>nul | find /I "zjmud-client.exe" >nul
if not errorlevel 1 (
    echo   [2/2] 客戶端已在執行。若要重開請先執行 STOP_ZJMUD.bat
    goto :done
)

REM release  exe
REM debug tauri dev  dev server  URL
REM ERR_CONNECTION_REFUSED   tauri dev
if exist "%EXE_RELEASE%" (
    echo   [2/2] 啟動客戶端 ^(release^) ...
    start "" "%EXE_RELEASE%"
    goto :done
)

echo   [2/2] 尚無 release 版，改用 tauri dev 啟動。
echo         ^(想要可獨立執行的版本，請先跑 BUILD_ZJMUD.bat^)
echo         首次編譯約需 3-5 分鐘，請耐心等候 ...
echo.
where npm >nul 2>nul
if errorlevel 1 (
    echo   [錯誤] 找不到 npm。請安裝 Node.js：https://nodejs.org
    goto :fail
)
where cargo >nul 2>nul
if errorlevel 1 (
    echo   [錯誤] 找不到 cargo。請安裝 Rust：https://rustup.rs
    goto :fail
)
cd /d "%CLIENT_DIR%"
if not exist "node_modules" (
    echo         安裝相依套件 ...
    call npm install --no-fund --no-audit
)
start "ZJMUD Client (dev)" /D "%CLIENT_DIR%" cmd /c "npx tauri dev"

:done
echo.
echo   ------------------------------------------------------------
echo   完成。客戶端會自動連線到 127.0.0.1:5001。
echo.
echo   首次登入：客戶端會自動跳出登入表單，填帳號密碼即可。
echo   帳號規則：4-20 字元、英文字母開頭、只能用小寫字母/數字/底線
echo   帳號不存在會自動註冊；沒有角色會再跳出建立角色視窗。
cho.
echo   要停止請執行：STOP_ZJMUD.bat
echo   ------------------------------------------------------------
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1

REM ----------  ----------
REM %1 =    %2 =
:waitport
setlocal
set "PORT=%~1"
set /a LIMIT=%~2
set /a N=0
:wploop
netstat -an | findstr /C:":%PORT% " | findstr /I "LISTENING" >nul
if not errorlevel 1 (endlocal & exit /b 0)
timeout /t 1 /nobreak >nul
set /a N+=1
if %N% LSS %LIMIT% goto :wploop
endlocal & exit /b 1