# jscli

`jscli` is the JSON-SCADA command line client. It connects to a local or remote installation over HTTPS, signs in with a JSON-SCADA account, and uses that account's permissions. It runs GraphQL operations and calls the other HTTP API endpoints directly. It can read and write JSON, CSV, XLSX, and ODS data.

## Install

Requires Python 3.10 or newer. From the repository root, install it into a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install ./src/jscli
. .venv/bin/activate
jscli --help
```

On Windows, use PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install .\src\jscli
.\.venv\Scripts\jscli.exe --help
```

## Connect

Put global options before the subcommand. The default URL is `https://localhost`. Pass `--url https://scada.example.org` for a remote server or use `JSCLI_URL`. Set the account with `--username` or `JSCLI_USERNAME`. The CLI prompts for the password without echoing it. For automation, supply `JSCLI_PASSWORD` through the environment. The CLI keeps the session token in memory and signs out when the command finishes.

Use the HTTPS address of the JSON-SCADA reverse proxy. See the [Nginx HTTPS template](../../conf-templates/nginx_https.conf) for a local listener. The certificate must match the host name. For a privately issued certificate, provide the CA PEM via `--ca-file` or `JSCLI_CA_FILE`. For mutual TLS, supply `--cert` and, if separate, `--key`. Use `--invoke-path` to change the default `/Invoke/` sign-in and sign-out prefix. The GraphQL endpoint defaults to `/apollo`. Pass `--endpoint` after a shortcut or the `graphql` subcommand to override it.

## Common operations with flags

Use `jscli COMMAND --help` for all filters and options. Each shortcut uses the same account and permissions as the corresponding API operation. Choose JSON, CSV, XLSX, or ODS by the output extension or with `--format`. Lists return rows directly, and history returns one row per sample with its tag name.

```sh
jscli -u operator tags --tag DEMO_POINT
jscli -u operator tags --station KAW2 --limit 500 -o tags.xlsx
jscli -u operator tags --station KAW2 --count
jscli -u operator history --tag DEMO_POINT --from 2026-07-18T00:00:00Z -o history.ods
jscli -u operator events --station KAW2 --priority-max 3 -o events.csv
jscli -u operator alarms --unacked
jscli -u operator alarms --historical --from 2026-07-18T00:00:00Z
```

Repeat `--tag` to query multiple tags. For `history`, `--limit` applies per tag. Use `--skip` and `--limit` to page through `tags` and the inventory commands `stations`, `bays`, `drivers`, `connections`, `users`, and `roles`. Use `info` to check server status and `whoami` to inspect your permissions.

```sh
jscli -u operator set-tag --point DEMO_POINT --annotation "Inspection scheduled"
jscli -u operator command --point DEMO_COMMAND --value 1
jscli -u operator command-status --handle COMMAND_HANDLE
jscli -u operator ack-alarm --point DEMO_POINT
jscli -u operator ack-event --event-id EVENT_ID
```

Replace the sample point names and IDs with values from your system. `command` queues a command and returns its handle. Use `command-status` to see whether it is pending, acknowledged, failed, or canceled. To acknowledge all alarms or all events, pass `--all` explicitly. Use `ack-alarm --silence` to silence the beep and `ack-event --tag TAG` to acknowledge events for a tag. Add `--remove` to `ack-event` to request removal instead of acknowledgment.

### Import point property changes

Use `set-tag --input FILE` to update point properties from JSON, CSV, XLSX, or ODS. Every record needs a `point` field with the tag or numeric key and at least one property. For example, save this as `updates.csv`:

```csv
point,annotation,hiLimit,alarmDisabled
DEMO_POINT,Inspection scheduled,120,false
```

```sh
jscli -u operator set-tag --input updates.csv -o applied.json
```

The property columns are `annotation`, `notes`, `loLimit`, `loloLimit`, `lololoLimit`, `hiLimit`, `hihiLimit`, `hihihiLimit`, `hysteresis`, `alarmDisabled`, and `newValue` for substitution. Numeric and Boolean columns can contain plain CSV text. Leave cells blank to omit a property. To clear an annotation or note in a file, use an empty JSON string in a JSON input or in a table with `--input-json-cells`. The CLI validates every record before sending updates. It applies updates in order and stops on the first server error. Earlier updates may already have taken effect.

## Run a custom GraphQL query

Save a GraphQL operation in `tags.graphql`:

```graphql
query Tags($station: String!) {
  tags(filter: { group1: $station }, limit: 1000, sortBy: "tag") {
    tag description value valueString invalid unit
  }
}
```

Save its variables in `station.json`:

```json
{ "station": "KAW2" }
```

```sh
jscli --url https://scada.example.org -u operator graphql tags.graphql \
  --variables station.json --select /tags --output tags.xlsx
```

Choose `tags.csv`, `tags.ods`, or `tags.json` to switch formats. Without `--output`, the CLI writes JSON to stdout. Use `--format` to override the extension or to pipe another format. GraphQL output starts at `data`; `--select` is a [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) into that result. The server controls query limits and paging. For nested lists, point to the intended table, for example `--select /historicalData/0/values`.

The [server API reference](../server_realtime_auth/README.md) describes GraphQL queries and mutations and the OPC-style requests on `/Invoke/`. To inspect the installed schema:

```sh
printf '%s\n' '{ __schema { queryType { fields { name } } mutationType { fields { name } } } }' |
  jscli -u operator graphql -
```

## Import rows with a custom operation

Import supplies data to an API operation you choose. For example, save this mutation in `annotation.graphql`:

```graphql
mutation Annotation($tagOrId: String!, $properties: TagPropertiesInput!) {
  updateTagProperties(tagOrId: $tagOrId, properties: $properties) {
    ok
  }
}
```

Save `annotations.csv` with JSON cells. Replace `DEMO_POINT` with a point your account can annotate.

```csv
tagOrId,properties
"""DEMO_POINT""","{""annotation"":""Inspection scheduled""}"
```

```sh
jscli -u operator graphql annotation.graphql \
  --input annotations.csv --input-json-cells --each
```

Each row supplies the variables of one request. `--variable NAME` instead assigns the whole imported value to a named GraphQL variable. Combine `--variables` with `--input` to add shared variables with distinct names. For an HTTP endpoint, `request --input` sends the parsed input as JSON and `--wrap KEY` places it under a named field. Without `--each` an input table is sent as one array.

`--each` runs requests in order and stops at the first HTTP or API error. Earlier requests may already have changed server data. The CLI reports the failed row and does not retry it. An HTTP or GraphQL success may still contain operation-specific statuses, such as OPC per-point codes or a queued command handle. Inspect those fields for the final outcome.

## Call HTTP endpoints directly

```sh
jscli -u operator request GET /Invoke/auth/userDisplays
jscli -u operator request POST /Invoke/ --input read-request.json --select /Body/Results -o readings.ods
```

Supply query parameters in the URL-encoded path, `--body FILE` for exact request bytes, and `--header 'Name: Value'` for additional headers. Output starts at the HTTP response body. Use `--format raw` to save exact response bytes, including ZIP files and other attachments.

For an administrator, project export and import use the server's ZIP endpoints:

```sh
printf '%s\n' '{"project":{"fileName":"project.zip"}}' |
  jscli -u admin request POST /Invoke/auth/exportProject --input - --format raw -o project.zip
jscli -u admin request POST /Invoke/auth/importProject \
  --form-field projectFileName=project.zip --form-file projectFileData=project.zip
```

## Table format

- The first row contains unique, nonblank column names. XLSX and ODS read the first sheet by default. Use `--sheet NAME` to select another sheet.
- Exports accept a JSON object or an array of objects. Columns are the union of their keys in first appearance order. Nested values become JSON text.
- Plain CSV imports nonblank cells as strings. XLSX and ODS also read native numbers and booleans. Date and time cells become strings. Blank cells omit that field, and empty rows are skipped. Formula cells must be replaced with values before import.
- Plain spreadsheet exports normalize line breaks to LF and write integers with more than 15 digits as text.
- To preserve JSON types, nulls, empty strings, missing fields, and nested values, use `--output-json-cells` on export and `--input-json-cells` on import. Column names remain plain text. Every populated data cell contains one JSON value. In XLSX and ODS, set edited JSON cells to text.
- Plain CSV is text interchange. Use XLSX when opening untrusted point text in a spreadsheet application, since CSV readers can interpret text starting with an equals sign as a formula.

Convert between formats without signing in:

```sh
jscli convert --input input.ods --sheet Points --output points.json
```
