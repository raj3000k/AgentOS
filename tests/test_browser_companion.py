import io
import json
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from unittest.mock import Mock, patch

from agentos.web import make_server


class BrowserCompanionTests(unittest.TestCase):
    def test_extension_origin_allows_only_token_protected_runs_and_pairing(self):
        server = make_server(0, request_token='w'*32)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        extension = 'chrome-extension://'+'a'*32
        def request(path, origin, key='w'*32):
            payload = {'provider':'ollama','model':'fixture','prompt':'Summarize selected source text.',
                       'capabilities':[], 'run_id':'12345678-1234-4234-8234-123456789012'}
            req = urllib.request.Request(url+path, data=json.dumps(payload).encode(), headers={
                'Content-Type':'application/json','Origin':origin,'X-AgentOS-Token':key})
            return urllib.request.urlopen(req, timeout=3)
        try:
            client = Mock()
            client.chat.return_value = {'role':'assistant','content':'A source-grounded summary.'}
            with patch('agentos.web.create_client',return_value=client):
                with request('/api/run/stream', extension) as response:
                    events = [json.loads(line) for line in response.read().decode().splitlines()]
                self.assertEqual(events[-1]['data']['content'], 'A source-grounded summary.')
            with request('/api/linkedin/pair', extension) as response:
                self.assertGreaterEqual(len(json.load(response)['code']), 40)
            for path, origin, key in (('/api/agents/save',extension,'w'*32),
                                      ('/api/linkedin/pair',extension,'wrong'),
                                      ('/api/linkedin/pair','https://evil.test','w'*32),
                                      ('/api/linkedin/disconnect',extension,'w'*32),
                                      ('/api/run/stream','https://evil.test','w'*32),
                                      ('/api/run/stream','chrome-extension://invalid','w'*32),
                                      ('/api/run/stream',extension,'wrong')):
                with self.subTest(path=path,origin=origin), self.assertRaises(urllib.error.HTTPError) as error:
                    request(path,origin,key)
                self.assertEqual(error.exception.code,403)
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_browser_bundle_contains_complete_side_panel_and_safe_renderer(self):
        server = make_server(0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/browser-extension.zip') as response:
                with zipfile.ZipFile(io.BytesIO(response.read())) as bundle:
                    names=set(bundle.namelist())
                    self.assertEqual(len(names),9)
                    self.assertIn('agentos-browser-companion/sidepanel.html',names)
                    self.assertIn('agentos-browser-companion/companion.js',names)
                    manifest=json.loads(bundle.read('agentos-browser-companion/manifest.json'))
                    self.assertEqual(manifest['side_panel']['default_path'],'sidepanel.html')
                    self.assertIn('sidePanel',manifest['permissions'])
                    self.assertEqual(manifest['host_permissions'],['http://127.0.0.1:8765/*'])
        finally:
            server.shutdown();server.server_close();thread.join()
