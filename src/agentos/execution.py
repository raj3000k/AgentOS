"""Supervise a trusted worker process with a deadline and immediate stop.

This separates execution lifetime, not OS permissions. It is not a sandbox.
"""
from dataclasses import replace
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

from .agent import RunResult
from .conversation import append_turn, history_messages
from .errors import ProviderError

MAX_MESSAGE_BYTES = 8_000_000


def _start_worker():
    return subprocess.Popen([sys.executable, '-m', 'agentos.worker'], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            start_new_session=os.name == 'posix')


def _kill_worker(process):
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL)
        elif process.poll() is None:
            process.kill()
    except (ProcessLookupError, PermissionError):
        # macOS may reject killpg for an already exited/reaped group.
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
    process.wait(timeout=3)


def run_isolated(config, *, run_timeout=300, on_event=None, should_stop=None):
    """Config comes from validated application settings, never model-supplied code.

    The deadline includes worker startup/inference/tools. Progress checkpoints
    preserve only operations observed by the supervisor before interruption.
    """
    if type(run_timeout) not in (int, float) or not 0 < run_timeout <= 1800:
        raise ValueError('Run deadline must be positive and at most 1800 seconds')
    payload = json.dumps(config, allow_nan=False).encode()
    if len(payload) > 524288:
        raise ValueError('Worker configuration is too large')
    deadline = time.monotonic() + run_timeout
    state = {'messages': [{'role': 'system', 'content': config['instructions']}]
             + history_messages(config['history']) + [{'role': 'user', 'content': config['prompt']}],
             'model_calls': 0, 'tool_calls': 0}
    process = _start_worker()
    inbox = queue.Queue(maxsize=16)
    closing = threading.Event()
    forced_reason = []

    def enqueue(value):
        while not closing.is_set():
            try:
                inbox.put(value, timeout=.05)
                return
            except queue.Full:
                pass

    def read_messages():
        try:
            while not closing.is_set():
                line = process.stdout.readline(MAX_MESSAGE_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_MESSAGE_BYTES:
                    raise ValueError('Worker message too large')
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError('Invalid worker message')
                enqueue(message)
        except (ValueError, OSError):
            enqueue({'type': 'error', 'error': 'Invalid worker response'})
        finally:
            enqueue({'type': 'closed'})

    def write_config():
        try:
            process.stdin.write(payload)
            process.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    def supervise():
        # Enforce worker lifetime even if an observer/network response is blocked.
        while not closing.is_set():
            reason = 'user_stop' if should_stop is not None and should_stop() else (
                'run_timeout' if time.monotonic() >= deadline else None)
            if reason:
                forced_reason.append(reason)
                _kill_worker(process)
                return
            closing.wait(min(.05, max(.001, deadline - time.monotonic())))

    watchdog = threading.Thread(target=supervise, daemon=True)
    reader = threading.Thread(target=read_messages, daemon=True)
    writer = threading.Thread(target=write_config, daemon=True)
    reader.start()
    writer.start()
    watchdog.start()

    def interrupted(reason):
        content = ('Run stopped at your request.' if reason == 'user_stop' else 'Total run time limit reached.')
        content += (' The worker was terminated. Completed tool evidence received before interruption '
                    'is available below and in Inspect execution. The interrupted operation may have '
                    'performed work that was not reported; its result is not claimed as complete.')
        messages = [*state['messages'], {'role': 'assistant', 'content': content}]
        result = RunResult(content, messages, state['model_calls'], state['tool_calls'],
                           'cancelled' if reason == 'user_stop' else 'timed_out', reason)
        try:
            return replace(result, conversation=append_turn(config['history'], config['prompt'], result))
        except ValueError as exc:
            return replace(result, context_error=str(exc))

    try:
        while True:
            reason = forced_reason[0] if forced_reason else ('user_stop' if should_stop is not None and should_stop() else (
                'run_timeout' if time.monotonic() >= deadline else None))
            if reason:
                # Keep already delivered checkpoints; never wait for the blocked operation.
                for _ in range(16):
                    try:
                        message = inbox.get_nowait()
                    except queue.Empty:
                        break
                    if message.get('type') == 'checkpoint':
                        state = message['data']
                return interrupted(reason)
            try:
                message = inbox.get(timeout=min(.05, max(.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            kind = message.get('type')
            if kind == 'checkpoint':
                state = message['data']
            elif kind == 'event' and on_event is not None:
                on_event(message['data'])
            elif kind == 'result':
                if forced_reason or time.monotonic() >= deadline:
                    return interrupted(forced_reason[0] if forced_reason else 'run_timeout')
                return RunResult(**message['data'])
            elif kind in ('error', 'closed'):
                if forced_reason:
                    return interrupted(forced_reason[0])
                raise ProviderError(message.get('error', 'Worker exited before a final result'))
    finally:
        closing.set()
        _kill_worker(process)
        watchdog.join(timeout=3)
        reader.join(timeout=3)
        writer.join(timeout=3)
        process.stdout.close()
