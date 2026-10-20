"""Private subprocess entry point. Only the fixed capability registry can execute."""
from contextlib import redirect_stdout
from dataclasses import asdict
import json
import sys

from .agent import Agent
from .capabilities import build_capabilities
from .errors import AgentOSError
from .providers import create_client


def main():
    channel = sys.stdout

    def send(message):
        channel.write(json.dumps(message, allow_nan=False) + '\n')
        channel.flush()

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
                               on_checkpoint=lambda state: send({'type': 'checkpoint', 'data': state}))
            send({'type': 'result', 'data': asdict(result)})
    except AgentOSError as exc:
        send({'type': 'error', 'error': str(exc)})
    except Exception:
        send({'type': 'error', 'error': 'Isolated run failed. Check configuration and optional tool setup.'})


if __name__ == '__main__':
    main()
