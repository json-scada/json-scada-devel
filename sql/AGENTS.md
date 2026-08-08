# DOX: sql — SQL Scripts

## Purpose

SQL scripts for PostgreSQL/TimescaleDB database setup, maintenance, and data processing: table creation, historical data archival, historical/real-time data processing, Grafana/Metabase app database schemas.

## Ownership

- sql owns all PostgreSQL DDL and DML scripts
- Scripts are referenced by platform installation procedures

## Local Contracts

- Files: SQL scripts (`.sql`), shell scripts (`.sh`), Windows batch files (`.bat`)
- `create_tables.sql` — main schema creation script
- `process_pg_hist.*` — PostgreSQL historian data processing
- `process_pg_rtdata.*` — real-time data processing
- `delete_old.*` — old data cleanup/archival
- `terminate_pg_hist.*` / `terminate_pg_rtdata.*` — process termination
- `grafanaappdb.sql` — Grafana application database schema
- `metabaseappdb.sql` — Metabase application database schema

## Work Guidance

- Maintain compatibility with PostgreSQL 16+ and TimescaleDB 2.0+
- Shell scripts should work on both Linux (`.sh`) and Windows (`.bat`)
- Always test schema changes with both `psql` and application code
- Document table structures and relationships

## Verification

- Validate `.sql` files with `psql --file <script>` dry run
- Test on PostgreSQL 16+ with TimescaleDB extension
