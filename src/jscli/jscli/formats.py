"""Convert API JSON documents to and from tables."""

import csv
import io
import math
import re
from datetime import date, time, timedelta
from pathlib import Path
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring
from odf.opendocument import OpenDocumentSpreadsheet
from odf.table import Table, TableCell, TableRow
from odf.teletype import addTextToElement
from odf.text import P
from openpyxl import Workbook, load_workbook
from openpyxl.cell import WriteOnlyCell

from .http import CliError, decode_json, encode_json

FORMATS = ("json", "csv", "xlsx", "ods")
MAX_ROWS = 1_048_576
MAX_COLUMNS = 16_384
OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
INVALID_XML_TEXT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")


def file_format(path, explicit, default="json"):
    if explicit:
        return explicit
    suffix = Path(path).suffix.lower().lstrip(".")
    return suffix if suffix in FORMATS else default


def parse_table(rows, json_cells):
    rows = iter(rows)
    columns = list(next(rows, ()))
    while columns and columns[-1] is None:
        columns.pop()
    if not columns or any(not isinstance(name, str) or not name.strip() for name in columns):
        raise CliError("the table needs a first row of nonempty text column names")
    if len(set(columns)) != len(columns):
        raise CliError("the table contains duplicate column names")
    result = []
    for number, cells in enumerate(rows, 2):
        cells = list(cells)
        if all(value is None or value == "" for value in cells):
            continue
        if any(value is not None and value != "" for value in cells[len(columns):]):
            raise CliError(f"table row {number} has data beyond the header")
        row = {}
        for name, value in zip(columns, cells):
            if value is None or value == "":
                continue
            if json_cells:
                try:
                    if not isinstance(value, str):
                        raise ValueError("expected a text cell")
                    value = decode_json(value)
                except ValueError as exc:
                    raise CliError(f"row {number}, column {name}: invalid JSON cell ({exc})") from exc
            row[name] = value
        result.append(row)
    return result


def xlsx_rows(raw, sheet):
    book = load_workbook(io.BytesIO(raw), read_only=True, keep_links=False)
    try:
        if sheet is not None and sheet not in book.sheetnames:
            raise CliError(f"no worksheet named {sheet!r}")
        ws = book[sheet] if sheet is not None else book.worksheets[0]
        # Read the real XML rows even if the workbook's dimension metadata is stale.
        ws.reset_dimensions()
        for cells in ws.iter_rows():
            row = []
            for cell in cells:
                if cell.data_type in {"f", "e"}:
                    raise CliError(f"worksheet cell {cell.coordinate} contains a formula or error")
                value = cell.value
                if isinstance(value, (date, time)):
                    value = value.isoformat()
                elif isinstance(value, timedelta):
                    value = str(value)
                row.append(value)
            yield row
    finally:
        book.close()


def ods_text(node):
    def content(element):
        pieces = [element.text or ""]
        for child in element:
            if child.tag == TEXT + "s":
                count = int(child.get(TEXT + "c", "1"))
                if not 0 < count <= 1_000_000:
                    raise CliError("invalid ODS space count")
                pieces.append(" " * count)
            elif child.tag == TEXT + "tab":
                pieces.append("\t")
            elif child.tag == TEXT + "line-break":
                pieces.append("\n")
            else:
                pieces.append(content(child))
            pieces.append(child.tail or "")
        return "".join(pieces)

    return "\n".join(content(p) for p in node.findall(TEXT + "p"))


def ods_cell(cell):
    kind = cell.get(OFFICE + "value-type")
    if cell.get(TABLE + "formula"):
        raise CliError("ODS worksheet contains a formula")
    if kind in {"float", "percentage", "currency"}:
        value = cell.attrib[OFFICE + "value"]
        if re.fullmatch(r"[+-]?[0-9]+", value):
            return int(value)
        number = float(value)
        if not math.isfinite(number):
            raise CliError("ODS worksheet contains a non-finite number")
        return number
    if kind == "boolean":
        return cell.attrib[OFFICE + "boolean-value"] == "true"
    if kind == "date":
        return cell.attrib[OFFICE + "date-value"]
    if kind == "time":
        return cell.attrib[OFFICE + "time-value"]
    if kind == "string":
        value = cell.get(OFFICE + "string-value")
        return ods_text(cell) if value is None else value
    return None


def ods_rows(raw, sheet):
    with ZipFile(io.BytesIO(raw)) as book:
        with book.open("content.xml") as content:
            root = fromstring(content.read(), forbid_dtd=True)
    tables = root.findall(f"./{OFFICE}body/{OFFICE}spreadsheet/{TABLE}table")
    if sheet is not None:
        tables = [t for t in tables if t.get(TABLE + "name") == sheet]
    if not tables:
        raise CliError(f"no worksheet named {sheet!r}" if sheet is not None else "no ODS worksheet")

    row_number = 0
    for row in tables[0].iter(TABLE + "table-row"):
        repeat = int(row.get(TABLE + "number-rows-repeated", "1"))
        cells = []
        column = 0
        for cell in row:
            if cell.tag not in {TABLE + "table-cell", TABLE + "covered-table-cell"}:
                continue
            count = int(cell.get(TABLE + "number-columns-repeated", "1"))
            value = ods_cell(cell)
            if count < 1:
                raise CliError("invalid ODS column repeat count")
            if value is not None and value != "":
                if column + count > MAX_COLUMNS:
                    raise CliError("ODS worksheet has too many populated columns")
                cells.extend([None] * (column - len(cells)))
                cells.extend([value] * count)
            column += count
        if repeat < 1:
            raise CliError("invalid ODS row repeat count")
        if cells:
            if row_number + repeat > MAX_ROWS:
                raise CliError("ODS worksheet has too many populated rows")
            for _ in range(repeat):
                yield cells
        elif row_number == 0:
            yield []
        row_number += repeat


def read_data(raw, fmt, sheet=None, json_cells=False):
    if fmt == "json":
        return decode_json(raw)
    if fmt == "csv":
        csv.field_size_limit(max(csv.field_size_limit(), len(raw)))
        rows = csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""), strict=True)
    elif fmt == "xlsx":
        rows = xlsx_rows(raw, sheet)
    else:
        rows = ods_rows(raw, sheet)
    return parse_table(rows, json_cells)


def table_rows(value, fmt, json_cells):
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise CliError("table export needs an object or an array of objects; use --select")
    columns = list(dict.fromkeys(key for row in value for key in row))
    if not columns:
        raise CliError("no columns to export; use JSON for an empty result")
    if any(not key.strip() for key in columns):
        raise CliError("table export cannot use blank field names")
    if fmt in {"xlsx", "ods"} and (len(columns) > MAX_COLUMNS or len(value) + 1 > MAX_ROWS):
        raise CliError("data exceeds worksheet size limits; export CSV or JSON")
    yield columns
    for row in value:
        yield [table_cell(row[key], fmt, json_cells) if key in row else None for key in columns]


def table_cell(value, fmt, json_cells):
    if json_cells or isinstance(value, (dict, list)):
        return encode_json(value).decode()
    if fmt == "csv" and isinstance(value, bool):
        return "true" if value else "false"
    if fmt in {"xlsx", "ods"} and isinstance(value, int) and not isinstance(value, bool):
        if abs(value) >= 10**15:
            return str(value)
    return value


def write_xlsx(rows):
    book = Workbook(write_only=True)
    sheet = book.create_sheet("Data")

    for row in rows:
        cells = []
        for value in row:
            if isinstance(value, str):
                cell = WriteOnlyCell(sheet, value=value)
                cell.data_type = "s"
                cells.append(cell)
            else:
                cells.append(value)
        sheet.append(cells)
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def write_ods(rows):
    book = OpenDocumentSpreadsheet()
    table = Table(name="Data")
    book.spreadsheet.addElement(table)
    for row in rows:
        tr = TableRow()
        for value in row:
            if isinstance(value, bool):
                cell = TableCell(valuetype="boolean", booleanvalue=str(value).lower())
            elif isinstance(value, (int, float)):
                cell = TableCell(valuetype="float", value=str(value))
            elif isinstance(value, str):
                cell = TableCell(valuetype="string")
                paragraph = P()
                addTextToElement(paragraph, value)
                cell.addElement(paragraph)
            else:
                cell = TableCell()
            tr.addElement(cell)
        table.addElement(tr)
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def write_data(value, fmt, json_cells=False):
    if fmt == "json":
        return encode_json(value, indent=2) + b"\n"
    # Validate and convert before opening a destination or starting a workbook.
    rows = list(table_rows(value, fmt, json_cells))
    if fmt == "csv":
        buf = io.StringIO(newline="")
        csv.writer(buf).writerows(rows)
        return buf.getvalue().encode()
    for row in rows:
        for index, value in enumerate(row):
            if not isinstance(value, str):
                continue
            if INVALID_XML_TEXT.search(value):
                raise CliError("worksheet text contains an invalid XML character; use JSON cells or export JSON")
            if fmt == "xlsx" and len(value) > 32767:
                raise CliError("an XLSX cell exceeds 32,767 characters; export CSV or JSON")
            row[index] = value.replace("\r\n", "\n").replace("\r", "\n")
    return write_xlsx(rows) if fmt == "xlsx" else write_ods(rows)
