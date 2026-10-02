import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
