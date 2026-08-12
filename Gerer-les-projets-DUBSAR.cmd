@echo off
setlocal

if not "%~1"=="" (
  echo Argument invalide.
  exit /b 1
)

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  echo Node.js 20 ou plus recent est requis.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0packages\dubsar-workbench-launcher\bin\dubsar-workbench-open.mjs" --manage
if errorlevel 1 (
  echo La gestion des projets a echoue.
  pause
  exit /b 1
)

exit /b 0
