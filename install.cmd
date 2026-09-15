@echo off
rem install.cmd - Windows wrapper for install.ps1 (bypasses ExecutionPolicy).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo Install failed with exit code %EXITCODE%.
) else (
  echo.
  echo Install finished successfully.
)
pause
exit /b %EXITCODE%
