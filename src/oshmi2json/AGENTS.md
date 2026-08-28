# DOX: src/oshmi2json — OSHMI to JSON Converter

## Purpose

Node.js tool that converts OSHMI (Open Source HMI) format SVG displays and tag definitions to JSON-SCADA format. Provides migration path from OSHMI to JSON-SCADA.

## Ownership

- oshmi2json owns the OSHMI migration tooling

## Local Contracts

- **Language:** Node.js
- **Main entry:** `oshmi2json.js`
- **Files:**
  - `oshmi2json.js` — main converter logic
  - `json-scada-mongo-import.js` — MongoDB import helper
  - `json-scada-mongo-import.csv` — sample CSV import data
  - `point_calc.txt` — point calculation definitions
  - `point_list.txt` — point list definitions
- **Config:** Command-line arguments

## Work Guidance

- Converts OSHMI SVG SCADA displays to JSON-SCADA compatible format
- Generates MongoDB import files from OSHMI tag definitions
- Supports point calculations conversion
- Used during migration from legacy OSHMI installations

## Verification

- Test conversion with sample OSHMI export files
- Verify generated JSON imports correctly into MongoDB
