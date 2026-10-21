import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agentos.env_config import api_key_from_env


class EnvConfigTests(unittest.TestCase):
    def test_explicit_file_literal_key_and_no_environment_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.local'
            path.write_text("# local only\nOTHER=value\nGEMINI_API_KEY='literal-$(touch sentinel)-key'\n")
            with self.assertRaises(ValueError):
                api_key_from_env('GEMINI_API_KEY', path)
            path.write_text('GEMINI_API_KEY="literal-$(whoami)-key"\n')
            with patch.dict(os.environ, {'GEMINI_API_KEY': 'exported'}):
                self.assertEqual(api_key_from_env('GEMINI_API_KEY', path), 'literal-$(whoami)-key')
                self.assertEqual(api_key_from_env('GEMINI_API_KEY'), 'exported')
                self.assertEqual(os.environ['GEMINI_API_KEY'], 'exported')

    def test_invalid_files_do_not_echo_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.local'
            for text in ('GEMINI_API_KEY=secret\nGEMINI_API_KEY=secret', 'GEMINI_API_KEY="secret',
                         'GEMINI_API_KEY=', 'OTHER=secret', 'secret malformed', 'x' * 65537):
                path.write_text(text)
                with self.assertRaises(ValueError) as caught:
                    api_key_from_env('GEMINI_API_KEY', path)
                self.assertNotIn('secret', str(caught.exception))
            with self.assertRaises(ValueError):
                api_key_from_env('GEMINI_API_KEY', Path(directory) / 'missing')
