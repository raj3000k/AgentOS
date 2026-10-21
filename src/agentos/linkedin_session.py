"""Explicitly paired Chrome tab bridge; never imports browser cookies or credentials."""
from datetime import datetime, timezone
import json
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request

from .tools import tool
from .web_research import apply_target, bounded_result, linkedin_job_url


def job_navigation(url):
    """Only fixed LinkedIn job search/detail URLs may be sent to the chosen tab."""
    if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 33 for c in url):
        raise ValueError('Invalid LinkedIn navigation')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'www.linkedin.com' or parsed.fragment:
        raise ValueError('Only LinkedIn job pages are supported')
    if re.fullmatch(r'/jobs/view/\d+/?', parsed.path) and not parsed.query:
        return url
    query = urllib.parse.parse_qs(parsed.query)
    if (parsed.path == '/jobs/search/' and set(query) <= {'keywords', 'location', 'start'}
            and all(len(v) == 1 for v in query.values()) and query.get('keywords') and query.get('location')
            and len(query['keywords'][0]) <= 200 and len(query['location'][0]) <= 150
            and query.get('start', ['0'])[0].isdigit() and 0 <= int(query.get('start', ['0'])[0]) <= 100):
        return url
    raise ValueError('Only bounded job search/detail navigation is supported')


class LinkedInBridge:
    def __init__(self):
        self.lock = threading.Condition()
        self.secret = ''
        self.last_seen = 0
        self.pending = None
        self.result = None
        self.busy = False

    def pair(self):
        with self.lock:
            self.secret = secrets.token_urlsafe(32)
            self.last_seen = 0
            self.pending = None
            self.result = None
            self.lock.notify_all()
            return self.secret

    def disconnect(self):
        with self.lock:
            self.secret = ''
            self.last_seen = 0
            self.pending = None
            self.result = None
            self.lock.notify_all()

    def authorized(self, value):
        return bool(self.secret and isinstance(value, str) and secrets.compare_digest(self.secret, value))

    def status(self):
        with self.lock:
            return {'connected': bool(self.secret and time.monotonic() - self.last_seen < 10),
                    'paired': bool(self.secret)}

    def heartbeat(self):
        with self.lock:
            self.last_seen = time.monotonic()

    def poll(self):
        with self.lock:
            self.last_seen = time.monotonic()
            if self.pending and self.pending['expires_at'] > time.time():
                command = dict(self.pending)
                # Commands are delivered at most once. Never repeat a navigation on a retry.
                if not self.pending.get('delivered'):
                    self.pending['delivered'] = True
                    return command
            return None

    def reply(self, data):
        with self.lock:
            if (not self.pending or self.pending['id'] != data.get('id')
                    or self.pending['expires_at'] <= time.time()):
                raise ValueError('Expired or unknown browser command')
            # A completed long read is also a fresh authenticated heartbeat.
            self.last_seen = time.monotonic()
            self.result = data
            self.lock.notify_all()

    def read(self, url, timeout=30):
        job_navigation(url)
        with self.lock:
            if not self.status()['connected']:
                return {'status': 'session_disconnected', 'error': 'Connect the LinkedIn extension and keep its selected tab open and logged in.'}
            if self.busy:
                return {'status': 'session_busy', 'error': 'Another run is using the LinkedIn tab. Retry after it finishes.'}
            self.busy = True
            secret = self.secret
            command = {'id': secrets.token_urlsafe(16), 'url': url, 'expires_at': time.time() + timeout}
            self.pending = command
            self.result = None
            try:
                self.lock.wait_for(lambda: self.result is not None or self.secret != secret, timeout)
                result = self.result
                if result is None or self.secret != secret:
                    return {'status': 'session_unavailable', 'error': 'Tab disconnected or did not answer within 30 seconds.'}
                return result
            finally:
                self.pending = None
                self.result = None
                self.busy = False


class LinkedInSession:
    def __init__(self, bridge=None, endpoint='', secret=''):
        self.bridge, self.endpoint, self.secret = bridge, endpoint, secret
        self.tools = [tool(self.search_linkedin_session), tool(self.inspect_linkedin_session_job)]

    def _read(self, url):
        if self.bridge is not None:
            return self.bridge.read(url)
        parsed = urllib.parse.urlsplit(self.endpoint)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path != '/api/linkedin/read'
                or parsed.username or parsed.password or parsed.query or parsed.fragment or not self.secret):
            return {'status': 'session_disconnected', 'error': 'Connect LinkedIn in the AgentOS workspace first.'}
        request = urllib.request.Request(self.endpoint, data=json.dumps({'url': job_navigation(url)}).encode(),
                                         headers={'Content-Type': 'application/json', 'X-AgentOS-Bridge': self.secret})
        try:
            # Fixed loopback transport only; never inherit proxy settings or follow redirects.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=35) as response:
                raw = response.read(200001)
                if len(raw) > 200000:
                    raise ValueError('Oversize bridge response')
                return json.loads(raw)
        except (OSError, ValueError):
            return {'status': 'session_unavailable', 'error': 'LinkedIn connection unavailable. Reconnect in the workspace.'}

    def search_linkedin_session(self, keywords: str, location: str, limit: int = 5, start: int = 0) -> dict:
        """Search through the explicitly connected logged-in LinkedIn tab. Candidates only. limit 1–10, start 0–100. Never signs in or submits applications."""
        if not keywords.strip() or not location.strip() or len(keywords) > 200 or len(location) > 150 or not 1 <= limit <= 10 or not 0 <= start <= 100:
            return {'status': 'error', 'error': 'Provide bounded keywords/location, limit 1–10, start 0–100'}
        url = 'https://www.linkedin.com/jobs/search/?' + urllib.parse.urlencode({'keywords': keywords, 'location': location, 'start': start})
        page = self._read(url)
        if page.get('status') != 'read':
            return bounded_result(page)
        jobs, seen = [], set()
        for link in page.get('links', []):
            try:
                source, job_id = linkedin_job_url(link.get('url', ''))
            except ValueError:
                continue
            if job_id not in seen:
                seen.add(job_id)
                jobs.append({'job_id': job_id, 'title': str(link.get('text', ''))[:180], 'source_url': source,
                             'location': '', 'company': '', 'verification': 'search_candidate'})
        return bounded_result({'status': 'read' if jobs else 'no_results_or_inaccessible', 'url': url,
                               'checked_at': datetime.now(timezone.utc).isoformat(), 'jobs': jobs[:limit],
                               'note': 'Authenticated tab search candidates only. Inspect each posting; never infer company/location from query.'})

    def inspect_linkedin_session_job(self, url: str) -> dict:
        """Read a specific posting in the connected LinkedIn tab. Extract visible job details and exposed apply hrefs; never clicks Apply or fills/submits forms."""
        try:
            source, job_id = linkedin_job_url(url)
        except ValueError:
            return {'status': 'error', 'error': 'Provide a specific LinkedIn job URL'}
        page = self._read(source)
        if page.get('status') != 'read':
            return bounded_result({**page, 'source_url': source})
        from .job_quality import closure_reason, experience
        description = str(page.get('description', ''))[:20000]
        closed = bool(closure_reason(description))
        target = apply_target(str(page.get('application_url', '')), source)
        easy = page.get('easy_apply') is True
        return bounded_result({'status': 'read', 'source_url': source, 'url': source, 'job_id': job_id,
                               'checked_at': datetime.now(timezone.utc).isoformat(),
                               'title': str(page.get('title', ''))[:180], 'company': str(page.get('company', ''))[:120],
                               'location': str(page.get('location', ''))[:180], 'description': description[:6000],
                               'description_truncated': len(description) > 6000, 'description_status': 'complete' if description and page.get('description_status') != 'partial' else 'partial',
                               'experience_requirements': experience(description),
                               'application_url': None if closed else target or (source if easy else None),
                               'apply_status': 'closed' if closed else 'external_link_found' if target else 'linkedin_easy_apply' if easy else 'not_exposed',
                               'verification': 'closed' if closed else 'posting_read_not_confirmed_open',
                               'note': ('Visible authenticated-tab evidence; extracted application links still require destination verification. Session/cookies are never returned.'
                                        + (' Description is incomplete; missing role requirements and availability must not be inferred.' if not description or page.get('description_status') == 'partial' else ''))})
