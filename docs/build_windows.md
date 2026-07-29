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

### Install Python

    winget install Python.Python.3.14

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


