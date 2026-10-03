import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
        APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_API_ISSUER: '', APPLE_API_KEY: '',
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

const signingSteps = workflow.jobs['build-installer']!.steps;
const signingSetup = signingSteps.find(step => step.run?.includes('floway-updater.key'))!.run!;
const certificateImport = signingSteps.find(step => step.run?.includes('security import'))!.run!;
const certificateIdentity = 'Developer ID Application: Floway Test (ABCDEFGHIJ)';

const withSigningSandbox = async (operation: (root: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-p12-signing-'));
  const env = {
    ...process.env,
    RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, 'outputs'), GITHUB_ENV: join(root, 'environment'),
    PUBLISH: 'false', REQUIRE_APPLE: 'true', APPLE_CERTIFICATE: '', APPLE_CERTIFICATE_PASSWORD: '',
    APPLE_API_KEY_CONTENT: '', APPLE_API_ISSUER: '', APPLE_API_KEY: '',
    APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '',
    TAURI_SIGNING_PRIVATE_KEY: '', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  };
  try {
    await operation(root, env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('Floway selects Apple ID notarization with a p12 and no manually configured identity or Team ID', async () => {
  await withSigningSandbox(async (root, env) => {
    await promisify(execFile)('bash', ['-c', signingSetup], {
      env: { ...env, APPLE_CERTIFICATE: 'fixture-p12', APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-app-password' },
    });
    expect(await readFile(join(root, 'outputs'), 'utf8')).toContain('signed=true\n');
    const result = await readFile(join(root, 'environment'), 'utf8');
    expect(result).toContain('APPLE_ID=fixture@example.invalid\n');
    expect(result).toContain('APPLE_PASSWORD=fixture-app-password\n');
    expect(result).not.toContain('APPLE_SIGNING_IDENTITY=');
    expect(result).not.toContain('APPLE_TEAM_ID=');
    expect(result).not.toContain('APPLE_API_KEY_PATH=');
  });
});

test('Floway preserves API key notarization and prefers it when both authentication methods are complete', async () => {
  await withSigningSandbox(async (root, env) => {
    const key = 'fixture-api-key\nwith-newline\n';
    await promisify(execFile)('bash', ['-c', signingSetup], {
      env: {
        ...env, APPLE_CERTIFICATE: 'fixture-p12', APPLE_API_KEY_CONTENT: key,
        APPLE_API_ISSUER: 'fixture-issuer', APPLE_API_KEY: 'fixture-key-id',
        APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-app-password',
      },
    });
    expect(await readFile(join(root, 'outputs'), 'utf8')).toContain('signed=true\n');
    expect(await readFile(join(root, 'AuthKey.p8'), 'utf8')).toBe(key);
    const result = await readFile(join(root, 'environment'), 'utf8');
    expect(result).toContain(`APPLE_API_KEY_PATH=${join(root, 'AuthKey.p8')}\n`);
    expect(result).not.toContain('APPLE_PASSWORD=');
  });
});

test.each([
  { APPLE_CERTIFICATE: 'fixture-p12' },
  { APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-app-password' },
  { APPLE_CERTIFICATE: 'fixture-p12', APPLE_API_KEY_CONTENT: 'fixture-api-key', APPLE_API_KEY: 'fixture-key-id' },
])('Floway rejects incomplete Apple credentials before a required signed build: %j', async credentials => {
  await withSigningSandbox(async (_root, env) => {
    await expect(promisify(execFile)('bash', ['-c', signingSetup], { env: { ...env, ...credentials } }))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Apple signing requires APPLE_CERTIFICATE') });
  });
});

test('Floway cannot silently publish an unsigned app when Apple credentials are partly configured', async () => {
  await withSigningSandbox(async (_root, env) => {
    await expect(promisify(execFile)('bash', ['-c', signingSetup], {
      env: { ...env, PUBLISH: 'true', REQUIRE_APPLE: 'false', APPLE_CERTIFICATE: 'fixture-p12', TAURI_SIGNING_PRIVATE_KEY: 'fixture-updater-key' },
    })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Apple signing requires APPLE_CERTIFICATE') });
  });
});

test('Floway keeps unsigned previews available even when complete Apple credentials are configured', async () => {
  await withSigningSandbox(async (root, env) => {
    await promisify(execFile)('bash', ['-c', signingSetup], {
      env: { ...env, REQUIRE_APPLE: 'false', APPLE_CERTIFICATE: 'fixture-p12', APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-app-password' },
    });
    expect(await readFile(join(root, 'outputs'), 'utf8')).toContain('signed=false\n');
    const result = await readFile(join(root, 'environment'), 'utf8');
    expect(result).not.toContain('APPLE_PASSWORD=');
  });
});

// Execute the actual workflow program against a fake macOS security command.
// These checks cover identity selection and failure propagation, not Apple trust.
const securityFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'import') {
  if (fs.readFileSync(args[1], 'utf8') !== 'fixture-p12-bytes') process.exit(78);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'imported'), 'yes');
  if (process.env.FIXTURE_IMPORT_FAIL) { console.error('fixture certificate import failed'); process.exit(77); }
}
if (args[0] === 'find-identity') {
  if (fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'imported'), 'utf8') !== 'yes') process.exit(79);
  process.stdout.write(process.env.FIXTURE_IDENTITIES);
}
`;

const importWithIdentities = async (root: string, env: NodeJS.ProcessEnv, identities: string, extra: NodeJS.ProcessEnv = {}): Promise<void> => {
  await writeFile(join(root, 'security'), securityFixture, { mode: 0o700 });
  await promisify(execFile)('bash', ['-c', certificateImport], {
    env: {
      ...env, ...extra, PATH: `${root}${delimiter}${process.env.PATH}`,
      APPLE_CERTIFICATE: Buffer.from('fixture-p12-bytes').toString('base64'),
      APPLE_CERTIFICATE_PASSWORD: 'fixture-export-password', FIXTURE_IDENTITIES: identities,
    },
  });
};

test('Floway imports the p12 then derives the unique Developer ID identity and Team ID', async () => {
  await withSigningSandbox(async (root, env) => {
    await importWithIdentities(root, env, `  1) ${'A'.repeat(40)} "${certificateIdentity}"\n     1 valid identities found\n`);
    expect(await readFile(join(root, 'environment'), 'utf8')).toBe(`APPLE_SIGNING_IDENTITY=${certificateIdentity}\nAPPLE_TEAM_ID=ABCDEFGHIJ\n`);
  });
});

test.each([
  '     0 valid identities found\n',
  `  1) ${'A'.repeat(40)} "Apple Development: Floway Test (ABCDEFGHIJ)"\n     1 valid identities found\n`,
  `  1) ${'A'.repeat(40)} "${certificateIdentity}"\n  2) ${'B'.repeat(40)} "Developer ID Application: Floway Other (1234567890)"\n     2 valid identities found\n`,
])('Floway rejects missing, wrong-type or ambiguous p12 identities: %s', async identities => {
  await withSigningSandbox(async (root, env) => {
    await expect(importWithIdentities(root, env, identities)).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('exactly one valid Developer ID Application'),
    });
  });
});

test('Floway rejects an identity whose Team ID cannot be derived', async () => {
  await withSigningSandbox(async (root, env) => {
    await expect(importWithIdentities(root, env, '  1) ABCDEF "Developer ID Application: Floway Test"\n')).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('Could not derive the Apple Team ID'),
    });
  });
});

test('Floway preserves the original p12 import failure instead of continuing identity discovery', async () => {
  await withSigningSandbox(async (root, env) => {
    await expect(importWithIdentities(root, env, `  1) ABCDEF "${certificateIdentity}"\n`, { FIXTURE_IMPORT_FAIL: '1' }))
      .rejects.toMatchObject({ code: 77, stderr: expect.stringContaining('fixture certificate import failed') });
  });
});
