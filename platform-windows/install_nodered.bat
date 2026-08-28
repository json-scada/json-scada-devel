@echo off
REM Installs an optional local Node-RED runtime for JSON-SCADA using the bundled Node.
REM Node-RED is optional: the NODE-RED driver also works with a remote or containerized
REM Node-RED. After running this, enable the JSON_SCADA_nodered_runtime service.

setlocal
set NODE=C:\json-scada\platform-windows\nodejs-runtime\node.exe
set NPM=C:\json-scada\platform-windows\nodejs-runtime\npm.cmd
set RUNTIME=C:\json-scada\platform-windows\nodered-runtime

echo Installing Node-RED (pinned major) and node-red-contrib-jsonscada into %RUNTIME% ...
if not exist "%RUNTIME%" mkdir "%RUNTIME%"

REM Local (non-global) install using the bundled Node runtime
call "%NPM%" install --prefix "%RUNTIME%" node-red@4 node-red-contrib-jsonscada
if errorlevel 1 (
  echo.
  echo ERROR: npm install failed. If this machine is offline, install from a tarball:
  echo   npm pack node-red@4 node-red-contrib-jsonscada  (on a connected machine)
  echo   then: npm install --prefix "%RUNTIME%" ^<tarball1^> ^<tarball2^>
  exit /b 1
)

REM Copy the settings template if not already present
if not exist "C:\json-scada\conf\node-red-settings.js" (
  copy /y "C:\json-scada\conf-templates\node-red-settings.js" "C:\json-scada\conf\node-red-settings.js"
  echo Copied node-red-settings.js to C:\json-scada\conf\
)
if not exist "C:\json-scada\conf\node-red" mkdir "C:\json-scada\conf\node-red"

echo.
echo Done. Node-RED editor will be at http://127.0.0.1:1880/nodered/ once the
echo JSON_SCADA_nodered_runtime service is started (see create_services.bat).
echo Review C:\json-scada\conf\node-red-settings.js and set adminAuth before any
echo network exposure. Enable the /nodered/ reverse-proxy location in conf\nginx.conf.
endlocal
