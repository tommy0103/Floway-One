import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// https://github.com/menci/floway
export const UPSTREAM_URL = 'https://github.com/menci/floway.git';
export const CHECKPOINT_PATH = '.github/upstream-sync.generated.json';
export const BRANCH_PREFIX = 'codex/upstream-sync-';
// The fork owns its verification, automation, and human-edited release notes.
export const PRESERVED_PATHS = [
  'CHANGELOG.md',
  '.github/workflows/verify.yaml',
  '.github/workflows/upstream-sync.yaml',
  CHECKPOINT_PATH,
];

export class CommandError extends Error {
  constructor(command: string, args: string[], result: { status: number | null; stdout: string; stderr: string; error?: Error }) {
    super(`${command} ${args.join(' ')} exited ${result.status}:\n${result.stderr}\n${result.stdout}`, { cause: result.error });
  }
}

export function command(cwd: string, executable: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(executable, args, { cwd, input, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new CommandError(executable, args, result);
  return result.stdout.trim();
}

function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  // Never execute checked-out Git hooks while preparing upstream changes.
  return command(cwd, 'git', ['-c', 'core.hooksPath=/dev/null', ...args], input, env);
}

export interface SyncCommit {
  sha: string;
  subject: string;
  picked: boolean;
  preservedPaths: string[];
}

export interface SyncReport {
  status: 'unchanged' | 'prepared' | 'conflict';
  base: string;
  from: string;
  upstreamTip: string;
  through: string;
  remaining: number;
  commits: SyncCommit[];
  changedFiles: string[];
  conflict?: { sha: string; paths: string[] };
}

export class UpstreamConflict extends Error {
  readonly report: SyncReport;

  constructor(report: SyncReport, cause: Error) {
    super(`Floway upstream conflict at ${report.conflict!.sha}: ${report.conflict!.paths.join(', ')}`, { cause });
    this.report = report;
  }
}

export function prepareSync(options: { checkout: string; directory: string; batchSize: number; upstreamUrl?: string }): SyncReport {
  const { checkout, directory, batchSize } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error('Upstream batch size must be an integer from 1 to 50');
  const checkpoint = JSON.parse(readFileSync(join(checkout, CHECKPOINT_PATH), 'utf8')) as { version?: unknown; sha?: unknown };
  if (checkpoint.version !== 1 || typeof checkpoint.sha !== 'string' || !/^[0-9a-f]{40}$/.test(checkpoint.sha)) {
    throw new Error('Invalid Floway upstream checkpoint');
  }
  const base = git(checkout, ['rev-parse', 'HEAD']);
  const identity = git(checkout, ['var', 'GIT_COMMITTER_IDENT']).match(/^(.*) <([^>]+)> \d+ [+-]\d{4}$/);
  if (!identity) throw new Error('Cannot read the default Git committer identity');
  git(checkout, ['clone', '--no-hardlinks', '--no-checkout', checkout, directory]);
  git(directory, ['config', 'user.name', identity[1]!]);
  git(directory, ['config', 'user.email', identity[2]!]);
  git(directory, ['checkout', '--detach', base]);
  git(directory, ['fetch', '--no-tags', options.upstreamUrl ?? UPSTREAM_URL, '+refs/heads/main:refs/remotes/upstream/main']);
  const upstreamTip = git(directory, ['rev-parse', 'refs/remotes/upstream/main']);
  // A squash merge does not make upstream commits ancestors of the fork.
  // The cursor, rather than the merge base, selects the next contiguous batch.
  const history = git(directory, ['rev-list', '--first-parent', upstreamTip]).split('\n');
  if (!history.includes(checkpoint.sha)) throw new Error(`Upstream checkpoint ${checkpoint.sha} is absent from main's first-parent history; review the upstream rewrite before syncing`);
  const pending = git(directory, ['rev-list', '--reverse', '--first-parent', `${checkpoint.sha}..${upstreamTip}`]).split('\n').filter(Boolean);
  const batch = pending.slice(0, batchSize);
  const report: SyncReport = {
    status: batch.length === 0 ? 'unchanged' : 'prepared', base, from: checkpoint.sha, upstreamTip,
    through: batch.at(-1) ?? checkpoint.sha, remaining: pending.length - batch.length, commits: [], changedFiles: [],
  };
  for (const sha of batch) {
    const parents = git(directory, ['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
    const paths = git(directory, ['diff', '--name-only', parents[0]!, sha]).split('\n').filter(Boolean);
    const preservedPaths = paths.filter(path => PRESERVED_PATHS.includes(path));
    const subject = git(directory, ['show', '-s', '--format=%s', sha]);
    let failure: Error | undefined;
    try {
      git(directory, ['cherry-pick', '--no-commit', ...(parents.length > 1 ? ['-m', '1'] : []), sha]);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
    }
    const originalConflicts = git(directory, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    for (const path of preservedPaths) {
      const exists = spawnSync('git', ['cat-file', '-e', `HEAD:${path}`], { cwd: directory }).status === 0;
      if (exists) git(directory, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
      else git(directory, ['rm', '-f', '--ignore-unmatch', '--', path]);
    }
    const conflicts = git(directory, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    if (conflicts.length > 0) {
      report.status = 'conflict';
      report.through = report.from;
      report.remaining = pending.length;
      report.conflict = { sha, paths: conflicts };
      throw new UpstreamConflict(report, failure ?? new Error('Unmerged Git index'));
    }
    if (failure && originalConflicts.length === 0) throw failure;
    const picked = git(directory, ['diff', '--cached', '--name-only']).length > 0;
    // --quit clears a conflicted/empty pick without discarding its staged tree.
    if (failure) git(directory, ['cherry-pick', '--quit']);
    if (picked) {
      const author = git(directory, ['show', '-s', '--format=%an <%ae>', sha]);
      const date = git(directory, ['show', '-s', '--format=%aI', sha]);
      const message = `${git(directory, ['show', '-s', '--format=%B', sha])}\n\n(cherry picked from commit ${sha})\n`;
      git(directory, ['commit', '--author', author, '-F', '-'], message, { ...process.env, GIT_AUTHOR_DATE: date });
    }
    report.commits.push({ sha, subject, picked, preservedPaths });
  }
  if (batch.length > 0) {
    writeFileSync(join(directory, CHECKPOINT_PATH), `${JSON.stringify({ version: 1, sha: report.through }, null, 2)}\n`);
    git(directory, ['add', CHECKPOINT_PATH]);
    git(directory, ['commit', '-m', `chore: record Floway upstream cursor ${report.through.slice(0, 12)}`]);
    report.changedFiles = git(directory, ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  }
  return report;
}

function markdown(text: string): string {
  return text.replace(/[\\`*_{}[\]<>#!|]/g, '\\$&').replaceAll('@', '&#64;').replace(/[\r\n]/g, ' ');
}

export function renderReport(report: SyncReport): string {
  const commits = report.commits.map(commit => `- [${commit.sha.slice(0, 12)}](https://github.com/menci/floway/commit/${commit.sha}) ${markdown(commit.subject)}${commit.picked ? '' : ' (patch already present or only preserved files changed)'}${commit.preservedPaths.length ? `; preserved: ${commit.preservedPaths.map(markdown).join(', ')}` : ''}`);
  return [
    '# Floway upstream cherry-pick', '',
    `Status: **${report.status}**`, '',
    `Cursor: \`${report.from}\` → \`${report.through}\``,
    `Upstream main: \`${report.upstreamTip}\`; remaining after this batch: ${report.remaining}.`, '',
    ...commits, '',
    ...(report.conflict ? [`Conflict at [${report.conflict.sha}](https://github.com/menci/floway/commit/${report.conflict.sha}): ${report.conflict.paths.map(markdown).join(', ')}.`, 'The entire candidate is discarded; no branch is pushed and the cursor is unchanged.', ''] : []),
    '## Changed files', '', ...report.changedFiles.map(path => `- ${markdown(path)}`), '',
    'Full Verify must pass, and personal desktop/Gateway changes require human review. This automation never merges a PR.', '',
  ].join('\n');
}

export function syncBranch(report: SyncReport): string {
  return `${BRANCH_PREFIX}${report.base.slice(0, 12)}-${report.through.slice(0, 12)}`;
}

export function publishSync(options: {
  checkout: string; directory: string; repository: string; baseBranch: string; report: SyncReport; bodyFile: string;
  gh?: (args: string[]) => string;
  destination?: string;
  dispatchVerify?: boolean;
}): string {
  const { checkout, directory, repository, baseBranch, report, bodyFile } = options;
  if (report.status !== 'prepared') throw new Error('Only a complete upstream batch can be published');
  const gh = options.gh ?? (args => command(checkout, 'gh', args));
  const branch = syncBranch(report);
  const destination = options.destination ?? `https://github.com/${repository}.git`;
  const existing = git(directory, ['ls-remote', destination, `refs/heads/${branch}`]).split(/\s+/)[0];
  if (existing) {
    git(directory, ['fetch', destination, `refs/heads/${branch}`]);
    if (git(directory, ['diff', '--name-only', 'FETCH_HEAD', 'HEAD'])) {
      throw new Error(`Existing ${branch} has different contents; preserve it for human review rather than force-pushing`);
    }
  } else {
    git(directory, ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', destination, `HEAD:refs/heads/${branch}`]);
  }
  const url = gh(['pr', 'create', '--repo', repository, '--base', baseBranch, '--head', branch, '--draft', '--title', `chore: sync Floway upstream through ${report.through.slice(0, 12)}`, '--body-file', bodyFile]);
  // Explicit dispatch also works with GITHUB_TOKEN; relying on its push/PR
  // events would leave Verify absent or waiting for human workflow approval.
  // https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
  if (options.dispatchVerify !== false) gh(['workflow', 'run', 'verify.yaml', '--repo', repository, '--ref', branch]);
  return url;
}

export function resumeVerification(options: { repository: string; branch: string; sha: string; gh: (args: string[]) => string; dispatchOnly: boolean }): void {
  const { repository, branch, sha, gh, dispatchOnly } = options;
  const runs = JSON.parse(gh(['api', `repos/${repository}/actions/workflows/verify.yaml/runs`, '--method', 'GET', '-f', `head_sha=${sha}`, ...(dispatchOnly ? ['-f', 'event=workflow_dispatch'] : []), '-f', 'per_page=100'])) as { workflow_runs: { status: string; conclusion: string | null }[] };
  const verifiedOrRunning = runs.workflow_runs.some(run => ['queued', 'in_progress', 'completed'].includes(run.status) && run.conclusion !== 'action_required');
  if (!verifiedOrRunning) gh(['workflow', 'run', 'verify.yaml', '--repo', repository, '--ref', branch]);
}

export function pendingSyncPulls(options: { repository: string; baseBranch: string; gh: (args: string[]) => string }): { url: string; branch: string; sha: string }[] {
  const { repository, baseBranch, gh } = options;
  const pages = JSON.parse(gh(['api', `repos/${repository}/pulls`, '--method', 'GET', '--paginate', '--slurp', '-f', 'state=open', '-f', `base=${baseBranch}`, '-f', 'per_page=100'])) as {
    html_url: string;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
  }[][];
  return pages.flat()
    .filter(pull => pull.head.ref.startsWith(BRANCH_PREFIX) && pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase())
    .map(pull => ({ url: pull.html_url, branch: pull.head.ref, sha: pull.head.sha }));
}
