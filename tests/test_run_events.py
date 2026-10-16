"""Offline lifecycle, cooperative cancellation, and real loopback streaming checks."""
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from unittest.mock import patch

from agentos import Agent, ProviderError, tool
from agentos.storage import WorkspaceStore
from agentos.web import make_server
from test_agent import FakeClient, assistant, call, double


@contextmanager
def workspace(path):
    server = make_server(0, request_token='x' * 32, storage_path=path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def post(url, path, data, token='x' * 32):
    request = urllib.request.Request(url + path, data=json.dumps(data).encode(), headers={
        'Content-Type': 'application/json', 'X-AgentOS-Token': token})
    return urllib.request.urlopen(request, timeout=5)


class RunEventTests(unittest.TestCase):
    def test_event_order_and_no_arguments_or_content_in_activity(self):
        events = []
        result = Agent(tools=[double], client=FakeClient(assistant(calls=[call()]), assistant('Answer'))).run(
            'Private prompt', on_event=events.append)
        self.assertEqual(result.finish_reason, 'completed')
        self.assertEqual([e['type'] for e in events], ['model_start', 'model_end', 'tool_start', 'tool_end', 'model_start', 'model_end'])
        self.assertEqual(events[3], {'type':'tool_end', 'name':'double', 'tool_calls':1, 'ok':True})
        self.assertNotIn('Private prompt', json.dumps(events))
        self.assertNotIn('arguments', json.dumps(events))

    def test_stop_before_model_does_no_work(self):
        client = FakeClient()
        result = Agent(client=client).run('Hi', should_stop=lambda: True)
        self.assertEqual((result.finish_reason, result.model_calls, result.tool_calls), ('cancelled',0,0))
        self.assertEqual(client.requests, [])

    def test_stop_after_model_prevents_entire_tool_batch(self):
        stop = threading.Event()
        def event(item):
            if item['type'] == 'model_end':
                stop.set()
        result = Agent(tools=[double], client=FakeClient(assistant(calls=[call(), call()]))).run(
            'Hi', on_event=event, should_stop=stop.is_set)
        self.assertEqual((result.finish_reason, result.model_calls, result.tool_calls), ('cancelled',1,0))

    def test_stop_during_tool_keeps_result_and_skips_rest_of_batch(self):
        stop = threading.Event()
        executed = []
        @tool
        def record():
            executed.append(True)
            stop.set()
            return 'collected evidence'
        client = FakeClient(assistant(calls=[call('record', {}),call('record', {})]))
        result = Agent(tools=[record], client=client).run('Hi', should_stop=stop.is_set)
        self.assertEqual(executed, [True])
        self.assertEqual((result.finish_reason,result.model_calls,result.tool_calls), ('cancelled',1,1))
        self.assertIn('collected evidence', result.messages[-2]['content'])
        self.assertEqual(len(client.requests), 1)

    def test_stop_during_provider_failure_returns_cancelled(self):
        stop = threading.Event()
        class Client:
            def chat(self, **kwargs):
                stop.set()
                raise ProviderError('Timed out')
        result = Agent(client=Client()).run('Hi', should_stop=stop.is_set)
        self.assertEqual(result.finish_reason, 'cancelled')

    def test_stream_cancel_history_and_registry_cleanup(self):
        entered = threading.Event()
        release = threading.Event()
        class Client:
            def chat(self, **kwargs):
                entered.set()
                if not release.wait(4):
                    raise ProviderError('Test did not release request')
                return assistant(calls=[call()])
        with tempfile.TemporaryDirectory() as directory, workspace(Path(directory)/'workspace.sqlite3') as url:
            payload = {'provider':'ollama','model':'fake','prompt':'Hi','run_id':str(uuid.uuid4()),'save_history':True}
            with patch('agentos.web.create_client', return_value=Client()), post(url, '/api/run/stream', payload) as response:
                self.assertEqual(response.headers['Content-Type'], 'application/x-ndjson')
                self.assertEqual(json.loads(response.readline())['type'], 'started')
                self.assertTrue(entered.wait(2))
                try:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        post(url, '/api/run/stop', {'run_id':payload['run_id']}, token='bad')
                    self.assertEqual(caught.exception.code, 403)
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        post(url, '/api/run/stream', payload)
                    self.assertEqual(caught.exception.code, 409)
                    with post(url, '/api/run/stop', {'run_id':payload['run_id']}) as stopped:
                        self.assertTrue(json.load(stopped)['stopping'])
                finally:
                    release.set()
                events = [json.loads(line) for line in response]
                result = events[-1]['data']
                self.assertEqual(events[-1]['type'], 'result')
                self.assertEqual((result['finish_reason'],result['tool_calls']), ('cancelled',0))
                store = WorkspaceStore(Path(directory)/'workspace.sqlite3')
                self.assertEqual(store.get('runs',result['history_id'])['data']['result']['finish_reason'], 'cancelled')
            with post(url, '/api/run/stop', {'run_id':payload['run_id']}) as stopped:
                self.assertFalse(json.load(stopped)['stopping'])
            # Same ID can be reused after completion; provider errors travel inside the stream.
            with patch('agentos.web.create_client') as create:
                create.return_value.chat.side_effect = ProviderError('Provider unavailable')
                with post(url, '/api/run/stream', payload) as response:
                    events = [json.loads(line) for line in response]
                self.assertEqual(events[-1]['type'], 'error')
                self.assertEqual(events[-1]['data']['error'], 'Provider unavailable')

    def test_stream_validation_happens_before_headers(self):
        with tempfile.TemporaryDirectory() as directory, workspace(Path(directory)/'workspace.sqlite3') as url:
            with patch('agentos.web.create_client', return_value=FakeClient()):
                for override in ({'run_id':'bad'}, {'prompt':''}):
                    payload = {'provider':'ollama','model':'fake','prompt':'Hi','run_id':str(uuid.uuid4()), **override}
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        post(url, '/api/run/stream', payload)
                    self.assertEqual(caught.exception.code, 400)
