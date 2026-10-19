"""LWOS: the review's OCR scope takes its base from the pull request, never from prose in scope.md.

Run: python3 scripts/lwos/test_ocr_scope.py  (no network; fake `ocr` and `gh` on PATH, a local bare origin)
"""

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / ".archon/workflows/sdlc/review/scripts/ocr-scope.py"
SCOPE_MD = textwrap.dedent("""\
    ## 1. Contract
    The PR discloses a deviation: base `_lwos_bytes` lives in `lwos_ai`.

    ## 2. Target
    PR https://github.com/o/r/pull/7 (o/r), base `v19-dev`, head branch `archon/task`.
    """)


def sh(*argv, cwd):
    subprocess.run(argv, cwd=cwd, check=True, capture_output=True)


class OcrScopeBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        origin, work, self.bin = self.tmp / "origin.git", self.tmp / "work", self.tmp / "bin"
        self.bin.mkdir()
        sh("git", "init", "-q", "--bare", str(origin), cwd=self.tmp)
        sh("git", "init", "-q", "-b", "v19-dev", str(work), cwd=self.tmp)
        (work / ".opencodereview").mkdir()
        (work / ".opencodereview/rule.json").write_text("{}")
        sh("git", "add", ".", cwd=work)
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init", cwd=work)
        sh("git", "remote", "add", "origin", str(origin), cwd=work)
        sh("git", "push", "-q", "origin", "v19-dev", cwd=work)
        self.work = work
        self.calls = self.tmp / "ocr-calls.txt"
        (self.bin / "ocr").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env python3
            import json, sys
            open({str(self.calls)!r}, "a").write(" ".join(sys.argv[1:]) + "\\n")
            if sys.argv[1:3] == ["delegate", "preview"]:
                print(json.dumps({{"reviewable_files": [], "merge_base": "abc"}}))
            else:
                print(json.dumps({{"bundles": []}}))
            """))
        (self.bin / "ocr").chmod(0o755)
        self.artifacts = self.tmp / "artifacts"
        (self.artifacts / "review").mkdir(parents=True)
        (self.artifacts / "review/scope.md").write_text(SCOPE_MD)

    def run_scope(self, gh_base, pr_number=7):
        (self.bin / "gh").write_text(f"#!/bin/sh\necho '{gh_base}'\n")
        (self.bin / "gh").chmod(0o755)
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", ARTIFACTS_DIR=str(self.artifacts),
                   INPUTS_SCOPE=json.dumps({"pr": {"number": pr_number, "repo": {"path": "o/r"}}} if pr_number else {}))
        subprocess.run(["python3", str(SCRIPT)], cwd=self.work, env=env, check=True, capture_output=True)
        return self.calls.read_text()

    def test_the_pull_request_base_wins_over_prose_in_scope_md(self):
        calls = self.run_scope("v19-dev")
        self.assertIn("--from origin/v19-dev", calls)
        self.assertNotIn("_lwos_bytes", calls)

    def test_without_a_pull_request_only_the_target_line_is_read(self):
        calls = self.run_scope("", pr_number=None)
        self.assertIn("--from origin/v19-dev", calls)
        self.assertNotIn("_lwos_bytes", calls)


if __name__ == "__main__":
    unittest.main()
