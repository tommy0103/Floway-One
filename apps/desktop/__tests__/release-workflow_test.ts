import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';
import { parse } from 'yaml';

interface Step { uses?: string; run?: string; with?: Record<string, unknown> }
interface Job { steps: Step[]; needs?: string[]; if?: string; permissions: Record<string, string> }
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: unknown }> }; push: { tags: string[] } };
  jobs: Record<string, Job>;
}
const workflow = parse(await readFile(new URL('../../../.github/workflows/release.yaml', import.meta.url), 'utf8')) as Workflow;

test('Floway manual preview is the default and publication depends on the validated complete asset set', () => {
  expect(workflow.on.workflow_dispatch.inputs.publish).toEqual(expect.objectContaining({ type: 'boolean', default: false }));
  expect(workflow.on.push.tags).toEqual(['v*']);
  expect(workflow.jobs.publish?.if).toBe("needs.prepare.outputs.publish == 'true'");
  expect(workflow.jobs.publish?.needs).toEqual(['prepare', 'assemble']);
  expect(workflow.jobs.assemble?.needs).toEqual(['prepare', 'build-installer']);
  expect(workflow.jobs.publish?.permissions.contents).toBe('write');
  for (const name of ['prepare', 'build-installer', 'assemble']) expect(workflow.jobs[name]?.permissions.contents).toBe('read');
});

test('Floway downstream release stages check out the same validated source commit', () => {
  for (const name of ['build-installer', 'assemble', 'publish']) {
    const checkout = workflow.jobs[name]?.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ needs.prepare.outputs.source_commit }}');
  }
  expect(workflow.jobs.publish?.steps.some(step => step.run?.includes('release:require'))).toBe(true);
});

test('Floway release shell programs parse without executing signing or publication', async () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run) await promisify(execFile)('bash', ['-n', '-c', step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'fixture')]);
    }
  }
});

test('Floway signing setup preserves the encoded private key bytes and uses the supported Tauri variable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-release-signing-'));
  try {
    const step = workflow.jobs['build-installer']?.steps.find(candidate => candidate.run?.includes('floway-updater.key'));
    expect(step?.run).toBeDefined();
    const key = 'ZmFrZSBzaWduaW5nIGtleQ==';
    await promisify(execFile)('bash', ['-c', step!.run!], {
      env: {
        ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, 'outputs'), GITHUB_ENV: join(root, 'environment'),
        PUBLISH: 'false', REQUIRE_APPLE: 'false', APPLE_CERTIFICATE: '', APPLE_API_KEY_CONTENT: '',
        APPLE_SIGNING_IDENTITY: '', APPLE_API_ISSUER: '', APPLE_API_KEY: '',
        TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
      },
    });
    expect(await readFile(join(root, 'floway-updater.key'), 'utf8')).toBe(key);
    const environment = await readFile(join(root, 'environment'), 'utf8');
    expect(environment).toContain(`TAURI_SIGNING_PRIVATE_KEY=${join(root, 'floway-updater.key')}\n`);
    expect(environment).not.toContain('TAURI_SIGNING_PRIVATE_KEY_PATH=');
    expect(environment).toContain('"createUpdaterArtifacts":true');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Floway production artifacts are frozen before fixture builds and uploaded only after packaged verification', () => {
  const steps = workflow.jobs['build-installer']!.steps;
  const collect = steps.findIndex(step => step.run?.includes('release:collect'));
  const gate = steps.findIndex(step => step.run?.includes('test:packaged:macos'));
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  expect(collect).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(collect);
  expect(upload).toBeGreaterThan(gate);
});
