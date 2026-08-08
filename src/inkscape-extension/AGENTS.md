# DOX: src/inkscape-extension — Inkscape SVG SCADA Extension

## Purpose

Python extension for Inkscape that enables SVG synoptic display editing with SCADA markup. Provides tools for adding SCADA data bindings to SVG elements using the json-scada markup standard.

## Ownership

- inkscape-extension owns the Inkscape SCADA SVG editing extension

## Local Contracts

- **Language:** Python (Inkscape extension API)
- **Files:**
  - `scada.inx` — Inkscape extension definition (XML)
  - `scada.py` — extension implementation
- **Install:** Copy to Inkscape's extensions directory

## Work Guidance

- Implements Inkscape extension interface for accessing selected SVG elements
- Adds/modifies `inkscape:label` attributes with JSON SCADA markup
- Follows SCADAvis.io / OSHMI / JSON-SCADA SVG markup conventions
- The `svg-scada` skill documents the markup format for AI-assisted creation

## Verification

- Install in Inkscape and verify extension appears in Extensions menu
- Test with a sample SVG file
