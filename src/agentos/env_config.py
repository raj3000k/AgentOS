"""Explicit, data-only credential-file loading for CLI runs."""
import os
from pathlib import Path
import re


def api_key_from_env(name, env_file=None):
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
        raise ValueError('Invalid API key environment variable name')
    if env_file is None:
        return os.environ.get(name, '')
    try:
        with Path(env_file).open('rb') as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError('Environment file exceeds 64 KB')
        text = raw.decode('utf-8')
    except (OSError, UnicodeError):
        raise ValueError('Cannot read environment file as UTF-8') from None
    value = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, candidate = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key.strip()):
            raise ValueError('Environment file must contain KEY=value entries only')
        if key.strip() != name:
            continue
        if value is not None:
            raise ValueError('Duplicate API key entry in environment file')
        candidate = candidate.strip()
        if candidate.startswith(('"', "'")):
            if len(candidate) < 2 or candidate[-1] != candidate[0]:
                raise ValueError('Invalid quoted API key entry')
            candidate = candidate[1:-1]
        if not candidate or any(ord(char) < 33 or ord(char) > 126 for char in candidate):
            raise ValueError('API key entry must contain a nonempty printable key without spaces')
        value = candidate
    if value is None:
        raise ValueError('Requested API key entry is missing from environment file')
    # Explicit file selection takes precedence; never export it into process environment.
    return value
