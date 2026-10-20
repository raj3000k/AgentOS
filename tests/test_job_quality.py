"""Repeatable offline job-quality fixtures; no model-supplied jobs or external reads."""
from datetime import datetime, timezone
import json
import unittest
from unittest.mock import patch

from agentos import Agent, tool
from agentos.capabilities import build_capabilities
from agentos.errors import ToolError
from agentos.job_boards import JobBoards
from agentos.job_quality import JobReview, ats_key, canonical, criteria_for, experience, role_match, specific_link
from test_agent import FakeClient, assistant, call
from test_capabilities import public_response


def record(job_id='one', **values):
    return {'title':'Software Engineer I','location':'Bangalore','description':'0–2 years of software development experience required.',
            'company_board':'example','platform':'lever','job_id':job_id,
            'source_url':f'https://jobs.lever.co/example/{job_id}',
            'application_url':f'https://jobs.lever.co/example/{job_id}/apply',
            'apply_status':'employer_application_link','verification':'published_in_employer_feed',
            'checked_at':datetime.now(timezone.utc).isoformat(), **values}


def feed_record(job_id='one', **values):
    return {'id':job_id,'text':'Software Engineer I','categories':{'location':'Bengaluru'},
            'hostedUrl':f'https://jobs.lever.co/example/{job_id}',
            'applyUrl':f'https://jobs.lever.co/example/{job_id}/apply',
            'descriptionPlain':'0–2 years of software development experience required.', **values}


class JobQualityTests(unittest.TestCase):
    def test_repeated_requirements_and_unrelated_or_do_not_erase_experience(self):
        self.assertEqual(experience('We need 1-2 years of experience in Java or Python. Requirements: 1-2 years of professional backend development experience.')['minimum_years'],1)
        self.assertEqual(experience('2+ years of software engineering experience, including at least 1 year in a startup or growth-stage environment.')['minimum_years'],2)
        self.assertEqual(experience('Bachelor degree with 3 years experience OR Master degree with 2 years experience.')['status'],'ambiguous')
        self.assertTrue(specific_link('https://company.example/careers?ashby_jid=ec05c135-ab26-437a-8fe9-f7a5c4da08e5'))
        self.assertFalse(specific_link('https://company.example/careers'))

    def test_easy_apply_is_not_reported_as_closure(self):
        review=JobReview()
        source='https://www.linkedin.com/jobs/view/123/'
        review.capture(record(source_url=source,application_url=source,apply_status='linkedin_easy_apply'),'inspect_linkedin_session_job')
        result=review.verify_job_application(source)
        self.assertEqual(result['status'],'not_verified')
        self.assertIn('not evidence that the opening is closed',result['error'])
        review.capture(record(source_url=source,application_url=source,apply_status='closed'),'inspect_linkedin_session_job')
        self.assertEqual(review.verify_job_application(source)['status'],'closed')

    def test_role_aliases_and_wrong_levels(self):
        for title in ('SDE 1','SDE1','Software Engineer I','Software Development Engineer 1','Junior Software Developer','Associate Software Engineer','Backend Engineer I','Software Engineer Level 1'):
            with self.subTest(title=title):
                self.assertEqual(role_match(title,'SDE 1'),'match')
        for title in ('Senior Software Engineer','Software Engineer II','SDE 2','Staff Software Engineer','Software Engineer Intern','Software Test Engineer I','Data Engineer I','Software Engineer L2'):
            with self.subTest(title=title):
                self.assertEqual(role_match(title,'SDE 1'),'mismatch')
        self.assertEqual(role_match('Software Engineer','SDE 1'),'unknown')
        self.assertEqual(role_match('Software Engineer','SDE 1','1 year experience required'),'match')
        self.assertEqual(role_match('Junior Data Engineer','Junior Data Engineer'),'match')

    def test_experience_quotes_preferences_alternatives_and_company_age(self):
        for text, minimum in [('0–2 years experience',0),('1 to 3 yrs required',1),('Minimum 3+ years of experience',3),
                              ('Up to 2 years of experience',0),('At least 5 years relevant experience',5)]:
            with self.subTest(text=text):
                parsed=experience(text)
                self.assertEqual(parsed['minimum_years'],minimum)
                self.assertTrue(parsed['evidence'])
        self.assertIsNone(experience('5 years preferred')['minimum_years'])
        self.assertIsNone(experience('2 years React experience or 5 years Java experience')['minimum_years'])
        self.assertIsNone(experience('4 year degree required')['minimum_years'])
        self.assertEqual(experience('Our company has 20 years of experience. Qualifications: 0–2 years development experience.')['minimum_years'],0)

    def test_location_and_conflicting_experience_are_not_guessed(self):
        self.assertEqual(criteria_for(record(),'SDE 1','Bengaluru',2)['location'],'match')
        self.assertEqual(criteria_for(record(location='Bengaluru, Karnataka'),'SDE 1','Bangalore, India',2)['location'],'match')
        self.assertEqual(criteria_for(record(location='Chennai'),'SDE 1','Bangalore',2)['location'],'mismatch')
        self.assertEqual(criteria_for(record(location='Remote, India'),'SDE 1','Bangalore',2)['location'],'unknown')
        self.assertEqual(criteria_for(record(description='Minimum 5 years experience required'),'SDE 1','Bangalore',2)['experience'],'mismatch')
        self.assertEqual(criteria_for(record(description='Experience not specified'),'SDE 1','Bangalore',2)['experience'],'unknown')

    def test_mixed_results_deduplicate_without_merging_distinct_ids(self):
        review=JobReview()
        review.capture({'jobs':[record(),record('senior',title='Software Engineer II'),record('chennai',location='Chennai'),
                                record('unknown',description='Experience not specified'),
                                record('closed',apply_status='closed'),record('experienced',description='Minimum 5 years experience required'),
                                record('two'),record('generic',source_url='https://company.example/careers',application_url='https://company.example/careers')]},'search_company_jobs')
        review.capture(record(source_url='https://jobs.lever.co/example/one?utm_source=x'),'inspect_company_job')
        review.capture({'source_url':'https://www.linkedin.com/jobs/view/123','title':'Software Engineer I','location':'Bangalore',
                        'description':'0–2 years experience','company':'Example','application_url':'https://jobs.lever.co/example/one/apply',
                        'apply_status':'external_link_found','verification':'posting_read_not_confirmed_open'},'inspect_linkedin_job')
        review.capture({'source_url':'https://www.linkedin.com/jobs/view/blocked','title':'Candidate','verification':'search_candidate'},'search_linkedin_jobs')
        review.capture({'source_url':'https://www.linkedin.com/jobs/view/blocked','title':'','verification':'posting_read_not_confirmed_open',
                        'status':'blocked','apply_status':'login_required'},'inspect_linkedin_job')
        result=review.review_job_results(limit=10)
        self.assertEqual(result['unique_jobs'],9)
        self.assertEqual(result['counts'],{'confirmed_match':2,'uncertain':2,'excluded':3,'closed':1,'blocked':1})
        confirmed=[job for job in result['jobs'] if job['quality_category']=='confirmed_match']
        self.assertEqual({job['source_url'].split('?')[0] for job in confirmed},{'https://jobs.lever.co/example/one','https://jobs.lever.co/example/two'})
        one=next(job for job in confirmed if 'one' in job['source_url'])
        self.assertTrue(any('linkedin' in source for source in one['sources']))
        closed=next(job for job in result['jobs'] if job['quality_category']=='closed')
        self.assertIsNone(closed['application_url'])
        generic=next(job for job in result['jobs'] if job['source_url']=='https://company.example/careers')
        self.assertIsNone(generic['application_url'])

    def test_identity_queries_and_generic_links_remain_distinct(self):
        self.assertEqual(canonical('https://jobs.lever.co/example/one?utm_source=a'),canonical('https://jobs.lever.co/example/one/apply'))
        self.assertNotEqual(canonical('https://company.example/careers?job_id=1'),canonical('https://company.example/careers?job_id=2'))
        self.assertEqual(canonical('https://www.linkedin.com/jobs/view/software-engineer-123?trk=foo'),'linkedin|123')
        self.assertFalse(specific_link('https://company.example/careers'))
        self.assertFalse(specific_link('https://company.example/jobs/search'))
        self.assertFalse(specific_link('https://127.0.0.1/jobs/123'))
        self.assertEqual(ats_key('https://job-boards.greenhouse.io/example/jobs/12#app'),('greenhouse','example','12'))
        review=JobReview()
        for job_id in ('one','two'):
            review.capture(record(job_id,source_url='https://company.example/careers',application_url='https://company.example/careers'),'search_company_jobs')
        # Capture must retain distinct feed IDs even when a broken feed reuses a homepage.
        self.assertEqual(review.review_job_results()['unique_jobs'],2)

    def test_observed_ats_destination_verification_merges_exact_record(self):
        review=JobReview()
        source='https://www.linkedin.com/jobs/view/123'
        review.capture({'source_url':source,'title':'Software Engineer I','company':'Example','location':'Bangalore',
                        'description':'0–2 years experience','application_url':'https://jobs.lever.co/example/one/apply',
                        'apply_status':'external_link_found','verification':'posting_read_not_confirmed_open'},'inspect_linkedin_job')
        self.assertEqual(review.review_job_results()['counts']['uncertain'],1)
        with patch('agentos.web_research._download',return_value=public_response(feed_record())) as download:
            check=review.verify_job_application(source)
        self.assertEqual(check['status'],'published_in_employer_feed')
        self.assertIn('api.lever.co/v0/postings/example/one',download.call_args.args[0])
        self.assertEqual(review.review_job_results()['counts']['confirmed_match'],1)
        with patch('agentos.web_research._download',return_value=(404,{'content-type':'application/json'},b'{}')):
            check=review.verify_job_application(source)
        self.assertEqual(check['status'],'unavailable')
        self.assertEqual(review.review_job_results()['counts']['confirmed_match'],0)
        with patch('agentos.web_research._download') as download:
            self.assertEqual(review.verify_job_application('https://www.linkedin.com/jobs/view/invented')['status'],'error')
        download.assert_not_called()

    def test_readable_generic_destination_is_not_a_verified_job(self):
        review=JobReview()
        review.capture(record(platform='',verification='posting_read_not_confirmed_open',application_url='https://company.example/jobs/one'),'inspect_linkedin_job')
        with patch('agentos.web_research._download',return_value=(200,{'content-type':'text/html'},b'<title>Careers</title>')):
            check=review.verify_job_application('https://jobs.lever.co/example/one')
        self.assertEqual(check['status'],'read')
        self.assertEqual(review.review_job_results()['counts']['confirmed_match'],0)

    def test_feed_alias_search_and_full_description_before_trimming(self):
        payload=[feed_record(descriptionPlain='0–2 years experience. '+('Product details. '*300)+' Minimum 5 years experience required.')]
        with patch('agentos.web_research._download',return_value=public_response(payload)):
            result=JobBoards().search_company_jobs('lever','example','SDE 1','Bangalore')
        self.assertEqual(len(result['jobs']),1)
        job=result['jobs'][0]
        self.assertTrue(job['description_truncated'])
        self.assertEqual(job['experience_requirements']['minimum_years'],5)
        review=JobReview();review.capture(result,'search_company_jobs')
        self.assertEqual(review.review_job_results()['counts']['excluded'],1)
        greenhouse={'jobs':[{'id':12,'title':'Software Engineer I','location':{'name':'Bangalore'},
                             'absolute_url':'https://job-boards.greenhouse.io/example/jobs/12',
                             'content':'&lt;p&gt;0–2 years experience required&lt;/p&gt;'}]}
        with patch('agentos.web_research._download',return_value=public_response(greenhouse)) as download:
            result=JobBoards().search_company_jobs('greenhouse','example','SDE1','Bengaluru')
        self.assertIn('content=true',download.call_args.args[0])
        self.assertEqual(result['jobs'][0]['experience_requirements']['minimum_years'],0)
        prospect={**greenhouse['jobs'][0],'internal_job_id':None}
        with patch('agentos.web_research._download',return_value=public_response(prospect)):
            inspected=JobBoards().inspect_company_job(prospect['absolute_url'])
        self.assertIsNone(inspected['application_url'])
        self.assertEqual(inspected['apply_status'],'prospect_pool')
        review=JobReview();review.capture(inspected,'inspect_company_job')
        self.assertEqual(review.review_job_results()['counts']['excluded'],1)

    def test_expiry_conflicts_and_wrong_application_identity_are_not_promoted(self):
        review=JobReview()
        review.capture(record('expired',description='0–2 years experience. Apply by 2000-01-01'),'inspect_company_job')
        review.capture(record('wrong',application_url='https://jobs.lever.co/example/other/apply'),'inspect_company_job')
        review.capture(record('conflict'),'inspect_company_job')
        review.capture(record('conflict',platform='',verification='posting_read_not_confirmed_open',location='Chennai'),'inspect_linkedin_job')
        counts=review.review_job_results(limit=10)['counts']
        self.assertEqual(counts['confirmed_match'],0)
        self.assertEqual(counts['closed'],1)
        self.assertEqual(counts['uncertain'],2)

    def test_pagination_limits_and_no_model_supplied_records(self):
        review=JobReview()
        for index in range(101):
            review.capture(record(str(index)),'search_company_jobs')
        first=review.review_job_results(limit=3)
        second=review.review_job_results(limit=3,offset=first['next_offset'])
        self.assertTrue(first['capture_truncated'])
        clipped=JobReview();clipped.capture({'jobs':[record()],'results_truncated':True},'search_company_jobs')
        self.assertTrue(clipped.review_job_results()['capture_truncated'])
        self.assertEqual(first['unique_jobs'],100)
        self.assertEqual(len(first['jobs']),3)
        self.assertFalse({job['source_url'] for job in first['jobs']} & {job['source_url'] for job in second['jobs']})
        self.assertEqual(review.review_job_results(category='excluded')['jobs'],[])
        for args in ({'jobs':'[]'},{'max_experience':True},{'category':'invented'}):
            if args.get('category')=='invented':
                self.assertEqual(review.tools[0].invoke(args)['status'],'error')
            else:
                with self.assertRaises(ToolError):
                    review.tools[0].invoke(args)

    def test_collection_is_reset_between_agent_runs_and_registry_is_fixed(self):
        review=JobReview()
        @tool(name='inspect_company_job')
        def inspect(url: str) -> dict:
            return record()
        tools=[review.wrap(inspect),*review.tools]
        client=FakeClient(assistant(calls=[call('inspect_company_job',{'url':'https://jobs.lever.co/example/one'})]),
                          assistant(calls=[call('review_job_results',{})]),assistant('One match'),
                          assistant(calls=[call('review_job_results',{})]),assistant('No new evidence'))
        agent=Agent(tools=tools,client=client)
        first=agent.run('Search')
        self.assertTrue(any('"confirmed_match": 1' in m.get('content','') for m in first.messages if m['role']=='tool'))
        second=agent.run('Review again')
        review_message=next(m for m in second.messages if m.get('tool_name')=='review_job_results')
        self.assertEqual(json.loads(review_message['content'])['result']['unique_jobs'],0)
        self.assertEqual(build_capabilities(['calculator'])[0][0].name,'calculate')
        self.assertNotIn('review_job_results',{t.name for t in build_capabilities(['writing'])[0]})
        self.assertIn('verify_job_application',{t.name for t in build_capabilities(['web_research'])[0]})
