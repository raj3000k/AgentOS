from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from agentos.storage import WorkspaceStore, profile_data
from agentos.web import make_server
from test_http_cli import server, response
import test_providers_web as helpers


def profile():
    return {'name':'Job Finder','purpose':'Find useful roles','instructions':'Use trusted research tools.',
            'capabilities':['web_research'],'model':'qwen3:8b','provider':'ollama',
            'starter_prompts':['Find entry-level roles.'], 'api_key':'never-store-this', 'file_directory':'/private/folder'}


@contextmanager
def workspace(path):
    httpd = make_server(0, storage_path=path)
    worker = threading.Thread(target=httpd.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_port}'
    finally:
        httpd.shutdown(); httpd.server_close(); worker.join()


class StorageTests(unittest.TestCase):
    def test_profile_survives_restart_updates_and_excludes_credentials_and_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.sqlite3'
            first = WorkspaceStore(path)
            saved = first.save_agent(profile())
            second = WorkspaceStore(path)
            data = second.get('agents', saved['id'])['data']
            self.assertNotIn('api_key', data)
            self.assertNotIn('file_directory', data)
            self.assertEqual(data['capabilities'], ['web_research'])
            second.save_agent({**profile(), 'name':'Updated'}, saved['id'])
            self.assertEqual(first.list('agents')[0]['name'], 'Updated')
            self.assertNotIn(b'never-store-this', path.read_bytes())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            second.delete('agents', saved['id'])
            self.assertEqual(first.list('agents'), [])

    def test_results_partial_and_error_records_reopen_without_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory) / 'workspace.sqlite3')
            result = {'content':'# Answer','messages':[{'role':'assistant','content':'# Answer'}],
                      'model_calls':2,'tool_calls':1,'finish_reason':'partial','limit_reason':'model_steps','api_key':'excluded'}
            run_id = store.save_run(profile(), 'Find jobs', result)
            record = store.get('runs', run_id)['data']
            self.assertEqual(record['result']['finish_reason'], 'partial')
            self.assertEqual(record['result']['content'], '# Answer')
            self.assertNotIn('api_key', record['result'])
            failed = store.save_run(profile(), 'Try again', error='Cannot reach provider')
            self.assertEqual(store.get('runs', failed)['status'], 'error')
            store.delete('runs', run_id)
            self.assertEqual(len(store.list('runs')), 1)

    def test_schema_version_and_future_schema_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.sqlite3'
            WorkspaceStore(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
                db.execute('PRAGMA user_version=2')
            with self.assertRaises(ValueError):
                WorkspaceStore(path)

    def test_validation_and_pagination(self):
        for invalid in ({**profile(),'capabilities':['shell']}, {**profile(),'base_url':'https://user:secret@example.com'},
                        {**profile(),'max_steps':True}, {**profile(),'provider':'unknown'}, None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                profile_data(invalid)
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory) / 'workspace.sqlite3')
            for index in range(52):
                store.save_run(profile(), f'Task {index}', error='Test failure')
            self.assertEqual(len(store.list('runs')), 50)
            self.assertEqual(len(store.list('runs', offset=50)), 2)
            for table, value in [('not-a-table','x'), ('runs', "' OR 1=1")]:
                with self.assertRaises(ValueError):
                    store.get(table, value)

    def test_http_save_opt_out_and_reopen_across_server_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.sqlite3'
            helper = helpers.WebTests()
            with workspace(path) as url, server([(200,response('First answer')),(200,response('Saved answer'))]) as (ollama, requests):
                token = helper.token(url)
                with helper.post(url, token, {'profile':profile()}, path='/api/agents/save') as output:
                    saved = json.load(output)['item']
                payload = {'provider':'ollama','model':'selected','base_url':ollama,'name':'Job Finder','prompt':'Find jobs','instructions':'Use evidence.'}
                with helper.post(url, token, payload):
                    pass
                self.assertEqual(WorkspaceStore(path).list('runs'), [])
                with helper.post(url, token, {**payload,'save_history':True}) as output:
                    run = json.load(output)
                run_id = run['history_id']
                self.assertEqual(len(requests), 2)
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(url + '/api/runs')
                self.assertEqual(caught.exception.code, 403)
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    helper.post(url, 'wrong-token', {'id':saved['id']}, path='/api/agents/delete')
                self.assertEqual(caught.exception.code, 403)
            with workspace(path) as url:
                token = helper.token(url)
                request = urllib.request.Request(url + '/api/runs/' + run_id, headers={'X-AgentOS-Token':token})
                with urllib.request.urlopen(request) as output:
                    record = json.load(output)['item']['data']
                self.assertEqual(record['result']['content'], 'Saved answer')
                with helper.post(url, token, {'id':run_id}, path='/api/runs/delete'):
                    pass
                self.assertEqual(WorkspaceStore(path).list('runs'), [])

    def test_history_write_failure_does_not_discard_answer(self):
        with tempfile.TemporaryDirectory() as directory, workspace(Path(directory)/'workspace.sqlite3') as url, server([(200,response('Keep this answer'))]) as (ollama, _):
            helper = helpers.WebTests()
            token = helper.token(url)
            with patch('agentos.storage.WorkspaceStore.save_run', side_effect=sqlite3.OperationalError('disk full')):
                with helper.post(url, token, {'provider':'ollama','model':'selected','base_url':ollama,'prompt':'Hi','save_history':True}) as output:
                    result = json.load(output)
            self.assertEqual(result['content'], 'Keep this answer')
            self.assertIn('history_error', result)
