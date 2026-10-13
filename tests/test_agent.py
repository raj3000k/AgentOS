import json
import unittest

from agentos import Agent, ProviderError, RunLimitError, tool


def call(name="double", arguments=None):
    return {"function": {"name": name, "arguments": {"n": 2} if arguments is None else arguments}}


def assistant(content="", calls=None):
    return {"role": "assistant", "content": content, "tool_calls": calls or []}


class FakeClient:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.requests = []

    def chat(self, **kwargs):
        self.requests.append(kwargs)
        return next(self.responses)


@tool
def double(n: int) -> int:
    return 2 * n


class AgentTests(unittest.TestCase):
    def test_multiple_tools_and_transcript(self):
        first = assistant(calls=[call(), call(arguments={"n": 3})])
        first["thinking"] = "preserve-provider-field"
        client = FakeClient(first, assistant("4 and 6"))
        result = Agent(tools=[double], client=client).run("Double 2 and 3")
        self.assertEqual((result.content, result.model_calls, result.tool_calls), ("4 and 6", 2, 2))
        messages = client.requests[1]["messages"]
        self.assertEqual(messages[2]["thinking"], "preserve-provider-field")
        self.assertEqual([json.loads(m["content"])["result"] for m in messages[3:]], [4, 6])
        self.assertTrue(all(m["tool_name"] == "double" for m in messages[3:]))

    def test_bad_tool_calls_allow_recovery(self):
        client = FakeClient(assistant(calls=[call("unknown"), call(arguments={"n": "bad"})]), assistant("Recovered"))
        result = Agent(tools=[double], client=client).run("Try tools")
        self.assertEqual(result.content, "Recovered")
        self.assertTrue(all(not json.loads(m["content"])["ok"] for m in result.messages if m["role"] == "tool"))

    def test_runs_are_isolated(self):
        client = FakeClient(assistant("first"), assistant("second"))
        agent = Agent(client=client)
        agent.run("one")
        agent.run("two")
        self.assertEqual(len(client.requests[1]["messages"]), 2)
        self.assertEqual(client.requests[1]["messages"][1]["content"], "two")

    def test_limits_prevent_batch_side_effects(self):
        executed = []

        @tool
        def record():
            executed.append(True)

        for limits in ({"max_steps": 1}, {"max_tool_calls": 0}, {"max_tool_calls": 1}):
            client = FakeClient(assistant(calls=[call("record", {}), call("record", {})]))
            with self.subTest(limits=limits), self.assertRaises(RunLimitError):
                Agent(tools=[record], client=client, **limits).run("run")
        self.assertEqual(executed, [])

    def test_repeated_calls_stop(self):
        client = FakeClient(*(assistant(calls=[call()]) for _ in range(3)))
        with self.assertRaises(RunLimitError):
            Agent(tools=[double], client=client, max_steps=3).run("repeat")
        self.assertEqual(len(client.requests), 3)

    def test_malformed_batch_does_not_partially_execute(self):
        executed = []

        @tool
        def record():
            executed.append(True)

        client = FakeClient(assistant(calls=[call("record", {}), {"function": {"name": "record", "arguments": "{}"}}]))
        with self.assertRaises(ProviderError):
            Agent(tools=[record], client=client).run("run")
        self.assertEqual(executed, [])

    def test_invalid_messages(self):
        for message in ({}, None, assistant(), {"role": "assistant", "content": 2},
                        {"role": "assistant", "content": "ok", "tool_calls": None}):
            with self.subTest(message=message), self.assertRaises(ProviderError):
                Agent(client=FakeClient(message)).run("hello")

    def test_configuration_validation(self):
        for kwargs in ({"max_steps": 0}, {"max_steps": True}, {"max_tool_calls": -1},
                       {"tools": [double, double]}, {"tools": [lambda: None]}, {"model": ""},
                       {"model": "ollama/"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                Agent(**kwargs)
        with self.assertRaises(ValueError):
            Agent().run(" ")


class FinalizationTests(unittest.TestCase):
    def test_reserves_final_turn_within_total_request_budget(self):
        client = FakeClient(assistant(calls=[call()]), assistant(calls=[call(arguments={"n": 3})]), assistant("Collected 4 and 6; search incomplete."))
        result = Agent(tools=[double], client=client, max_steps=3, finalize_on_limit=True).run("Research")
        self.assertEqual((result.model_calls, result.tool_calls), (3, 2))
        self.assertEqual(result.finish_reason, "budget_summary")
        self.assertEqual(result.limit_reason, "model_steps")
        self.assertEqual(client.requests[-1]["tools"], [])
        self.assertIn("Tools are now disabled", client.requests[-1]["messages"][-1]["content"])

    def test_ignored_finalization_never_executes_more_tools(self):
        client = FakeClient(assistant(calls=[call()]), assistant(calls=[call(arguments={"n": 99})]))
        result = Agent(tools=[double], client=client, max_steps=2, finalize_on_limit=True).run("Research")
        self.assertEqual(result.finish_reason, "partial")
        self.assertEqual(result.tool_calls, 1)
        self.assertIn("double: 4", result.content)
        self.assertEqual(len([message for message in result.messages if message.get("tool_calls")]), 1)

    def test_oversized_tool_batch_is_not_executed_or_left_pending(self):
        client = FakeClient(assistant(calls=[call(), call()]), assistant("No evidence collected."))
        result = Agent(tools=[double], client=client, max_steps=4, max_tool_calls=1, finalize_on_limit=True).run("Research")
        self.assertEqual(result.tool_calls, 0)
        self.assertEqual(result.model_calls, 2)
        self.assertEqual(result.limit_reason, "tool_calls")
        self.assertFalse(any(message.get("tool_calls") for message in result.messages))

    def test_summary_provider_failure_retains_collected_results(self):
        class FailingClient(FakeClient):
            def chat(self, **kwargs):
                if self.requests:
                    raise ProviderError("Summary request failed")
                return super().chat(**kwargs)
        result = Agent(tools=[double], client=FailingClient(assistant(calls=[call()])), max_steps=2,
                       finalize_on_limit=True).run("Research")
        self.assertEqual(result.finish_reason, "partial")
        self.assertEqual(result.model_calls, 2)
        self.assertIn("double: 4", result.content)

    def test_single_request_budget_and_normal_success(self):
        malformed = {"role": "assistant", "content": "Summary", "tool_calls": None}
        partial = Agent(client=FakeClient(malformed), max_steps=1, finalize_on_limit=True).run("Research")
        self.assertEqual(partial.finish_reason, "partial")
        client = FakeClient(assistant(calls=[call()]))
        result = Agent(tools=[double], client=client, max_steps=1, finalize_on_limit=True).run("Research")
        self.assertEqual(result.tool_calls, 0)
        self.assertIn("No successful tool results", result.content)
        self.assertEqual(len(client.requests), 1)
        result = Agent(client=FakeClient(assistant("Done")), finalize_on_limit=True).run("Hello")
        self.assertEqual(result.finish_reason, "completed")
        self.assertIsNone(result.limit_reason)
