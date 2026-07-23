
set JSPATH=\json-scada
set SRCPATH=%JSPATH%\src
set BINPATH=%JSPATH%\bin
set BINWINPATH=%JSPATH%\demo-docker\bin_win
set NPM=%JSPATH%\platform-windows\nodejs-runtime\npm
set NPX=%JSPATH%\platform-windows\nodejs-runtime\npx
rem _set NPM="%programfiles%\nodejs\npm"

go mod tidy
go build -ldflags="-s -w" -o %BINPATH%\iec104client.exe .\cmd\iec104client
go build -ldflags="-s -w" -o %BINPATH%\iec104server.exe .\cmd\iec104server
go build -ldflags="-s -w" -o %BINPATH%\iec101client.exe .\cmd\iec101client
go build -ldflags="-s -w" -o %BINPATH%\iec101server.exe .\cmd\iec101server
go build -ldflags="-s -w" -o %BINPATH%\iec103client.exe .\cmd\iec103client
