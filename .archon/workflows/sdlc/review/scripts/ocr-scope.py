"""Deterministic review scope through open-code-review delegation (LWOS fork).

Runs `ocr delegate preview` for the commit under review against its base and `ocr delegate rule`
for the reviewable files, and writes the result beside scope.md so every lens reads the same
file list and rule text instead of deciding on its own whether to delegate. Never fails the
review: when `ocr` or the project's rule file is absent it records why and the lenses proceed as
before. Reads nothing from a model and makes no network call (OCR delegation is offline).
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

artifacts = Path(os.environ["ARTIFACTS_DIR"]) / "review"
artifacts.mkdir(parents=True, exist_ok=True)
out_json = artifacts / "ocr-scope.json"
out_md = artifacts / "ocr-rules.md"
scope_input = json.loads(os.environ.get("INPUTS_SCOPE") or "{}")


def finish(result: dict) -> None:
    out_json.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({
        "available": result["available"],
        "reviewable_count": len(result.get("reviewable_files", [])),
        "bundle_count": len(result.get("bundles", [])),
        "summary": result["summary"],
    }))


def unavailable(reason: str) -> None:
    out_md.write_text(f"# OCR delegation\n\nNot available for this review: {reason}\n")
    finish({"available": False, "reason": reason, "summary": f"OCR delegation not available: {reason}"})


def run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, check=False)


ocr = shutil.which("ocr")
if not ocr:
    unavailable("the ocr command is not installed on this host")
    raise SystemExit(0)
if not Path(".opencodereview/rule.json").is_file():
    unavailable("the checkout has no .opencodereview/rule.json")
    raise SystemExit(0)

head = run(["git", "rev-parse", "HEAD"]).stdout.strip()
# The pull request's own base branch is authoritative. scope.md is free text written by an agent and may
# quote identifiers in backticks after the word "base" (run e86c6487 read `_lwos_bytes` that way), so it is
# consulted only through its Target line, and only when the pull request cannot be asked.
base = None
pr = scope_input.get("pr") or {}
if pr.get("number"):
    r = run(["gh", "pr", "view", str(pr["number"]), "--repo", pr["repo"]["path"], "--json", "baseRefName", "--jq", ".baseRefName"])
    base = r.stdout.strip() or None
scope_md = artifacts / "scope.md"
if not base and scope_md.is_file():
    m = re.search(r"^PR \S+ \([^)]*\), base `([^`]+)`", scope_md.read_text(), re.MULTILINE)
    if m:
        base = m.group(1)
if not base:
    r = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    base = r.stdout.strip().removeprefix("origin/") or None
if not base:
    unavailable("no base branch could be determined from the pull request, the Target line of scope.md or origin/HEAD")
    raise SystemExit(0)

run(["git", "fetch", "origin", base])  # a stale local base would scope a diff the pull request does not have
preview = run([ocr, "delegate", "preview", "--format", "json", "--from", f"origin/{base}", "--to", head])
if preview.returncode != 0:
    unavailable(f"ocr delegate preview exited {preview.returncode}: {preview.stderr.strip()[-300:]}")
    raise SystemExit(0)
pv = json.loads(preview.stdout)
files = [f["path"] for f in pv.get("reviewable_files", [])]
excluded = [{"path": f["path"], "reason": f.get("exclude_reason")} for f in pv.get("excluded_files", [])]
bundles = []
if files:
    rules = run([ocr, "delegate", "rule", "--format", "json", *files])
    if rules.returncode != 0:
        unavailable(f"ocr delegate rule exited {rules.returncode}: {rules.stderr.strip()[-300:]}")
        raise SystemExit(0)
    for g in json.loads(rules.stdout).get("groups", []):
        bundles.append({"group_id": g["group_id"], "source": g["source"], "pattern": g["pattern"], "files": g["files"], "rule": g["rule"]})

lines = [
    "# OCR delegation",
    "",
    f"Commit under review `{head}` against `origin/{base}` (merge base `{pv.get('merge_base')}`): "
    f"{len(files)} reviewable file(s) in {len(bundles)} rule bundle(s); {len(excluded)} excluded by OCR.",
    "",
    "Every reviewable file below is in scope and is judged against its bundle's rule text. Files OCR cannot read "
    "(`unsupported_ext`) are still read from the diff when they carry policy (access CSV, install list, READMEs).",
    "",
]
for b in bundles:
    lines += [f"## Bundle {b['group_id']}: {b['source']} / `{b['pattern']}`", "", "Files:"]
    lines += [f"- `{p}`" for p in b["files"]]
    lines += ["", "Rule text:", "", b["rule"], ""]
if excluded:
    lines += ["## Excluded by OCR", ""] + [f"- `{e['path']}` ({e['reason']})" for e in excluded] + [""]
out_md.write_text("\n".join(lines))
finish({
    "available": True,
    "base": base,
    "head": head,
    "merge_base": pv.get("merge_base"),
    "reviewable_files": files,
    "excluded_files": excluded,
    "bundles": [{k: v for k, v in b.items() if k != "rule"} for b in bundles],
    "rules_path": str(out_md),
    "summary": f"OCR delegation: {len(files)} reviewable file(s) in {len(bundles)} bundle(s) at {head[:7]} against origin/{base} (merge base {str(pv.get('merge_base'))[:7]})",
})
