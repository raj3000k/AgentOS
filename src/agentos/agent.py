"""Minimal bounded single-agent execution loop."""

from copy import deepcopy
from dataclasses import dataclass, replace
import json

from .conversation import MAX_TURNS, validate_history, history_messages, append_turn
from .planning import PLAN_PROMPT, TaskPlan
from .errors import ProviderError, RunLimitError
from .ollama import ChatClient, OllamaClient
from .tools import Tool, execute_tool


@dataclass(frozen=True)
class RunResult:
    content: str
    messages: list[dict]
    model_calls: int
    tool_calls: int
    finish_reason: str = "completed"
    limit_reason: str | None = None
    conversation: list[dict] | None = None
    context_error: str | None = None
    plan: dict | None = None


class Agent:
    def __init__(self, *, name: str = "Assistant", model: str = "qwen3:8b",
                 instructions: str = "You are a helpful assistant. Use tools when appropriate.",
                 tools: list[Tool] | None = None, client: ChatClient | None = None,
                 max_steps: int = 8, max_tool_calls: int = 16,
                 finalize_on_limit: bool = False):
        if type(max_steps) is not int or max_steps < 1:
            raise ValueError("max_steps must be a positive integer")
        if type(max_tool_calls) is not int or max_tool_calls < 0:
            raise ValueError("max_tool_calls must be a nonnegative integer")
        if type(finalize_on_limit) is not bool:
            raise ValueError("finalize_on_limit must be a boolean")
        self.finalize_on_limit = finalize_on_limit
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

    def run(self, prompt: str, *, history=None, on_event=None, should_stop=None, on_checkpoint=None, plan_task=False) -> RunResult:
        """Run a fresh conversation, or explicitly supply validated prior turns as history.

        History is data-only; prior tool calls are never replayed or permissions restored.
        Lifecycle events contain metadata; plan events include bounded user-facing model
        descriptions/assessments that can echo user data. Checkpoints include sensitive
        transcripts. Treat callbacks as trusted application code, not a secret boundary.
        Callbacks run synchronously and their exceptions propagate. Stopping does
        not interrupt an in-flight call or undo side effects. Cancelled transcripts
        may include assistant tool calls whose remaining batch was not executed.
        """
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Prompt cannot be empty")
        if type(plan_task) is not bool or (plan_task and self.max_steps < 2):
            raise ValueError('Planning requires a boolean setting and at least two model steps')
        if plan_task and 'update_task_plan' in self.tools:
            raise ValueError('update_task_plan is reserved when planning is enabled')
        plan = None
        registry = dict(self.tools)
        finalize_on_limit = self.finalize_on_limit or plan_task
        history = validate_history([] if history is None else history)
        if len(history) >= MAX_TURNS:
            raise ValueError('Conversation has 20 replies. Start a new conversation.')

        started_callbacks=set()
        for entry in self.tools.values():
            callback=entry.on_run_start
            if callback is not None and id(callback) not in started_callbacks:
                if not callable(callback):
                    raise ValueError('Tool lifecycle callback must be trusted callable application code')
                callback()
                started_callbacks.add(id(callback))

        def finish(result):
            result = replace(result, plan=plan.snapshot() if plan else None)
            try:
                return replace(result, conversation=append_turn(history, prompt, result))
            except ValueError as exc:
                return replace(result, context_error=str(exc))

        def checkpoint(model_calls, tool_calls):
            if on_checkpoint is not None:
                on_checkpoint({'messages': deepcopy(messages), 'model_calls': model_calls, 'tool_calls': tool_calls, 'plan': plan.snapshot() if plan else None})

        def emit(kind, **details):
            if on_event is not None:
                on_event({"type": kind, **details})

        def cancelled(model_calls, tool_calls):
            content = "Run stopped at your request. Collected tool results remain available in Inspect execution."
            messages.append({"role": "assistant", "content": content})
            return finish(RunResult(content, messages, model_calls, tool_calls, "cancelled", "user_stop"))

        messages = ([{"role": "system", "content": self.instructions}]
                    + history_messages(history) + [{"role": "user", "content": prompt}])
        first_step = 1
        if plan_task:
            if should_stop is not None and should_stop():
                return cancelled(0, 0)
            checkpoint(1, 0)
            emit('model_start', step=1, max_steps=self.max_steps, finalizing=False, phase='planning')
            if should_stop is not None and should_stop():
                return cancelled(0, 0)
            try:
                proposal = self.client.chat(model=self.model,
                    messages=deepcopy(messages) + [{'role':'user','content':PLAN_PROMPT}], tools=[])
            except ProviderError:
                if should_stop is not None and should_stop():
                    return cancelled(1, 0)
                raise
            emit('model_end', step=1)
            if should_stop is not None and should_stop():
                return cancelled(1, 0)
            plan = TaskPlan(proposal, prompt)
            registry.update({entry.name:entry for entry in plan.tools})
            messages.append({'role':'assistant', 'content':plan.instructions()})
            messages.append({'role':'user','content':'Proceed with the task using this plan. Report progress honestly and finish with the requested deliverable and limitations.'})
            checkpoint(1, 0)
            emit('plan_ready', plan=plan.snapshot())
            first_step = 2
        schemas = [entry.schema() for entry in registry.values()]
        tool_count = 0
        limit_reason = None
        for step in range(first_step, self.max_steps + 1):
            if should_stop is not None and should_stop():
                return cancelled(step - 1, tool_count)
            finalizing = finalize_on_limit and (limit_reason is not None
                or step == self.max_steps or tool_count >= self.max_tool_calls)
            if finalizing:
                limit_reason = limit_reason or ("model_steps" if step == self.max_steps else "tool_calls")
                messages.append({"role": "user", "content":
                    "Execution budget reached. Tools are now disabled. Write the final answer using only "
                    "evidence already collected. Include exact links and sources when present; clearly "
                    "mark partial, unverified, blocked or missing results. Do not request more tools or "
                    "invent information. If nothing was collected, say so."})
            checkpoint(step, tool_count)
            emit("model_start", step=step, max_steps=self.max_steps, finalizing=finalizing)
            if should_stop is not None and should_stop():
                return cancelled(step - 1, tool_count)
            try:
                message = self.client.chat(model=self.model, messages=deepcopy(messages),
                                           tools=[] if finalizing else schemas)
            except ProviderError:
                if should_stop is not None and should_stop():
                    return cancelled(step, tool_count)
                if not finalizing:
                    raise
                return finish(self._partial_result(messages, step, tool_count, limit_reason))
            emit("model_end", step=step)
            if should_stop is not None and should_stop():
                return cancelled(step, tool_count)
            if finalizing and (not isinstance(message, dict) or message.get("role") != "assistant"
                               or not isinstance(message.get("tool_calls", []), list)
                               or message.get("tool_calls") or not isinstance(message.get("content"), str)
                               or not message["content"].strip()):
                return finish(self._partial_result(messages, step, tool_count, limit_reason))
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
            if not calls:
                if not content.strip():
                    raise ProviderError("Ollama returned an empty final answer")
                messages.append(deepcopy(message))
                return finish(RunResult(content, messages, step, tool_count,
                                        "budget_summary" if finalizing else "completed", limit_reason))
            if step == self.max_steps:
                raise RunLimitError("Model step limit reached before a final answer; final batch was not executed")
            if tool_count + len(calls) > self.max_tool_calls:
                if finalize_on_limit:
                    limit_reason = "tool_calls"
                    continue
                raise RunLimitError("Tool call limit exceeded; batch was not executed")
            messages.append(deepcopy(message))
            for call in calls:
                fn = call["function"]
                if should_stop is not None and should_stop():
                    return cancelled(step, tool_count)
                emit("tool_start", name=fn["name"], tool_calls=tool_count)
                if should_stop is not None and should_stop():
                    return cancelled(step, tool_count)
                result = execute_tool(registry, fn["name"], fn["arguments"],
                                      max_result_chars=15900 if plan else 16000)
                if plan and fn['name'] != 'update_task_plan':
                    envelope = json.loads(result)
                    envelope['evidence_ref'] = plan.record_evidence(fn['name'], envelope)
                    result = json.dumps(envelope)
                tool_message = {"role": "tool", "tool_name": fn["name"], "content": result}
                if "id" in call:
                    tool_message["tool_call_id"] = call["id"]
                messages.append(tool_message)
                tool_count += 1
                checkpoint(step, tool_count)
                if plan and fn['name'] == 'update_task_plan':
                    emit('plan_update', plan=plan.snapshot())
                emit("tool_end", name=fn["name"], tool_calls=tool_count,
                     ok=json.loads(result).get("ok", False))
        raise RunLimitError("Model step limit reached")

    @staticmethod
    def _partial_result(messages, model_calls, tool_count, limit_reason):
        heading = ("Partial results: the provider request failed after tool execution; no final model summary is available."
                   if limit_reason == "provider_error" else
                   "Partial results: the execution budget was reached and the model did not provide a final summary.")
        lines = [heading,
                 "Only collected tool evidence is shown below; it may be incomplete or unverified."]
        collected = 0
        for message in messages:
            if message["role"] != "tool" or message.get("tool_name") == "update_task_plan":
                continue
            try:
                envelope = json.loads(message["content"])
            except (ValueError, TypeError):
                continue
            if not envelope.get("ok"):
                lines.append(f"{message.get('tool_name', 'Tool')}: tool returned an error.")
                continue
            result = envelope.get("result")
            if not isinstance(result, dict):
                lines.append(f"{message.get('tool_name', 'Tool')}: {json.dumps(result)[:1000]}")
                collected += 1
                continue
            records = result.get("jobs") or result.get("results") or [result]
            if not isinstance(records, list):
                records = [result]
            for record in records[:10]:
                if not isinstance(record, dict):
                    continue
                title = record.get("title") or record.get("company") or message.get("tool_name", "Page")
                source = record.get("source_url") or record.get("url") or result.get("url")
                state = record.get("apply_status") or record.get("verification") or record.get("status") or "unverified collected evidence"
                lines.append(f"\n{str(title)[:200]} — {str(state)[:100]}")
                if source:
                    lines.append(f"Source: {source}")
                if record.get("application_url"):
                    lines.append(f"Application destination: {record['application_url']}")
                application_links = record.get("application_links", [])
                if not isinstance(application_links, list):
                    application_links = []
                for url in application_links[:3]:
                    lines.append(f"Extracted application destination (unverified): {url}")
                if record.get("error"):
                    lines.append(str(record["error"])[:250])
                collected += 1
        if not collected:
            lines.append("No successful tool results were collected. Try a narrower task or increase the configured limits.")
        content = "\n".join(lines)
        if len(content) > 14000:
            content = content[:14000] + "\n[Partial summary truncated; the transcript retains the collected evidence.]"
        messages.append({"role": "assistant", "content": content})
        return RunResult(content, messages, model_calls, tool_count, "partial", limit_reason)
