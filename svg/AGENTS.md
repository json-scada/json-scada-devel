# DOX: svg — SVG SCADA Displays

## Purpose

SVG files used for SCADA synoptic displays. These SVGs contain inline JSON metadata (in `inkscape:label` attributes) that drives real-time data visualization in the JSON-SCADA web interface. Used with SCADAvis.io / OSHMI / JSON-SCADA rendering.

## Ownership

- svg owns all SVG display files
- SVG SCADA markup conventions are defined by the `svg-scada` skill

## Local Contracts

- All SVGs follow the SCADAvis.io/OSHMI markup format
- JSON configuration embedded in `inkscape:label` attributes (HTML-escaped)
- `inkscape:label` on group/layer elements define data bindings
- Vector/scalar point IDs reference JSON-SCADA data model
- Colors, thresholds, animations defined in the JSON markup
- Supporting files:
  - `screen_list.js` — defines available screens and their load order
  - `tags.tsv` — tag definitions for the displays

## Work Guidance

- Always load the `svg-scada` skill before editing SVG SCADA files
- SVG JSON must be valid HTML-escaped JSON (no raw `<`, `>`, `&`)
- Point IDs must match existing tags in the JSON-SCADA database
- Prefer Inkscape-compatible SVG for round-trip editing
- Maintain visual hierarchy: background, static elements, dynamic elements
- Use SVG layers/groups for organization

## Verification

- Validate SVG XML syntax
- Verify JSON in `inkscape:label` parses correctly
- Check point IDs against `tags.tsv` or database schema
- Test rendering in the JSON-SCADA web interface
