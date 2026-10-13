import json
import unittest
from unittest.mock import Mock

from agentos.context import generate_context
from agentos.errors import ProviderError
from test_http_cli import server
import test_providers_web as web_helpers
from test_providers_web import workspace


def brief():
    return {"name": "Interview Coach", "purpose": "Prepare for backend interviews.",
            "instructions": "Coach the user using supplied information. Ask about experience before tailoring questions.",
            "starter_prompts": ["Ask me a backend interview question.", "Explain indexing.", "Review my answer."],
            "assumptions": ["General backend interviews unless the user specifies a role."]}


class ContextTests(unittest.TestCase):
    def client(self, content, calls=None):
        client = Mock()
        client.chat.return_value = {"role": "assistant", "content": content, "tool_calls": calls or []}
        return client

    def test_generates_context_in_one_request_without_tools(self):
        client = self.client(json.dumps(brief()))
        result = generate_context(client, "chosen", "Help me prepare for interviews")
        self.assertEqual(result, brief())
        client.chat.assert_called_once()
        call = client.chat.call_args.kwargs
        self.assertEqual(call["model"], "chosen")
        self.assertEqual(call["tools"], [])
        self.assertEqual(call["messages"][-1]["content"], "Help me prepare for interviews")

    def test_accepts_json_fence(self):
        self.assertEqual(generate_context(self.client('```json\n' + json.dumps(brief()) + '\n```'), "model", "Coach"), brief())

    def test_invalid_description_never_calls_model(self):
        for description in ("", "  ", "x" * 4001, None, 42):
            client = Mock()
            with self.subTest(description_type=type(description)), self.assertRaises(ValueError):
                generate_context(client, "model", description)
            client.chat.assert_not_called()

    def test_rejects_malformed_or_unbounded_context(self):
        drafts = [{}, {**brief(), "instructions": ""}, {**brief(), "instructions": "x" * 8001},
                  {**brief(), "name": 42}, {**brief(), "starter_prompts": [None]},
                  {**brief(), "assumptions": ["x"] * 6}, {**brief(), "tools": ["execute_python"]}]
        for content in ["plain text", "null", "[]", *map(json.dumps, drafts)]:
            with self.subTest(content=content[:60]), self.assertRaises(ProviderError):
                generate_context(self.client(content), "model", "Coach")

    def test_model_cannot_execute_tools_during_generation(self):
        client = self.client(json.dumps(brief()), [{"function": {"name": "calculate", "arguments": {}}}])
        with self.assertRaisesRegex(ProviderError, "no tools were executed"):
            generate_context(client, "model", "Coach")

    def test_web_context_then_run_uses_applied_instructions(self):
        responses = [(200, {"done": True, "message": {"role": "assistant", "content": json.dumps(brief())}}),
                     (200, {"done": True, "message": {"role": "assistant", "content": "Let's practice."}})]
        helper = web_helpers.WebTests()
        with workspace() as url, server(responses) as (ollama, requests):
            token = helper.token(url)
            connection = {"provider": "ollama", "model": "selected", "base_url": ollama}
            with helper.post(url, token, {**connection, "description": "An interview coach"}, path="/api/context") as response:
                context = json.load(response)["context"]
            self.assertEqual(context, brief())
            self.assertEqual(requests[0][1]["tools"], [])
            with helper.post(url, token, {**connection, "name": context["name"],
                             "instructions": context["instructions"], "prompt": context["starter_prompts"][0]}) as response:
                self.assertEqual(json.load(response)["content"], "Let's practice.")
            self.assertTrue(requests[1][1]["messages"][0]["content"].startswith(context["instructions"]))
            self.assertIn("calculate", requests[1][1]["messages"][0]["content"])
