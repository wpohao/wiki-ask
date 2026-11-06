@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=%~dp0"
if not defined WIKICHAT_CONFIG_DIR set "WIKICHAT_CONFIG_DIR=%USERPROFILE%\.wikichat"
for %%I in ("%WIKICHAT_CONFIG_DIR%") do set "WIKICHAT_CONFIG_DIR=%%~fI"
set "TOKEN_FILE=%WIKICHAT_CONFIG_DIR%\token"
set "PORT=%WIKICHAT_PORT%"
if not defined PORT set "PORT=7798"

where node >nul 2>&1
if errorlevel 1 (
  echo [wiki-ask] 找不到 node，請先安裝 Node.js 20 以上。
  pause
  exit /b 1
)

call :health
if "%HTTP_CODE%"=="200" (
  echo [wiki-ask] daemon 已在執行，直接開啟瀏覽器。
  goto open_browser
)

echo [wiki-ask] 正在開啟 daemon 視窗...
start "wiki-ask daemon" /D "%PROJECT_DIR%daemon" "%ComSpec%" /d /k "node server.js"
if errorlevel 1 (
  echo [wiki-ask] 無法啟動 daemon 視窗。
  pause
  exit /b 1
)

echo [wiki-ask] 等待 daemon 就緒...
for /l %%N in (1,1,20) do (
  rem ping waits ~1s anywhere; timeout.exe needs console input and Git Bash's PATH finds GNU timeout first.
  >nul "%SystemRoot%\System32\PING.EXE" -n 2 127.0.0.1
  call :health
  call :ready_check
  if defined READY goto open_browser
)

echo [wiki-ask] 等待 daemon 逾時，請查看 daemon 視窗的錯誤訊息。
pause
exit /b 1

:open_browser
if not exist "%TOKEN_FILE%" (
  echo [wiki-ask] 找不到 token 檔：%TOKEN_FILE%
  pause
  exit /b 1
)
set /p TOKEN=<"%TOKEN_FILE%"
start "" "http://127.0.0.1:%PORT%/#token=%TOKEN%"
exit /b 0

:health
set "HTTP_CODE="
for /f %%C in ('curl --ssl-no-revoke -s -o nul -w "%%{http_code}" "http://127.0.0.1:%PORT%/health" 2^>nul') do set "HTTP_CODE=%%C"
exit /b 0

:ready_check
set "READY="
if exist "%TOKEN_FILE%" if "%HTTP_CODE%"=="200" set "READY=1"
exit /b 0
