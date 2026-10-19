"""Bounded visible task plans; progress claims are model assessments, not proof."""
from copy import deepcopy
import json

from .errors import ToolError
from .tools import tool

PLAN_PROMPT = '''Before doing the task, return only a JSON object {"steps":[{"title":"...","criterion":"..."}]}.
Write 1–6 concise, actionable steps and one observable completion criterion per step.
Titles are at most 120 characters and criteria at most 250. Outline actions/outcomes, not hidden reasoning.
Respect the user's actual task and the tools already enabled. Do not invent capabilities or execute tools.
Do not answer the task yet. No Markdown fences or other fields.'''


class TaskPlan:
    def __init__(self, message, prompt):
        self.warning = None
        self.evidence = {}
        try:
            if (not isinstance(message, dict) or message.get('role') != 'assistant' or not isinstance(message.get('tool_calls', []), list) or message.get('tool_calls')
                    or not isinstance(message.get('content'), str) or len(message['content']) > 5000):
                raise ValueError()
            data = json.loads(message['content'])
            if not isinstance(data, dict) or set(data) != {'steps'} or not isinstance(data['steps'], list) or not 1 <= len(data['steps']) <= 6:
                raise ValueError()
            steps = []
            for entry in data['steps']:
                if not isinstance(entry, dict) or set(entry) != {'title', 'criterion'}:
                    raise ValueError()
                for key, maximum in [('title',120),('criterion',250)]:
                    if not isinstance(entry[key], str) or not entry[key].strip() or len(entry[key]) > maximum:
                        raise ValueError()
                steps.append({'title':entry['title'].strip(),'criterion':entry['criterion'].strip()})
        except (ValueError, TypeError, RecursionError):
            steps = [{'title':prompt.strip()[:120], 'criterion':'Address the requested outcome and explicitly report missing evidence or limitations.'}]
            self.warning = 'The model did not return a valid plan. A single task checkpoint is shown; no planning tool calls were executed.'
        self.steps = [{'id':f's{index+1}', **entry, 'status':'pending', 'note':'', 'evidence':[]}
                      for index, entry in enumerate(steps)]
        self.tools = [tool(self.update_task_plan)]

    def instructions(self):
        return ('Visible task plan (user-facing checkpoints, not hidden reasoning):\n'
                + json.dumps(self.snapshot())
                + '\nUse update_task_plan to report in_progress, completed or blocked steps. '
                'Completion requires a concise note addressing that step criterion. '
                'External tool results have evidence_ref values (e1, e2, ...); cite successful current-run '
                'references as comma-separated evidence_refs. Do not cite invented, failed or historical references. '
                'For writing or reasoning without tool evidence, leave references empty; this remains a model assessment. '
                'Updates consume the configured tool-call budget. Before the final answer, report each step status; '
                'leave blocked/incomplete work explicit. Never claim independent verification from a status update.')

    def record_evidence(self, name, envelope):
        reference = f'e{len(self.evidence)+1}'
        self.evidence[reference] = {'name':name, 'ok':envelope.get('ok') is True}
        return reference

    def update_task_plan(self, step_id: str, status: str, note: str = '', evidence_refs: str = '') -> dict:
        """Update a known visible plan step. status: pending/in_progress/completed/blocked. Completed/blocked needs a note. evidence_refs: comma-separated successful current-run e1,e2 identifiers, or empty for model-only assessment. This changes progress data only, never executes task actions."""
        step = next((entry for entry in self.steps if entry['id'] == step_id), None)
        if step is None or status not in ('pending','in_progress','completed','blocked') or len(note) > 400 or len(evidence_refs) > 200:
            raise ToolError('Invalid plan step, status, note or evidence references')
        references = list(dict.fromkeys(value.strip() for value in evidence_refs.split(',') if value.strip()))
        if len(references) > 12 or any(reference not in self.evidence or not self.evidence[reference]['ok'] for reference in references):
            raise ToolError('Cite only successful current-run tool evidence references')
        if status in ('completed','blocked') and not note.strip():
            raise ToolError('Completed or blocked steps require a note addressing the criterion')
        step.update(status=status, note=note.strip(), evidence=references)
        return {'step_id':step_id, 'status':status, 'note':step['note'], 'evidence':references,
                'completed':sum(entry['status']=='completed' for entry in self.steps), 'total':len(self.steps)}

    def snapshot(self):
        completed = sum(step['status']=='completed' for step in self.steps)
        return {'steps':deepcopy(self.steps), 'completed':completed, 'total':len(self.steps),
                'checks':{'all_steps_marked_completed':completed == len(self.steps),
                          'has_blocked_steps':any(step['status']=='blocked' for step in self.steps),
                          'evidence_references_valid':True, 'independently_verified':False},
                'warning':self.warning,
                'assessment':'Progress and criterion satisfaction are model-reported. AgentOS validates only reference existence and successful tool return, not factual correctness.'}
