from contextlib import contextmanager, redirect_stdout, redirect_stderr
import io
import json
import re
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from agentos import Agent, CompatibleClient, ProviderError, create_client
from agentos.builtin_tools import calculate
from agentos.web import make_server
from agentos.cli import main
from test_http_cli import server


def completion(message, finish="stop"):
    return {"choices": [{"finish_reason": finish, "message": message}]}


@contextmanager
def workspace():
    httpd = make_server(0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


class ProviderTests(unittest.TestCase):
    def test_tool_roundtrip_preserves_ids_and_metadata(self):
        call = {"id": "call_1", "type": "function", "function": {
            "name": "calculate", "arguments": json.dumps({"a": 25, "b": 48, "operation": "multiply"})},
            "extra_content": {"google": {"thought_signature": "opaque"}}}
        first = completion({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls")
        final = completion({"role": "assistant", "content": "1200"})
        with server([(200, first), (200, final)]) as (url, requests):
            client = CompatibleClient(url + "/v1", "test-key")
            with patch.object(client._opener, "open", wraps=client._opener.open) as opened:
                result = Agent(tools=[calculate], client=client).run("25 * 48")
            self.assertEqual(opened.call_args_list[0].args[0].get_header("Authorization"), "Bearer test-key")
        self.assertEqual(result.content, "1200")
        self.assertEqual(requests[0][0], "/v1/chat/completions")
        messages = requests[1][1]["messages"]
        self.assertEqual(messages[-1]["tool_call_id"], "call_1")
        self.assertNotIn("tool_name", messages[-1])
        self.assertIsInstance(messages[-2]["tool_calls"][0]["function"]["arguments"], str)
        self.assertEqual(messages[-2]["tool_calls"][0]["extra_content"], call["extra_content"])
        self.assertNotIn("test-key", json.dumps(result.messages))

    def test_plain_chat_omits_tools(self):
        with server([(200, completion({"role": "assistant", "content": "Hello"}))]) as (url, requests):
            result = Agent(client=CompatibleClient(url, "key")).run("Hi")
        self.assertEqual(result.content, "Hello")
        self.assertNotIn("tools", requests[0][1])

    def test_malformed_batch_executes_nothing(self):
        valid = {"id": "one", "type": "function", "function": {"name": "calculate", "arguments": '{"a":1,"b":2,"operation":"add"}'}}
        invalid = {"id": "two", "type": "function", "function": {"name": "calculate", "arguments": "bad"}}
        with server([(200, completion({"role": "assistant", "tool_calls": [valid, invalid]}, "tool_calls"))]) as (url, _):
            with patch("agentos.agent.execute_tool") as execute, self.assertRaises(ProviderError):
                Agent(tools=[calculate], client=CompatibleClient(url, "key")).run("Hi")
            execute.assert_not_called()

    def test_errors_do_not_echo_credentials(self):
        for status, body in [(401, {"error": "secret-key"}), (429, {}), (200, {}),
                             (200, completion({"role": "assistant", "content": "partial"}, "length")),
                             (200, b"x" * 2_000_001)]:
            with self.subTest(status=status), server([(status, body)]) as (url, _):
                with self.assertRaises(ProviderError) as caught:
                    CompatibleClient(url, "secret-key").chat(model="chosen", messages=[], tools=[])
                self.assertNotIn("secret-key", str(caught.exception))

    def test_cli_api_key_from_environment(self):
        output = io.StringIO()
        with server([(200, completion({"role": "assistant", "content": "Hello"}))]) as (url, requests):
            with patch.dict("os.environ", {"TEST_PROVIDER_KEY": "secret"}), redirect_stdout(output):
                code = main(["run", "Hi", "--provider", "custom", "--model", "selected",
                             "--host", url, "--api-key-env", "TEST_PROVIDER_KEY", "--no-tools"])
        self.assertEqual(code, 0)
        self.assertEqual(requests[0][1]["model"], "selected")
        self.assertNotIn("secret", output.getvalue())

    def test_cli_cloud_requires_user_model(self):
        with redirect_stderr(io.StringIO()), patch("agentos.cli.create_client") as create:
            self.assertEqual(main(["run", "Hi", "--provider", "gemini"]), 1)
        create.assert_not_called()

    def test_explicit_configuration(self):
        for provider in ("gemini", "openai", "groq", "deepseek"):
            with self.subTest(provider=provider), self.assertRaises(ValueError):
                create_client(provider)
        for url in ("http://example.com/v1", "https://user:pass@example.com", "https://example.com?key=x", "https://example.com:bad"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                CompatibleClient(url, "key")
        with self.assertRaises(ValueError):
            create_client("gemini", api_key="key", base_url="https://wrong.example")
        with self.assertRaises(ValueError):
            create_client("ollama", api_key="key")
        with self.assertRaises(ValueError):
            create_client("unknown", api_key="key")
        self.assertEqual(create_client("gemini", api_key="key").base_url,
                         "https://generativelanguage.googleapis.com/v1beta/openai")


class WebTests(unittest.TestCase):
    def post(self, url, token, data, origin=None):
        headers = {"Content-Type": "application/json", "X-AgentOS-Token": token}
        if origin:
            headers["Origin"] = origin
        return urllib.request.urlopen(urllib.request.Request(url + "/api/run",
            data=json.dumps(data).encode(), headers=headers), timeout=5)

    def token(self, url):
        with urllib.request.urlopen(url) as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return re.search('name="agentos-token" content="([^"]+)"', response.read().decode()).group(1)

    def test_local_run_and_static_assets(self):
        with workspace() as url, server([(200, {"done": True, "message": {"role": "assistant", "content": "Hi"}})]) as (ollama, _):
            token = self.token(url)
            with self.post(url, token, {"provider": "ollama", "model": "selected-local", "base_url": ollama, "prompt": "Hello"}) as response:
                result = json.load(response)
            self.assertEqual(result["model"], "selected-local")
            self.assertEqual(result["content"], "Hi")
            for path in ("/app.js", "/style.css", "/api/providers"):
                with urllib.request.urlopen(url + path) as response:
                    self.assertEqual(response.status, 200)

    def test_cloud_run_uses_explicit_custom_key(self):
        with workspace() as url, server([(200, completion({"role": "assistant", "content": "API answer"}))]) as (provider, requests):
            token = self.token(url)
            with self.post(url, token, {"provider": "custom", "model": "chosen-api", "base_url": provider, "api_key": "secret", "prompt": "Hello"}) as response:
                result = json.load(response)
            self.assertEqual(requests[0][1]["model"], "chosen-api")
            self.assertNotIn("secret", json.dumps(result))

    def test_access_checks_and_invalid_configuration(self):
        with workspace() as url:
            token = self.token(url)
            for supplied, origin in [("wrong", None), (token, "https://evil.example")]:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.post(url, supplied, {}, origin)
                self.assertEqual(caught.exception.code, 403)
            for data in ({"provider": "gemini", "model": "chosen", "prompt": "hi"},
                         {"provider": "ollama", "model": "chosen", "base_url": "http://remote.example", "prompt": "hi"},
                         {"provider": "ollama", "model": "chosen", "max_steps": 0}):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.post(url, token, data)
                self.assertEqual(caught.exception.code, 400)
            request = urllib.request.Request(url, headers={"Host": "evil.example"})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            self.assertEqual(caught.exception.code, 403)
