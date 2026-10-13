"""Loopback-only workspace; no credential or conversation persistence."""
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
import json
import secrets
import time
import urllib.parse

from .agent import Agent
from .builtin_tools import calculate
from .context import generate_context
from .errors import AgentOSError
from .providers import PROVIDERS, create_client
from .web_research import WebResearch, WEB_INSTRUCTIONS


def make_server(port=8765, *, request_token=None):
    token = request_token if request_token is not None else secrets.token_urlsafe(32)
    if not isinstance(token, str) or len(token) < 32 or not token.isascii() or not all(c.isalnum() or c in "-_" for c in token):
        raise ValueError("Invalid workspace request token")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass

        def send(self, status, body, mime="application/json"):
            if mime == "application/json":
                body = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

        def do_GET(self):
            if not self.allowed():
                return self.send(403, {"error": "Open the workspace using its printed loopback URL"})
            if self.path == "/api/providers":
                return self.send(200, {"providers": PROVIDERS})
            assets = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/style.css": ("style.css", "text/css; charset=utf-8")}
            if self.path not in assets:
                return self.send(404, {"error": "Not found"})
            name, mime = assets[self.path]
            body = files("agentos").joinpath("static", name).read_bytes()
            if name == "index.html":
                body = body.replace(b"__TOKEN__", token.encode())
            self.send(200, body, mime)

        def do_POST(self):
            origin = self.headers.get("Origin")
            if (not self.allowed() or self.headers.get("X-AgentOS-Token") != token
                    or (origin is not None and origin != f"http://127.0.0.1:{self.server.server_port}")):
                return self.send(403, {"error": "Request rejected; reload the local workspace"})
            if self.path not in ("/api/run", "/api/context"):
                return self.send(404, {"error": "Not found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 65536:
                    raise ValueError("Request must be between 1 and 65536 bytes")
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected JSON")
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError("Expected an object")
                provider = data.get("provider", "")
                model = data.get("model", "")
                key = data.get("api_key", "")
                host = data.get("base_url", "")
                instructions = data.get("instructions", "You are a helpful assistant.")
                if not all(isinstance(v, str) for v in (provider, model, key, host, instructions)):
                    raise ValueError("Provider, model, key, endpoint and instructions must be text")
                if not model.strip():
                    raise ValueError("Choose a model before running")
                if provider == "ollama" and host:
                    if urllib.parse.urlsplit(host).hostname not in ("localhost", "127.0.0.1", "::1"):
                        raise ValueError("Local mode requires a loopback Ollama endpoint")
                enabled = data.get("calculator", True)
                if type(enabled) is not bool:
                    raise ValueError("Calculator must be true or false")
                research_enabled = data.get("web_research", False)
                if type(research_enabled) is not bool:
                    raise ValueError("Web research must be true or false")
                steps = data.get("max_steps", 16)
                calls = data.get("max_tool_calls", 24)
                timeout = data.get("timeout", 120)
                if type(steps) is not int or not 1 <= steps <= 32:
                    raise ValueError("Model steps must be 1–32")
                if type(calls) is not int or not 0 <= calls <= 64:
                    raise ValueError("Tool calls must be 0–64")
                if type(timeout) not in (int, float) or not 1 <= timeout <= 300:
                    raise ValueError("Request timeout must be 1–300 seconds")
                client = create_client(provider, api_key=key, base_url=host, timeout=timeout)
                if self.path == "/api/context":
                    draft = generate_context(client, model, data.get("description", ""),
                                             web_research=research_enabled, calculator=enabled)
                    return self.send(200, {"context": draft, "provider": provider, "model": model,
                                            "capabilities": {"web_research": research_enabled, "calculator": enabled}})
                name = data.get("name", "Assistant")
                if not isinstance(name, str) or not name.strip() or len(name) > 80:
                    raise ValueError("Invalid agent name")
                tools = [calculate] if enabled else []
                if research_enabled:
                    tools.extend(WebResearch().tools)
                    instructions += "\n\nActual enabled capabilities for this run:\n" + WEB_INSTRUCTIONS
                agent = Agent(name=name, model=model, instructions=instructions, client=client,
                              tools=tools, max_steps=steps, max_tool_calls=calls,
                              finalize_on_limit=research_enabled)
                started = time.monotonic()
                result = agent.run(data.get("prompt", ""))
                self.send(200, {**asdict(result), "elapsed": round(time.monotonic() - started, 2),
                                "provider": provider, "model": model})
            except (ValueError, TypeError, OverflowError):
                self.send(400, {"error": "Invalid configuration. Check the model, API key, endpoint, prompt and limits."})
            except AgentOSError as exc:
                self.send(502, {"error": str(exc)})
            except Exception:
                self.send(500, {"error": "Run failed unexpectedly"})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def serve(port=8765):
    with make_server(port) as server:
        print(f"AgentOS workspace: http://127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever()
