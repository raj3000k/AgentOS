"""Optional clean-browser rendering with pinned, public GET-only network transport."""
from functools import lru_cache
from pathlib import Path
import time
import urllib.parse

from .tools import tool
from .web_research import WebResearch, public_url, _download

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@lru_cache(maxsize=1)
def browser_available():
    if sync_playwright is None:
        return False
    try:
        with sync_playwright() as runtime:
            return Path(runtime.chromium.executable_path).is_file()
    except Exception:
        return False


class BrowserReader(WebResearch):
    def __init__(self):
        super().__init__(max_requests=40)
        self.bytes_read = 0
        self.tools = [tool(self.read_browser_page), tool(self.inspect_browser_job)]

    def _page(self, url):
        import datetime
        checked = datetime.datetime.now(datetime.timezone.utc).isoformat()
        try:
            url = public_url(url)
            if not browser_available():
                return {'status': 'setup_required', 'url': url, 'html': '', 'checked_at': checked,
                        'error': 'Install AgentOS[browser] and run python -m playwright install chromium'}
            deadline = time.monotonic() + 25
            failures = []
            with sync_playwright() as runtime:
                browser = runtime.chromium.launch(headless=True, args=['--proxy-server=direct://', '--proxy-bypass-list=*', '--disable-quic'])
                try:
                    context = browser.new_context(service_workers='block', accept_downloads=False)
                    context.add_init_script('window.RTCPeerConnection = undefined; window.webkitRTCPeerConnection = undefined;')
                    context.route_web_socket('**/*', lambda route: route.close())

                    def route_request(route):
                        request = route.request
                        if (request.method != 'GET' or request.resource_type not in ('document', 'script', 'stylesheet', 'xhr', 'fetch')
                                or self.remaining <= 0 or self.bytes_read >= 8_000_000 or time.monotonic() > deadline):
                            route.abort()
                            return
                        try:
                            destination = public_url(request.url)
                            self.remaining -= 1
                            status, headers, body = _download(destination, max_bytes=2_000_000)
                            if status in (301, 302, 303, 307, 308):
                                public_url(urllib.parse.urljoin(destination, headers.get('location', '')))
                            self.bytes_read += len(body)
                            if self.bytes_read > 8_000_000:
                                raise ValueError('Browser byte budget exhausted')
                            safe_headers = {key: value for key, value in headers.items() if key not in
                                            ('set-cookie', 'transfer-encoding', 'content-length', 'connection', 'content-encoding')}
                            route.fulfill(status=status, headers=safe_headers, body=body)
                        except Exception:
                            failures.append('A resource was blocked, too large, or unavailable')
                            route.abort()

                    context.route('**/*', route_request)
                    page = context.new_page()
                    response = page.goto(url, wait_until='domcontentloaded', timeout=20000)
                    try:
                        page.wait_for_load_state('networkidle', timeout=4000)
                    except Exception:
                        pass
                    final_url = public_url(page.url)
                    html = page.content()
                    if len(html.encode()) > 1_000_000:
                        return {'status': 'error', 'url': final_url, 'html': '', 'checked_at': checked, 'error': 'Rendered page exceeds 1 MB'}
                    status = response.status if response else None
                    return {'status': 'read' if status == 200 else 'blocked', 'http_status': status,
                            'url': final_url, 'html': html if status == 200 else '', 'checked_at': checked,
                            'rendered': True, 'resource_failures': len(failures),
                            'browser_note': 'Fresh unauthenticated browser. Public GET resources only; some page features may be unavailable.'}
                finally:
                    browser.close()
        except Exception:
            return {'status': 'unavailable', 'url': url[:2048], 'html': '', 'checked_at': checked,
                    'error': 'Browser page could not be read. It may require login, block access, or exceed budgets.'}

    def read_browser_page(self, url: str) -> dict:
        """Render/read a public JavaScript page in a clean browser. Extract text and apply anchors. GET-only; no login/cookies/forms/downloads/model code. Use employer feeds first when available."""
        return self.read_web_page(url)

    def inspect_browser_job(self, url: str) -> dict:
        """Render one LinkedIn posting and extract exposed application destination. Cannot bypass sign-in or reveal links hidden by the site."""
        return self.inspect_linkedin_job(url)
