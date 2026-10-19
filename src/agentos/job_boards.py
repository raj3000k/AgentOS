"""Public read-only employer job APIs; no submission endpoints."""
from datetime import datetime, timezone
import json
import re
import urllib.parse
from html import unescape

from .tools import tool
from .web_research import WebResearch, FetchError, public_url, bounded_result, PageParser, clean


class JobBoards:
    def __init__(self):
        self.reader = WebResearch(max_requests=10)
        self.tools = [tool(self.search_company_jobs), tool(self.inspect_company_job)]

    def _json(self, url):
        checked = datetime.now(timezone.utc).isoformat()
        try:
            page = self.reader.fetch(url, allow_json=True)
            if page['status'] != 'read':
                return None, {**{key: value for key, value in page.items() if key != 'html'}, 'checked_at': checked}
            return json.loads(page['html']), {'status': 'read', 'url': page['url'], 'checked_at': datetime.now(timezone.utc).isoformat()}
        except (FetchError, ValueError):
            return None, {'status': 'unavailable', 'url': url, 'checked_at': checked, 'error': 'Company job feed could not be read'}

    def _job(self, record, platform, board):
        if platform == 'greenhouse':
            title = record.get('title', '')
            location = record.get('location', {}).get('name', '')
            source = record.get('absolute_url', '')
            target = source
            description = unescape(record.get('content', ''))
        else:
            title = record.get('text', '')
            location = record.get('categories', {}).get('location', '')
            source = record.get('hostedUrl', '')
            target = record.get('applyUrl', '')
            description = record.get('descriptionPlain', '')
        from .job_quality import experience, closure_reason
        full_description=clean(PageParser(str(description)).root.text())
        closed=bool(closure_reason(full_description))
        prospect=platform=='greenhouse' and 'internal_job_id' in record and record['internal_job_id'] is None
        source = public_url(source)
        target = public_url(target) if target else None
        return {'title': str(title)[:180], 'company_board': board, 'location': str(location)[:180],
                'job_id': str(record.get('id', '')), 'source_url': source, 'application_url': None if closed or prospect else target,
                'description': full_description[:1800], 'description_truncated': len(full_description)>1800,
                'experience_requirements': experience(full_description),
                'apply_status': 'closed' if closed else 'prospect_pool' if prospect else 'employer_application_link' if target else 'not_exposed',
                'verification': 'prospect_pool' if prospect else 'published_in_employer_feed', 'platform': platform,
                'posting_type': 'prospect_pool' if prospect else 'specific_job',
                'note': 'Published in this employer board at check time. Confirm employer identity, experience and location; no application submitted.'}

    def search_company_jobs(self, platform: str, board: str, keywords: str = '', location: str = '', limit: int = 5) -> dict:
        """Read a known employer Greenhouse/Lever board and filter published roles by title/location. Get board slug from an observed careers URL. platform: greenhouse, lever, lever_eu; limit 1–10. Exact posting/apply links returned."""
        if platform not in ('greenhouse', 'lever', 'lever_eu') or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', board) or not 1 <= limit <= 10 or len(keywords) > 150 or len(location) > 150:
            return {'status': 'error', 'error': 'Invalid platform, observed board slug, filters or limit'}
        url = (f'https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true' if platform == 'greenhouse'
               else f"https://{'api.eu.lever.co' if platform == 'lever_eu' else 'api.lever.co'}/v0/postings/{board}?mode=json")
        payload, evidence = self._json(url)
        if payload is None:
            return {**evidence, 'jobs': []}
        records = payload.get('jobs', []) if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            return {'status': 'error', 'error': 'Invalid company feed', 'jobs': []}
        jobs = []
        for record in records:
            if not isinstance(record, dict):
                continue
            if platform == 'greenhouse' and 'internal_job_id' in record and record['internal_job_id'] is None:
                continue
            try:
                job = self._job(record, platform, board)
            except (FetchError, AttributeError, TypeError):
                continue
            requested_location = location.lower().replace('bangalore', 'bengaluru')
            actual_location = job['location'].lower().replace('bangalore', 'bengaluru')
            from .job_quality import role_match
            if (keywords.strip() and role_match(job['title'],keywords,job['description'])=='mismatch') or requested_location not in actual_location:
                continue
            jobs.append(job)
            if len(jobs) == limit:
                break
        return bounded_result({**evidence, 'jobs': jobs, 'note': 'Filtered published feed. Board slug identifies the source, not independently verified company identity.'})

    def inspect_company_job(self, url: str) -> dict:
        """Read the exact employer API record for an observed Greenhouse or Lever posting URL. Returns published status and application destination; no application submission."""
        try:
            parsed = urllib.parse.urlsplit(public_url(url))
            if parsed.hostname in ('boards.greenhouse.io', 'job-boards.greenhouse.io'):
                match = re.fullmatch(r'/([A-Za-z0-9_-]+)/jobs/(\d+)/?', parsed.path)
                platform = 'greenhouse'
            elif parsed.hostname in ('jobs.lever.co', 'jobs.eu.lever.co'):
                match = re.fullmatch(r'/([A-Za-z0-9_-]+)/([A-Za-z0-9-]+)/?(?:apply/?)?', parsed.path)
                platform = 'lever_eu' if parsed.hostname == 'jobs.eu.lever.co' else 'lever'
            else:
                match = None
            if not match:
                raise ValueError()
            board, job_id = match.groups()
            api = (f'https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job_id}' if platform == 'greenhouse'
                   else f"https://{'api.eu.lever.co' if platform == 'lever_eu' else 'api.lever.co'}/v0/postings/{board}/{job_id}?mode=json")
            record, evidence = self._json(api)
            if record is None:
                return evidence
            if not isinstance(record, dict) or str(record.get('id', '')) != job_id:
                raise ValueError()
            return bounded_result({**evidence, **self._job(record, platform, board)})
        except (ValueError, TypeError, AttributeError):
            return {'status': 'error', 'error': 'Use an observed specific Greenhouse or Lever posting URL'}
