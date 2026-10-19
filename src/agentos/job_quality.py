"""Deterministic job matching over collected tool evidence, never model-supplied jobs."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
import json
import re
import urllib.parse

from .tools import tool
from .web_research import WebResearch, public_url, FetchError, bounded_result

CATEGORIES = ('confirmed_match', 'uncertain', 'excluded', 'closed', 'blocked')
CAPTURE = {'search_linkedin_jobs','inspect_linkedin_job','inspect_browser_job','search_company_jobs','inspect_company_job'}
REVIEW_INSTRUCTIONS = '''For job tasks, use review_job_results before the final answer. It reviews only actual current-run tool observations, not jobs supplied by a model. Set role/location/max_experience to the user's criteria and report them explicitly. Defaults are SDE 1, Bengaluru, at most 2 years minimum required experience; these are not legal eligibility checks. Review uncertain, excluded, closed and blocked results separately. Use verify_job_application for an observed source when its destination needs checking, then review again. Do not call an extracted URL verified/open merely because it exists. Confirmed matches mean matching explicit evidence plus an exact published employer-feed destination at check time, not a guarantee of accepting applications or independent employer identity. Never pad a requested count with unrelated/uncertain roles. Use the review's reasons, source timestamps and exact URLs in the final answer. Pagination/category filters let you inspect omitted results without repeating searches.'''


def normal(text):
    return re.sub(r'[^a-z0-9]+',' ',str(text).lower().replace('bangalore','bengaluru')).strip()


def ats_key(url):
    try:
        p=urllib.parse.urlsplit(public_url(url))
    except (ValueError, TypeError):
        return None
    if p.hostname in ('boards.greenhouse.io','job-boards.greenhouse.io'):
        match=re.fullmatch(r'/([\w-]+)/jobs/(\d+)/?',p.path)
        return ('greenhouse',match[1].lower(),match[2]) if match else None
    if p.hostname in ('jobs.lever.co','jobs.eu.lever.co'):
        match=re.fullmatch(r'/([\w-]+)/([\w-]+)(?:/apply)?/?',p.path)
        return ('lever_eu' if p.hostname=='jobs.eu.lever.co' else 'lever',match[1].lower(),match[2]) if match else None
    return None


def canonical(url):
    try:
        key=ats_key(url)
        if key:
            return '|'.join(key)
        p=urllib.parse.urlsplit(public_url(url))
        if p.hostname in ('linkedin.com','www.linkedin.com','in.linkedin.com'):
            match=re.search(r'/jobs/view/(?:[^/?]*-)?(\d+)/?',p.path)
            if match:
                return 'linkedin|'+match[1]
        query=[(k,v) for k,v in urllib.parse.parse_qsl(p.query,keep_blank_values=True)
               if not k.lower().startswith('utm_') and k.lower() not in ('trk','trackingid','ref','source','refid')]
        return urllib.parse.urlunsplit(('https',f'[{p.hostname}]' if ':' in p.hostname else p.hostname,p.path.rstrip('/') or '/',urllib.parse.urlencode(sorted(query)),''))
    except (ValueError, TypeError):
        return None


def specific_link(url):
    if ats_key(url):
        return True
    key=canonical(url)
    if not key or key.startswith('linkedin|'):
        return False
    p=urllib.parse.urlsplit(key)
    parts=[part for part in p.path.split('/') if part]
    return (len(parts)>=2 and parts[-1].lower() not in ('jobs','careers','search','apply','openings')
            or any(k.lower() in ('jobid','job_id','gh_jid','requisitionid','reqid') and v for k,v in urllib.parse.parse_qsl(p.query)))


def closure_reason(description):
    text=str(description)
    if re.search(r'no longer accepting applications|this job is no longer available|this (?:job|position) (?:is|has been) closed',text,re.I):
        return 'Explicit closure notice in collected posting evidence'
    for match in re.finditer(r'(?:apply by|application deadline|applications? close(?:s)?|closing date)\s*:?\s*(\d{4}-\d{2}-\d{2})',text,re.I):
        try:
            deadline=datetime.strptime(match[1],'%Y-%m-%d').date()
        except ValueError:
            continue
        if deadline<datetime.now(timezone.utc).date():
            return 'Explicit application deadline has passed (date before today in UTC)'
    return None


def experience(description):
    text=str(description).replace('–','-').replace('—','-')
    findings=[]
    pattern=r'\b(\d{1,2})\s*(?:(?:-|to)\s*(\d{1,2}))?\s*(\+|plus)?\s*(?:years?|yrs?)\b'
    for match in re.finditer(pattern,text,re.I):
        context=text[max(0,match.start()-65):min(len(text),match.end()+80)]
        sentence=re.split(r'[.!?;\n]',context)
        relevant=next((part for part in sentence if match.group(0).lower() in part.lower()),context)
        prefix=text[max(0,match.start()-45):match.start()]
        if re.search(r'(?:we|our company|company|business)\b.{0,25}(?:have|has|over|with)\s*$',prefix,re.I) or re.match(r'\s*(?:degree|program|course)\b',text[match.end():],re.I):
            continue
        if re.search(r'prefer|nice.to.have|bonus|desirable',relevant,re.I):
            continue
        if not (re.search(r'experience|minimum|at least|required|qualification',relevant,re.I) or len(text.strip())<100):
            continue
        low=int(match[1]); high=int(match[2]) if match[2] else None
        if re.search(r'(?:up to|less than)\s*$',text[max(0,match.start()-15):match.start()],re.I):
            high=low; low=0
        if low>50 or high is not None and (high<low or high>50):
            continue
        findings.append({'minimum_years':low,'range_max':high,'quote':relevant.strip()[:180]})
    if not findings:
        return {'status':'unknown','minimum_years':None,'evidence':[]}
    if len(findings)>1 and re.search(r'\bor\b',text,re.I):
        return {'status':'ambiguous','minimum_years':None,'evidence':[row['quote'] for row in findings[:3]]}
    return {'status':'stated','minimum_years':max(row['minimum_years'] for row in findings),
            'evidence':[row['quote'] for row in findings[:3]]}


def role_match(title, role, description=''):
    title=normal(title); query=normal(role)
    junior=bool(re.search(r'\b(?:sde|software (?:development )?engineer)\s*(?:1|i)\b|\b(?:junior|entry level)\b',query)) and bool(re.search(r'\bsde|\bsoftware|\b(?:backend|frontend|full stack|android|ios|mobile|web)\b.*\b(?:engineer|developer)',query))
    if not junior:
        return 'match' if query and all(token in title.split() for token in query.split()) else 'mismatch'
    software=bool(re.search(r'\bsde(?:[1-9])?\b|\b(?:software|backend|frontend|full stack|android|ios|mobile|web)\b.*\b(?:engineer|developer)(?:[1-9])?\b',title))
    if not software:
        return 'mismatch'
    if re.search(r'\b(?:senior|sr|staff|principal|lead|manager|intern|internship|test|qa|devops|support)\b|\b(?:sde|engineer)\s*(?:[2-9]|ii|iii|iv)\b|\b(?:level|l)\s*[2-9]\b',title):
        return 'mismatch'
    if re.search(r'\b(?:junior|entry level|associate)\b|\b(?:sde|engineer)\s*(?:1|i)\b|\b(?:level|l)\s*1\b',title):
        return 'match'
    exp=experience(description)
    return 'match' if exp['minimum_years'] is not None and exp['minimum_years']<=2 else 'unknown'


def criteria_for(job, role, location, max_experience):
    exp=job.get('experience_requirements') or experience(job.get('description',''))
    actual=normal(job.get('location','')); requested=normal(location)
    if 'bengaluru' in requested.split():
        requested='bengaluru'
    # Generic remote/India does not establish availability in a requested city.
    loc='match' if requested and re.search(r'\b'+re.escape(requested)+r'\b',actual) else 'unknown' if not actual or 'remote' in actual else 'mismatch'
    exp_status='unknown' if exp['minimum_years'] is None else 'match' if exp['minimum_years']<=max_experience else 'mismatch'
    return {'role':role_match(job.get('title',''),role, f"{exp['minimum_years']} years experience" if exp['minimum_years'] is not None else ''),
            'location':loc,'experience':exp_status,'minimum_years':exp['minimum_years'],'experience_evidence':exp['evidence']}


def observation_identity(row):
    if row.get('platform') and row.get('company_board') and row.get('job_id'):
        return ('feed',row['platform'],row['company_board'].lower(),str(row['job_id']))
    return ('source',canonical(row.get('source_url')))


class JobReview:
    def __init__(self):
        self.reset()
        self.tools=[replace(tool(self.review_job_results),on_run_start=self.reset),tool(self.verify_job_application)]

    def reset(self):
        self.observations=[]
        self.truncated=False
        self.checks={}
        self.reader=WebResearch(max_requests=8)

    def wrap(self, entry):
        if entry.name not in CAPTURE:
            return entry
        def observed(*args,**kwargs):
            result=entry.function(*args,**kwargs)
            self.capture(result,entry.name)
            return result
        return replace(entry,function=observed)

    def capture(self, result, name):
        if not isinstance(result,dict):
            return
        if result.get('results_truncated'):
            self.truncated=True
        for row in result.get('jobs',[]) if isinstance(result.get('jobs'),list) else [result]:
            if not isinstance(row,dict):
                continue
            source=row.get('source_url') or (result.get('source_url') if not result.get('jobs') else None)
            if not canonical(source):
                continue
            fields=('title','company','company_board','location','job_id','source_url','application_url','description',
                    'verification','apply_status','status','checked_at','platform','posting_type')
            record={key:deepcopy(row[key]) for key in fields if isinstance(row.get(key),(str,int,bool))}
            if isinstance(row.get('experience_requirements'),dict):
                record['experience_requirements']=deepcopy(row['experience_requirements'])
            record['source_url']=source
            record['checked_at']=row.get('checked_at') or result.get('checked_at')
            record['description']=str(record.get('description',''))[:6000]
            record['observed_by']=name
            # Bound data held by this run; newer observations replace the same source/tool.
            self.observations=[old for old in self.observations if not (observation_identity(old)==observation_identity(record) and old['observed_by']==name)]
            if len(self.observations)>=100 or sum(len(json.dumps(old)) for old in self.observations)+len(json.dumps(record))>256000:
                self.truncated=True
                continue
            self.observations.append(record)

    def verify_job_application(self, source_url: str) -> dict:
        """Check the already observed application destination of a captured source job. No guessed URLs: source must have been inspected in this run. Reads only; no applications/login. Eight extra GET requests maximum."""
        source=canonical(source_url)
        records=[row for row in self.observations if canonical(row['source_url'])==source and row.get('application_url')]
        if not source or not records:
            return {'status':'error','error':'Inspect this source first; no observed application destination is available.'}
        record=records[-1]; target=record['application_url']
        if record.get('apply_status')=='closed' or not specific_link(target):
            return {'status':'not_verified','error':'The posting is closed or its destination is generic, hidden or Easy Apply.'}
        if ats_key(target):
            from .job_boards import JobBoards
            boards=JobBoards();boards.reader=self.reader
            inspected=boards.inspect_company_job(target)
            self.capture(inspected,'inspect_company_job')
            result={'status':'closed' if inspected.get('apply_status')=='closed' else 'published_in_employer_feed' if inspected.get('verification')=='published_in_employer_feed' else 'unavailable',
                    'source_url':source_url,'application_url':target,'checked_at':inspected.get('checked_at') or datetime.now(timezone.utc).isoformat(),
                    'note':'Exact observed destination checked against its employer API record; employer identity/hiring acceptance are not independently guaranteed.'}
        else:
            page=self.reader._page(target)
            result={key:page.get(key) for key in ('status','url','http_status','checked_at')}
            result.update(source_url=source_url,application_url=target,note='Destination reachability only. A readable page does not prove role identity or an active application form.')
        self.checks[source]=result
        return result

    def review_job_results(self, role: str = 'SDE 1', location: str = 'Bengaluru', max_experience: int = 2,
                           category: str = 'all', limit: int = 5, offset: int = 0) -> dict:
        """Deduplicate and classify actual collected jobs by role/location/required minimum experience and exact feed-backed application link. No model-supplied records. category all/confirmed_match/uncertain/excluded/closed/blocked; limit 1–10; offset 0–100."""
        if not role.strip() or len(role)>150 or not location.strip() or len(location)>150 or not 0<=max_experience<=10 or category not in ('all',*CATEGORIES) or not 1<=limit<=10 or not 0<=offset<=100:
            return {'status':'error','error':'Invalid review criteria, category or pagination'}
        groups=[]
        for observation in self.observations:
            if observation.get('platform') and observation.get('company_board') and observation.get('job_id'):
                keys={f"feed|{observation['platform']}|{observation['company_board'].lower()}|{observation['job_id']}"}
                for url in (observation['source_url'],observation.get('application_url')):
                    key=ats_key(url)
                    if key and key==(observation['platform'],observation['company_board'].lower(),str(observation['job_id'])):
                        keys.add(canonical(url))
            else:
                keys={canonical(observation['source_url'])}
                if observation.get('application_url') and specific_link(observation['application_url']):
                    keys.add(canonical(observation['application_url']))
            joined=[group for group in groups if keys & group['keys']]
            if joined:
                group=joined[0];group['keys']|=keys;group['rows'].append(observation)
                for other in joined[1:]:
                    group['keys']|=other['keys'];group['rows'].extend(other['rows']);groups.remove(other)
            else:
                groups.append({'keys':keys,'rows':[observation]})
        jobs=[]
        for group in groups:
            rows=group['rows']
            best=deepcopy(max(rows,key=lambda row:(row.get('verification')=='published_in_employer_feed',row.get('verification')!='search_candidate',bool(row.get('description')),row.get('checked_at') or '')))
            for field in ('title','company','location'):
                if not best.get(field):
                    best[field]=next((row[field] for row in reversed(rows) if row.get(field)),'')
            checks=criteria_for(best,role,location,max_experience)
            closed=any(row.get('apply_status')=='closed' or row.get('verification')=='closed' or closure_reason(row.get('description','')) for row in rows)
            blocked=best.get('apply_status') in ('login_required','unavailable') or best.get('status') in ('blocked','unavailable','error')
            target=best.get('application_url')
            key=ats_key(target) if target else None
            exact=bool(key and best.get('verification')=='published_in_employer_feed' and key[2]==str(best.get('job_id'))
                       and key[1]==str(best.get('company_board','')).lower() and key[0]==best.get('platform') and ats_key(best['source_url'])==key)
            destination_check=max((self.checks[canonical(row['source_url'])] for row in rows if canonical(row['source_url']) in self.checks),key=lambda check:check.get('checked_at') or '',default=None)
            destination_failed=bool(destination_check and destination_check.get('status')!='published_in_employer_feed')
            conflict=any(any(criteria_for(row,role,location,max_experience)[field]=='mismatch' and checks[field]=='match' for field in ('role','location','experience')) for row in rows if row.get('verification')!='search_candidate')
            state=('closed' if closed else 'blocked' if blocked else 'excluded' if best.get('posting_type')=='prospect_pool' or 'mismatch' in (checks['role'],checks['location'],checks['experience'])
                   else 'confirmed_match' if all(checks[field]=='match' for field in ('role','location','experience')) and exact and best.get('checked_at') and not destination_failed and not conflict else 'uncertain')
            reasons=[f'{field}: {checks[field]}' for field in ('role','location','experience')]
            reasons.append('Exact employer-feed posting/application identity supported' if exact else 'Exact published employer application identity not established')
            if best.get('posting_type')=='prospect_pool':
                reasons.append('Prospect pool, not a specific published job opening')
            if closed:
                reasons.append('A closure notice or expired explicit application deadline was observed')
            if blocked:
                reasons.append('Posting details are blocked, unavailable or require login')
            if conflict:
                reasons.append('Inspected sources disagree about role, location or experience')
            if destination_failed:
                reasons.append('The most recent destination check did not confirm employer publication')
            easy=best.get('apply_status')=='linkedin_easy_apply'
            generic=not target or not specific_link(target) and not easy
            if generic:
                reasons.append('No exact application destination exposed; generic career pages are not apply links')
            jobs.append({'title':best.get('title','Unknown role'),'company':best.get('company') or best.get('company_board','Unknown employer'),
                         'location':best.get('location',''),'source_url':best['source_url'],'application_url':None if closed or generic else target,
                         'quality_category':state,'criteria':checks,'reasons':reasons,'checked_at':best.get('checked_at'),
                         'link_status':'exact_feed_destination' if exact else 'linkedin_easy_apply' if easy else 'generic_or_hidden' if generic else 'unverified_destination',
                         'verification':best.get('verification','unverified'),
                         'sources':list(dict.fromkeys(row['source_url'] for row in rows))[:4],
                         'destination_check':{key:value for key,value in destination_check.items() if key in ('status','checked_at','http_status','note')} if destination_check else None})
        jobs.sort(key=lambda job:CATEGORIES.index(job['quality_category']))
        counts={key:sum(job['quality_category']==key for job in jobs) for key in CATEGORIES}
        filtered=[job for job in jobs if category=='all' or job['quality_category']==category]
        result=bounded_result({'status':'reviewed','criteria':{'role':role,'location':location,'max_required_experience':max_experience},
                               'counts':counts,'unique_jobs':len(jobs),'observations':len(self.observations),'capture_truncated':self.truncated,
                               'category':category,'offset':offset,'filtered_total':len(filtered),'jobs':filtered[offset:offset+limit],
                               'note':'Confirmed means matching collected criteria plus exact feed publication evidence at check time; not guaranteed hiring/acceptance or independently verified employer identity. Unknown evidence stays uncertain. English rule-based matching is conservative and may miss wording.'})
        if result.get('status')=='reviewed':
            result['returned_count']=len(result['jobs'])
            result['next_offset']=offset+len(result['jobs']) if result['jobs'] and offset+len(result['jobs'])<len(filtered) else None
        return result
