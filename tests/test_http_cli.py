from contextlib import contextmanager, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import threading
import unittest
from unittest.mock import patch

from agentos import Agent, OllamaClient, ProviderError
from agentos.builtin_tools import calculate
from agentos.cli import main


@contextmanager
def server(responses):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            status, body = responses[len(requests) - 1]
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", requests
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


def response(content="Done", calls=None):
    return {"done": True, "message": {"role": "assistant", "content": content, "tool_calls": calls or []}}


class HttpAndCliTests(unittest.TestCase):
    def test_real_http_tool_roundtrip(self):
        calls = [{"function": {"name": "calculate", "arguments": {"a": 25, "operation": "multiply", "b": 48}}}]
        with server([(200, response("", calls)), (200, response("1200"))]) as (url, requests):
            result = Agent(tools=[calculate], client=OllamaClient(url)).run("25 * 48")
        self.assertEqual(result.content, "1200")
        self.assertEqual(requests[0][0], "/api/chat")
        self.assertFalse(requests[0][1]["stream"])
        self.assertFalse(requests[0][1]["think"])
        self.assertEqual(json.loads(requests[1][1]["messages"][-1]["content"])["result"], 1200)

    def test_provider_errors(self):
        for status, body in ((404, {}), (500, {}), (200, b"not-json"), (200, []),
                             (200, {"error": "failure"}), (200, {"done": False}),
                             (200, {"done": True, "message": {"role": "user"}}),
                             (200, b"x" * 2_000_001)):
            with self.subTest(status=status, body_type=type(body)), server([(status, body)]) as (url, _):
                with self.assertRaises(ProviderError):
                    OllamaClient(url).chat(model="qwen3:8b", messages=[], tools=[])

    def test_connection_failure(self):
        client = OllamaClient()
        with patch.object(client._opener, "open", side_effect=TimeoutError()):
            with self.assertRaisesRegex(ProviderError, "timed out"):
                client.chat(model="qwen3:8b", messages=[], tools=[])

    def test_invalid_configuration(self):
        for url in ("file:///tmp/model", "http://user:password@localhost", "http://localhost/api",
                    "http://localhost?x=1", "http://localhost:bad", "http://localhost:99999"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                OllamaClient(url)
        for timeout in (0, -1, float("nan"), float("inf")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                OllamaClient(timeout=timeout)

    def test_cli_json_and_no_tools(self):
        output = io.StringIO()
        with server([(200, response("hello"))]) as (url, requests), redirect_stdout(output):
            code = main(["run", "hi", "--host", url, "--json", "--no-tools"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["content"], "hello")
        self.assertEqual(requests[0][1]["tools"], [])

    def test_cli_errors(self):
        error = io.StringIO()
        with redirect_stderr(error):
            code = main(["run", "hi", "--max-steps", "0"])
        self.assertEqual(code, 1)
        self.assertIn("positive integer", error.getvalue())
        self.assertNotIn("Traceback", error.getvalue())

    def test_cli_plain_text(self):
        output = io.StringIO()
        with server([(200, response("hello"))]) as (url, _), redirect_stdout(output):
            code = main(["run", "hi", "--host", url])
        self.assertEqual(code, 0)
        self.assertEqual(output.getvalue(), "hello\n")
