@echo off
setlocal
REM ==========================================================================
REM Builds the native dependencies of the C++ DNP3 drivers (Dnp3ClientCpp and
REM Dnp3Server) for MSVC / Windows x64:
REM
REM   1. OpenSSL          - via vcpkg, triplet x64-windows-static-md
REM                         (static OpenSSL + dynamic CRT, matching /MD)
REM   2. opendnp3         - git submodule, static lib, TLS enabled
REM   3. mongo-cxx-driver - git submodule, static libs, installed into
REM                         src\mongo-cxx-driver-lib
REM
REM Requires Visual Studio 2022 or later with the "Desktop development with
REM C++" workload, plus cmake and git on the PATH.
REM
REM Run this once. Every step is skipped when its output already exists, so
REM the script is safe to re-run. Then use build-windows.bat to build the
REM drivers themselves.
REM
REM Optional overrides, set before calling:
REM   VCPKG_ROOT       vcpkg location (default: <repo parent>\vcpkg)
REM   OPENSSL_ROOT_DIR use an existing OpenSSL instead of the vcpkg one
REM ==========================================================================

set "SRCPATH=%~dp0.."
set "DNP3PATH=%~dp0"

where cmake >nul 2>nul || (echo ERROR: cmake not found on the PATH. & exit /b 1)
where git >nul 2>nul || (echo ERROR: git not found on the PATH. & exit /b 1)

REM --- git submodules -------------------------------------------------------
if not exist "%DNP3PATH%opendnp3\CMakeLists.txt" (
    echo === Checking out the opendnp3 submodule ===
    git -C "%SRCPATH%\.." submodule update --init --recursive src/dnp3/opendnp3 || exit /b 1
)
if not exist "%SRCPATH%\mongo-cxx-driver\mongo-cxx-driver\CMakeLists.txt" (
    echo === Checking out the mongo-cxx-driver submodule ===
    git -C "%SRCPATH%\.." submodule update --init --recursive src/mongo-cxx-driver/mongo-cxx-driver || exit /b 1
)

REM --- OpenSSL via vcpkg ----------------------------------------------------
if defined OPENSSL_ROOT_DIR goto :openssl_ready

if not defined VCPKG_ROOT set "VCPKG_ROOT=%~dp0..\..\..\vcpkg"
set "OPENSSL_ROOT_DIR=%VCPKG_ROOT%\installed\x64-windows-static-md"

if exist "%OPENSSL_ROOT_DIR%\lib\libssl.lib" goto :openssl_ready

if not exist "%VCPKG_ROOT%\.vcpkg-root" (
    echo === Cloning vcpkg into %VCPKG_ROOT% ===
    git clone --depth 1 https://github.com/microsoft/vcpkg.git "%VCPKG_ROOT%" || exit /b 1
)

REM The vcpkg copy bundled with Visual Studio is read-only and refuses classic
REM mode, but its executable works fine when placed in a full vcpkg clone.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VCPKG_ROOT%\vcpkg.exe" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -prerelease -products * -property installationPath`) do (
        if exist "%%i\VC\vcpkg\vcpkg.exe" copy /Y "%%i\VC\vcpkg\vcpkg.exe" "%VCPKG_ROOT%\vcpkg.exe" >nul
    )
)
if not exist "%VCPKG_ROOT%\vcpkg.exe" (
    echo === Bootstrapping vcpkg ===
    call "%VCPKG_ROOT%\bootstrap-vcpkg.bat" -disableMetrics || exit /b 1
)

echo === Building OpenSSL with vcpkg (this takes a while) ===
"%VCPKG_ROOT%\vcpkg.exe" install openssl:x64-windows-static-md || exit /b 1

:openssl_ready
echo === OpenSSL: %OPENSSL_ROOT_DIR% ===

REM --- opendnp3 -------------------------------------------------------------
if exist "%DNP3PATH%opendnp3\build\cpp\lib\Release\opendnp3.lib" (
    echo === opendnp3 already built, skipping ===
) else (
    echo === Building opendnp3 ===
    if not exist "%DNP3PATH%opendnp3\build" mkdir "%DNP3PATH%opendnp3\build"
    pushd "%DNP3PATH%opendnp3\build"
    cmake .. -A x64 -DDNP3_TLS=ON -DDNP3_EXAMPLES=OFF ^
        -DOPENSSL_ROOT_DIR="%OPENSSL_ROOT_DIR%" -DOPENSSL_USE_STATIC_LIBS=TRUE || (popd & exit /b 1)
    cmake --build . --config Release --parallel || (popd & exit /b 1)
    popd
)

REM --- mongo-cxx-driver -----------------------------------------------------
REM The C driver (libmongoc/libbson) is downloaded and built as a subproject
REM and uses Windows Secure Channel for TLS, so it needs no OpenSSL.
if exist "%SRCPATH%\mongo-cxx-driver-lib\lib\mongoc-static-1.0.lib" (
    echo === mongo-cxx-driver already installed, skipping ===
) else (
    echo === Building mongo-cxx-driver ===
    if not exist "%SRCPATH%\mongo-cxx-driver\mongo-cxx-driver\build" mkdir "%SRCPATH%\mongo-cxx-driver\mongo-cxx-driver\build"
    pushd "%SRCPATH%\mongo-cxx-driver\mongo-cxx-driver\build"
    cmake .. -A x64 -DCMAKE_CXX_STANDARD=17 -DENABLE_TESTS=OFF ^
        -DBUILD_SHARED_LIBS=OFF -DBUILD_SHARED_AND_STATIC_LIBS=OFF ^
        -DCMAKE_INSTALL_PREFIX="%SRCPATH%\mongo-cxx-driver-lib" || (popd & exit /b 1)
    cmake --build . --config RelWithDebInfo --parallel || (popd & exit /b 1)
    cmake --build . --config RelWithDebInfo --target install || (popd & exit /b 1)
    popd
)

echo.
echo === Dependencies ready. Now run build-windows.bat ===
endlocal
