@echo off
setlocal EnableExtensions
chcp 65001 >nul

REM ===========================================================
REM  daily-dashboard : one-click publish to GitHub
REM
REM  Usage:  tools\push-to-github.cmd [owner] [repo]
REM  Proxy:  set DASH_PROXY=http://host:port   (default 127.0.0.1:7890)
REM
REM  Why a proxy is needed: github.com is not reachable directly on
REM  this machine (TLS-layer block + poisoned DNS). The Pages CDN
REM  (github.io) IS reachable, so only the push needs the proxy.
REM ===========================================================

set "OWNER=%~1"
if "%OWNER%"=="" set "OWNER=leoli04"
set "REPO=%~2"
if "%REPO%"=="" set "REPO=daily-dashboard"
set "PROXY=%DASH_PROXY%"
if "%PROXY%"=="" set "PROXY=http://127.0.0.1:7890"

echo.
echo  daily-dashboard  --^>  GitHub
echo    repo   : %OWNER%/%REPO%
echo    proxy  : %PROXY%
echo.

cd /d "%~dp0.."
if not exist ".git" (
  echo [FAIL] .git not found. Run from the repository: tools\push-to-github.cmd
  exit /b 1
)

echo [1/5] checking proxy ...
set "DASH_PROXY_URI=%PROXY%"
powershell -NoProfile -Command "try{$u=[Uri]$env:DASH_PROXY_URI;$c=New-Object Net.Sockets.TcpClient;$c.Connect($u.Host,$u.Port);$c.Close();exit 0}catch{exit 1}"
if errorlevel 1 (
  echo [FAIL] cannot reach %PROXY%
  echo        Start your proxy first, or set DASH_PROXY=http://host:port
  exit /b 1
)
echo       ok

echo [2/5] pointing git at the proxy (repo-local only) ...
git config --local "http.https://github.com.proxy" "%PROXY%"

echo [3/5] checking git identity ...
set "GITMAIL="
for /f "delims=" %%i in ('git config --get user.email 2^>nul') do set "GITMAIL=%%i"
if not defined GITMAIL (
  echo       unset - installing a repo-local fallback
  git config --local user.email "%OWNER%@users.noreply.github.com"
  git config --local user.name  "%OWNER%"
) else (
  echo       %GITMAIL%
)

echo [4/5] staging and committing ...
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore: publish dashboard source and Pages workflow"
) else (
  echo       nothing to commit
)

echo [5/5] pushing ...
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "https://github.com/%OWNER%/%REPO%.git"
) else (
  git remote set-url origin "https://github.com/%OWNER%/%REPO%.git"
)
git branch -M main
git push -u origin main
if errorlevel 1 (
  echo.
  echo [FAIL] push failed.
  echo        Most likely the repository does not exist yet:
  echo          https://github.com/%OWNER%/%REPO%
  echo        Create it EMPTY ^(no README / no .gitignore / no license^),
  echo        then run this script again.
  exit /b 1
)

echo.
echo DONE. Two manual steps left in the browser:
echo   1. repo -^> Settings -^> Pages -^> Source = "GitHub Actions"
echo   2. repo -^> Actions  -^> enable workflows if prompted
echo.
echo Site: https://%OWNER%.github.io/%REPO%/
echo.
endlocal
