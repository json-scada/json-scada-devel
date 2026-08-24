@echo off
REM Build the Go Change Stream Data Processor for Windows.
setlocal
cd /d "%~dp0"
set CGO_ENABLED=0
go build -ldflags="-s -w" -o cs_data_processor.exe .
if errorlevel 1 exit /b 1
echo Built cs_data_processor.exe
endlocal
