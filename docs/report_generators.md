# Report Generators

Report generators are common tools, there are many open source and commercial software packages available, so I do not consider reinventing this wheel. See here some options.

Independent opinions/testimonies/reviews of any reporting tool for MongoDB or PostgreSQL are welcome via pull-requests or via _Discussions_ section.

## Self-Service Solutions

### Metabase

This is a powerful open source BI tool that can work with MongoDB and PostgreSQL.
https://github.com/metabase/metabase

### Grafana

Grafana OSS (bundled with JSON-SCADA, 13.2.x) has no built-in PDF reporting. Options:

- **Grafana Dashboard Reporter** (free, Apache-2.0) — app plugin `mahendrapaipuri-dashboardreporter-app`,
  v1.13.1 (2026-09-30), requires Grafana >= 10.0.3. Renders a dashboard to PDF through a Grafana API
  endpoint, using Grafana's own authentication.
  https://github.com/mahendrapaipuri/grafana-dashboard-reporter-app
  - Not published in the Grafana plugin catalog (Grafana does not list plugins that overlap with
    Enterprise reporting), so it is installed from the GitHub release and must be allowed as an
    unsigned plugin:

    ```bash
    VERSION=1.13.1; grafana cli --pluginUrl "https://github.com/mahendrapaipuri/grafana-dashboard-reporter-app/releases/download/v${VERSION}/mahendrapaipuri-dashboardreporter-app-${VERSION}.zip" plugins install mahendrapaipuri-dashboardreporter-app
    ```

    ```ini
    [plugins]
    allow_loading_unsigned_plugins = mahendrapaipuri-dashboardreporter-app
    ```

  - Requires [grafana-image-renderer](https://github.com/grafana/grafana-image-renderer) to render
    panels, plus a recent `chromium` on the Grafana host when the renderer runs as an external service
    (the renderer-as-plugin form is deprecated; versions after 4.0.16 of it are known not to work with
    this reporter).
  - Report URL: `<grafana-url>/api/plugins/mahendrapaipuri-dashboardreporter-app/resources/report?dashUid=<dashboard UID>`
    (options such as `&theme=dark`, `&layout=grid`, `&orientation=landscape`). See the plugin's
    [documentation](https://github.com/mahendrapaipuri/grafana-dashboard-reporter-app/blob/main/src/README.md)
    for configuration.
- **Grafana Enterprise / Grafana Cloud** (paid) — built-in reporting (scheduled PDF reports, export as PDF).
  https://grafana.com/docs/grafana/latest/visualizations/dashboards/create-reports/

The community dashboard https://grafana.com/grafana/dashboards/11365 ("Grafana Reports") is not a
reporting plugin: it is a panel that calls the separate [IzakMarais/reporter](https://github.com/IzakMarais/reporter)
service (Go + LaTeX, last release v2.3.1 in 2019). Grafana Dashboard Reporter above is its maintained successor.

### Eclipse Streamsheets

An open-source tool for processing stream data using a spreadsheet-like interface. Supports MongoDB, MQTT and other data sources.
https://github.com/eclipse/streamsheets

### Nocodb

The Open Source Airtable alternative. Can connect to PostgreSQL.
https://github.com/nocodb/nocodb

### Budibase

Budibase is an open-source low-code platform. Supports MongoDB, PostgreSQL and other data sources.
https://github.com/Budibase/budibase

### ToolJet

https://github.com/ToolJet/ToolJet
Open-source extensible low-code platform. Supports MongoDB, PostgreSQL and other data sources.

### Apache Superset

Open-source BI and data exploration tool with a Python (Flask) server and a React/TypeScript web UI.
Connects to PostgreSQL/TimescaleDB through SQLAlchemy.
https://github.com/apache/superset

### Redash

Python-based BI tool.
https://github.com/getredash/redash

### QueryTree

Ad hoc reporting tool for PostgreSQL, MySQL and SQL Server.
https://github.com/d4software/QueryTree

### Widestage

This is supposed to work with MongoDB and PostgreSQL. I have encountered problems with MongoDB.
https://github.com/widestage/widestage

### Jasper Reports

This is a very popular report solution. I have encountered problems with MongoDB Java JDBC driver.
https://community.jaspersoft.com/community-download

### Knowage

This is a powerful tool for reporting and data analysis. I was not able to make it work with MongoDB 4.2/4.4.
https://github.com/KnowageLabs/Knowage-Server

### Helical Insight

This is a Java-based tool for reporting and data analysis.
https://helicalinsight.github.io/helicalinsight/#/quickstart

### Orange

Data mining, ML and visualization tool.
https://github.com/biolab/orange3

### JSReport

An open-source platform for designing and rendering various reports.
https://github.com/jsreport/jsreport

### MS Power BI

This is a popular commercial (with some free tiers) BI Package that can work with PostgreSQL. It is not a report generator but can suit most needs. It can work with MongoDB using the _MongoBD Connector for BI_.
https://docs.mongodb.com/bi-connector/master/connect/powerbi/

### More tools listed here

https://www.postgresql.org/download/products/5-reporting-tools/

## Code-based Tools

### KoolReport

A powerful PHP reporting tool.
https://github.com/koolphp/koolreport

### Reportico

Another PHP reporting tool.
https://www.reportico.org

### Carbone

Node.js/JSON reporting tool.
https://github.com/Ideolys/carbone

### Storybook

Storybook is an open source tool for building UI components and pages in isolation. It streamlines UI development, testing, and documentation.
https://storybook.js.org/

### Supabase

Open source Firebase alternative. Supports PostgreSQL.
https://github.com/supabase/supabase
