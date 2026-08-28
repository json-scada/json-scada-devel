# DOX: src/carbone-reports — Carbone Report Generator

## Purpose

Node.js service for generating PDF/XLSX reports using the Carbone report engine. Creates templated SCADA reports from MongoDB data.

## Ownership

- carbone-reports owns the Carbone report generation integration

## Local Contracts

- **Language:** Node.js
- **Main entry:** `index.js`
- **Structure:**
  - `index.js` — report generation logic
  - `app-defs.js` — application definitions
  - `load-config.js` — configuration loader
  - `simple-logger.js` — logging utility
  - `point_list_template.ods` — template file for point list reports
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Uses Carbone.js templating engine to merge MongoDB data with ODS templates
- Generates PDF, XLSX, or other document formats
- Report templates define layout and data binding

## Verification

- Verify report generation with sample data and templates
