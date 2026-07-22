set JSPATH=\json-scada
set SRCPATH=%JSPATH%\src
set BINPATH=%JSPATH%\bin
set BINWINPATH=%JSPATH%\demo-docker\bin_win
set NPM=%JSPATH%\platform-windows\nodejs-runtime\npm
set NPX=%JSPATH%\platform-windows\nodejs-runtime\npx
rem _set NPM="%programfiles%\nodejs\npm"

set GOOS=windows
set GOARCH=amd64
go mod tidy 
go build -ldflags="-s -w"
copy /Y iccp-server.exe %BINPATH%
set GOOS=linux
set GOARCH=arm64
go build -ldflags="-s -w" -o iccp-server-linux-arm64
set GOOS=linux
set GOARCH=amd64
go build -ldflags="-s -w" -o iccp-server-linux-amd64
set GOOS=
set GOARCH=
