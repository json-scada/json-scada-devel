# DOX: jscli — JSON-SCADA command line client

## Purpose

Use the authenticated JSON-SCADA HTTP APIs from a terminal and exchange JSON, CSV, XLSX, and ODS data.

## Ownership

- Owns the Python package, console entry point, and usage guide.
- The server owns the API schemas, authorization, persistence and audit trail.

## Local Contracts

- Python 3.10+. Install with `python -m pip install ./src/jscli` from the repository root.
- Remote operations require verified HTTPS. Sign in through `/Invoke/auth/signin`, use the returned JWT in `x-access-token`, and sign out after the invocation. Keep credentials and session state out of local config and command line password arguments.
- `graphql` sends the supplied operation to `/apollo`. `request` sends same-server HTTP requests with JSON, raw bodies or multipart forms. `convert` handles formats locally.
- Shortcuts accept flags for common read and operator actions, send values as GraphQL variables, and return the selected operation's result. History returns one row per sample. `set-tag --input` validates all property records before making sequential requests.
- Table input uses named columns. JSON cell mode preserves JSON values and distinguishes missing fields from null and empty string.

## Work Guidance

- Keep the generic commands available for operations outside the shortcuts. Check shortcut queries and mutations against the server schema when changing their flags or output.
- Keep output data on stdout or in the requested file and diagnostics on stderr.
- Batch calls are sequential. Stop on request failure and report the affected input row. Never retry mutations automatically.

## Verification

- Install in a Python virtual environment and run `jscli --help`.
- Use `jscli convert` to round-trip representative JSON through CSV, XLSX, and ODS in JSON cell mode.
