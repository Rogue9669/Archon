import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonObject = Record<string, unknown>;
type MergeMethod = keyof typeof methodFlags;

type HoldCode = '' | 'base_conflict' | 'base_moved';

interface MergeResult {
  done: boolean;
  merged: boolean;
  urls: string[];
  queued: string[];
  prior_base_sha: string;
  summary: string;
  // A stable code for the two holds a composing lifecycle can act on itself: a
  // base conflict (merge the base into the branch) and a moved base (assess again).
  hold_code: HoldCode;
}

const methodFlags = {
  merge: '--merge',
  squash: '--squash',
  rebase: '--rebase',
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`merge-action: ${name} is required`);
  return value;
}

function input(name: string, fallback?: unknown): unknown {
  const raw = process.env[`INPUTS_${name.toUpperCase()}`];
  return raw === undefined || raw === '' ? fallback : (JSON.parse(raw) as unknown);
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function isMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && Object.hasOwn(methodFlags, value);
}

function plan(): { value: JsonObject; digest: string } {
  const bytes = readFileSync(join(requiredEnv('ARTIFACTS_DIR'), 'merge-plan.json'));
  return {
    value: object(JSON.parse(bytes.toString('utf8')) as unknown),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function requestedMethodMatches(method: unknown): boolean {
  const requested = process.env.INPUTS_MERGE_METHOD ?? '';
  return requested === '' || (isMethod(requested) && requested === method);
}

function validPlan(value: JsonObject): boolean {
  const entries = value.pull_requests;
  const numbers = new Set<number>();
  const heads = new Set<string>();
  return (
    typeof value.repository === 'string' &&
    value.repository !== '' &&
    typeof value.base === 'string' &&
    value.base !== '' &&
    typeof value.base_sha === 'string' &&
    value.base_sha !== '' &&
    isMethod(value.method) &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 5 &&
    entries.every((item) => {
      const entry = object(item);
      const valid =
        Number.isInteger(entry.number) &&
        typeof entry.url === 'string' &&
        entry.url !== '' &&
        typeof entry.head_sha === 'string' &&
        entry.head_sha !== '';
      if (!valid) return false;
      const number = entry.number as number;
      const head = entry.head_sha as string;
      if (numbers.has(number) || heads.has(head)) return false;
      numbers.add(number);
      heads.add(head);
      return true;
    })
  );
}

function evidenceReasons(value: JsonObject): string[] {
  if (!Array.isArray(value.evidence)) {
    return ['merge plan evidence bindings are missing or invalid'];
  }
  const reasons: string[] = [];
  for (const item of value.evidence) {
    const evidence = object(item);
    if (
      typeof evidence.path !== 'string' ||
      evidence.path === '' ||
      typeof evidence.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(evidence.sha256)
    ) {
      reasons.push('merge plan evidence bindings are missing or invalid');
      continue;
    }
    try {
      const actual = createHash('sha256').update(readFileSync(evidence.path)).digest('hex');
      if (actual !== evidence.sha256) reasons.push(`approved evidence changed: ${evidence.path}`);
    } catch {
      reasons.push(`approved evidence is unavailable: ${evidence.path}`);
    }
  }
  return reasons;
}

function gate(): void {
  const assessment = object(input('assessment'));
  const current = plan();
  const method = assessment.method;
  const reasons: string[] = [];
  if (assessment.eligible !== true) reasons.push('the assessed batch is not eligible');
  if (!validPlan(current.value)) reasons.push('merge plan entries are missing or invalid');
  if (!isMethod(method) || current.value.method !== method) {
    reasons.push('merge method is missing, conflicting, or unsupported');
  }
  if (!requestedMethodMatches(method)) {
    reasons.push('requested merge method does not match the assessed plan');
  }
  // The plan digest is computed here from the file's exact bytes and carried to the merge
  // node in this script's output; an agent-transcribed digest is not consulted (two LWOS
  // merges were refused on a hand-copied sha256 that differed from the file).
  const policy = object(input('ci_policy'));
  const policyReason = typeof policy.reason === 'string' ? policy.reason : '';
  if (policy.requirement === 'required') {
    if (policy.checks_state !== 'passing') {
      reasons.push(`required checks are not passing${policyReason ? `: ${policyReason}` : ''}`);
    }
  } else if (policy.requirement !== 'none') {
    reasons.push(`required CI policy is unknown${policyReason ? `: ${policyReason}` : ''}`);
  }
  if (assessment.validation_verified !== true) reasons.push('independent validation is not verified');
  if (assessment.review_verified !== true) reasons.push('independent review is not verified');
  reasons.push(...evidenceReasons(current.value));
  // GitHub's own mergeability, read by the policy script, decides the base-conflict
  // hold: an agent's prose about a conflict is not consulted.
  const conflicts = strings(policy.conflicts);
  if (conflicts.length > 0) {
    reasons.push(`pull request conflicts with its base: ${conflicts.join(', ')}`);
  }
  console.log(
    JSON.stringify({
      ready: reasons.length === 0,
      summary: reasons.length > 0 ? reasons.join('; ') : (typeof assessment.summary === 'string' ? assessment.summary : ''),
      method: isMethod(method) ? method : '',
      plan_digest: current.digest,
      hold_code: conflicts.length > 0 ? 'base_conflict' : '',
    })
  );
}

function authorized(gated: JsonObject, mode: string, approval: unknown): boolean {
  if (gated.ready !== true) return false;
  if (mode === 'auto') return true;
  return mode === 'approve' && object(approval).decision === 'approve';
}

function finish(result: MergeResult): void {
  const lines = ['# Merge result', '', result.summary];
  if (result.urls.length > 0) lines.push('', 'Merged:', ...result.urls.map((url) => `- ${url}`));
  if (result.queued.length > 0) lines.push('', 'Queued:', ...result.queued.map((url) => `- ${url}`));
  writeFileSync(join(requiredEnv('ARTIFACTS_DIR'), 'merge-result.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify(result));
}

function stop(
  urls: string[],
  queued: string[],
  priorBaseSha: string,
  summary: string,
  holdCode: HoldCode = ''
): void {
  finish({ done: true, merged: false, urls, queued, prior_base_sha: priorBaseSha, summary, hold_code: holdCode });
}

function gateHoldCode(gated: JsonObject): HoldCode {
  return gated.hold_code === 'base_conflict' ? 'base_conflict' : '';
}

function runGh(args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
}

function execute(): void {
  const gated = object(input('gate'));
  const previous = object(input('previous'));
  const request = object(input('request'));
  const urls = strings(previous.urls);
  const queued = strings(previous.queued);
  const priorBaseSha = typeof previous.prior_base_sha === 'string' ? previous.prior_base_sha : '';
  if (!authorized(gated, process.env.INPUTS_MODE ?? '', input('approval'))) {
    stop(urls, queued, priorBaseSha, 'merge is not authorized', gateHoldCode(gated));
    return;
  }

  const current = plan();
  if (gated.plan_digest !== current.digest) {
    stop(urls, queued, priorBaseSha, 'approved merge plan changed');
    return;
  }
  const evidenceFailures = evidenceReasons(current.value);
  if (evidenceFailures.length > 0) {
    stop(urls, queued, priorBaseSha, evidenceFailures.join('; '));
    return;
  }
  const entries = current.value.pull_requests;
  if (!validPlan(current.value) || !Array.isArray(entries)) {
    stop(urls, queued, priorBaseSha, 'merge plan entries are missing or invalid');
    return;
  }
  if (urls.length >= entries.length) {
    finish({
      done: true,
      merged: true,
      urls,
      queued,
      prior_base_sha: priorBaseSha,
      summary: 'all planned pull requests are merged',
      hold_code: '',
    });
    return;
  }

  const entry = object(entries[urls.length]);
  const repository = current.value.repository;
  const number = entry.number;
  const head = entry.head_sha;
  const method = current.value.method;
  const requestMatches =
    request.repository === repository &&
    request.number === number &&
    request.head_sha === head &&
    request.method === method;
  if (request.authorized !== true || !requestMatches || !isMethod(method)) {
    // A refused refresh with the base past the assessed `base_sha` is the moved-base
    // hold: the live base is read here, not inferred from the agent's wording.
    let holdCode: HoldCode = '';
    if (request.authorized !== true && typeof repository === 'string' && typeof current.value.base === 'string') {
      const live = runGh(['api', `repos/${repository}/branches/${encodeURIComponent(current.value.base)}`, '--jq', '.commit.sha']);
      const liveSha = live.exitCode === 0 ? (live.stdout?.toString() ?? '').trim() : '';
      if (liveSha !== '' && liveSha !== current.value.base_sha) holdCode = 'base_moved';
    }
    stop(
      urls,
      queued,
      priorBaseSha,
      typeof request.summary === 'string' && request.summary !== ''
        ? request.summary
        : 'fresh merge checks did not authorize a write',
      holdCode
    );
    return;
  }
  if (!requestedMethodMatches(method)) {
    stop(urls, queued, priorBaseSha, 'requested merge method does not match the approved plan');
    return;
  }
  if (typeof repository !== 'string' || !Number.isInteger(number) || typeof head !== 'string') {
    stop(urls, queued, priorBaseSha, 'planned pull request identity is malformed');
    return;
  }

  const merge = runGh([
    'pr',
    'merge',
    String(number),
    '--repo',
    repository,
    methodFlags[method],
    '--match-head-commit',
    head,
  ]);
  const readback = runGh([
    'pr',
    'view',
    String(number),
    '--repo',
    repository,
    '--json',
    'state,mergedAt,mergeCommit,url',
  ]);
  let state: JsonObject = {};
  if (readback.exitCode === 0) {
    try {
      state = object(JSON.parse(readback.stdout?.toString() ?? '') as unknown);
    } catch {
      // Unclear readback is held below even when GitHub accepted the write.
    }
  }
  const url = typeof entry.url === 'string' ? entry.url : '';
  if (
    state.state === 'MERGED' &&
    typeof state.mergedAt === 'string' &&
    state.mergedAt !== '' &&
    object(state.mergeCommit).oid !== undefined
  ) {
    const completed = [...urls, url];
    const base = current.value.base;
    const baseReadback =
      typeof base === 'string'
        ? runGh(['api', `repos/${repository}/branches/${encodeURIComponent(base)}`, '--jq', '.commit.sha'])
        : undefined;
    const nextBaseSha =
      baseReadback?.exitCode === 0 ? (baseReadback.stdout?.toString() ?? '').trim() : '';
    if (nextBaseSha === '') {
      stop(
        completed,
        queued,
        priorBaseSha,
        'merge was confirmed but the live base readback is unclear'
      );
      return;
    }
    const done = completed.length === entries.length;
    finish({
      done,
      merged: done,
      urls: completed,
      queued,
      prior_base_sha: nextBaseSha,
      summary: done
        ? 'all planned pull requests are merged'
        : 'merge confirmed; refreshing the next planned pull request',
      hold_code: '',
    });
  } else if (merge.exitCode === 0) {
    stop(urls, queued, priorBaseSha, 'GitHub accepted the request but merge or queue state is unclear');
  } else {
    const detail =
      merge.stderr?.toString().trim() || merge.stdout?.toString().trim() || 'gh pr merge failed';
    stop(urls, queued, priorBaseSha, detail);
  }
}

const action = requiredEnv('INPUTS_ACTION');
if (action === 'gate') gate();
else if (action === 'execute') execute();
else throw new Error(`merge-action: unsupported action ${action}`);
