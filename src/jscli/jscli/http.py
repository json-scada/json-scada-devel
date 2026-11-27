"""Transport and response handling for the JSON-SCADA HTTP API."""

import json
import re
import ssl
from dataclasses import dataclass
from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

JSON_TYPE = "application/json"
TOKEN_RE = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+")
JWT_RE = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


class CliError(Exception):
    """A failure that can be reported without a traceback."""


def reject_constant(value):
    raise ValueError(f"invalid JSON constant {value}")


def decode_json(raw):
    return json.loads(raw, parse_constant=reject_constant)


def encode_json(value, *, indent=None):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, indent=indent).encode()


@dataclass
class Response:
    body: bytes
    content_type: str
    attachment: bool

    def json(self):
        try:
            return decode_json(self.body)
        except (ValueError, UnicodeError) as exc:
            raise CliError(f"invalid JSON response: {exc}") from exc

    @property
    def is_json(self):
        return not self.attachment and (
            self.content_type == JSON_TYPE or self.content_type.endswith("+json")
        )


class RefuseRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_url(base, path):
    if not path.startswith("/") or path.startswith("//") or "#" in path or any(
        ord(c) <= 32 or ord(c) == 127 or c == "\\" for c in path
    ):
        raise CliError("API path must start with one slash and contain no unescaped spaces or fragments")
    return base + path


def base_url(value):
    if any(ord(c) <= 32 or ord(c) == 127 or c == "\\" for c in value):
        raise CliError("--url must be an HTTPS base URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https" or not parsed.hostname
        or parsed.username is not None or parsed.password is not None
        or "?" in value or "#" in value
    ):
        raise CliError("--url must be an HTTPS base URL without credentials, query, or fragment")
    return value.rstrip("/")


def check_api_error(value):
    if not isinstance(value, dict):
        return
    error = value.get("error")
    if value.get("ok") is False or error is True or (isinstance(error, str) and error):
        message = value.get("message") or error
        raise CliError(message if isinstance(message, str) else "the API rejected the request")
    body = value.get("Body")
    header = body.get("ResponseHeader") if isinstance(body, dict) else None
    code = header.get("ServiceResult") if isinstance(header, dict) else None
    if isinstance(code, int) and code & 0x80000000:
        detail = header.get("StringTable")
        message = f"OPC service failure (0x{code & 0xffffffff:08x})"
        if isinstance(detail, list) and detail and isinstance(detail[0], str):
            message += f": {detail[0]}"
        raise CliError(message)


class Client:
    def __init__(self, args):
        self.base = base_url(args.url)
        self.signin_path = args.invoke_path.rstrip("/") + "/auth/signin"
        self.signout_path = args.invoke_path.rstrip("/") + "/auth/signout"
        api_url(self.base, self.signin_path)
        self.timeout = args.timeout
        ctx = ssl.create_default_context()
        if args.ca_file:
            ctx.load_verify_locations(cafile=args.ca_file)
        if args.cert:
            ctx.load_cert_chain(args.cert, args.key)
        self.opener = build_opener(HTTPSHandler(context=ctx), RefuseRedirects())
        self.token = None

    def send(self, method, path, body=None, headers=None, *, timeout=None):
        url = api_url(self.base, path)
        headers = dict(headers or {})
        if self.token:
            headers["x-access-token"] = self.token
        try:
            request = Request(url, data=body, headers=headers, method=method)
            with self.opener.open(request, timeout=timeout or self.timeout) as reply:
                response = Response(
                    reply.read(), reply.headers.get_content_type(),
                    reply.headers.get_content_disposition() == "attachment",
                )
                return response, reply.headers
        except HTTPError as exc:
            with exc:
                if 300 <= exc.code < 400:
                    raise CliError(f"HTTP {exc.code}: redirects are disabled; use the final HTTPS URL") from None
                message = f"HTTP {exc.code}"
                if exc.headers.get_content_type() == JSON_TYPE:
                    try:
                        value = decode_json(exc.read(8192))
                        if isinstance(value, dict):
                            detail = value.get("message") or value.get("error")
                            if isinstance(detail, str):
                                message += f": {detail}"
                    except (ValueError, UnicodeError):
                        pass
                raise CliError(message) from None
        except (URLError, OSError) as exc:
            raise CliError(f"HTTPS request failed: {exc}") from exc

    def signin(self, username, password):
        response, headers = self.send(
            "POST", self.signin_path,
            encode_json({"username": username, "password": password}),
            {"Content-Type": JSON_TYPE},
        )
        result = response.json()
        check_api_error(result)
        for header in headers.get_all("Set-Cookie", []):
            cookie = SimpleCookie(header).get("x-access-token")
            if cookie and JWT_RE.fullmatch(cookie.value):
                self.token = cookie.value
                return
        raise CliError("sign-in did not return an x-access-token cookie")

    def signout(self):
        try:
            self.send("POST", self.signout_path, b"", timeout=min(5, self.timeout))
        finally:
            self.token = None

    def graphql(self, path, query, variables, operation):
        payload = {"query": query, "variables": variables}
        if operation is not None:
            payload["operationName"] = operation
        response, _ = self.send("POST", path, encode_json(payload), {"Content-Type": JSON_TYPE})
        value = response.json()
        check_api_error(value)
        if not isinstance(value, dict):
            raise CliError("expected a GraphQL response object")
        if value.get("errors"):
            messages = []
            for error in value["errors"]:
                if isinstance(error, dict):
                    message = error.get("message", "GraphQL error")
                    extensions = error.get("extensions")
                    code = extensions.get("code") if isinstance(extensions, dict) else None
                    messages.append(f"{message} [{code}]" if code else str(message))
                else:
                    messages.append(str(error))
            raise CliError("; ".join(messages))
        if "data" not in value:
            raise CliError("expected a GraphQL response with a data field")
        return value["data"]
