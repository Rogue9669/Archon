/**
 * The lifecycle's base-merge script against real git repositories made here: a
 * bare origin, a clone on the pull request's branch, and a base branch that moved.
 * No network, no gh: the base branch name is bound through BASE_BRANCH.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '../../workflows/sdlc/lifecycle/scripts/base-merge.ts');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content, 'utf8');
}

const NOTES = 'lwos_improve/data/release_notes.xml';
const MANIFEST = 'lwos_improve/__manifest__.py';

function notes(records: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<odoo>\n${records.map((id) => `    <record id="${id}" model="lwos.release_note">\n        <field name="version">${id}</field>\n    </record>\n`).join('')}</odoo>\n`;
}

function manifest(version: string): string {
  return `{\n    "name": "LWOS Improve",\n    "version": "${version}",\n    "depends": ["base"],\n}\n`;
}

interface Repos {
  origin: string;
  work: string;
  other: string;
}

/** A bare origin with `dev` at one commit, `work` cloned on branch `feature`, and `other` cloned on `dev`. */
function repos(): Repos {
  const root = mkdtempSync(join(tmpdir(), 'base-merge-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(root, 'init', '--bare', '-b', 'dev', origin);
  git(seed, 'init', '-b', 'dev');
  write(seed, NOTES, notes(['a']));
  write(seed, MANIFEST, manifest('19.0.1.1.0'));
  write(seed, 'other.py', 'VALUE = 1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'dev');
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'feature');
  const other = join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  return { origin, work, other };
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function runScript(cwd: string): { code: number; output: Record<string, unknown>; stderr: string } {
  const artifacts = mkdtempSync(join(tmpdir(), 'base-merge-artifacts-'));
  roots.push(artifacts);
  const result = spawnSync('bun', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: {
      ...gitEnv,
      ARTIFACTS_DIR: artifacts,
      BASE_BRANCH: 'dev',
      INPUTS_PRS: JSON.stringify(['https://github.com/example/app/pull/7']),
    },
  });
  return {
    code: result.status ?? 1,
    output: JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>,
    stderr: result.stderr,
  };
}

describe('base-merge', () => {
  it('keeps both release notes and raises the manifest above both sides when both bumped to the same version', () => {
    const { origin, work, other } = repos();
    write(work, NOTES, notes(['a', 'feature_note']));
    write(work, MANIFEST, manifest('19.0.1.2.0'));
    commitAll(work, 'feature: note and bump');
    git(work, 'push', '-q', '-u', 'origin', 'feature');
    write(other, NOTES, notes(['a', 'base_note']));
    write(other, MANIFEST, manifest('19.0.1.2.0'));
    const baseHead = commitAll(other, 'base: note and bump');
    git(other, 'push', '-q', 'origin', 'dev');

    const { code, output } = runScript(work);
    expect(code).toBe(0);
    expect(output).toMatchObject({ resolved: true, conflicts: [] });
    expect([...(output.files_resolved as string[])].sort()).toEqual([MANIFEST, NOTES].sort());
    const merged = readFileSync(join(work, NOTES), 'utf8');
    expect(merged).toContain('id="feature_note"');
    expect(merged).toContain('id="base_note"');
    expect(merged.match(/<odoo>/g)).toHaveLength(1);
    expect(merged.match(/<\/odoo>/g)).toHaveLength(1);
    expect(readFileSync(join(work, MANIFEST), 'utf8')).toContain('"version": "19.0.1.2.1"');
    const head = git(work, 'rev-parse', 'HEAD');
    expect(output.new_head).toBe(head);
    expect(git(work, 'rev-parse', `${head}^2`)).toBe(baseHead);
    expect(git(work, 'log', '-1', '--format=%s')).toBe(`Merge origin/dev into feature (base-merge: ${(output.files_resolved as string[]).join(', ')})`);
    expect(git(work, 'ls-remote', origin, 'refs/heads/feature').split('\t')[0]).toBe(head);
    expect(git(work, 'status', '--porcelain')).toBe('');
  });

  it('takes the higher version plus one when the two sides bumped to different numbers', () => {
    const { work, other } = repos();
    write(work, MANIFEST, manifest('19.0.1.2.0'));
    commitAll(work, 'feature: bump');
    git(work, 'push', '-q', '-u', 'origin', 'feature');
    write(other, MANIFEST, manifest('19.0.1.3.0'));
    commitAll(other, 'base: bump further');
    git(other, 'push', '-q', 'origin', 'dev');

    const { output } = runScript(work);
    expect(output).toMatchObject({ resolved: true, files_resolved: [MANIFEST] });
    expect(readFileSync(join(work, MANIFEST), 'utf8')).toContain('"version": "19.0.1.3.1"');
  });

  it('aborts cleanly on a conflict outside the allowlist and leaves the checkout as it was', () => {
    const { origin, work, other } = repos();
    write(work, 'other.py', 'VALUE = 2\n');
    write(work, MANIFEST, manifest('19.0.1.2.0'));
    const before = commitAll(work, 'feature: value and bump');
    git(work, 'push', '-q', '-u', 'origin', 'feature');
    write(other, 'other.py', 'VALUE = 3\n');
    write(other, MANIFEST, manifest('19.0.1.2.0'));
    commitAll(other, 'base: value and bump');
    git(other, 'push', '-q', 'origin', 'dev');

    const { code, output } = runScript(work);
    expect(code).toBe(0);
    expect(output).toMatchObject({ resolved: false, conflicts: ['other.py'], files_resolved: [], new_head: before });
    expect(String(output.summary)).toContain('other.py');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(work, 'other.py'), 'utf8')).toBe('VALUE = 2\n');
    expect(git(work, 'ls-remote', origin, 'refs/heads/feature').split('\t')[0]).toBe(before);
  });

  it('merges a base that moved without conflicts and pushes the merge commit', () => {
    const { origin, work, other } = repos();
    write(work, 'feature.py', 'FEATURE = True\n');
    const before = commitAll(work, 'feature: new file');
    git(work, 'push', '-q', '-u', 'origin', 'feature');
    write(other, 'base.py', 'BASE = True\n');
    const baseHead = commitAll(other, 'base: new file');
    git(other, 'push', '-q', 'origin', 'dev');

    const { output } = runScript(work);
    expect(output).toMatchObject({ resolved: true, files_resolved: [], conflicts: [] });
    const head = git(work, 'rev-parse', 'HEAD');
    expect(head).not.toBe(before);
    expect(output.new_head).toBe(head);
    expect(git(work, 'rev-parse', `${head}^2`)).toBe(baseHead);
    expect(git(work, 'ls-remote', origin, 'refs/heads/feature').split('\t')[0]).toBe(head);
  });

  it('reports an unchanged branch when the base is already contained', () => {
    const { work } = repos();
    write(work, 'feature.py', 'FEATURE = True\n');
    const before = commitAll(work, 'feature: new file');
    git(work, 'push', '-q', '-u', 'origin', 'feature');
    const { output } = runScript(work);
    expect(output).toMatchObject({ resolved: true, files_resolved: [], new_head: before });
    expect(String(output.summary)).toContain('nothing to merge');
  });
});
