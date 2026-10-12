import json
import unittest

from agentos import tool
from agentos.builtin_tools import calculate
from agentos.tools import execute_tool


@tool
def add(a: int, b: int = 2) -> int:
    """Add two integers."""
    return a + b


class ToolsTests(unittest.TestCase):
    def test_schema_and_defaults(self):
        schema = add.schema()["function"]
        self.assertEqual(schema["parameters"]["required"], ["a"])
        self.assertEqual(schema["parameters"]["properties"]["b"]["default"], 2)
        self.assertFalse(schema["parameters"]["additionalProperties"])
        self.assertEqual(add.invoke({"a": 4}), 6)

    def test_invalid_arguments_do_not_execute(self):
        calls = []

        @tool
        def record(value: int):
            calls.append(value)

        for args in ({}, {"value": "2"}, {"value": True}, {"value": 2, "extra": 3}, []):
            with self.subTest(args=args):
                result = json.loads(execute_tool({"record": record}, "record", args))
                self.assertFalse(result["ok"])
        self.assertEqual(calls, [])

    def test_unknown_tool(self):
        result = json.loads(execute_tool({}, "shell", {"command": "echo unwanted"}))
        self.assertFalse(result["ok"])

    def test_exception_is_sanitized(self):
        @tool
        def broken():
            raise RuntimeError("secret-password")

        result = execute_tool({"broken": broken}, "broken", {})
        self.assertNotIn("secret-password", result)
        self.assertIn("RuntimeError", result)

    def test_result_validation(self):
        for value in (object(), float("nan"), "x" * 17000):
            @tool
            def invalid():
                return value
            self.assertFalse(json.loads(execute_tool({"invalid": invalid}, "invalid", {}))["ok"])

    def test_unsupported_signatures(self):
        def untyped(a):
            pass

        def variadic(*args: str):
            pass

        def complex_type(a: list[str]):
            pass

        async def asynchronous(a: int):
            pass

        def generator(a: int):
            yield a

        async def async_generator(a: int):
            yield a

        def bad_default(a: int = "wrong"):
            pass

        for fn in (untyped, variadic, complex_type, asynchronous, generator, async_generator, bad_default):
            with self.subTest(fn=fn.__name__), self.assertRaises(ValueError):
                tool(fn)

    def test_custom_name(self):
        renamed = tool(add.function, name="sum_numbers", description="Sum numbers")
        self.assertEqual(renamed.schema()["function"]["name"], "sum_numbers")
        with self.assertRaises(ValueError):
            tool(add.function, name="not valid")

    def test_calculator_safe_operations(self):
        for operation, expected in (("add", 10), ("subtract", 6), ("multiply", 16), ("divide", 4)):
            self.assertEqual(calculate.invoke({"a": 8, "operation": operation, "b": 2}), expected)
        for args in ({"a": 1, "operation": "divide", "b": 0},
                     {"a": 1, "operation": "__import__('os')", "b": 2},
                     {"a": float("inf"), "operation": "add", "b": 2},
                     {"a": 10 ** 400, "operation": "add", "b": 2},
                     {"a": 1e101, "operation": "add", "b": 2}):
            self.assertFalse(json.loads(execute_tool({"calculate": calculate}, "calculate", args))["ok"])
