"""Explicit local SQLite agent profiles and run records. No credential storage."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
import urllib.parse
import uuid

from .capabilities import validate_selection
from .providers import PROVIDERS


def profile_data(data):
    if not isinstance(data, dict):
        raise ValueError("Expected an agent object")
    result = {}
    for field, default, maximum in [('name', 'Assistant', 80), ('purpose', '', 400), ('instructions', 'You are a helpful assistant.', 8000),
                                    ('model', 'qwen3:8b', 200), ('provider', 'ollama', 30), ('base_url', '', 2048)]:
        value = data.get(field, default)
        if not isinstance(value, str) or len(value) > maximum or (field in ('name', 'model', 'instructions') and not value.strip()):
            raise ValueError('Invalid agent profile')
        result[field] = value.strip()
    if result['provider'] not in (*PROVIDERS, 'ollama', 'custom'):
        raise ValueError('Unknown provider')
    if result['base_url']:
        url = urllib.parse.urlsplit(result['base_url'])
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Endpoint must not contain credentials or query parameters')
        url.port
    result['capabilities'] = validate_selection(data.get('capabilities', []))
    starters = data.get('starter_prompts', [])
    if not isinstance(starters, list) or len(starters) > 3 or any(not isinstance(value, str) or len(value) > 500 for value in starters):
        raise ValueError('Invalid starter prompts')
    result['starter_prompts'] = starters
    for key, default, low, high in [('max_steps', 16, 1, 32), ('max_tool_calls', 24, 0, 64), ('run_timeout', 300, 5, 1800), ('timeout', 120, 1, 300)]:
        value = data.get(key, default)
        valid_type = type(value) in (int, float) if key == 'timeout' else type(value) is int
        if not valid_type or not math.isfinite(value) or not low <= value <= high:
            raise ValueError('Invalid execution limits')
        result[key] = value
    return result


class WorkspaceStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink():
            raise ValueError('Workspace database cannot be a symlink')
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version > 1:
                raise ValueError('Workspace database is newer than this AgentOS version')
            if version == 0:
                db.execute('CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)')
                db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)')
                db.execute('CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC)')
                db.execute('PRAGMA user_version=1')
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA secure_delete=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def save_agent(self, data, agent_id=None):
        profile = profile_data(data)
        stamp = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            if agent_id:
                self._id(agent_id)
                cursor = db.execute('UPDATE agents SET name=?, data=?, updated_at=? WHERE id=?',
                                    (profile['name'], json.dumps(profile), stamp, agent_id))
                if not cursor.rowcount:
                    raise KeyError('Agent not found')
            else:
                agent_id = str(uuid.uuid4())
                db.execute('INSERT INTO agents VALUES(?,?,?,?,?)', (agent_id, profile['name'], json.dumps(profile), stamp, stamp))
        return self.get('agents', agent_id)

    def save_run(self, profile, prompt, result=None, error=None):
        if not isinstance(prompt, str) or len(prompt) > 20000:
            raise ValueError('Invalid prompt')
        data = {'profile': profile_data(profile), 'prompt': prompt}
        if result is not None:
            # Persist only public RunResult fields; never the HTTP request/client configuration.
            data['result'] = {key: result[key] for key in ('content', 'messages', 'model_calls', 'tool_calls', 'finish_reason', 'limit_reason', 'elapsed', 'provider', 'model', 'conversation', 'context_error') if key in result}
            status = result.get('finish_reason', 'completed')
        else:
            data['error'] = str(error)[:500]
            status = 'error'
        encoded = json.dumps(data, allow_nan=False)
        if len(encoded.encode()) > 4_000_000:
            raise ValueError('Run exceeds the 4 MB storage limit')
        run_id = str(uuid.uuid4())
        with self.connect() as db:
            db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?)', (run_id, data['profile']['name'], prompt[:240], status, encoded, datetime.now(timezone.utc).isoformat()))
        return run_id

    def list(self, table, offset=0):
        self._table(table)
        if type(offset) is not int or not 0 <= offset <= 1000000:
            raise ValueError("Invalid list offset")
        with self.connect() as db:
            if table == 'agents':
                records = db.execute('SELECT id,name,created_at,updated_at FROM agents ORDER BY updated_at DESC,id DESC LIMIT 50 OFFSET ?', (offset,)).fetchall()
            else:
                records = db.execute('SELECT id,agent_name,prompt,status,created_at FROM runs ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?', (offset,)).fetchall()
        return [dict(row) for row in records]

    def get(self, table, item_id):
        self._table(table)
        self._id(item_id)
        with self.connect() as db:
            record = db.execute(f'SELECT * FROM {table} WHERE id=?', (item_id,)).fetchone()
        if record is None:
            raise KeyError('Item not found')
        item = dict(record)
        item['data'] = json.loads(item['data'])
        return item

    def delete(self, table, item_id):
        self._table(table)
        self._id(item_id)
        with self.connect() as db:
            if not db.execute(f'DELETE FROM {table} WHERE id=?', (item_id,)).rowcount:
                raise KeyError('Item not found')

    @staticmethod
    def _table(table):
        if table not in ('agents', 'runs'):
            raise ValueError('Invalid collection')

    @staticmethod
    def _id(value):
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError('Invalid item ID')
