"""Explicit function registration, JSON schemas, and strict argument validation."""

import inspect
import json
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, get_type_hints

from .errors import ToolError

_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean"}


def _valid(value: Any, annotation: type) -> bool:
    if annotation is float:
        try:
            return type(value) in (int, float) and math.isfinite(value)
        except OverflowError:
            return False
    return type(value) is annotation


@dataclass(frozen=True)
class Tool:
    """A trusted synchronous function exposed to the model."""

    function: Callable
    name: str
    description: str
    signature: inspect.Signature
    annotations: dict[str, type]
    on_run_start: Callable | None = None

    def schema(self) -> dict:
        properties = {}
        required = []
        for name, parameter in self.signature.parameters.items():
            properties[name] = {"type": _TYPES[self.annotations[name]]}
            if parameter.default is inspect.Parameter.empty:
                required.append(name)
            else:
                properties[name]["default"] = parameter.default
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": {"type": "object", "properties": properties,
                           "required": required, "additionalProperties": False},
        }}

    def invoke(self, arguments: dict) -> Any:
        if not isinstance(arguments, dict) or not all(isinstance(k, str) for k in arguments):
            raise ToolError("Arguments must be a JSON object with string keys")
        try:
            bound = self.signature.bind(**arguments)
        except TypeError as exc:
            raise ToolError(str(exc)) from exc
        bound.apply_defaults()
        for name, value in bound.arguments.items():
            if not _valid(value, self.annotations[name]):
                raise ToolError(f"Argument '{name}' must be {_TYPES[self.annotations[name]]}")
        try:
            return self.function(*bound.args, **bound.kwargs)
        except Exception as exc:
            # Do not leak arbitrary function exception text (paths, tokens, etc.) to a model.
            raise ToolError(f"Tool '{self.name}' failed ({type(exc).__name__})") from exc


def tool(function: Callable | None = None, *, name: str | None = None,
         description: str | None = None):
    """Register a function with scalar str/int/float/bool parameters."""
    def decorate(fn: Callable) -> Tool:
        if (inspect.iscoroutinefunction(fn) or inspect.isgeneratorfunction(fn)
                or inspect.isasyncgenfunction(fn)):
            raise ValueError("Tools must be synchronous functions, not generators")
        tool_name = name or fn.__name__
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", tool_name):
            raise ValueError("Tool names must be identifiers of at most 64 characters")
        signature = inspect.signature(fn)
        annotations = get_type_hints(fn)
        for key, parameter in signature.parameters.items():
            if parameter.kind not in (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                                      inspect.Parameter.KEYWORD_ONLY):
                raise ValueError("Tools cannot use positional-only or variadic parameters")
            if annotations.get(key) not in _TYPES:
                raise ValueError(f"Tool parameter '{key}' needs a str, int, float, or bool annotation")
            if parameter.default is not inspect.Parameter.empty and not _valid(parameter.default, annotations[key]):
                raise ValueError(f"Invalid default for '{key}'")
        return Tool(fn, tool_name, description or inspect.getdoc(fn) or tool_name,
                    signature, annotations)
    return decorate(function) if function is not None else decorate


def execute_tool(registry: Mapping[str, Tool], name: str, arguments: dict,
                 max_result_chars: int = 16000) -> str:
    """Return a JSON success/error envelope for a model tool result."""
    try:
        if name not in registry:
            raise ToolError(f"Unknown tool '{name}'")
        result = registry[name].invoke(arguments)
        try:
            content = json.dumps({"ok": True, "result": result}, allow_nan=False)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ToolError("Tool result must be JSON serializable and finite") from exc
        if len(content) > max_result_chars:
            raise ToolError("Tool result exceeds the configured size limit")
        return content
    except ToolError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
