# DOX: docs — Documentation

## Purpose

Project documentation: installation guides, architecture descriptions, schema documentation, developer guides, and report generator docs.

## Ownership

- docs owns all project documentation files
- Each src component's `README.md` is owned by that component

## Local Contracts

- Markdown (`.md`) format for all docs
- Architecture diagrams in PlantUML (`.txt`) and Draw.io (`.drawio`) formats
- PNG images for rendered diagrams
- Key documents:
  - `install.md` — installation guide (primary)
  - `docker_image.md` — Docker deployment
  - `schema.md` — MongoDB/PostgreSQL schema documentation
  - `DEVELOPER_GUIDE.md` — development guide
  - `report_generators.md` — report generation docs
  - `JSON-SCADA_Arquitecture.txt` — PlantUML architecture diagram
  - `JSON-SCADA_ARCHITECTURE.drawio` — Draw.io architecture diagram
  - `JSON-SCADA_Connections.drawio` — Connections diagram

## Work Guidance

- Keep docs in sync with code changes
- Architecture diagrams should be updated when protocol drivers or major services change
- Screenshots go in `screenshots/` subdirectory
- Use relative links to reference other docs and source files
