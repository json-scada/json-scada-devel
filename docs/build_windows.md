# Build Intructions for Windows Platform

## Introduction

For better results and avoid problems, consider a clean Windows 11 install or VM to begin with.

## Install all the necessary tools

Install Git

    winget install Git.Git

Install Visual Studio 2026 and Dotnet SDKs

    winget install Microsoft.VisualStudio.Community --silent --accept-package-agreements --accept-source-agreements --override "--wait --quiet --add ProductLang En-us --add Microsoft.VisualStudio.Workload.ManagedDesktop --add Microsoft.VisualStudio.Workload.NetCrossPlat --add Microsoft.VisualStudio.Workload.NativeDesktop --add Microsoft.VisualStudio.Workload.CoreEditor –-installPath ""c:\Program Files\Microsoft Visual Studio\18\Community"""

    winget install Microsoft.DotNet.Framework.DeveloperPack_4
    winget install Microsoft.DotNet.SDK.8

Install CMake 

    winget install Kitware.CMake

Install NSIS 3.12 

    winget install NSIS.NSIS

Install Access Control plugin for NSIS
https://nsis.sourceforge.io/mediawiki/images/4/4a/AccessControl.zip
Copy AccessControl.dll from Plugins\i386-ansi to NSIS\Plugins\x86-ansi
Copy AccessControl.dll from Plugins\i386-unicode to NSIS\Plugins\x86-unicode

Install GO 

    winget install GoLang.Go

Install JDK

    winget install EclipseAdoptium.Temurin.26.JDK

Apache Maven
    winget install chocolatey
    choco install maven (As Admin)

Install Nodejs

    winget install OpenJS.NodeJS

Clone get repo

    git clone --recurse-submodules https://github.com/riclolsen/json-scada --config core.autocrlf=input

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

