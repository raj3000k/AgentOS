import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from agentos.capabilities import build_capabilities, catalog, validate_selection
from agentos.context import generate_context
from agentos.errors import ProviderError, ToolError
from agentos.local_tools import FileReader, analyze_csv, extract_text_patterns, inspect_json
from agentos.job_boards import JobBoards
from agentos.browser_reader import BrowserReader
from test_context import brief
from test_http_cli import server, response
import test_providers_web as web_helpers


def public_response(payload):
    return 200, {'content-type': 'application/json'}, json.dumps(payload).encode()


class CapabilityTests(unittest.TestCase):
    def test_fixed_catalog_and_unknown_ids(self):
        with patch('agentos.browser_reader.browser_available', return_value=False):
            entries = catalog()
        self.assertEqual(len(entries), 10)
        self.assertFalse(next(entry for entry in entries if entry['id'] == 'browser_reading')['available'])
        for values in (["shell"], ["../../tools"], "web_research", [42]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_selection(values)
        tools, instructions = build_capabilities(['writing', 'code_review'])
        self.assertEqual(tools, [])
        self.assertIn('No email sending', instructions)

    def test_auto_recommendations_are_validated_data_only(self):
        draft = {**brief(), 'capabilities': ['web_research', 'job_boards'],
                 'capability_reasons': {'web_research': 'Find sources', 'job_boards': 'Exact apply destinations'}}
        client = Mock()
        client.chat.return_value = {'role': 'assistant', 'content': json.dumps(draft)}
        with patch('agentos.browser_reader.browser_available', return_value=False):
            result = generate_context(client, 'chosen', 'Find SDE I jobs', auto_select=True)
        self.assertEqual(result['capabilities'], ['web_research', 'job_boards'])
        self.assertEqual(client.chat.call_args.kwargs['tools'], [])
        self.assertIn('Registered capability catalog', client.chat.call_args.kwargs['messages'][0]['content'])

    def test_auto_rejects_unknown_unavailable_or_unexplained_recommendations(self):
        cases = [(['shell'], {'shell': 'Run commands'}), (['browser_reading'], {'browser_reading': 'Browse'}),
                 (['file_reading'], {}), (['writing'], {'writing': 42})]
        for selected, reasons in cases:
            client = Mock()
            client.chat.return_value = {'role': 'assistant', 'content': json.dumps({**brief(), 'capabilities': selected, 'capability_reasons': reasons})}
            with self.subTest(selected=selected), patch('agentos.browser_reader.browser_available', return_value=False), self.assertRaises(ProviderError):
                generate_context(client, 'chosen', 'Task', auto_select=True)

    def test_file_tools_require_a_folder_and_prevent_traversal_hidden_and_symlinks(self):
        with self.assertRaises(ValueError):
            build_capabilities(['file_reading'])
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            root = Path(folder)
            (root / 'notes.md').write_text('Hello notes')
            (root / '.env').write_text('secret')
            (root / 'credentials.json').write_text('{}')
            (root / 'linked.md').symlink_to(Path(outside) / 'notes.md')
            reader = FileReader(folder)
            self.assertEqual(reader.read_text_file('notes.md')['text'], 'Hello notes')
            self.assertNotIn('.env', [entry['path'] for entry in reader.list_files()['entries']])
            for path in ('../outside.txt', '.env', 'linked.md', 'credentials.json', '/etc/passwd'):
                with self.subTest(path=path), self.assertRaises((ValueError, FileNotFoundError)):
                    reader.read_text_file(path)

    def test_csv_statistics_and_invalid_numeric_values(self):
        result = analyze_csv.invoke({'text': 'name,amount\na,10\nb,20\nc,bad\nd,\n', 'numeric_column': 'amount'})
        self.assertEqual(result['row_count'], 4)
        self.assertEqual(result['numeric']['mean'], 15)
        self.assertEqual(result['numeric']['invalid'], 1)
        self.assertEqual(result['missing']['amount'], 1)
        with self.assertRaises(ToolError):
            analyze_csv.invoke({'text': 'a,a\n1,2'})

    def test_pattern_extraction_and_json_do_not_execute(self):
        result = extract_text_patterns.invoke({'text': 'https://example.com/job https://example.com/job user@example.com', 'kind': 'urls'})
        self.assertEqual(result['matches'], ['https://example.com/job'])
        self.assertEqual(inspect_json.invoke({'text': '{"role":"SDE I"}'})['keys'], ['role'])
        with self.assertRaises(ToolError):
            inspect_json.invoke({'text': '__import__("os").system("bad")'})

    def test_public_company_feed_returns_exact_employer_links(self):
        lever = [{'id': 'abc-123', 'text': 'Software Engineer I', 'categories': {'location': 'Bengaluru'},
                  'hostedUrl': 'https://jobs.lever.co/example/abc-123', 'applyUrl': 'https://jobs.lever.co/example/abc-123/apply', 'descriptionPlain': '0–2 years'}]
        with patch('agentos.web_research._download', return_value=public_response(lever)) as download:
            result = JobBoards().search_company_jobs('lever', 'example', 'Engineer', 'Bengaluru')
        self.assertEqual(result['jobs'][0]['application_url'], lever[0]['applyUrl'])
        self.assertEqual(result['jobs'][0]['verification'], 'published_in_employer_feed')
        self.assertIn('api.lever.co/v0/postings/example', download.call_args.args[0])
        with patch('agentos.web_research._download', return_value=public_response(lever[0])):
            specific = JobBoards().inspect_company_job(lever[0]['hostedUrl'])
        self.assertEqual(specific['application_url'], lever[0]['applyUrl'])

    def test_greenhouse_missing_and_malicious_urls(self):
        feed = {'jobs': [{'id': 12, 'title': 'Engineer', 'location': {'name': 'Bengaluru'}, 'absolute_url': 'https://job-boards.greenhouse.io/example/jobs/12'},
                         {'id': 13, 'title': 'Engineer', 'location': {'name': 'Bengaluru'}, 'absolute_url': 'https://127.0.0.1/private'}]}
        with patch('agentos.web_research._download', return_value=public_response(feed)):
            result = JobBoards().search_company_jobs('greenhouse', 'example')
        self.assertEqual(len(result['jobs']), 1)
        self.assertEqual(result['jobs'][0]['job_id'], '12')
        with patch('agentos.web_research._download') as download:
            self.assertEqual(JobBoards().inspect_company_job('https://evil.example/jobs/12')['status'], 'error')
            self.assertEqual(JobBoards().search_company_jobs('lever', '../../etc')['status'], 'error')
            download.assert_not_called()

    def test_optional_browser_setup_and_bounded_rendered_evidence(self):
        with patch('agentos.browser_reader.browser_available', return_value=False):
            result = BrowserReader().read_browser_page('https://example.com')
            self.assertEqual(result['status'], 'setup_required')
            with self.assertRaises(ValueError):
                build_capabilities(['browser_reading'])
        reader = BrowserReader()
        with patch.object(reader, '_page', return_value={'status': 'read', 'url': 'https://example.com/jobs/12', 'html': '<title>Engineer</title><a href="/apply/12">Apply</a>', 'rendered': True}):
            result = reader.read_browser_page('https://example.com/jobs/12')
        self.assertEqual(result['application_links'], ['https://example.com/apply/12'])

    def test_api_auto_draft_then_explicit_application_registers_tools(self):
        draft = {**brief(), 'capabilities': ['data_analysis', 'structured_extraction'],
                 'capability_reasons': {'data_analysis': 'Analyze CSV', 'structured_extraction': 'Return structured output'}}
        responses = [(200, response(json.dumps(draft))), (200, response('Ready'))]
        with web_helpers.workspace() as url, server(responses) as (ollama, requests), patch('agentos.browser_reader.browser_available', return_value=False):
            helper = web_helpers.WebTests()
            token = helper.token(url)
            connection = {'provider': 'ollama', 'model': 'chosen', 'base_url': ollama}
            with helper.post(url, token, {**connection, 'description': 'Analyze CSV and extract URLs', 'auto_capabilities': True}, path='/api/context') as output:
                result = json.load(output)
            self.assertEqual(result['selected_capabilities'], draft['capabilities'])
            with helper.post(url, token, {**connection, 'prompt': 'Hello', 'capabilities': result['selected_capabilities']}) as output:
                self.assertEqual(json.load(output)['content'], 'Ready')
            schemas = {entry['function']['name'] for entry in requests[-1][1]['tools']}
            self.assertEqual(schemas, {'analyze_csv', 'extract_text_patterns', 'inspect_json'})
            self.assertEqual(requests[0][1]['tools'], [])

    def test_browser_resource_gate_blocks_post_private_and_cookie_forwarding(self):
        from agentos.browser_reader import BrowserReader
        context = Mock()
        page = Mock()
        page.url = 'https://example.com'
        page.content.return_value = '<title>Rendered job</title><a href="/apply/12">Apply</a>'
        page.goto.return_value = Mock(status=200)
        context.new_page.return_value = page
        browser = Mock()
        browser.new_context.return_value = context
        runtime = Mock()
        runtime.chromium.launch.return_value = browser
        manager = Mock()
        manager.__enter__ = Mock(return_value=runtime)
        manager.__exit__ = Mock(return_value=False)
        routes = []
        def navigate(*args, **kwargs):
            callback = context.route.call_args.args[1]
            for method, url in [('GET', 'https://example.com'), ('POST', 'https://example.com/apply'), ('GET', 'https://127.0.0.1/private')]:
                route = Mock()
                route.request.method = method
                route.request.url = url
                route.request.resource_type = 'document'
                callback(route)
                routes.append(route)
            return Mock(status=200)
        page.goto.side_effect = navigate
        with patch('agentos.browser_reader.browser_available', return_value=True), patch('agentos.browser_reader.sync_playwright', return_value=manager), patch('agentos.browser_reader._download', return_value=(200, {'content-type':'text/html', 'set-cookie':'secret'}, b'<p>Job</p>')) as download:
            result = BrowserReader().read_browser_page('https://example.com')
        self.assertEqual(download.call_count, 1)
        self.assertNotIn('set-cookie', routes[0].fulfill.call_args.kwargs['headers'])
        routes[1].abort.assert_called_once()
        routes[2].abort.assert_called_once()
        self.assertTrue(result['rendered'])
        self.assertEqual(result['application_links'], ['https://example.com/apply/12'])


    def test_job_recipe_adds_available_fallbacks_but_manual_selection_is_unchanged(self):
        from agentos.capabilities import add_research_fallbacks
        available = {entry['id']: {**entry, 'available': True} for entry in catalog()}
        selected, reasons = add_research_fallbacks(['web_research'], {'web_research':'Find jobs'}, 'Find LinkedIn job openings', available)
        self.assertEqual(selected, ['web_research', 'job_boards', 'browser_reading'])
        self.assertIn('Research fallback', reasons['job_boards'])
        self.assertEqual(build_capabilities(['web_research'])[0][0].name, 'search_linkedin_jobs')
        available['browser_reading']['available'] = False
        selected, _ = add_research_fallbacks(['web_research'], {'web_research':'Find jobs'}, 'Find LinkedIn jobs', available)
        self.assertNotIn('browser_reading', selected)
