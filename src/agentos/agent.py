"""Minimal bounded single-agent execution loop."""

from copy import deepcopy
from dataclasses import dataclass

from .errors import ProviderError, RunLimitError
from .ollama import ChatClient, OllamaClient
from .tools import Tool, execute_tool


@dataclass(frozen=True)
class RunResult:
    content: str
    messages: list[dict]
    model_calls: int
    tool_calls: int


class Agent:
    def __init__(self, *, name: str = "Assistant", model: str = "qwen3:8b",
                 instructions: str = "You are a helpful assistant. Use tools when appropriate.",
                 tools: list[Tool] | None = None, client: ChatClient | None = None,
                 max_steps: int = 8, max_tool_calls: int = 16):
        if type(max_steps) is not int or max_steps < 1:
            raise ValueError("max_steps must be a positive integer")
        if type(max_tool_calls) is not int or max_tool_calls < 0:
            raise ValueError("max_tool_calls must be a nonnegative integer")
        model = model.removeprefix("ollama/").strip()
        if not model or not name.strip():
            raise ValueError("Agent name and model cannot be empty")
        self.name = name
        self.model = model
        self.instructions = instructions
        self.tools: dict[str, Tool] = {}
        for entry in tools or []:
            if not isinstance(entry, Tool):
                raise ValueError("Register functions with @tool before passing them to Agent")
            if entry.name in self.tools:
                raise ValueError(f"Duplicate tool name: {entry.name}")
            self.tools[entry.name] = entry
        self.client = client if client is not None else OllamaClient()
        self.max_steps = max_steps
        self.max_tool_calls = max_tool_calls

    def run(self, prompt: str) -> RunResult:
        """Run an isolated conversation. No implicit memory persists across calls."""
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Prompt cannot be empty")
        messages = [{"role": "system", "content": self.instructions},
                    {"role": "user", "content": prompt}]
        schemas = [entry.schema() for entry in self.tools.values()]
        tool_count = 0
        for step in range(1, self.max_steps + 1):
            message = self.client.chat(model=self.model, messages=deepcopy(messages), tools=schemas)
            if not isinstance(message, dict) or message.get("role") != "assistant":
                raise ProviderError("Expected an assistant message")
            content = message.get("content", "")
            calls = message.get("tool_calls", [])
            if not isinstance(content, str) or not isinstance(calls, list):
                raise ProviderError("Invalid assistant content or tool_calls")
            # Validate the entire batch before executing any of its functions.
            for call in calls:
                fn = call.get("function") if isinstance(call, dict) else None
                if (not isinstance(fn, dict) or not isinstance(fn.get("name"), str)
                        or not isinstance(fn.get("arguments"), dict)):
                    raise ProviderError("Malformed tool call; expected function name and arguments object")
            messages.append(deepcopy(message))
            if not calls:
                if not content.strip():
                    raise ProviderError("Ollama returned an empty final answer")
                return RunResult(content, messages, step, tool_count)
            if step == self.max_steps:
                raise RunLimitError("Model step limit reached before a final answer; final batch was not executed")
            if tool_count + len(calls) > self.max_tool_calls:
                raise RunLimitError("Tool call limit exceeded; batch was not executed")
            for call in calls:
                fn = call["function"]
                result = execute_tool(self.tools, fn["name"], fn["arguments"])
                messages.append({"role": "tool", "tool_name": fn["name"], "content": result})
                tool_count += 1
        raise RunLimitError("Model step limit reached")
