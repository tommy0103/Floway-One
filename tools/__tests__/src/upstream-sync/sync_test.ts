import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { CHECKPOINT_PATH, command, CommandError, pendingSyncPulls, prepareSync, publishSync, renderReport, resumeVerification, syncBranch, UpstreamConflict } from '../../../src/upstream-sync/sync.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'floway-sync-test-'));
  directories.push(directory);
  const upstream = join(directory, 'upstream');
  const checkout = join(directory, 'fork');
  mkdirSync(upstream);
  const git = (cwd: string, ...args: string[]) => command(cwd, 'git', ['-c', 'core.hooksPath=/dev/null', ...args]);
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.name', 'Upstream author');
  git(upstream, 'config', 'user.email', 'upstream@example.test');
  writeFileSync(join(upstream, 'shared.txt'), 'base\n');
  writeFileSync(join(upstream, 'CHANGELOG.md'), 'upstream notes\n');
  mkdirSync(join(upstream, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(upstream, '.github/workflows/verify.yaml'), 'upstream verification\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'Base');
  const base = git(upstream, 'rev-parse', 'HEAD');
  git(directory, 'clone', upstream, checkout);
  git(checkout, 'config', 'user.name', 'Fork committer');
  git(checkout, 'config', 'user.email', 'fork@example.test');
  writeFileSync(join(checkout, CHECKPOINT_PATH), `${JSON.stringify({ version: 1, sha: base })}\n`);
  writeFileSync(join(checkout, 'personal.txt'), 'personal desktop behavior\n');
  writeFileSync(join(checkout, 'CHANGELOG.md'), 'human notes\n');
  writeFileSync(join(checkout, '.github/workflows/verify.yaml'), 'full personal verification\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'Personal fork');
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, value] of Object.entries(files)) writeFileSync(join(upstream, path), value);
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', message);
    return git(upstream, 'rev-parse', 'HEAD');
  };
  const prepare = (batchSize = 10, name = 'candidate') => prepareSync({ checkout, directory: join(directory, name), upstreamUrl: upstream, batchSize });
  return { directory, upstream, checkout, base, git, commit, prepare, candidate: join(directory, 'candidate') };
}

test('Floway picks dependent commits in order, preserves fork verification and release notes, and records authors and provenance', () => {
  const f = fixture();
  const first = f.commit({ 'feature.txt': 'first dependency\n', 'CHANGELOG.md': 'changed upstream notes\n' }, 'Feature');
  const last = f.commit({ 'feature.txt': 'first dependency\nsecond dependency\n', '.github/workflows/verify.yaml': 'replace personal CI\n' }, 'Dependent fix');
  const report = f.prepare();
  expect(report.commits.map(commit => commit.sha)).toEqual([first, last]);
  expect(report.status).toBe('prepared');
  expect(readFileSync(join(f.candidate, 'feature.txt'), 'utf8')).toContain('second dependency');
  expect(readFileSync(join(f.candidate, 'personal.txt'), 'utf8')).toBe('personal desktop behavior\n');
  expect(readFileSync(join(f.candidate, 'CHANGELOG.md'), 'utf8')).toBe('human notes\n');
  expect(readFileSync(join(f.candidate, '.github/workflows/verify.yaml'), 'utf8')).toBe('full personal verification\n');
  expect(JSON.parse(readFileSync(join(f.candidate, CHECKPOINT_PATH), 'utf8')).sha).toBe(last);
  expect(f.git(f.candidate, 'log', '-1', '--format=%an <%ae>', 'HEAD~1')).toBe('Upstream author <upstream@example.test>');
  expect(f.git(f.candidate, 'log', '-1', '--format=%aI', 'HEAD~1')).toBe(f.git(f.upstream, 'show', '-s', '--format=%aI', last));
  expect(f.git(f.candidate, 'log', '-1', '--format=%B', 'HEAD~1')).toContain(`cherry picked from commit ${last}`);
  expect(f.git(f.checkout, 'status', '--porcelain')).toBe('');
  expect(JSON.parse(readFileSync(join(f.checkout, CHECKPOINT_PATH), 'utf8')).sha).toBe(f.base);
});

test('Floway resumes from the recorded cursor after a squash instead of importing the same commits again', () => {
  const f = fixture();
  const first = f.commit({ 'feature.txt': 'first\n' }, 'First');
  const second = f.commit({ 'feature.txt': 'first\nsecond\n' }, 'Second');
  const initial = f.prepare(1);
  expect(initial.through).toBe(first);
  expect(initial.remaining).toBe(1);
  for (const path of ['feature.txt', CHECKPOINT_PATH]) writeFileSync(join(f.checkout, path), readFileSync(join(f.candidate, path)));
  f.git(f.checkout, 'add', '.');
  f.git(f.checkout, 'commit', '-m', 'Squashed upstream batch (#123)');
  const next = f.prepare(1, 'next-candidate');
  expect(next.commits.map(commit => commit.sha)).toEqual([second]);
  expect(next.from).toBe(first);
});

test('Floway discards a conflicting batch without changing the source checkout or its cursor', () => {
  const f = fixture();
  f.commit({ 'feature.txt': 'valid earlier patch\n' }, 'First');
  const conflicting = f.commit({ 'shared.txt': 'upstream conflicting change\n' }, 'Conflict');
  writeFileSync(join(f.checkout, 'shared.txt'), 'personal conflicting change\n');
  f.git(f.checkout, 'add', '.');
  f.git(f.checkout, 'commit', '-m', 'Local change');
  let failure: UpstreamConflict | undefined;
  try { f.prepare(); } catch (error) {
    expect(error).toBeInstanceOf(UpstreamConflict);
    failure = error as UpstreamConflict;
  }
  expect(failure?.report.conflict).toEqual({ sha: conflicting, paths: ['shared.txt'] });
  expect(failure?.report.through).toBe(f.base);
  expect(failure?.report.remaining).toBe(2);
  expect(failure?.cause).toBeInstanceOf(Error);
  expect(renderReport(failure!.report)).toContain('no branch is pushed');
  expect(JSON.parse(readFileSync(join(f.checkout, CHECKPOINT_PATH), 'utf8')).sha).toBe(f.base);
  expect(f.git(f.checkout, 'status', '--porcelain')).toBe('');
});

test('Floway advances the cursor for an already applied patch and a release-note-only commit', () => {
  const f = fixture();
  f.commit({ 'feature.txt': 'already imported\n' }, 'Feature');
  const last = f.commit({ 'CHANGELOG.md': 'upstream changed notes\n' }, 'Notes');
  writeFileSync(join(f.checkout, 'feature.txt'), 'already imported\n');
  f.git(f.checkout, 'add', '.');
  f.git(f.checkout, 'commit', '-m', 'Manual port');
  const report = f.prepare();
  expect(report.commits.map(commit => commit.picked)).toEqual([false, false]);
  expect(report.through).toBe(last);
  expect(report.changedFiles).toEqual([CHECKPOINT_PATH]);
});

test('Floway flattens upstream merges against their first parent once', () => {
  const f = fixture();
  f.git(f.upstream, 'switch', '-c', 'feature');
  f.commit({ 'feature.txt': 'side branch feature\n' }, 'Side feature');
  f.git(f.upstream, 'switch', 'main');
  f.commit({ 'main.txt': 'main change\n' }, 'Main');
  f.git(f.upstream, 'merge', '--no-ff', 'feature', '-m', 'Merge feature');
  const report = f.prepare();
  expect(report.commits.map(commit => commit.subject)).toEqual(['Main', 'Merge feature']);
  expect(readFileSync(join(f.candidate, 'feature.txt'), 'utf8')).toBe('side branch feature\n');
});

test('Floway refuses an invalid cursor and an upstream rewrite rather than guessing a new merge base', () => {
  const f = fixture();
  writeFileSync(join(f.checkout, CHECKPOINT_PATH), '{}');
  expect(() => f.prepare()).toThrow('Invalid Floway upstream checkpoint');
  writeFileSync(join(f.checkout, CHECKPOINT_PATH), JSON.stringify({ version: 1, sha: '1'.repeat(40) }));
  expect(() => f.prepare()).toThrow('absent from main');
});

test('Floway has no candidate commits when upstream is unchanged', () => {
  const f = fixture();
  const report = f.prepare();
  expect(report.status).toBe('unchanged');
  expect(report.commits).toEqual([]);
  expect(f.git(f.candidate, 'rev-parse', 'HEAD')).toBe(f.git(f.checkout, 'rev-parse', 'HEAD'));
});

test('Floway publishes a candidate to a new branch and explicitly starts full Verify without touching main', () => {
  const f = fixture();
  f.commit({ 'feature.txt': 'feature\n' }, 'Feature');
  const report = f.prepare();
  const remote = join(f.directory, 'remote.git');
  f.git(f.directory, 'clone', '--bare', f.checkout, remote);
  const mainBefore = f.git(remote, 'rev-parse', 'main');
  const calls: string[][] = [];
  const bodyFile = join(f.directory, 'report.md');
  writeFileSync(bodyFile, renderReport(report));
  const url = publishSync({
    checkout: f.checkout,
    directory: f.candidate,
    repository: 'owner/Floway',
    baseBranch: 'main',
    report,
    bodyFile,
    destination: remote,
    gh: args => {
      calls.push(args);
      return 'https://github.com/owner/Floway/pull/1';
    },
  });
  expect(url).toContain('/pull/1');
  expect(f.git(remote, 'rev-parse', `refs/heads/${syncBranch(report)}`)).toBe(f.git(f.candidate, 'rev-parse', 'HEAD'));
  expect(f.git(remote, 'rev-parse', 'main')).toBe(mainBefore);
  expect(calls[0]).toContain('--draft');
  expect(calls[1]).toEqual(['workflow', 'run', 'verify.yaml', '--repo', 'owner/Floway', '--ref', syncBranch(report)]);
  // Repeating after a failed PR API request can reuse the identical tree.
  publishSync({ checkout: f.checkout, directory: f.candidate, repository: 'owner/Floway', baseBranch: 'main', report, bodyFile, destination: remote, gh: args => args[0] === 'pr' ? url : '' });
  f.git(remote, 'update-ref', `refs/heads/${syncBranch(report)}`, mainBefore);
  expect(() => publishSync({ checkout: f.checkout, directory: f.candidate, repository: 'owner/Floway', baseBranch: 'main', report, bodyFile, destination: remote, gh: () => '' })).toThrow('preserve it for human review');
});

test('Floway resumes a missing Verify dispatch and leaves an existing or failed run for review without rerunning it', () => {
  for (const runs of [[], [{ status: 'completed', conclusion: 'failure' }], [{ status: 'in_progress', conclusion: null }]]) {
    const calls: string[][] = [];
    resumeVerification({
      repository: 'owner/Floway',
      branch: 'codex/upstream-sync-test',
      sha: 'a'.repeat(40),
      dispatchOnly: true,
      gh: args => {
        calls.push(args);
        return JSON.stringify({ workflow_runs: runs });
      },
    });
    expect(calls[0]).toContain('event=workflow_dispatch');
    expect(calls.length).toBe(runs.length === 0 ? 2 : 1);
  }
});

test('Floway finds its pending sync PR across every API page and excludes other forks', () => {
  const calls: string[][] = [];
  const pull = (ref: string, repository = 'owner/Floway') => ({ html_url: 'https://github.com/owner/Floway/pull/7', head: { ref, sha: 'a'.repeat(40), repo: { full_name: repository } } });
  const pending = pendingSyncPulls({
    repository: 'owner/Floway',
    baseBranch: 'main',
    gh: args => {
      calls.push(args);
      return JSON.stringify([[pull('codex/other-work')], [pull('codex/upstream-sync-other', 'another/fork'), pull('codex/upstream-sync-owned')]]);
    },
  });
  expect(pending).toEqual([{ url: 'https://github.com/owner/Floway/pull/7', branch: 'codex/upstream-sync-owned', sha: 'a'.repeat(40) }]);
  expect(calls[0]).toContain('--paginate');
  expect(calls[0]).toContain('--slurp');
});

test('Floway preserves the original command error when an executable cannot start', () => {
  try {
    command(tmpdir(), '/floway-test-nonexistent-executable', []);
    throw new Error('Expected the command to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).status).toBeNull();
    expect((error as CommandError).cause).toMatchObject({ code: 'ENOENT' });
  }
});
