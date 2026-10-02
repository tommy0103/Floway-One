import { expect, test } from 'vitest';

import { planRelease, requirePublishableRelease } from '../../src/release-plan.ts';
import type { ReleaseRequest } from '../../src/release-plan.ts';

const commit = 'a'.repeat(40);
const request: ReleaseRequest = {
  event: 'workflow_dispatch', refType: 'branch', refName: 'main', commit,
  requestedCommit: commit, requestedVersion: '1.10.0', publish: true,
};
const plan = planRelease(request, '1.10.0');
const eligibility = {
  onMain: true,
  verification: { headSha: commit, status: 'completed', conclusion: 'success', event: 'push' },
  releases: [],
};

test('Floway manual publication binds the explicit version and full checked-out source', () => {
  expect(plan).toEqual({ tag: 'v1.10.0', version: '1.10.0', sourceCommit: commit, publish: true });
  expect(() => requirePublishableRelease(plan, eligibility)).not.toThrow();
});

test('Floway preview accepts a feature branch without granting publication', () => {
  expect(planRelease({ ...request, refName: 'codex/release', requestedCommit: '', requestedVersion: '', publish: false }, '1.10.0'))
    .toEqual({ ...plan, publish: false });
});

test.each([
  { refName: 'codex/release' }, { refType: 'tag' }, { requestedCommit: '' }, { requestedVersion: '' },
  { requestedCommit: 'main' }, { requestedCommit: 'b'.repeat(40) }, { commit: 'a'.repeat(7) },
])('Floway publication rejects ambiguous or unapproved source input %j', patch => {
  expect(() => planRelease({ ...request, ...patch }, '1.10.0')).toThrow();
});

test.each(['1.9.0', 'v1.10.0', '1.10.0-beta.1', '01.10.0'])('Floway publication rejects incompatible version %s', requestedVersion => {
  expect(() => planRelease({ ...request, requestedVersion }, '1.10.0')).toThrow(/version/);
});

test('Floway tag publication preserves the tag entry and rejects version disagreement', () => {
  expect(planRelease({ ...request, event: 'push', refType: 'tag', refName: 'v1.10.0', publish: false, requestedCommit: '', requestedVersion: '' }, '1.10.0'))
    .toEqual(plan);
  expect(() => planRelease({ ...request, event: 'push', refType: 'tag', refName: 'v1.9.0' }, '1.10.0')).toThrow(/version/);
  expect(() => planRelease({ ...request, event: 'push', refType: 'branch' }, '1.10.0')).toThrow(/tag/);
});

test.each([
  { onMain: false }, { existingTagCommit: 'b'.repeat(40) }, { verification: undefined },
  { verification: { ...eligibility.verification, headSha: 'b'.repeat(40) } },
  { verification: { ...eligibility.verification, status: 'in_progress' } },
  { verification: { ...eligibility.verification, conclusion: 'failure' } },
  { verification: { ...eligibility.verification, event: 'pull_request' } },
])('Floway publication rejects incomplete owning evidence %j', patch => {
  expect(() => requirePublishableRelease(plan, { ...eligibility, ...patch })).toThrow();
});

test('Floway publication accepts a matching existing tag and compares stable versions numerically', () => {
  expect(() => requirePublishableRelease(plan, {
    ...eligibility, existingTagCommit: commit,
    releases: [
      { tag_name: 'v1.9.99', draft: false, prerelease: false },
      { tag_name: 'v99.0.0', draft: false, prerelease: true },
    ],
  })).not.toThrow();
  for (const tag of ['v1.10.0', 'v1.10.1', 'v2.0.0', 'stable']) {
    expect(() => requirePublishableRelease(plan, {
      ...eligibility, releases: [{ tag_name: tag, draft: false, prerelease: false }],
    })).toThrow();
  }
  expect(() => requirePublishableRelease(plan, {
    ...eligibility, releases: [{ tag_name: plan.tag, draft: true, prerelease: false }],
  })).toThrow(/already exists/);
});
