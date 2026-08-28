# DOX: src/updateUser — User Management Utility

## Purpose

Node.js command-line utility for managing JSON-SCADA user accounts: create, update, delete users and roles in MongoDB.

## Ownership

- updateUser owns the user management CLI tool

## Local Contracts

- **Language:** Node.js
- **Main entry:** `updateUser.js`
- **Pattern:** standard Node.js app (`app-defs.js`, `load-config.js`, `simple-logger.js`)
- **Config:** INI file via Supervisor or environment variables
- **Execution:** Command-line only (not a service)

## Work Guidance

- Used during initial setup and ongoing user administration
- Operates directly on the MongoDB users collection
- Supports password hashing and role assignment
- Can be run as a standalone CLI tool

## Verification

- Test user creation, update, and deletion operations
- Verify changes appear in MongoDB users collection
