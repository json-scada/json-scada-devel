# DOX: src/AdminUI — Web Admin Interface

## Purpose

Vue.js single-page application (SPA) for the JSON-SCADA web administration interface: real-time data visualization, configuration management, SVG synoptic displays, user management, and protocol monitoring.

## Ownership

- AdminUI owns all Vue components, routing, state management, styles, and the Vite build configuration
- All changes to the web interface happen here

## Local Contracts

- **Framework:** Vue 3 with Vite build tool
- **Package manager:** npm (see `package-lock.json`)
- **Linting:** ESLint (`.eslintrc.js`) + Prettier (`.prettierrc.json`)
- **Browser targets:** defined in `.browserslistrc`
- **Build output:** `dist/` directory
- **Dev server:** `npx vite` for local development
- **Production build:** `npm run build`
- All API calls go through the realtime data server (WebSocket + JWT auth)
- Vue component naming: PascalCase. Single-file components with `<script setup>` preferred
- Styles: scoped CSS. Global styles in `src/` root

## Work Guidance

- Maintain responsive design for mobile/tablet/desktop
- Use existing components and patterns when adding features
- SVG synoptic displays use the `svg-scada` skill conventions (JSON in `inkscape:label`)
- Internationalization (i18n): use established patterns in the codebase

## Verification

- `npm install` — install dependencies
- `npm run build` — production build must succeed with no errors
- `npx eslint src/` — lint check
