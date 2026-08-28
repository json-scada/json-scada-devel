# DOX: platform-rhel10 — RHEL 10 / Rocky 10 / Alma 10 Deployment

## Purpose

Automated installation and configuration scripts for deploying JSON-SCADA on RHEL 10 and compatible derivatives (Rocky Linux 10, AlmaLinux 10). Supports both x86-64 and ARM64 architectures.

## Ownership

- platform-rhel10 owns the RHEL 10 installer and service configs
- Sister directory to platform-rhel9 — differs in package versions and compatibility

## Local Contracts

Identical structure to [platform-rhel9/AGENTS.md](../platform-rhel9/AGENTS.md):
- Installers: `json-scada-install.sh`, `json-scada-install-aarch64.sh`
- Supervisor config: `supervisord.conf`
- One `.ini` file per service
- Nginx, MongoDB, PostgreSQL configs

## Work Guidance

- Keep configs in sync with platform-rhel9 — differences are RHEL 10 package versions and compatibility adjustments
- When adding a new service, add configs to both RHEL platform dirs

## Verification

- Run installer on fresh RHEL 10 / Rocky 10 / Alma 10 VM
- Validate all daemons via `supervisorctl status`
