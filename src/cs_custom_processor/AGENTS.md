# DOX: src/cs_custom_processor — Custom Change Stream Processor

## Purpose

TypeScript application providing a user-extensible change stream data processor. Users write custom TypeScript modules to implement bespoke SCADA logic, protocol transformation, and data processing.

## Ownership

- cs_custom_processor owns the custom processor framework and user module interface

## Local Contracts

- **Language:** TypeScript (compiled to JS via `tsconfig.json`)
- **Main source:** `src/` directory
  - `cs_custom_processor.ts` — core processor framework
  - `customized_module.ts` — user-customizable module template
  - `src/jsonscada/` — JSON-SCADA type definitions and utilities
- **Build output:** `dist/` directory (compiled JS)
- **Build:** `npm run build` (TypeScript compilation)
- **Config:** INI file via Supervisor
- **Pattern:** Prettier (`.prettierrc.json`)

## Work Guidance

- The framework subscribes to MongoDB Change Streams and dispatches events to user modules
- Users modify `customized_module.ts` to implement custom logic
- TypeScript types in `src/jsonscada/` provide IDE autocompletion for JSON-SCADA data structures
- The `dist/` output is what Node.js actually runs in production
- Think of this as a plugin system: the framework handles connectivity/redundancy, the user module handles business logic

## Verification

- `npm install` — dependencies install cleanly
- `npm run build` — TypeScript compiles with no errors
- Test with sample customized_module.ts that processes change stream events
