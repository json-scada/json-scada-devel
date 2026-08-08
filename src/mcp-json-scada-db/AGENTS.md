# DOX: src/mcp-json-scada-db — MCP Server

## Purpose

Model Context Protocol (MCP) server that provides AI coding assistants (Cline, Windsurf, Cursor, Copilot, etc.) with structured access to JSON-SCADA database schemas, development templates, and project context for AI-assisted development.

## Ownership

- mcp-json-scada-db owns the MCP server implementation and its skills (`src/.skills/`)
- Skills provide reusable behaviors for AI tools interacting with JSON-SCADA

## Local Contracts

- **Language:** TypeScript (Node.js)
- **Package manager:** npm
- **Build:** `npm run build` (TypeScript -> JS in `dist/`)
- **Pattern:** Express/MCP server with skills loaded from `.skills/` directory
- Skills are loaded dynamically and provide structured tool definitions

## Work Guidance

- Maintain MCP protocol compatibility (stdin/stdout transport)
- Skills should follow the MCP tool definition format
- Skills must be self-documenting with clear descriptions and parameter schemas
- New skills go in `src/.skills/` with descriptive filenames

## Verification

- `npm install` — install dependencies
- `npm run build` — TypeScript compilation succeeds
- `npm test` (if tests exist)
