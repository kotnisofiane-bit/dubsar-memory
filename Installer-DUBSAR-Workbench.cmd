@echo off
setlocal

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
  echo Windows PowerShell est introuvable.
  pause
  exit /b 1
)

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0packages\dubsar-workbench-launcher\scripts\install-shortcut.ps1"
if errorlevel 1 (
  echo L'installation du raccourci DUBSAR Workbench a echoue.
  pause
  exit /b 1
)

pause
exit /b 0
