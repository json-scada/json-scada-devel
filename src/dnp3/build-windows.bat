@echo off
setlocal
REM ==========================================================================
REM Builds the C++ DNP3 drivers for MSVC / Windows x64 and copies the
REM executables to the bin folder.
REM
REM Run build-windows-deps.bat first - it checks out the submodules and builds
REM OpenSSL, opendnp3 and mongo-cxx-driver.
REM
REM Usage:
REM   build-windows.bat            build Dnp3ClientCpp
REM   build-windows.bat server     build Dnp3Server as well
REM
REM Optional overrides, set before calling:
REM   VCPKG_ROOT       vcpkg location (default: <repo parent>\vcpkg)
REM   OPENSSL_ROOT_DIR use an existing OpenSSL instead of the vcpkg one
REM ==========================================================================

set "DNP3PATH=%~dp0"
set "SRCPATH=%~dp0.."
set "BINPATH=%~dp0..\..\bin"

where cmake >nul 2>nul || (echo ERROR: cmake not found on the PATH. & exit /b 1)

if not defined VCPKG_ROOT set "VCPKG_ROOT=%~dp0..\..\..\vcpkg"

REM A VCPKG_ROOT pointing at a classic-mode-less instance (e.g. the one Visual
REM Studio sets machine-wide, at ...\VC\vcpkg) has no installed\ tree. Fall
REM back to the default repo-local location build-windows-deps.bat uses.
if exist "%VCPKG_ROOT%\.vcpkg-root" if not exist "%VCPKG_ROOT%\ports" (
    echo === Ignoring classic-mode-less vcpkg at %VCPKG_ROOT% ===
    set "VCPKG_ROOT=%~dp0..\..\..\vcpkg"
)

if not defined OPENSSL_ROOT_DIR set "OPENSSL_ROOT_DIR=%VCPKG_ROOT%\installed\x64-windows-static-md"

if not exist "%OPENSSL_ROOT_DIR%\lib\libssl.lib" (
    echo ERROR: OpenSSL not found at %OPENSSL_ROOT_DIR%.
    echo Run build-windows-deps.bat first, or set OPENSSL_ROOT_DIR.
    exit /b 1
)
if not exist "%DNP3PATH%opendnp3\build\cpp\lib\Release\opendnp3.lib" (
    echo ERROR: opendnp3 is not built. Run build-windows-deps.bat first.
    exit /b 1
)
if not exist "%SRCPATH%\mongo-cxx-driver-lib\lib\mongoc-static-1.0.lib" (
    echo ERROR: mongo-cxx-driver is not installed. Run build-windows-deps.bat first.
    exit /b 1
)

if not exist "%BINPATH%" mkdir "%BINPATH%"

echo === Building Dnp3ClientCpp ===
if not exist "%DNP3PATH%Dnp3ClientCpp\build" mkdir "%DNP3PATH%Dnp3ClientCpp\build"
pushd "%DNP3PATH%Dnp3ClientCpp\build"
cmake .. -A x64 -DOPENSSL_ROOT_DIR="%OPENSSL_ROOT_DIR%" -DOPENSSL_USE_STATIC_LIBS=TRUE || (popd & exit /b 1)
cmake --build . --config Release --parallel || (popd & exit /b 1)
popd
copy /Y "%DNP3PATH%Dnp3ClientCpp\build\Release\Dnp3ClientCpp.exe" "%BINPATH%" || exit /b 1

if /i not "%1"=="server" goto :done

echo === Building Dnp3Server ===
if not exist "%DNP3PATH%Dnp3Server\build" mkdir "%DNP3PATH%Dnp3Server\build"
pushd "%DNP3PATH%Dnp3Server\build"
cmake .. -A x64 -DOPENSSL_ROOT_DIR="%OPENSSL_ROOT_DIR%" -DOPENSSL_USE_STATIC_LIBS=TRUE || (popd & exit /b 1)
cmake --build . --config Release --parallel || (popd & exit /b 1)
popd
copy /Y "%DNP3PATH%Dnp3Server\build\Release\Dnp3Server.exe" "%BINPATH%" || exit /b 1

:done
echo.
echo === Done, executables copied to %BINPATH% ===
endlocal
