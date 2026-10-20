import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from agentos.capabilities import build_capabilities
from agentos.linkedin_session import LinkedInBridge, LinkedInSession, job_navigation
from agentos.web import make_server


class LinkedInSessionTests(unittest.TestCase):
    def test_observed_linkedin_safety_apply_redirect_is_unwrapped(self):
        from agentos.web_research import apply_target
        source='https://www.linkedin.com/jobs/view/123/'
        self.assertEqual(apply_target('https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fexample.com%2Fjobs%2F123&urlhash=observed',source),'https://example.com/jobs/123')
        self.assertEqual(apply_target('https://www.linkedin.com/safety/go/?url=http%3A%2F%2F127.0.0.1%2Fprivate',source),'')

    def test_navigation_cannot_target_account_messages_or_external_hosts(self):
        for url in ('https://www.linkedin.com/jobs/view/123',
                    'https://www.linkedin.com/jobs/search/?keywords=SDE&location=Bengaluru&start=0'):
            self.assertEqual(job_navigation(url), url)
        for url in ('https://www.linkedin.com/messaging/', 'https://www.linkedin.com/feed/',
                    'http://www.linkedin.com/jobs/view/123', 'https://www.linkedin.com.evil.com/jobs/view/123',
                    'https://www.linkedin.com/jobs/view/123?redirect=https://evil.com',
                    'https://www.linkedin.com/jobs/search/?keywords=SDE&location=X&extra=Y',
                    'https://www.linkedin.com/jobs/search/?keywords=SDE&location=X&start=101', None):
            with self.subTest(url=url), self.assertRaises(ValueError):
                job_navigation(url)

    def test_explicit_pairing_at_most_once_delivery_disconnect_and_timeout(self):
        bridge = LinkedInBridge()
        self.assertEqual(bridge.read('https://www.linkedin.com/jobs/view/123')['status'], 'session_disconnected')
        secret = bridge.pair()
        self.assertTrue(bridge.authorized(secret))
        self.assertFalse(bridge.authorized('wrong'))
        bridge.poll()
        result = []
        thread = threading.Thread(target=lambda: result.append(bridge.read('https://www.linkedin.com/jobs/view/123')))
        thread.start()
        for _ in range(100):
            command = bridge.poll()
            if command:
                break
            time.sleep(.005)
        self.assertTrue(command)
        self.assertIsNone(bridge.poll())
        with self.assertRaises(ValueError):
            bridge.reply({'id': 'unknown'})
        bridge.reply({'id': command['id'], 'status': 'read', 'title': 'Software Engineer I'})
        thread.join(1)
        self.assertEqual(result[0]['title'], 'Software Engineer I')
        self.assertEqual(bridge.read('https://www.linkedin.com/jobs/view/123', timeout=.01)['status'], 'session_unavailable')
        self.assertIsNone(bridge.poll())
        new_secret = bridge.pair()
        self.assertNotEqual(secret, new_secret)
        self.assertFalse(bridge.authorized(secret))
        bridge.disconnect()
        self.assertFalse(bridge.authorized(new_secret))

    def test_valid_long_read_reply_refreshes_liveness_only_after_validation(self):
        bridge = LinkedInBridge()
        bridge.pair()
        bridge.last_seen = time.monotonic() - 20
        bridge.pending = {'id': 'current', 'expires_at': time.time() + 30}
        self.assertFalse(bridge.status()['connected'])
        with self.assertRaises(ValueError):
            bridge.reply({'id': 'wrong'})
        self.assertFalse(bridge.status()['connected'])
        bridge.pending['expires_at'] = time.time() - 1
        with self.assertRaises(ValueError):
            bridge.reply({'id': 'current'})
        self.assertFalse(bridge.status()['connected'])
        bridge.pending['expires_at'] = time.time() + 30
        bridge.reply({'id': 'current', 'status': 'read'})
        self.assertTrue(bridge.status()['connected'])

    def test_connected_data_is_bounded_reviewed_and_not_automatically_verified(self):
        page = {'status': 'read', 'title': 'Software Engineer I', 'company': 'Example', 'location': 'Bengaluru',
                'description': 'Required experience: 0-1 years. Build software.',
                'application_url': 'https://app.dover.com/apply/example/abc', 'easy_apply': False}
        bridge = LinkedInBridge()
        with patch.object(bridge, 'read', return_value=page):
            tools, context = build_capabilities(['linkedin_session'], linkedin_bridge=bridge)
            registry = {entry.name: entry for entry in tools}
            result = registry['inspect_linkedin_session_job'].function('https://www.linkedin.com/jobs/view/123')
            self.assertEqual(result['application_url'], page['application_url'])
            self.assertEqual(result['experience_requirements']['minimum_years'], 0)
            review = registry['review_job_results'].function()
            self.assertEqual(review['unique_jobs'], 1)
            self.assertEqual(review['counts']['uncertain'], 1)
            self.assertIn('No cookies', context)
            page['description'] = 'This job is closed'
            result = registry['inspect_linkedin_session_job'].function('https://www.linkedin.com/jobs/view/123')
            self.assertIsNone(result['application_url'])
        self.assertEqual(LinkedInSession()._read('https://www.linkedin.com/jobs/view/123')['status'], 'session_disconnected')

    def test_isolated_worker_uses_bridge_without_exposing_pairing_secret(self):
        from agentos.execution import run_isolated
        from test_execution import config
        from test_http_cli import server as provider, response
        bridge_server = make_server(0, request_token='w'*32)
        thread = threading.Thread(target=bridge_server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{bridge_server.server_port}'
        def api(path, data=None, code=None):
            headers = {'Content-Type':'application/json', 'X-AgentOS-Bridge' if code else 'X-AgentOS-Token':code or 'w'*32}
            req = urllib.request.Request(base+path, data=None if data is None else json.dumps(data).encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=3) as reply:
                return json.load(reply)
        code = api('/api/linkedin/pair', {})['code']
        api('/api/linkedin/poll', code=code)
        stop = threading.Event()
        def extension():
            while not stop.is_set():
                command = api('/api/linkedin/poll', code=code)['command']
                if command:
                    api('/api/linkedin/reply', {'id':command['id'], 'status':'read', 'title':'Software Engineer I',
                        'company':'Example', 'location':'Bengaluru', 'description':'Required experience: 0-1 years.',
                        'application_url':'https://jobs.lever.co/example/abc'}, code)
                stop.wait(.01)
        fake_extension = threading.Thread(target=extension, daemon=True)
        fake_extension.start()
        call = {'function':{'name':'inspect_linkedin_session_job','arguments':{'url':'https://www.linkedin.com/jobs/view/123/'}}}
        try:
            with provider([(200,response('',[call])), (200,response('Collected the posting.'))]) as (url, requests):
                result = run_isolated({**config(url), 'capabilities':['linkedin_session'],
                    'linkedin_endpoint':base+'/api/linkedin/read', 'linkedin_secret':code}, run_timeout=5)
                self.assertEqual(result.tool_calls, 1)
                self.assertEqual(result.content, 'Collected the posting.')
                self.assertIn('Software Engineer I', json.dumps(result.messages))
                self.assertNotIn(code, json.dumps(requests))
                self.assertNotIn(code, json.dumps(result.conversation))
        finally:
            stop.set(); fake_extension.join(2)
            bridge_server.shutdown(); bridge_server.server_close(); thread.join()

    def test_http_bridge_separate_credentials_and_worker_loopback_transport(self):
        server = make_server(0, request_token='w'*32)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def request(path, data=None, key='w'*32, header='X-AgentOS-Token'):
            req = urllib.request.Request(base+path, data=None if data is None else json.dumps(data).encode(),
                                         headers={header:key, 'Content-Type':'application/json'})
            with urllib.request.urlopen(req, timeout=4) as response:
                return json.load(response)
        try:
            code = request('/api/linkedin/pair', {})['code']
            with self.assertRaises(urllib.error.HTTPError):
                request('/api/linkedin/poll', key='w'*32, header='X-AgentOS-Bridge')
            request('/api/linkedin/poll', key=code, header='X-AgentOS-Bridge')
            self.assertTrue(request('/api/linkedin/status')['connected'])
            session = LinkedInSession(endpoint=base+'/api/linkedin/read', secret=code)
            result = []
            worker = threading.Thread(target=lambda: result.append(session.search_linkedin_session('SDE 1','Bengaluru')))
            worker.start()
            command = None
            for _ in range(100):
                command = request('/api/linkedin/poll', key=code, header='X-AgentOS-Bridge')['command']
                if command:
                    break
                time.sleep(.005)
            self.assertTrue(command)
            request('/api/linkedin/reply', {'id':command['id'],'status':'read','links':[
                {'text':'Software Engineer I','url':'https://www.linkedin.com/jobs/view/123'},
                {'text':'Duplicate','url':'https://www.linkedin.com/jobs/view/123'},
                {'text':'Ignore','url':'https://example.com/'}]}, key=code, header='X-AgentOS-Bridge')
            worker.join(2)
            self.assertEqual(len(result[0]['jobs']), 1)
            self.assertNotIn(code, json.dumps(result))
            with self.assertRaises(urllib.error.HTTPError):
                request('/api/linkedin/status', key=code, header='X-AgentOS-Bridge')
            request('/api/linkedin/disconnect', {})
            self.assertFalse(request('/api/linkedin/status')['connected'])
        finally:
            server.shutdown(); server.server_close(); thread.join()
