"""Bounded task planning, actual evidence references and honest completion checks."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import threading
import unittest

from agentos import Agent, tool
from agentos.errors import ToolError
from agentos.tools import execute_tool
from agentos.planning import TaskPlan
from agentos.execution import run_isolated
from agentos.storage import WorkspaceStore, profile_data
from test_agent import FakeClient, assistant, call, double
from test_http_cli import server, response
from test_execution import config


def proposal():
    return json.dumps({'steps':[{'title':'Calculate the value','criterion':'Double two using the enabled calculator.'},
                                {'title':'Present the result','criterion':'Give a concise answer with limitations.'}]})


def update(step='s1',status='completed',note='Doubled two and obtained four',refs='e1'):
    return call('update_task_plan',{'step_id':step,'status':status,'note':note,'evidence_refs':refs})


class PlanningTests(unittest.TestCase):
    def test_plan_progress_evidence_and_counts_are_within_existing_budgets(self):
        events=[]
        client=FakeClient(assistant(proposal()),assistant(calls=[call(),update()]),
                          assistant(calls=[update('s2',note='Prepared the concise answer',refs='')]),assistant('Four'))
        agent=Agent(tools=[double],client=client,max_steps=6)
        result=agent.run('Double two',plan_task=True,on_event=events.append)
        self.assertEqual((result.model_calls,result.tool_calls),(4,3))
        self.assertEqual(client.requests[0]['tools'],[])
        self.assertEqual({entry['function']['name'] for entry in client.requests[1]['tools']},{'double','update_task_plan'})
        self.assertEqual(set(agent.tools),{'double'})
        self.assertTrue(result.plan['checks']['all_steps_marked_completed'])
        self.assertFalse(result.plan['checks']['independently_verified'])
        self.assertEqual(result.plan['steps'][0]['evidence'],['e1'])
        self.assertEqual([event['type'] for event in events].count('plan_update'),2)
        self.assertEqual([e['name'] for e in result.conversation[0]['evidence']],['double'])
        # A fresh run on the same Agent has no implicit plan or registered control tool.
        agent.client=FakeClient(assistant('Fresh'))
        fresh=agent.run('Hello')
        self.assertIsNone(fresh.plan)
        self.assertEqual({entry['function']['name'] for entry in agent.client.requests[0]['tools']},{'double'})

    def test_final_answer_does_not_silently_complete_unreported_steps(self):
        result=Agent(client=FakeClient(assistant(proposal()),assistant('Here is an answer')),max_steps=4).run('Task',plan_task=True)
        self.assertEqual(result.finish_reason,'completed')
        self.assertFalse(result.plan['checks']['all_steps_marked_completed'])
        self.assertEqual(result.plan['completed'],0)
        self.assertTrue(all(step['status']=='pending' for step in result.plan['steps']))

    def test_invalid_unknown_failed_and_self_cited_evidence_cannot_complete_step(self):
        plan=TaskPlan(assistant(proposal()),'Task')
        for args in [('invented','completed','Done',''),('s1','completed','',''),('s1','completed','Done','e99'),
                     ('s1','anything','Done','')]:
            with self.subTest(args=args),self.assertRaises(ToolError):
                plan.update_task_plan(*args)
        ref=plan.record_evidence('unknown',{'ok':False})
        with self.assertRaises(ToolError):
            plan.update_task_plan('s1','completed','Done',ref)
        self.assertEqual(plan.snapshot()['completed'],0)
        plan.update_task_plan('s1','blocked','The required source is unavailable')
        self.assertTrue(plan.snapshot()['checks']['has_blocked_steps'])
        snapshot=plan.snapshot();snapshot['steps'][0]['status']='completed'
        self.assertEqual(plan.snapshot()['steps'][0]['status'],'blocked')
        # Runtime rejects fabricated references and returns a recoverable tool error.
        result=Agent(client=FakeClient(assistant(proposal()),assistant(calls=[update(refs='e999')]),assistant('Incomplete')),max_steps=5).run('Task',plan_task=True)
        self.assertEqual(result.plan['completed'],0)
        self.assertFalse(json.loads([m for m in result.messages if m['role']=='tool'][0]['content'])['ok'])
        # Progress tool replies stay small even when all plan fields use Unicode.
        unicode_plan=TaskPlan(assistant(json.dumps({'steps':[{'title':'क'*120,'criterion':'क'*250} for _ in range(6)]},ensure_ascii=False)),'Task')
        registry={entry.name:entry for entry in unicode_plan.tools}
        for index in range(6):
            output=execute_tool(registry,'update_task_plan',{'step_id':f's{index+1}','status':'completed','note':'क'*400})
            self.assertTrue(json.loads(output)['ok'])
        self.assertEqual(unicode_plan.snapshot()['completed'],6)


    def test_malformed_plan_has_safe_fallback_and_never_executes_planning_calls(self):
        executed=[]
        @tool
        def record():
            executed.append(True)
        for message in (assistant('Not JSON'),assistant(calls=[call('record',{})]),
                        assistant(json.dumps({'steps':[{'title':'X','criterion':'Y','execute':'shell'}]})),
                        assistant(json.dumps({'steps':[]}))):
            client=FakeClient(message,assistant('Task answer'))
            result=Agent(tools=[record],client=client,max_steps=4).run('User task',plan_task=True)
            self.assertEqual((result.model_calls,result.tool_calls),(2,0))
            self.assertEqual(result.plan['total'],1)
            self.assertTrue(result.plan['warning'])
        self.assertEqual(executed,[])

    def test_planning_and_control_calls_cannot_exceed_budgets(self):
        client=FakeClient(assistant(proposal()),assistant(calls=[update(refs='')]))
        result=Agent(client=client,max_steps=2).run('Task',plan_task=True)
        self.assertEqual((result.model_calls,result.tool_calls),(2,0))
        self.assertEqual(client.requests[-1]['tools'],[])
        self.assertEqual(result.finish_reason,'partial')
        self.assertEqual(result.plan['completed'],0)
        for kwargs in ({'max_steps':1},{'tools':TaskPlan(assistant(proposal()),'Task').tools}):
            client=FakeClient()
            with self.assertRaises(ValueError):
                Agent(client=client,**kwargs).run('Task',plan_task=True)
            self.assertEqual(client.requests,[])
        with self.assertRaises(ValueError):
            Agent().run('Task',plan_task='yes')

    def test_cancel_after_progress_preserves_plan_without_claiming_other_steps(self):
        stop=threading.Event()
        def event(value):
            if value['type']=='plan_update':
                stop.set()
        result=Agent(tools=[double],client=FakeClient(assistant(proposal()),assistant(calls=[call(),update(),call()])),max_steps=5).run(
            'Task',plan_task=True,on_event=event,should_stop=stop.is_set)
        self.assertEqual((result.finish_reason,result.tool_calls),('cancelled',2))
        self.assertEqual(result.plan['completed'],1)
        self.assertFalse(result.plan['checks']['all_steps_marked_completed'])

    def test_worker_deadline_retains_latest_plan_checkpoint(self):
        release=threading.Event()
        calculate=call('calculate',{'a':2,'operation':'multiply','b':2})
        requests=[]
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                if len(requests)==1:
                    body=response(proposal())
                elif len(requests)==2:
                    body=response('',[calculate,update()])
                else:
                    release.wait(10)
                    body=response('Too late')
                try:
                    self.send_response(200);self.end_headers();self.wfile.write(json.dumps(body).encode())
                except OSError:
                    pass
            def log_message(self,*args):
                pass
        httpd=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        worker=threading.Thread(target=httpd.serve_forever,daemon=True);worker.start()
        try:
            result=run_isolated({**config(f'http://127.0.0.1:{httpd.server_port}'),'plan_task':True},run_timeout=1.5)
            self.assertEqual(result.finish_reason,'timed_out')
            self.assertEqual(result.plan['completed'],1)
            self.assertEqual(result.plan['steps'][0]['evidence'],['e1'])
            self.assertEqual(result.plan['steps'][1]['status'],'pending')
            self.assertFalse(result.plan['checks']['all_steps_marked_completed'])
        finally:
            release.set();httpd.shutdown();httpd.server_close();worker.join()

    def test_real_worker_plan_events_and_archive_fields(self):
        calculate=call('calculate',{'a':2,'operation':'multiply','b':2})
        events=[]
        responses=[(200,response(proposal())),(200,response('',[calculate,update()])),
                   (200,response('',[update('s2',note='Prepared the answer',refs='')])),(200,response('Four'))]
        with server(responses) as (url,requests):
            result=run_isolated({**config(url),'plan_task':True},run_timeout=5,on_event=events.append)
        self.assertTrue(result.plan['checks']['all_steps_marked_completed'])
        self.assertIn('plan_ready',[e['type'] for e in events])
        self.assertEqual(requests[0][1]['tools'],[])
        with tempfile.TemporaryDirectory() as directory:
            store=WorkspaceStore(Path(directory)/'workspace.sqlite3')
            run_id=store.save_run({'name':'Planner','plan_task':True},'Task',asdict(result))
            data=store.get('runs',run_id)['data']
            self.assertTrue(data['profile']['plan_task'])
            self.assertEqual(data['result']['plan'],result.plan)
        self.assertFalse(profile_data({})['plan_task'])
        with self.assertRaises(ValueError):
            profile_data({'plan_task':'yes'})
