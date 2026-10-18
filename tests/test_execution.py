"""Real subprocess isolation and deadlines; inference fixtures use loopback only."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import uuid
from unittest.mock import patch

from agentos import ProviderError
from agentos.execution import run_isolated, _start_worker
from agentos.storage import WorkspaceStore
from agentos.web import make_server
from test_http_cli import server, response
from test_run_events import post


def config(url='http://127.0.0.1:1'):
    return {'provider':'ollama','model':'fixture','api_key':'','base_url':url,'timeout':120,
            'capabilities':['calculator'],'file_directory':'','name':'Assistant','instructions':'Use trusted tools.',
            'max_steps':8,'max_tool_calls':16,'prompt':'Double two','history':[]}


@contextmanager
def hanging_provider():
    entered = threading.Event()
    release = threading.Event()
    calls = []
    tool = {'function':{'name':'calculate','arguments':{'a':2,'operation':'multiply','b':2}}}
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            if len(calls) == 1:
                body = response('',[tool])
            else:
                entered.set()
                release.wait(10)
                body = response('Released')
            try:
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(body).encode())
            except OSError:
                pass
        def log_message(self,*args):
            pass
    httpd = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = threading.Thread(target=httpd.serve_forever,daemon=True); thread.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_port}',entered,calls
    finally:
        release.set();httpd.shutdown();httpd.server_close();thread.join()


def fixture_worker(source):
    return subprocess.Popen([sys.executable,'-c',source],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,start_new_session=os.name=='posix')


class ExecutionTests(unittest.TestCase):
    def test_real_worker_tool_roundtrip_followup_and_reaping(self):
        call = {'function':{'name':'calculate','arguments':{'a':2,'operation':'multiply','b':2}}}
        processes=[]
        def start():
            process=_start_worker(); processes.append(process); return process
        events=[]
        with server([(200,response('',[call])),(200,response('Four')),(200,response('Earlier answer was four'))]) as (url, requests), patch('agentos.execution._start_worker',side_effect=start):
            first=run_isolated(config(url),run_timeout=5,on_event=events.append)
            second=run_isolated({**config(url),'prompt':'What was the answer?','history':first.conversation},run_timeout=5)
        self.assertEqual((first.content,first.tool_calls),('Four',1))
        self.assertEqual(second.content,'Earlier answer was four')
        self.assertIn('Four',requests[-1][1]['messages'][2]['content'])
        self.assertEqual([e['type'] for e in events],['model_start','model_end','tool_start','tool_end','model_start','model_end'])
        self.assertTrue(all(p.poll() is not None and p.stdout.closed and p.stdin.closed for p in processes))

    def test_deadline_kills_blocked_model_and_preserves_tool_evidence(self):
        with hanging_provider() as (url, entered, _):
            start=time.monotonic()
            result=run_isolated(config(url),run_timeout=1.5)
            self.assertTrue(entered.is_set())
            self.assertLess(time.monotonic()-start,4)
            self.assertEqual((result.finish_reason,result.limit_reason,result.tool_calls),('timed_out','run_timeout',1))
            self.assertEqual(json.loads([m for m in result.messages if m['role']=='tool'][0]['content'])['result'],4)
            self.assertEqual(result.conversation[-1]['status'],'timed_out')

    def test_stop_interrupts_blocked_model_with_checkpoint(self):
        stop=threading.Event()
        def event(item):
            if item['type']=='model_start' and item['step']==2:
                stop.set()
        with hanging_provider() as (url, _, _):
            result=run_isolated(config(url),run_timeout=5,on_event=event,should_stop=stop.is_set)
        self.assertEqual((result.finish_reason,result.tool_calls),('cancelled',1))

    @unittest.skipUnless(os.name=='posix','POSIX process-group cleanup')
    def test_deadline_kills_group_members_even_when_worker_is_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_path=Path(directory)/'child.pid'
            source=("import json,sys,subprocess,time\n"
                    "config=json.load(sys.stdin)\n"
                    "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
                    f"open({str(pid_path)!r},'w').write(str(child.pid))\n"
                    "print(json.dumps({'type':'checkpoint','data':{'messages':[{'role':'user','content':'Hi'}],'model_calls':1,'tool_calls':0}}),flush=True)\n"
                    "time.sleep(60)\n")
            processes=[]
            def start():
                process=fixture_worker(source);processes.append(process);return process
            with patch('agentos.execution._start_worker',side_effect=start):
                result=run_isolated(config(),run_timeout=.5)
            self.assertEqual(result.finish_reason,'timed_out')
            self.assertTrue(all(p.poll() is not None for p in processes))
            child_pid=int(pid_path.read_text())
            status=subprocess.run(['ps','-o','stat=','-p',str(child_pid)],capture_output=True,text=True).stdout.strip()
            self.assertTrue(not status or status.startswith('Z'),status)

    def test_worker_exit_bad_protocol_and_callback_error_cleanup(self):
        for source in ('import sys; sys.stdin.read(); sys.exit(2)',
                       "import sys; sys.stdin.read(); print('x'*300,flush=True)"):
            processes=[]
            def start():
                process=fixture_worker(source);processes.append(process);return process
            with self.subTest(source=source), patch('agentos.execution._start_worker',side_effect=start), patch('agentos.execution.MAX_MESSAGE_BYTES',256):
                with self.assertRaises(ProviderError):
                    run_isolated(config(),run_timeout=3)
                self.assertTrue(all(p.poll() is not None for p in processes))
        processes=[]
        def start():
            process=_start_worker();processes.append(process);return process
        def fail(event):
            raise RuntimeError('Trusted observer failed')
        with patch('agentos.execution._start_worker',side_effect=start), self.assertRaises(RuntimeError):
            run_isolated(config(),run_timeout=3,on_event=fail)
        self.assertTrue(all(p.poll() is not None for p in processes))

    def test_watchdog_enforces_lifetime_when_observer_is_blocked(self):
        source=("import sys,json,time\njson.load(sys.stdin)\n"
                "print(json.dumps({'type':'event','data':{'type':'model_start'}}),flush=True)\n"
                "time.sleep(60)\n")
        processes=[]
        def start():
            process=fixture_worker(source);processes.append(process);return process
        def blocked(event):
            threading.Event().wait(.5)
            self.assertIsNotNone(processes[0].poll())
        with patch('agentos.execution._start_worker',side_effect=start):
            result=run_isolated(config(),run_timeout=.3,on_event=blocked)
        self.assertEqual(result.finish_reason,'timed_out')

    def test_server_close_stops_active_worker(self):
        with hanging_provider() as (url, entered, _):
            httpd=make_server(0,request_token='x'*32,isolate_runs=True)
            thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
            result=[]
            def request():
                with post(f'http://127.0.0.1:{httpd.server_port}','/api/run',{
                    'provider':'ollama','model':'fixture','base_url':url,'prompt':'Hi','capabilities':['calculator']}) as output:
                    result.append(json.load(output))
            caller=threading.Thread(target=request,daemon=True);caller.start()
            try:
                self.assertTrue(entered.wait(4))
            finally:
                httpd.shutdown();httpd.server_close();thread.join();caller.join(timeout=3)
            self.assertFalse(caller.is_alive())
            self.assertEqual(result[0]['finish_reason'],'cancelled')

    def test_isolated_http_deadline_history_and_next_run(self):
        with tempfile.TemporaryDirectory() as directory, hanging_provider() as (url, _, _):
            path=Path(directory)/'workspace.sqlite3'
            httpd=make_server(0,request_token='x'*32,storage_path=path,isolate_runs=True)
            thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
            workspace=f'http://127.0.0.1:{httpd.server_port}'
            try:
                with urllib.request.urlopen(workspace+'/api/workspace') as output:
                    self.assertTrue(json.load(output)['isolated_runs'])
                payload={'provider':'ollama','model':'fixture','base_url':url,'prompt':'Double two',
                         'run_timeout':5,'timeout':120,'capabilities':['calculator'],'run_id':str(uuid.uuid4()),'save_history':True}
                request=urllib.request.Request(workspace+'/api/run/stream',data=json.dumps(payload).encode(),headers={
                    'Content-Type':'application/json','X-AgentOS-Token':'x'*32})
                with urllib.request.urlopen(request,timeout=9) as output:
                    events=[json.loads(line) for line in output]
                result=events[-1]['data']
                self.assertEqual((events[-1]['type'],result['finish_reason'],result['tool_calls']),('result','timed_out',1))
                self.assertEqual(WorkspaceStore(path).get('runs',result['history_id'])['data']['result']['finish_reason'],'timed_out')
                with server([(200,response('Recovered'))]) as (fast,_):
                    with post(workspace,'/api/run',{**payload,'base_url':fast,'save_history':False,'history':result['conversation']}) as output:
                        self.assertEqual(json.load(output)['content'],'Recovered')
            finally:
                httpd.shutdown();httpd.server_close();thread.join()
