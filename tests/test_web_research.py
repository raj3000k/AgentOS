import json
import socket
import unittest
from unittest.mock import Mock, patch

from agentos import Agent
from agentos.context import generate_context
from agentos.errors import ToolError
from agentos.web_research import FetchError, WebResearch, apply_target, public_url, _download, MAX_BYTES
from test_http_cli import server, response
import test_providers_web as helpers

SEARCH = '''<ul><li><div class="base-search-card job-search-card"><a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/sde-i-at-example-12345?tracking=x"><span>SDE I</span></a><h3 class="base-search-card__title">SDE I</h3><h4 class="base-search-card__subtitle">Example &amp; Co</h4><span class="job-search-card__location">Bengaluru, India</span></div></li></ul>'''
JOB = '''<html><h1 class="topcard__title">SDE I</h1><a class="topcard__org-name-link">Example</a><span class="topcard__flavor--bullet">Bengaluru</span><div class="show-more-less-html__markup">0–2 years. Backend development.</div>{apply}</html>'''
EXTERNAL = '<a class="apply-button" href="https://www.linkedin.com/jobs/view/externalApply/?url=https%3A%2F%2Fcareers.example.com%2Fjobs%2F12345">Apply</a>'


def downloaded(html, status=200, headers=None):
    return status, headers or {"content-type": "text/html; charset=utf-8"}, html.encode()


class WebResearchTests(unittest.TestCase):
    def test_search_parses_candidates_deduplicates_and_builds_query(self):
        with patch("agentos.web_research._download", return_value=downloaded("<div class></div>" + SEARCH + SEARCH)) as download:
            result = WebResearch().search_linkedin_jobs("SDE 1", "Bengaluru")
        self.assertEqual(len(result["jobs"]), 1)
        self.assertEqual(result["jobs"][0]["company"], "Example & Co")
        self.assertEqual(result["jobs"][0]["source_url"], "https://www.linkedin.com/jobs/view/12345/")
        self.assertIn("keywords=SDE+1", download.call_args.args[0])
        self.assertEqual(result["jobs"][0]["verification"], "search_candidate")

    def test_inspect_extracts_exact_external_link(self):
        with patch("agentos.web_research._download", return_value=downloaded(JOB.format(apply=EXTERNAL))):
            result = WebResearch().inspect_linkedin_job("https://in.linkedin.com/jobs/view/sde-i-at-example-12345")
        self.assertEqual(result["application_url"], "https://careers.example.com/jobs/12345")
        self.assertEqual(result["apply_status"], "external_link_found")
        self.assertIn("0–2 years", result["description"])
        self.assertEqual(result["verification"], "posting_read_not_confirmed_open")
        self.assertIn("checked_at", result)

    def test_hidden_and_easy_apply_are_distinct(self):
        cases = [("", "not_exposed", None),
                 ('<button data-modal="job-details-topcard-apply-modal">Apply</button>', "login_required", None),
                 ('<button>Easy Apply</button>', "linkedin_easy_apply", "https://www.linkedin.com/jobs/view/12345/")]
        for apply, expected, target in cases:
            with self.subTest(expected=expected), patch("agentos.web_research._download", return_value=downloaded(JOB.format(apply=apply))):
                result = WebResearch().inspect_linkedin_job("https://www.linkedin.com/jobs/view/12345/")
            self.assertEqual(result["apply_status"], expected)
            self.assertEqual(result["application_url"], target)

    def test_closed_posting_does_not_offer_apply_link(self):
        with patch("agentos.web_research._download", return_value=downloaded(JOB.format(apply=EXTERNAL) + "No longer accepting applications")):
            result = WebResearch().inspect_linkedin_job("https://www.linkedin.com/jobs/view/12345/")
        self.assertEqual(result["verification"], "closed")
        self.assertIsNone(result["application_url"])

    def test_blocked_page_never_fabricates_link(self):
        for status in (403, 429, 999, 404):
            with self.subTest(status=status), patch("agentos.web_research._download", return_value=downloaded("", status)):
                result = WebResearch().inspect_linkedin_job("https://www.linkedin.com/jobs/view/12345/")
            self.assertIsNone(result["application_url"])
            self.assertEqual(result["apply_status"], "unavailable")

    def test_read_company_page_strips_scripts_and_extracts_relative_apply(self):
        html = '<title>SDE I</title><script>secret script</script><style>hidden CSS</style><p>Hiring SDE I in Bengaluru.</p><a href="/apply/123">Apply for this job</a>'
        with patch("agentos.web_research._download", return_value=downloaded(html)):
            result = WebResearch().read_web_page("https://careers.example.com/jobs/123")
        self.assertNotIn("secret script", result["text"])
        self.assertNotIn("hidden CSS", result["text"])
        self.assertEqual(result["application_links"], ["https://careers.example.com/apply/123"])

    def test_unicode_output_fits_tool_envelope(self):
        with patch("agentos.web_research._download", return_value=downloaded('<title>Job</title><p>' + '職' * 12000 + '</p>')):
            result = WebResearch().read_web_page("https://example.com")
        self.assertLessEqual(len(json.dumps(result)), 14000)
        self.assertTrue(result["text_truncated"])

    def test_search_web_rss_and_parser_failure(self):
        rss = '<rss><channel><item><title>Example SDE I</title><link>https://careers.example.com/jobs/123</link><description>Hiring in Bengaluru</description></item></channel></rss>'
        with patch("agentos.web_research._download", return_value=downloaded(rss, headers={"content-type": "application/rss+xml"})):
            result = WebResearch().search_web('Example "SDE I" Bengaluru')
        self.assertEqual(result["results"][0]["url"], "https://careers.example.com/jobs/123")
        with patch("agentos.web_research._download", return_value=downloaded('<html>Challenge</html>')):
            self.assertEqual(WebResearch().search_web("jobs")["results"], [])

    def test_invalid_urls_and_inputs_cannot_fetch(self):
        urls = ["http://example.com", "file:///tmp/a", "https://127.0.0.1", "https://[::1]",
                "https://localhost", "https://example.local", "https://user:key@example.com",
                "https://example.com:444", "https://169.254.169.254", "https://example.com/\nheader"]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(FetchError):
                public_url(url)
        with patch("agentos.web_research._download") as download:
            self.assertEqual(WebResearch().inspect_linkedin_job("https://evil.example/jobs/view/12345/")["status"], "error")
            self.assertEqual(WebResearch().search_linkedin_jobs("SDE", "Bengaluru", limit=100)["status"], "error")
            self.assertEqual(WebResearch().read_web_page("https://127.0.0.1")["status"], "error")
            download.assert_not_called()
        self.assertEqual(apply_target("javascript:alert(1)", "https://example.com"), "")
        self.assertEqual(apply_target("", "https://example.com"), "")

    def test_private_dns_is_rejected_before_connection(self):
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch("socket.getaddrinfo", return_value=addresses), patch("http.client.HTTPSConnection") as connection:
            with self.assertRaises(FetchError):
                _download("https://example.com")
            connection.assert_not_called()

    def test_pinned_dns_preserves_hostname_and_get(self):
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]
        response = Mock(status=200)
        response.getheaders.return_value = [("Content-Type", "text/html")]
        response.read.return_value = b"ok"
        connection = Mock()
        connection.getresponse.return_value = response
        with patch("socket.getaddrinfo", return_value=addresses), patch("http.client.HTTPSConnection", return_value=connection) as constructor:
            self.assertEqual(_download("https://example.com/jobs")[0], 200)
        self.assertEqual(constructor.call_args.args[0], "example.com")
        self.assertEqual(connection.request.call_args.args[:2], ("GET", "/jobs"))
        with patch("socket.create_connection") as connect:
            connection._create_connection(("example.com", 443), 12)
            self.assertEqual(connect.call_args.args[0], ("93.184.215.14", 443))

    def test_size_redirect_and_request_budgets(self):
        response = Mock(status=200)
        response.getheaders.return_value = []
        response.read.return_value = b"x" * (MAX_BYTES + 1)
        connection = Mock()
        connection.getresponse.return_value = response
        with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]), patch("http.client.HTTPSConnection", return_value=connection):
            with self.assertRaises(FetchError):
                _download("https://example.com")
        with patch("agentos.web_research._download", return_value=(302, {"location": "https://127.0.0.1/"}, b"")) as download:
            result = WebResearch().read_web_page("https://example.com")
            self.assertEqual(result["status"], "error")
            self.assertEqual(download.call_count, 1)
        with patch("agentos.web_research._download", return_value=downloaded("<p>ok</p>")) as download:
            research = WebResearch(max_requests=1)
            self.assertEqual(research.read_web_page("https://example.com")["status"], "read")
            self.assertEqual(research.read_web_page("https://example.com")["status"], "error")
            self.assertEqual(download.call_count, 1)

    def test_registered_tools_reject_invalid_scalar_inputs(self):
        tools = {entry.name: entry for entry in WebResearch().tools}
        with self.assertRaises(ToolError):
            tools["search_linkedin_jobs"].invoke({"keywords": "SDE", "location": "Bengaluru", "limit": True})

    def test_web_capability_registration_and_tool_execution_end_to_end(self):
        calls = [{"function": {"name": "inspect_linkedin_job", "arguments": {"url": "https://www.linkedin.com/jobs/view/12345/"}}}]
        with helpers.workspace() as url, server([(200, response("", calls)), (200, response("Found the exact apply URL."))]) as (ollama, requests):
            helper = helpers.WebTests()
            token = helper.token(url)
            with patch("agentos.web_research._download", return_value=downloaded(JOB.format(apply=EXTERNAL))):
                with helper.post(url, token, {"provider": "ollama", "model": "selected", "base_url": ollama,
                                 "web_research": True, "calculator": False, "prompt": "Find exact apply link"}) as output:
                    result = json.load(output)
            schemas = {entry["function"]["name"] for entry in requests[0][1]["tools"]}
            self.assertEqual(schemas, {"search_linkedin_jobs", "inspect_linkedin_job", "search_web", "read_web_page"})
            evidence = json.loads(result["messages"][-2]["content"])["result"]
            self.assertEqual(evidence["application_url"], "https://careers.example.com/jobs/12345")
            self.assertEqual(result["tool_calls"], 1)

    def test_disabled_web_tools_cannot_execute(self):
        call = {"function": {"name": "read_web_page", "arguments": {"url": "https://example.com"}}}
        client = Mock()
        client.chat.side_effect = [{"role": "assistant", "tool_calls": [call]}, {"role": "assistant", "content": "Unavailable"}]
        with patch("agentos.web_research._download") as download:
            result = Agent(client=client).run("Read a page")
            download.assert_not_called()
        self.assertIn("Unknown tool", result.messages[-2]["content"])

    def test_context_prompt_receives_enabled_capabilities_without_executing(self):
        client = Mock()
        client.chat.return_value = {"role": "assistant", "content": json.dumps({"name": "Researcher", "purpose": "Find jobs", "instructions": "Use available tools", "starter_prompts": ["Find SDE I jobs"], "assumptions": []})}
        generate_context(client, "model", "Find jobs", web_research=True, calculator=False)
        args = client.chat.call_args.kwargs
        self.assertEqual(args["tools"], [])
        self.assertIn("search_linkedin_jobs", args["messages"][0]["content"])
        self.assertIn("Calculator is disabled", args["messages"][0]["content"])


    def test_web_budget_returns_partial_application_evidence_instead_of_502(self):
        calls = [{"function": {"name": "inspect_linkedin_job", "arguments": {"url": "https://www.linkedin.com/jobs/view/12345/"}}}]
        with helpers.workspace() as url, server([(200, response("", calls)), (200, response("", calls))]) as (ollama, requests):
            helper = helpers.WebTests()
            token = helper.token(url)
            with patch("agentos.web_research._download", return_value=downloaded(JOB.format(apply=EXTERNAL))) as download:
                with helper.post(url, token, {"provider": "ollama", "model": "selected", "base_url": ollama,
                                 "max_steps": 2, "web_research": True, "prompt": "Find exact apply link"}) as output:
                    result = json.load(output)
            self.assertEqual(result["finish_reason"], "partial")
            self.assertEqual(result["model_calls"], 2)
            self.assertEqual(download.call_count, 1)
            self.assertIn("https://careers.example.com/jobs/12345", result["content"])
            self.assertEqual(requests[-1][1]["tools"], [])
