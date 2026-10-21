"""Private subprocess entry point. Only the fixed capability registry can execute."""
from contextlib import redirect_stdout
from dataclasses import asdict, replace
import json
import sys

from .agent import Agent
from .capabilities import build_capabilities
from .errors import AgentOSError, ProviderError
from .conversation import append_turn
from .providers import create_client


def main():
    channel = sys.stdout

    def send(message):
        channel.write(json.dumps(message, allow_nan=False) + '\n')
        channel.flush()

    latest = None

    def checkpoint(state):
        nonlocal latest
        latest = state
        send({'type': 'checkpoint', 'data': state})

    try:
        config = json.loads(sys.stdin.read(524289))
        # Tool/library prints cannot corrupt the private result protocol.
        with redirect_stdout(sys.stderr):
            client = create_client(
                config['provider'], api_key=config['api_key'], base_url=config['base_url'], timeout=config['timeout'])
            tools, context = build_capabilities(config['capabilities'], directory=config['file_directory'],
                                                linkedin_endpoint=config.get('linkedin_endpoint', ''),
                                                linkedin_secret=config.get('linkedin_secret', ''))
            agent = Agent(name=config['name'], model=config['model'], client=client,
                          instructions=config['instructions'] + ('\n\nActual enabled capabilities for this run:\n' + context if context else ''),
                          tools=tools, max_steps=config['max_steps'], max_tool_calls=config['max_tool_calls'],
                          finalize_on_limit=bool(tools))
            result = agent.run(config['prompt'], history=config['history'], plan_task=config.get('plan_task', False),
                               on_event=lambda event: send({'type': 'event', 'data': event}),
                               on_checkpoint=checkpoint)
            send({'type': 'result', 'data': asdict(result)})
    except ProviderError as provider_error:
        if latest and any(message.get('role') == 'tool' and message.get('tool_name') != 'update_task_plan'
                          for message in latest['messages']):
            result = Agent._partial_result(latest['messages'], latest['model_calls'], latest['tool_calls'], 'provider_error')
            result = replace(result, plan=latest.get('plan'))
            try:
                result = replace(result, conversation=append_turn(config['history'], config['prompt'], result))
            except ValueError as exc:
                result = replace(result, context_error=str(exc))
            send({'type': 'result', 'data': asdict(result)})
        else:
            send({'type': 'error', 'error': str(provider_error)})
    except AgentOSError as exc:
        send({'type': 'error', 'error': str(exc)})
    except Exception:
        send({'type': 'error', 'error': 'Isolated run failed. Check configuration and optional tool setup.'})


if __name__ == '__main__':
    main()
