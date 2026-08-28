# DOX: platform-mac — macOS Build Scripts

## Purpose

Build scripts and configuration for running JSON-SCADA on macOS (both Intel x86-64 and Apple Silicon ARM/M-series).

## Ownership

- platform-mac owns macOS-specific build support

## Local Contracts

- `build.sh` — build script for macOS
- `README.md` — macOS-specific notes and instructions

## Work Guidance

- macOS is a development platform, not a production deployment target
- Homebrew is the expected package manager for dependencies
- ARM M-series requires Rosetta 2 for x86-only binaries (e.g., DNP3, OPC-DA are Windows-only)
- MongoDB ARM build available for native M-series performance

## Verification

- Run `build.sh` on both Intel Mac and Apple Silicon Mac
- Verify all Node.js and Go components compile and run
