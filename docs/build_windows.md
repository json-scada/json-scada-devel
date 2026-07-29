# Build Intructions for Windows Platform

## Introduction

For better results and avoid problems, consider a clean Windows 11 install or VM to begin with.

## Install all the necessary tools

### Install Git

    winget install Git.Git

### Install Visual Studio 2026 and Dotnet SDKs

    winget install Microsoft.VisualStudio.Community --silent --accept-package-agreements --accept-source-agreements --override "--wait --quiet --add ProductLang En-us --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.Net.Component.4.8.TargetingPack --add Microsoft.VisualStudio.Workload.ManagedDesktop --add Microsoft.VisualStudio.Workload.NetCrossPlat --add Microsoft.VisualStudio.Workload.CoreEditor --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended"

    winget install Microsoft.DotNet.SDK.8
    winget install Microsoft.NuGet

    rem git clone https://github.com/microsoft/vcpkg C:\vcpkg
    rem C:\vcpkg\bootstrap-vcpkg.bat
    rem setx VCPKG_ROOT C:\vcpkg
    rem setx PATH "C:\vcpkg;%PATH%"

If msbuild.exe is not on the PATH, find it and add it:

    "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe
    Should print: C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe
    setx PATH "%PATH%;C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin"


### Install CMake 

    winget install Kitware.CMake

Install NSIS 3.12 

    winget install NSIS.NSIS

Install Access Control plugin for NSIS
https://nsis.sourceforge.io/mediawiki/images/4/4a/AccessControl.zip
Copy AccessControl.dll from Plugins\i386-ansi to NSIS\Plugins\x86-ansi
Copy AccessControl.dll from Plugins\i386-unicode to NSIS\Plugins\x86-unicode

### Install GO 

    winget install GoLang.Go

### Install JDK

    winget install EclipseAdoptium.Temurin.26.JDK

### Apache Maven
    winget install chocolatey
    choco install maven (As Admin)

### Install Nodejs

    winget install OpenJS.NodeJS

## Clone get repo

    git clone --recurse-submodules https://github.com/riclolsen/json-scada --config core.autocrlf=input

## Compiling and building the source code

Open "x64 Native Tools Command Prompt for VS".

    cd \json-scada\platform-windows
    build.bat

## Build the NSIS installer



C++ DNP3 drivers (Dnp3ClientCpp / Dnp3Server)

These need OpenSSL, opendnp3 and mongo-cxx-driver, which are built once by the
script below. It checks out the two git submodules, builds OpenSSL through the
vcpkg that ships with Visual Studio (triplet x64-windows-static-md), builds
opendnp3 with TLS enabled and installs mongo-cxx-driver into
src\mongo-cxx-driver-lib. It takes roughly half an hour and is skipped step by
step when re-run.

    cd src\dnp3
    build-windows-deps.bat

Afterwards platform-windows\build.bat builds the drivers along with everything
else. To build only them:

    src\dnp3\build-windows.bat          Dnp3ClientCpp
    src\dnp3\build-windows.bat server   both drivers

Set VCPKG_ROOT to relocate vcpkg (default: a vcpkg folder next to the
repository), or OPENSSL_ROOT_DIR to use an OpenSSL installation of your own.

