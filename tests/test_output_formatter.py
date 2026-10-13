from pathlib import Path
import shutil
import subprocess
import unittest


class OutputFormatterTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node is optional for frontend verification')
    def test_formatting_interactions_and_untrusted_markup(self):
        root = Path(__file__).resolve().parent.parent
        result = subprocess.run(['node', str(root / 'tests/output_renderer.js'),
                                 str(root / 'src/agentos/static/output.js')],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
