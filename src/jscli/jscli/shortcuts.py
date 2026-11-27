"""Flag-based commands backed by JSON-SCADA GraphQL operations."""

import argparse
import math
import re
from dataclasses import dataclass

from .http import CliError, check_api_error

PAGE = {"limit": "Int", "skip": "Int"}
TIME_RANGE = {"timeBegin": "DateTime", "timeEnd": "DateTime"}
TAG_FIELDS = (
    "_id tag description group1 group2 group3 type origin value valueString valueJson "
    "unit invalid alarmed priority timeTag timeTagAtSource annotation notes "
    "loLimit hiLimit loloLimit hihiLimit lololoLimit hihihiLimit hysteresis alarmDisabled"
)
ACTION_FIELDS = "ok error matchedCount"
PROPERTY_FLAGS = {
    "annotation": ("annotation", str),
    "notes": ("notes", str),
    "lo-limit": ("loLimit", float),
    "lolo-limit": ("loloLimit", float),
    "lololo-limit": ("lololoLimit", float),
    "hi-limit": ("hiLimit", float),
    "hihi-limit": ("hihiLimit", float),
    "hihihi-limit": ("hihihiLimit", float),
    "hysteresis": ("hysteresis", float),
    "alarm-disabled": ("alarmDisabled", bool),
    "substitute-value": ("newValue", float),
}
PROPERTY_TYPES = {field: kind for field, kind in PROPERTY_FLAGS.values()}
PROPERTY_TYPE_NAMES = {bool: "true or false", float: "a finite number", str: "text"}


@dataclass
class Operation:
    field: str
    selection: str = ""
    types: dict | None = None
    mutation: bool = False

    def execute(self, client, endpoint, variables):
        types = self.types or {}
        declarations = ", ".join(f"${name}: {kind}" for name, kind in types.items())
        arguments = ", ".join(f"{name}: ${name}" for name in types)
        verb = "mutation" if self.mutation else "query"
        signature = f"({declarations})" if declarations else ""
        call = f"({arguments})" if arguments else ""
        selection = f"{{ {self.selection} }}" if self.selection else ""
        document = f"{verb} {signature} {{ {self.field}{call} {selection} }}"
        data = client.graphql(endpoint, document, variables, None)
        if not isinstance(data, dict) or self.field not in data:
            raise CliError(f"missing {self.field} in the GraphQL response")
        value = data[self.field]
        if self.mutation:
            check_api_error(value)
            if not isinstance(value, dict) or value.get("ok") is not True:
                raise CliError(f"{self.field} did not report success")
        return value


def finite(value):
    if isinstance(value, bool):
        raise ValueError("expected a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("expected a finite number")
    return number


def page_number(value):
    result = int(value)
    if not 0 <= result <= 2_147_483_647:
        raise argparse.ArgumentTypeError("expected an integer between 0 and 2147483647")
    return result


def limit_number(value):
    result = page_number(value)
    if not result:
        raise argparse.ArgumentTypeError("limit must be greater than zero")
    return result


def point_arg(parser, *, required=False):
    parser.add_argument("--point", metavar="TAG_OR_ID", required=required, help="tag name or numeric point key")


def add_paging(parser, *, skip=False):
    parser.add_argument("--limit", type=limit_number, help="maximum number of results")
    if skip:
        parser.add_argument("--skip", type=page_number, help="skip this many results")


def add_range(parser):
    parser.add_argument("--from", dest="time_begin", metavar="ISO_TIME", help="start of time range")
    parser.add_argument("--to", dest="time_end", metavar="ISO_TIME", help="end of time range")


def add_shortcuts(commands, add_input_options, add_output_options):
    def add(name, help_text, operation=None):
        sub = commands.add_parser(name, help=help_text, description=help_text)
        sub.add_argument("--endpoint", default="/apollo", help="GraphQL endpoint path")
        add_output_options(sub)
        sub.set_defaults(shortcut=True, shortcut_operation=operation)
        return sub

    add("info", "show server version and database connection status",
        Operation("serverInfo", "name version timestamp authenticationEnabled mongoConnected"))
    add("whoami", "show the signed-in account and permissions",
        Operation("me", "username rights { isAdmin changePassword sendCommands enterAnnotations enterNotes "
                  "enterManuals enterLimits substituteValues ackEvents ackAlarms disableAlarms cimEngineering "
                  "viewSecEvents editDisplays group1List group1CommandList displayList maxSessionDays }"))
    for name, field, fields in (
        ("stations", "groups1", "name count"),
        ("users", "users", "_id username email roles isLDAPUser"),
        ("roles", "roles", "_id name isAdmin sendCommands ackEvents ackAlarms group1List group1CommandList"),
        ("drivers", "protocolDriverInstances", "_id protocolDriver protocolDriverInstanceNumber "
         "enabled activeNodeName activeNodeKeepAliveTimeTag softwareVersion stats"),
        ("connections", "protocolConnections", "_id protocolDriver protocolDriverInstanceNumber "
         "protocolConnectionNumber name description enabled commandsEnabled stats"),
    ):
        add_paging(add(name, f"list {name}", Operation(field, fields, PAGE)), skip=True)
    bays = add("bays", "list bays", Operation("groups2", "name count", {**PAGE, "group1": "String"}))
    bays.add_argument("--station", dest="group1")
    add_paging(bays, skip=True)

    tags = add("tags", "read, count, or export realtime tags")
    tags.add_argument("--tag", dest="tags", action="append", help="exact tag name (repeatable)")
    tags.add_argument("--id", dest="ids", action="append", type=finite, help="numeric point key (repeatable)")
    tags.add_argument("--station", dest="group1")
    tags.add_argument("--bay", dest="group2")
    tags.add_argument("--group3")
    tags.add_argument("--type", choices=("analog", "digital", "string", "json"))
    tags.add_argument("--origin", choices=("supervised", "command", "calculated", "manual", "system"))
    tags.add_argument("--contains", dest="tagContains", help="case-insensitive tag substring")
    tags.add_argument("--description-contains", dest="descriptionContains")
    tags.add_argument("--invalid", action=argparse.BooleanOptionalAction, help="filter by invalid quality")
    tags.add_argument("--alarmed", action=argparse.BooleanOptionalAction, help="filter by alarm flag")
    tags.add_argument("--sort", dest="sortBy", metavar="FIELD")
    tags.add_argument("--descending", dest="sortDesc", action="store_true", default=None)
    tags.add_argument("--count", action="store_true", help="return the number of matching tags")
    add_paging(tags, skip=True)

    history = add("history", "read or export historian samples")
    history.add_argument("--tag", dest="tags", action="append", required=True, help="tag name (repeatable)")
    add_range(history)
    add_paging(history)

    events = add("events", "read or export sequence of events")
    events.add_argument("--tag", dest="tags", action="append", help="tag name (repeatable)")
    events.add_argument("--station", dest="group1List", action="append", help="station name (repeatable)")
    events.add_argument("--priority-max", dest="priorityLte", type=finite)
    events.add_argument("--source-time", dest="useSourceTime", action="store_true")
    events.add_argument("--aggregate", action="store_true")
    events.add_argument("--include-removed", dest="includeRemoved", action="store_true")
    events.add_argument("--ascending", action="store_true")
    add_range(events)
    add_paging(events)

    alarms = add("alarms", "read or export the alarm list")
    alarms.add_argument("--historical", action="store_true")
    alarms.add_argument("--station", dest="group1List", action="append", help="station name (repeatable)")
    alarms.add_argument("--priority-max", dest="priorityMax", type=finite)
    alarms.add_argument("--text", help="case-insensitive alarm text filter")
    alarms.add_argument("--unacked", dest="unackedOnly", action="store_true")
    add_range(alarms)
    add_paging(alarms)

    command = add("command", "queue a command for one point")
    point_arg(command, required=True)
    command.add_argument("--value", type=finite, help="numeric command value")
    command.add_argument("--text", dest="valueString", help="string command value")
    status = add("command-status", "look up acknowledgment for a queued command",
        Operation("commandStatus", "commandHandle tag value valueString status timeTag ackTimeTag "
                  "cancelReason originatorUserName", {"commandHandle": "ID!"}))
    status.add_argument("--handle", dest="commandHandle", required=True)

    ack_alarm = add("ack-alarm", "acknowledge alarms or silence the beep")
    scope = ack_alarm.add_mutually_exclusive_group(required=True)
    point_arg(scope)
    scope.add_argument("--all", action="store_true")
    scope.add_argument("--silence", action="store_true")

    ack_event = add("ack-event", "acknowledge or remove SOE entries")
    scope = ack_event.add_mutually_exclusive_group(required=True)
    scope.add_argument("--event-id", dest="eventId")
    scope.add_argument("--tag")
    scope.add_argument("--all", action="store_true")
    ack_event.add_argument("--remove", action="store_true", help="remove the selected entries")

    update = add("set-tag", "update point properties from flags or an input file")
    point_arg(update)
    add_input_options(update)
    for option, (field, kind) in PROPERTY_FLAGS.items():
        if kind is bool:
            update.add_argument("--" + option, dest=field, action=argparse.BooleanOptionalAction)
        else:
            update.add_argument("--" + option, dest=field, type=finite if kind is float else str)


def pick(source, keys):
    return {key: value for key in keys if (value := source.get(key)) is not None}


def point(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise CliError("point must be a tag name or numeric point key")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CliError("point key must be finite")
        if value.is_integer():
            value = int(value)
    if not str(value).strip():
        raise CliError("point must not be blank")
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        raise CliError("point key exceeds the exact integer range")
    return str(value)


def property_value(field, kind, value):
    if kind is bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and (text := value.strip().lower()) in {"true", "false"}:
            return text == "true"
    elif kind is str and isinstance(value, str):
        return value
    elif kind is float:
        try:
            return finite(value)
        except (ValueError, TypeError, OverflowError):
            pass
    raise CliError(f"{field} must be {PROPERTY_TYPE_NAMES[kind]}")


def update_variables(source):
    extra = source.keys() - PROPERTY_TYPES.keys() - {"point"}
    if extra:
        raise CliError(f"unknown set-tag fields: {', '.join(sorted(extra))}")
    tag_or_id = point(source.get("point"))
    props = {field: property_value(field, PROPERTY_TYPES[field], value)
             for field, value in pick(source, PROPERTY_TYPES).items()}
    if not props:
        raise CliError("set-tag needs at least one property")
    if "newValue" in props:
        props["substituted"] = True
    return {"tagOrId": tag_or_id, "properties": props}


def prepare_update(args, imported):
    direct = pick(vars(args), ["point", *PROPERTY_TYPES])
    if args.input is None:
        return [update_variables(direct)], False
    if direct:
        raise CliError("--input cannot be combined with --point or property flags")
    rows = [imported] if isinstance(imported, dict) else imported
    if not isinstance(rows, list) or not rows:
        raise CliError("set-tag input needs a nonempty list of records or one JSON object")
    result = []
    for number, row in enumerate(rows, 1):
        try:
            if not isinstance(row, dict):
                raise CliError("record must be an object")
            result.append(update_variables(row))
        except CliError as exc:
            raise CliError(f"input record {number}: {exc}") from exc
    return result, True


def prepare(args, imported):
    """Return the operation, its validated argument sets, and whether this is a batch."""
    source = vars(args)
    if args.shortcut_operation is not None:
        operation = args.shortcut_operation
        return operation, [pick(source, operation.types or {})], False

    if args.command == "set-tag":
        variables, batch = prepare_update(args, imported)
        return Operation("updateTagProperties", ACTION_FIELDS,
                         {"tagOrId": "String!", "properties": "TagPropertiesInput!"}, True), variables, batch

    time_range = pick({"timeBegin": source.get("time_begin"), "timeEnd": source.get("time_end")}, TIME_RANGE)
    page = pick(source, PAGE)
    if args.command == "tags":
        filters = pick(source, ("tags", "ids", "group1", "group2", "group3", "type", "origin",
                                "tagContains", "descriptionContains", "invalid", "alarmed"))
        sort = pick(source, ("sortBy", "sortDesc"))
        if args.sortBy is not None and not re.fullmatch(r"[_A-Za-z][_0-9A-Za-z]*", args.sortBy):
            raise CliError("--sort must be a field name")
        if args.count:
            if page or sort:
                raise CliError("--count cannot be combined with paging or sort options")
            return Operation("tagsCount", types={"filter": "TagFilter"}), [{"filter": filters}], False
        operation = Operation("tags", TAG_FIELDS, {"filter": "TagFilter", **PAGE, "sortBy": "String", "sortDesc": "Boolean"})
        return operation, [{"filter": filters, **page, **sort}], False

    if args.command == "history":
        operation = Operation("historicalData", "tag values { value valueBool isDigital invalid timeTag timeTagAtSource }",
                              {"tags": "[String!]!", **TIME_RANGE, "limit": "Int"})
        return operation, [{"tags": args.tags, **time_range, **page}], False

    if args.command == "events":
        filters = pick(source, ("tags", "group1List", "priorityLte", "useSourceTime", "aggregate", "includeRemoved"))
        operation = Operation("soeEvents", "eventId tag pointKey group1 description eventText invalid priority "
                              "timeTag timeTagAtSource timeTagAtSourceOk ack count",
                              {"filter": "SoeFilter", "limit": "Int", "ascending": "Boolean"})
        return operation, [{"filter": {**filters, **time_range}, "ascending": args.ascending, **page}], False

    if args.command == "alarms":
        if time_range and not args.historical:
            raise CliError("--from and --to require --historical for alarms")
        operation = Operation("alarms", "alarmId tag pointKey group1 group2 description type priority value "
                              "valueString alarmText alarmRange timeTag timeTagAtSource timeTagAtSourceOk "
                              "active ack timeTagAck ackUser timeTagNormal",
                              {"mode": "AlarmListMode", **TIME_RANGE, "group1List": "[String!]",
                               "priorityMax": "Float", "text": "String", "unackedOnly": "Boolean", "limit": "Int"})
        variables = pick(source, operation.types)
        return operation, [{"mode": "HISTORICAL" if args.historical else "REALTIME", **variables, **time_range}], False

    if args.command == "command":
        values = pick(source, ("value", "valueString"))
        if not values:
            raise CliError("command needs --value or --text")
        operation = Operation("issueCommand", "ok error commandHandle",
                              {"tagOrId": "String!", "value": "Float", "valueString": "String"}, True)
        return operation, [{"tagOrId": point(args.point), **values}], False

    if args.command == "ack-alarm":
        variables = {"action": "ACK_ALL_ALARMS"} if args.all else {"action": "SILENCE_BEEP"}
        if args.point is not None:
            variables = {"action": "ACK_ONE_ALARM", "tagOrId": point(args.point)}
        operation = Operation("ackAlarms", ACTION_FIELDS, {"action": "AlarmAckAction!", "tagOrId": "String"}, True)
        return operation, [variables], False

    if args.command == "ack-event":
        target = pick(source, ("tag", "eventId"))
        if any(not value.strip() for value in target.values()):
            raise CliError("--tag and --event-id need a nonblank value")
        scope = "ALL_EVENTS" if args.all else "POINT_EVENTS" if args.tag is not None else "ONE_EVENT"
        action = ("REMOVE_" if args.remove else "ACK_") + scope
        operation = Operation("ackEvents", ACTION_FIELDS,
                              {"action": "EventAckAction!", "tag": "String", "eventId": "ID"}, True)
        return operation, [{"action": action, **target}], False

    raise CliError(f"unknown shortcut {args.command}")


def output(args, variables, result):
    if args.command == "history":
        return [{"tag": series["tag"], **value} for series in result for value in series["values"]]
    if args.command == "tags" and args.count:
        return {"count": result}
    if args.command == "set-tag":
        return {"point": variables["tagOrId"], **result}
    return result
