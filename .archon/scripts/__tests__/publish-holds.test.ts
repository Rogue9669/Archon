/**
 * The merge queue's publish-holds script validates the assess agent's holds list before it
 * touches GitHub. In preview mode it exits before any gh call, so validation runs with no network.
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, '../../workflows/sdlc/merge-queue/scripts/publish-holds.ts');
const PR = 'https://github.com/example/repo/pull/7';

function run(holds: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INPUTS_MODE: 'preview',
      INPUTS_PUBLISH_HOLDS: 'true',
      INPUTS_PRS: JSON.stringify([PR]),
      INPUTS_HOLDS: JSON.stringify(holds),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('publish-holds', () => {
  it('accepts a clear entry that carries the assess agent explanation and drops its reasons', () => {
    const result = run([{ pr_url: PR, head_sha: 'abc123', action: 'clear', reasons: ['the earlier hold is cleared at abc123'] }]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ published: false, updated: [], summary: 'hold publication disabled' });
  });

  it('still refuses a hold without evidence-backed reasons', () => {
    const result = run([{ pr_url: PR, head_sha: 'abc123', action: 'hold', reasons: [] }]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('a hold must include evidence-backed reasons');
  });

  it('still refuses a malformed entry', () => {
    const result = run([{ pr_url: PR, head_sha: '', action: 'clear', reasons: [] }]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('malformed or unrequested hold entry');
  });
});
