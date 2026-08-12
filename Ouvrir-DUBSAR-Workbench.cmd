@echo off
setlocal

set "OPEN_ARG="
if /I "%~1"=="--check" set "OPEN_ARG=--check"
if /I "%~1"=="--file" set "OPEN_ARG=--file"
if not "%~1"=="" if not defined OPEN_ARG (
  echo Argument invalide.
  exit /b 1
)

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  echo Node.js 20 ou plus recent est requis.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0packages\dubsar-workbench-launcher\bin\dubsar-workbench-open.mjs" --reviews %OPEN_ARG%
if errorlevel 1 (
  echo Le Workbench n'a pas pu etre actualise. Aucun ancien rapport n'a ete ouvert.
  pause
  exit /b 1
)

exit /b 0
