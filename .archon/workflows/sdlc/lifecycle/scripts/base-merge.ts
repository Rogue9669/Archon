// Merge the base branch into the delivered pull request's branch when the merge
// queue held it on a base conflict, and resolve only the conflicts that are
// mechanical by construction: an append-only release-notes data file (both
// sides' records are kept) and a manifest whose only conflicting line is its
// version (the higher version, plus one). Anything else aborts the merge and
// leaves the checkout exactly as it was, so a human or a repair delivery sees
// the real conflict. Never a rebase: the review continuation that follows must
// find the previously reviewed commit in the branch's history.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface Result {
  resolved: boolean;
  new_head: string;
  files_resolved: string[];
  conflicts: string[];
  summary: string;
}

interface Command {
  code: number;
  stdout: string;
  stderr: string;
}

const versionLine = /^(\s*"version"\s*:\s*")(\d+(?:\.\d+)*)(",?\s*)$/;

function run(argv: string[]): Command {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function git(...args: string[]): Command {
  return run(['git', ...args]);
}

function emit(result: Result): void {
  const artifacts = process.env.ARTIFACTS_DIR;
  if (artifacts !== undefined && artifacts !== '') {
    const lines = ['# Base merge', '', result.summary];
    if (result.files_resolved.length > 0) {
      lines.push('', 'Resolved:', ...result.files_resolved.map((file) => `- ${file}`));
    }
    if (result.conflicts.length > 0) {
      lines.push('', 'Left unresolved:', ...result.conflicts.map((file) => `- ${file}`));
    }
    try {
      writeFileSync(join(artifacts, 'base-merge.md'), `${lines.join('\n')}\n`, 'utf8');
    } catch {
      // The JSON result below is the node's contract; the note is a convenience.
    }
  }
  console.log(JSON.stringify(result));
}

function head(): string {
  const result = git('rev-parse', 'HEAD');
  return result.code === 0 ? result.stdout.trim() : '';
}

function unresolved(): string[] {
  const result = git('diff', '--name-only', '--diff-filter=U');
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

interface Block {
  ours: string[];
  theirs: string[];
}

/**
 * Split a conflicted file into plain line runs and conflict blocks, reading the
 * markers git writes in the `merge` and `diff3`/`zdiff3` styles. A file whose
 * markers do not pair returns null.
 */
function blocks(text: string): (string[] | Block)[] | null {
  const parts: (string[] | Block)[] = [];
  let plain: string[] = [];
  let current: Block | null = null;
  let side: 'ours' | 'base' | 'theirs' = 'ours';
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<< ')) {
      if (current !== null) return null;
      parts.push(plain);
      plain = [];
      current = { ours: [], theirs: [] };
      side = 'ours';
    } else if (line.startsWith('||||||| ') && current !== null) {
      side = 'base';
    } else if (line === '=======' && current !== null) {
      side = 'theirs';
    } else if (line.startsWith('>>>>>>> ') && current !== null) {
      parts.push(current);
      current = null;
    } else if (current === null) {
      plain.push(line);
    } else if (side === 'ours') {
      current.ours.push(line);
    } else if (side === 'theirs') {
      current.theirs.push(line);
    }
  }
  if (current !== null) return null;
  parts.push(plain);
  return parts;
}

/** Both sides of every conflict, ours first: the union merge of an append-only file. */
function union(text: string): string | null {
  const parts = blocks(text);
  if (!parts?.some((part) => !Array.isArray(part))) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) out.push(...part);
    else out.push(...part.ours, ...part.theirs);
  }
  return out.join('\n');
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * A manifest whose every conflict is exactly its version line on both sides takes
 * the higher of the two versions with its last component raised by one, so the
 * merged branch sits strictly above both. Any other conflict shape returns null.
 */
function nextVersion(text: string): string | null {
  const parts = blocks(text);
  if (!parts?.some((part) => !Array.isArray(part))) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      out.push(...part);
      continue;
    }
    if (part.ours.length !== 1 || part.theirs.length !== 1) return null;
    const ours = versionLine.exec(part.ours[0] ?? '');
    const theirs = versionLine.exec(part.theirs[0] ?? '');
    if (ours === null || theirs === null) return null;
    const left = ours[2].split('.').map(Number);
    const right = theirs[2].split('.').map(Number);
    const higher = compareVersions(left, right) >= 0 ? left : right;
    const bumped = [...higher.slice(0, -1), (higher[higher.length - 1] ?? 0) + 1];
    out.push(`${ours[1]}${bumped.join('.')}${ours[3]}`);
  }
  return out.join('\n');
}

/**
 * A manifest the branch bumped to a version the base has since reached (or passed)
 * is not a git conflict, but the merged branch would ship a version no higher than
 * the base's, and Odoo runs a module's migrations only on a version increase. Such a
 * manifest takes the base's version with its last component raised by one.
 */
function liftVersions(base: string, mergeBase: string): string[] {
  const changed = git('diff', '--name-only', mergeBase, 'HEAD', '--', '*__manifest__.py')
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && basename(line) === '__manifest__.py');
  const lifted: string[] = [];
  for (const file of changed) {
    const baseText = git('show', `origin/${base}:${file}`);
    if (baseText.code !== 0) continue;
    const baseLine = baseText.stdout.split('\n').map((line) => versionLine.exec(line)).find((match) => match !== null);
    if (baseLine === undefined || baseLine === null) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const index = lines.findIndex((line) => versionLine.test(line));
    const ours = index === -1 ? null : versionLine.exec(lines[index] ?? '');
    if (ours === null) continue;
    const baseVersion = baseLine[2].split('.').map(Number);
    if (compareVersions(ours[2].split('.').map(Number), baseVersion) > 0) continue;
    const bumped = [...baseVersion.slice(0, -1), (baseVersion[baseVersion.length - 1] ?? 0) + 1];
    lines[index] = `${ours[1]}${bumped.join('.')}${ours[3]}`;
    writeFileSync(file, lines.join('\n'), 'utf8');
    lifted.push(file);
  }
  return lifted;
}

function resolve(file: string): string | null {
  const name = basename(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (name === 'release_notes.xml' && /(^|\/)data\/release_notes\.xml$/.test(file)) return union(text);
  if (name === '__manifest__.py') return nextVersion(text);
  return null;
}

function abort(conflicts: string[], summary: string): void {
  git('merge', '--abort');
  emit({ resolved: false, new_head: head(), files_resolved: [], conflicts, summary });
}

function pullRequest(): { repository: string; number: string } | null {
  let prs: unknown;
  try {
    prs = JSON.parse(process.env.INPUTS_PRS ?? '') as unknown;
  } catch {
    return null;
  }
  const url = Array.isArray(prs) && typeof prs[0] === 'string' ? prs[0] : '';
  const match = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { repository: match[1], number: match[2] };
}

function baseBranch(pr: { repository: string; number: string } | null): string {
  const bound = (process.env.BASE_BRANCH ?? '').trim();
  if (bound !== '') return bound;
  if (pr === null) return '';
  const view = run(['gh', 'pr', 'view', pr.number, '--repo', pr.repository, '--json', 'baseRefName', '--jq', '.baseRefName']);
  return view.code === 0 ? view.stdout.trim() : '';
}

function main(): void {
  const pr = pullRequest();
  const base = baseBranch(pr);
  if (base === '') {
    emit({ resolved: false, new_head: head(), files_resolved: [], conflicts: [], summary: 'the base branch is unknown: BASE_BRANCH is empty and the pull request could not be read' });
    return;
  }
  const branchRead = git('rev-parse', '--abbrev-ref', 'HEAD');
  const branch = branchRead.stdout.trim();
  if (branchRead.code !== 0 || branch === '' || branch === 'HEAD' || branch === base) {
    emit({ resolved: false, new_head: head(), files_resolved: [], conflicts: [], summary: `the checkout is not on a pull request branch (HEAD is ${branch || 'detached'})` });
    return;
  }
  if (unresolved().length > 0 || git('status', '--porcelain').stdout.trim() !== '') {
    emit({ resolved: false, new_head: head(), files_resolved: [], conflicts: [], summary: 'the checkout is not clean; nothing was merged' });
    return;
  }
  const fetch = git('fetch', 'origin', base);
  if (fetch.code !== 0) {
    emit({ resolved: false, new_head: head(), files_resolved: [], conflicts: [], summary: `git fetch origin ${base} failed: ${fetch.stderr.trim()}` });
    return;
  }
  const before = head();
  const mergeBase = git('merge-base', 'HEAD', `origin/${base}`).stdout.trim();
  const merge = git('merge', '--no-edit', `origin/${base}`);
  const resolved: string[] = [];
  let committed = false;
  if (merge.code !== 0) {
    const conflicts = unresolved();
    if (conflicts.length === 0) {
      abort([], `git merge origin/${base} failed without a conflict: ${merge.stderr.trim() || merge.stdout.trim()}`);
      return;
    }
    const left: string[] = [];
    const contents = new Map<string, string>();
    for (const file of conflicts) {
      const content = resolve(file);
      if (content === null) left.push(file);
      else contents.set(file, content);
    }
    if (left.length > 0) {
      abort(left, `conflicts outside the mechanical allowlist: ${left.join(', ')}`);
      return;
    }
    for (const [file, content] of contents) {
      writeFileSync(file, content, 'utf8');
      const add = git('add', '--', file);
      if (add.code !== 0) {
        abort([file], `git add ${file} failed: ${add.stderr.trim()}`);
        return;
      }
      resolved.push(file);
    }
    const commit = git('commit', '--no-edit', '-m', `Merge origin/${base} into ${branch} (base-merge: ${resolved.join(', ')})`);
    if (commit.code !== 0) {
      abort(resolved, `git commit failed: ${commit.stderr.trim()}`);
      return;
    }
    committed = true;
  }
  if (head() === before) {
    emit({ resolved: true, new_head: before, files_resolved: [], conflicts: [], summary: `${branch} already contains origin/${base}; nothing to merge` });
    return;
  }
  const lifted = mergeBase === '' ? [] : liftVersions(base, mergeBase).filter((file) => !resolved.includes(file));
  if (lifted.length > 0) {
    resolved.push(...lifted);
    const add = git('add', '--', ...lifted);
    const message = `Merge origin/${base} into ${branch} (base-merge: ${resolved.join(', ')})`;
    const commit = add.code === 0
      ? (committed ? git('commit', '--amend', '--no-edit', '-m', message) : git('commit', '--amend', '-m', message))
      : add;
    if (commit.code !== 0) {
      git('reset', '--hard', before);
      emit({ resolved: false, new_head: head(), files_resolved: [], conflicts: lifted, summary: `lifting manifest versions failed: ${commit.stderr.trim()}` });
      return;
    }
  }
  const after = head();
  const push = git('push', 'origin', `HEAD:${branch}`);
  if (push.code !== 0) {
    emit({ resolved: false, new_head: after, files_resolved: resolved, conflicts: [], summary: `the merge commit ${after.slice(0, 8)} exists locally but git push origin ${branch} failed: ${push.stderr.trim()}` });
    return;
  }
  emit({
    resolved: true,
    new_head: after,
    files_resolved: resolved,
    conflicts: [],
    summary:
      resolved.length > 0
        ? `merged origin/${base} into ${branch} at ${after.slice(0, 8)}, resolving ${resolved.join(', ')}`
        : `merged origin/${base} into ${branch} at ${after.slice(0, 8)} without conflicts`,
  });
}

main();

// A module, so its declarations stay private to this script.
export {};
