"""Dependency-free, non-streaming Ollama HTTP transport."""

import json
import math
import urllib.error
import urllib.parse
import urllib.request
from typing import Protocol

from .errors import ProviderError


class ChatClient(Protocol):
    def chat(self, *, model: str, messages: list[dict], tools: list[dict]) -> dict:
        """Return an assistant message."""
        ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OllamaClient:
    def __init__(self, base_url: str = "http://localhost:11434", timeout: float = 120):
        parsed = urllib.parse.urlsplit(base_url)
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("Ollama URL has an invalid port") from exc
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError("Ollama URL must be an http(s) origin without credentials, path, or query")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Timeout must be a positive finite number")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        # Ignore proxy environment variables so localhost prompts stay local.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def chat(self, *, model: str, messages: list[dict], tools: list[dict]) -> dict:
        body = {"model": model, "messages": messages, "tools": tools,
                "stream": False, "think": False}
        request = urllib.request.Request(
            self.base_url + "/api/chat", data=json.dumps(body, allow_nan=False).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ProviderError("Ollama response exceeds 2 MB")
            payload = json.loads(raw)
        except urllib.error.HTTPError as exc:
            hint = " Check the model is installed with 'ollama list'." if exc.code == 404 else ""
            raise ProviderError(f"Ollama returned HTTP {exc.code}.{hint}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ProviderError("Cannot reach Ollama or request timed out. Start 'ollama serve' and check --host/--timeout.") from exc
        except (ValueError, UnicodeError) as exc:
            raise ProviderError("Ollama returned invalid JSON") from exc
        if not isinstance(payload, dict) or "error" in payload or payload.get("done") is not True:
            raise ProviderError("Ollama returned an error or incomplete response")
        message = payload.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            raise ProviderError("Ollama response is missing an assistant message")
        return message
