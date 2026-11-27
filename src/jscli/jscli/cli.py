"""Command line entry point."""

import argparse
import getpass
import math
import mimetypes
import os
import re
import sys
import tempfile
import warnings
from pathlib import Path
from uuid import uuid4

from . import shortcuts
from .formats import FORMATS, file_format, read_data, write_data
from .http import JSON_TYPE, TOKEN_RE, CliError, Client, api_url, check_api_error, decode_json, encode_json

VARIABLE_NAME = re.compile(r"[_A-Za-z][_0-9A-Za-z]*")
FORM_NAME = re.compile(r"[A-Za-z0-9_.-]+")
PROTECTED_HEADERS = {"authorization", "connection", "content-length", "cookie", "host", "proxy-authorization", "transfer-encoding", "x-access-token"}


def positive_seconds(value):
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be a positive number of seconds")
    return seconds


def add_input_options(parser):
    parser.add_argument("--input", "-i", metavar="FILE", help="input document, or - for stdin")
    parser.add_argument("--input-format", choices=FORMATS, help="override input extension")
    parser.add_argument("--sheet", help="input worksheet name (default: first sheet)")
    parser.add_argument("--input-json-cells", action="store_true", help="parse each nonblank data cell as JSON")


def add_output_options(parser, *, raw=False):
    parser.add_argument("--output", "-o", default="-", metavar="FILE", help="output file (default: stdout)")
    parser.add_argument("--format", choices=FORMATS + (("raw",) if raw else ()), help="override output extension")
    parser.add_argument("--select", metavar="POINTER", help="export a subtree using a JSON Pointer")
    parser.add_argument("--output-json-cells", action="store_true", help="encode each data cell as JSON")


def parser():
    root = argparse.ArgumentParser(prog="jscli", description="Use the JSON-SCADA API over HTTPS.")
    root.add_argument("--url", default=os.environ.get("JSCLI_URL", "https://localhost"), help="server base URL (JSCLI_URL)")
    root.add_argument("--username", "-u", default=os.environ.get("JSCLI_USERNAME"), help="account name (JSCLI_USERNAME)")
    root.add_argument("--ca-file", default=os.environ.get("JSCLI_CA_FILE"), help="additional trusted CA PEM (JSCLI_CA_FILE)")
    root.add_argument("--cert", help="client certificate PEM for mutual TLS")
    root.add_argument("--key", help="client private key PEM, if separate")
    root.add_argument("--timeout", default=60.0, type=positive_seconds, help="HTTPS socket timeout in seconds (default: 60)")
    root.add_argument("--invoke-path", default="/Invoke/", help="Invoke prefix used for sign-in and sign-out")
    commands = root.add_subparsers(dest="command", required=True)
    gql = commands.add_parser("graphql", help="run any GraphQL query or mutation")
    gql.add_argument("query", metavar="QUERY_FILE", help="GraphQL document file, or - for stdin")
    gql.add_argument("--endpoint", default="/apollo", help="GraphQL endpoint path")
    gql.add_argument("--operation", help="operation name for a document with multiple operations")
    gql.add_argument("--variables", metavar="FILE", help="JSON object with base variables, or -")
    gql.add_argument("--variable", metavar="NAME", help="assign imported data to this variable")
    gql.add_argument("--each", action="store_true", help="run once per input object in order")
    add_input_options(gql)
    add_output_options(gql)

    request = commands.add_parser("request", help="call an HTTP API route directly")
    request.add_argument("method", choices=("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"))
    request.add_argument("path", help="API path and optional URL-encoded query string")
    request.add_argument("--header", action="append", default=[], metavar="NAME:VALUE", help="add a request header")
    request.add_argument("--body", metavar="FILE", help="send literal bytes from FILE or stdin")
    request.add_argument("--content-type", help="media type of --body (default: application/octet-stream)")
    request.add_argument("--form-field", action="append", default=[], metavar="NAME=VALUE", help="multipart text field")
    request.add_argument("--form-file", action="append", default=[], metavar="NAME=FILE", help="multipart file field")
    request.add_argument("--wrap", metavar="KEY", help="wrap parsed input under this key")
    request.add_argument("--each", action="store_true", help="run once per input object in order")
    add_input_options(request)
    add_output_options(request, raw=True)

    convert = commands.add_parser("convert", help="convert data locally without signing in")
    add_input_options(convert)
    add_output_options(convert)
    shortcuts.add_shortcuts(commands, add_input_options, add_output_options)
    return root


def read_bytes(path):
    return sys.stdin.buffer.read() if path == "-" else Path(path).read_bytes()


def write_bytes(path, data):
    if path == "-":
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return
    destination = Path(path)
    # Preserve any existing export if conversion or writing fails.
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(data)
            output.close()
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


def input_value(args):
    fmt = file_format(args.input, args.input_format)
    if args.sheet is not None and fmt not in {"xlsx", "ods"}:
        raise CliError("--sheet requires XLSX or ODS input")
    if args.input_json_cells and fmt == "json":
        raise CliError("--input-json-cells requires CSV, XLSX, or ODS input")
    raw = read_bytes(args.input)
    try:
        return read_data(raw, fmt, args.sheet, args.input_json_cells)
    except CliError:
        raise
    except Exception as exc:
        raise CliError(f"cannot parse {fmt.upper()} input: {exc}") from exc


def selected(value, pointer):
    if pointer is None or pointer == "":
        return value
    if not pointer.startswith("/") or re.search(r"~(?![01])", pointer):
        raise CliError("--select must be a JSON Pointer starting with /")
    for name in pointer[1:].split("/"):
        name = name.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", name):
            index = int(name)
            if index < len(value):
                value = value[index]
                continue
        if isinstance(value, dict) and name in value:
            value = value[name]
            continue
        raise CliError(f"JSON Pointer {pointer!r} does not exist in the result")
    return value


def require_distinct_stdin(*paths):
    if paths.count("-") > 1:
        raise CliError("stdin can supply only one input per invocation")


def require_object(value, description):
    if not isinstance(value, dict):
        raise CliError(f"{description} must be a JSON object")
    return value


def payloads(value, each):
    if each:
        if not isinstance(value, list) or not value or any(not isinstance(row, dict) for row in value):
            raise CliError("--each requires a nonempty array of objects")
        return value
    return [value]


def graph_variables(args, imported):
    base = require_object(decode_json(read_bytes(args.variables)), "--variables") if args.variables else {}
    if args.variable and not VARIABLE_NAME.fullmatch(args.variable):
        raise CliError("--variable must be a GraphQL variable name without $")
    result = []
    for value in payloads(imported, args.each):
        if not args.input:
            result.append(base)
            continue
        extra = {args.variable: value} if args.variable else require_object(value, "input variables")
        repeated = base.keys() & extra.keys()
        if repeated:
            raise CliError(f"variables defined twice: {', '.join(sorted(repeated))}")
        result.append({**base, **extra})
    return result


def multipart(args):
    boundary = uuid4().hex
    parts = []
    for fields, is_file in ((args.form_field, False), (args.form_file, True)):
        for field in fields:
            name, separator, value = field.partition("=")
            if not separator or not FORM_NAME.fullmatch(name):
                raise CliError("multipart fields must use NAME=VALUE")
            disposition = f'Content-Disposition: form-data; name="{name}"'
            if is_file:
                filename = Path(value).name
                if not filename or any(ord(c) < 32 or c in {'"', '\\'} for c in filename):
                    raise CliError("invalid multipart filename")
                mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                parts.append(f'--{boundary}\r\n{disposition}; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
                parts.append(Path(value).read_bytes())
            else:
                parts.append(f"--{boundary}\r\n{disposition}\r\n\r\n".encode())
                parts.append(value.encode())
            parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def request_headers(items):
    headers = {}
    for item in items:
        name, separator, value = item.partition(":")
        name = name.strip().lower()
        if not separator or not TOKEN_RE.fullmatch(name) or name in PROTECTED_HEADERS:
            raise CliError(f"invalid or reserved HTTP header name: {name!r}")
        if any((ord(c) < 32 and c != "\t") or ord(c) == 127 for c in value):
            raise CliError("HTTP header contains a control character")
        headers[name] = value.strip()
    return headers


def request_inputs(args, imported):
    has_form = bool(args.form_field or args.form_file)
    if sum((bool(args.body), bool(args.input), has_form)) > 1:
        raise CliError("choose one of --body, --input, or multipart form fields")
    if args.content_type and not args.body:
        raise CliError("--content-type requires --body")
    headers = request_headers(args.header)
    if args.input:
        headers["content-type"] = JSON_TYPE
        return [
            (encode_json({args.wrap: value} if args.wrap else value), headers)
            for value in payloads(imported, args.each)
        ]
    if has_form:
        body, headers["content-type"] = multipart(args)
    elif args.body:
        body = read_bytes(args.body)
        headers.setdefault("content-type", args.content_type or "application/octet-stream")
    else:
        body = None
    return [(body, headers)]


def password():
    value = os.environ.get("JSCLI_PASSWORD")
    if value is not None:
        return value
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass("JSON-SCADA password: ")
        except (EOFError, getpass.GetPassWarning) as exc:
            raise CliError("password prompt needs a terminal; set JSCLI_PASSWORD for automation") from exc


def http_request(client, args, body, headers, fmt):
    response, _ = client.send(args.method, args.path, body, headers)
    if response.is_json and response.body:
        value = response.json()
        check_api_error(value)
        if fmt != "raw":
            return value
    if fmt == "raw":
        return response.body
    if not response.body:
        return None
    raise CliError(f"response is {response.content_type}; use --format raw")


def call_all(items, call, each):
    if not each:
        return call(items[0])
    results = []
    for number, item in enumerate(items, 1):
        try:
            results.append(call(item))
        except CliError as exc:
            raise CliError(f"input record {number} failed after {number - 1} successful requests: {exc}") from exc
    return results


def run_remote(args, imported, fmt):
    if not args.username:
        raise CliError("provide --username or set JSCLI_USERNAME")
    if args.key and not args.cert:
        raise CliError("--key requires --cert")
    client = Client(args)
    each = getattr(args, "each", False)
    if getattr(args, "shortcut", False):
        api_url(client.base, args.endpoint)
        operation, items, each = shortcuts.prepare(args, imported)

        def execute(variables):
            value = operation.execute(client, args.endpoint, variables)
            return shortcuts.output(args, variables, value)

    elif args.command == "graphql":
        api_url(client.base, args.endpoint)
        variables = graph_variables(args, imported)
        query = read_bytes(args.query).decode("utf-8-sig")
        if not query.strip():
            raise CliError("the GraphQL document is empty")
        def execute(values):
            return client.graphql(args.endpoint, query, values, args.operation)
        items = variables
    else:
        api_url(client.base, args.path)
        items = request_inputs(args, imported)
        def execute(item):
            return http_request(client, args, *item, fmt)
    client.signin(args.username, password())
    try:
        return call_all(items, execute, each)
    finally:
        try:
            client.signout()
        except CliError as exc:
            print(f"jscli: sign-out failed: {exc}", file=sys.stderr)


def run(args):
    if args.command == "graphql":
        require_distinct_stdin(args.input, args.query, args.variables)
    if args.command == "request":
        require_distinct_stdin(args.input, args.body)
    input_path = getattr(args, "input", None)
    if not input_path and (
        args.command == "convert" or getattr(args, "input_format", None)
        or getattr(args, "sheet", None) is not None
        or getattr(args, "input_json_cells", False) or getattr(args, "each", False)
        or getattr(args, "wrap", None) is not None or getattr(args, "variable", None) is not None
    ):
        raise CliError("provide an input file with --input")
    fmt = file_format(args.output, args.format)
    if args.output_json_cells and fmt not in {"csv", "xlsx", "ods"}:
        raise CliError("--output-json-cells requires CSV, XLSX, or ODS output")
    if fmt == "raw" and (args.select is not None or args.each):
        raise CliError("--format raw cannot be combined with --select or --each")
    imported = input_value(args) if input_path else None
    value = imported if args.command == "convert" else run_remote(args, imported, fmt)
    output = value if fmt == "raw" else write_data(selected(value, args.select), fmt, args.output_json_cells)
    write_bytes(args.output, output)


def main():
    args = parser().parse_args()
    try:
        run(args)
    except BrokenPipeError:
        return 1
    except KeyboardInterrupt:
        return 130
    except (CliError, OSError, ValueError) as exc:
        print(f"jscli: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
