"""Explicit user-selected, OpenAI-compatible provider transport."""
from copy import deepcopy
import json
import math
import urllib.error
import urllib.parse
import urllib.request

from .errors import ProviderError
from .ollama import OllamaClient, _NoRedirect

PROVIDERS = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "deepseek": "https://api.deepseek.com/v1",
}


class CompatibleClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 120):
        parsed = urllib.parse.urlsplit(base_url)
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("Invalid endpoint port") from exc
        local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query
                or parsed.fragment or (parsed.scheme != "https" and not (local and parsed.scheme == "http"))):
            raise ValueError("API endpoint must use HTTPS (HTTP allowed only on loopback)")
        if not isinstance(api_key, str) or not api_key.strip() or any(ord(c) < 32 or ord(c) > 126 for c in api_key):
            raise ValueError("A valid API key is required")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Timeout must be positive and finite")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key.strip()
        self.timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def chat(self, *, model: str, messages: list[dict], tools: list[dict]) -> dict:
        wire = deepcopy(messages)
        for message in wire:
            if message["role"] == "tool":
                message.pop("tool_name", None)
            for call in message.get("tool_calls", []):
                call["function"]["arguments"] = json.dumps(call["function"]["arguments"], allow_nan=False)
        body = {"model": model, "messages": wire, "stream": False}
        if tools:
            body["tools"] = tools
        request = urllib.request.Request(self.base_url + "/chat/completions",
            data=json.dumps(body, allow_nan=False).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self._api_key})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ProviderError("Provider response exceeds 2 MB")
            payload = json.loads(raw)
            choice = payload["choices"][0]
            if choice["finish_reason"] not in ("stop", "tool_calls"):
                raise ProviderError("Provider stopped without a complete answer (limit or filter)")
            message = deepcopy(choice["message"])
            if message.get("role") != "assistant":
                raise ValueError()
            if message.get("content") is None:
                message["content"] = ""
            calls = message.get("tool_calls", [])
            if not isinstance(calls, list):
                raise ValueError()
            ids = set()
            for call in calls:
                if (call.get("type") != "function" or not isinstance(call.get("id"), str)
                        or not call["id"] or call["id"] in ids):
                    raise ValueError()
                ids.add(call["id"])
                call["function"]["arguments"] = json.loads(call["function"]["arguments"])
                if not isinstance(call["function"]["arguments"], dict):
                    raise ValueError()
            return message
        except urllib.error.HTTPError as exc:
            # Only expose fixed diagnostic labels, never provider text that may echo secrets.
            diagnostic = ''
            try:
                payload = json.loads(exc.read(65537))
                error = payload.get('error', {}) if isinstance(payload, dict) else {}
                if isinstance(error, dict):
                    status = error.get('status')
                    known = {'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
                             'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL'}
                    if isinstance(status, str) and status in known:
                        diagnostic = f' ({status})'
                    details = error.get('details', [])
                    if isinstance(details, list) and any(isinstance(row, dict) and row.get('reason') == 'API_KEY_INVALID' for row in details):
                        diagnostic = ' (API_KEY_INVALID)'
            except (ValueError, TypeError, OSError):
                pass
            hints = {400: "Check request parameters and API key restrictions.", 401: "Check your API key.", 403: "Check account access.",
                     404: "Check the model ID and endpoint.", 429: "Rate limit or quota reached.",
                     503: "Provider temporarily unavailable; retry later. This response does not validate the key or model."}
            raise ProviderError(f"Provider returned HTTP {exc.code}{diagnostic}. {hints.get(exc.code, 'Request failed.')}".strip()) from None
        except (urllib.error.URLError, OSError):
            raise ProviderError("Cannot reach provider or request timed out") from None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError("Provider returned an invalid chat response") from None


def create_client(provider: str, *, api_key: str = "", base_url: str = "", timeout: float = 120):
    if provider == "ollama":
        if api_key:
            raise ValueError("Local Ollama does not accept an API key")
        return OllamaClient(base_url or "http://localhost:11434", timeout)
    if provider not in (*PROVIDERS, "custom"):
        raise ValueError("Unknown provider")
    if provider == "custom" and not base_url:
        raise ValueError("Custom provider requires an API base URL")
    if provider in PROVIDERS and base_url and base_url.rstrip("/") != PROVIDERS[provider]:
        raise ValueError("Use custom provider for a different API endpoint")
    return CompatibleClient(PROVIDERS.get(provider, base_url), api_key, timeout)
