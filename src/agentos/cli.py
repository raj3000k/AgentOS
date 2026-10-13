"""Command-line entry point for one-shot local runs."""

import argparse
from dataclasses import asdict
import json
import os
import sys

from .agent import Agent
from .builtin_tools import calculate
from .errors import AgentOSError
from .providers import create_client
from .web_research import WebResearch, WEB_INSTRUCTIONS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentos", description="Run a local Ollama agent")
    parser.add_argument("--version", action="version", version="AgentOS 0.1.0")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Send one prompt to an agent")
    run.add_argument("prompt")
    run.add_argument("--model", default=None)
    run.add_argument("--provider", choices=["ollama", "gemini", "openai", "groq", "deepseek", "custom"], default="ollama")
    run.add_argument("--api-key-env", default="AGENTOS_API_KEY", help="Environment variable containing your API key")
    run.add_argument("--host", default="", help="Ollama origin or custom API base URL")
    run.add_argument("--timeout", type=float, default=120)
    run.add_argument("--max-steps", type=int, default=8)
    run.add_argument("--max-tool-calls", type=int, default=16)
    run.add_argument("--instructions", default="You are a helpful assistant. Use calculate for arithmetic.")
    run.add_argument("--no-tools", action="store_true")
    run.add_argument("--web-research", action="store_true", help="Enable public read-only LinkedIn and web tools")
    run.add_argument("--json", action="store_true", help="Include messages and call counts as JSON")
    serve = commands.add_parser("serve", help="Open the local web workspace")
    serve.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    try:
        if args.command == "serve":
            from .web import serve
            serve(args.port)
            return 0
        model = args.model or ("qwen3:8b" if args.provider == "ollama" else "")
        if not model:
            raise ValueError("Select an API model with --model")
        client = create_client(args.provider, base_url=args.host, timeout=args.timeout,
                               api_key="" if args.provider == "ollama" else os.environ.get(args.api_key_env, ""))
        if args.no_tools and args.web_research:
            raise ValueError("--no-tools cannot be combined with --web-research")
        tools = [] if args.no_tools else [calculate]
        instructions = args.instructions
        if args.web_research:
            tools.extend(WebResearch().tools)
            instructions += "\n\n" + WEB_INSTRUCTIONS
        result = Agent(model=model, instructions=instructions,
                       tools=tools, client=client,
                       max_steps=args.max_steps, max_tool_calls=args.max_tool_calls,
                       finalize_on_limit=args.web_research).run(args.prompt)
        print(json.dumps(asdict(result), indent=2) if args.json else result.content)
        return 0
    except (AgentOSError, ValueError) as exc:
        print(f"agentos: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("agentos: interrupted", file=sys.stderr)
        return 130
