import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readReleaseNotes } from './release-manifest.ts';
import { readDesktopReleaseVersion } from './src/release-contract.ts';
import { planRelease, requirePublishableRelease } from './src/release-plan.ts';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(desktopRoot, '../..');
const execute = promisify(execFile);
const run = async (command: string, args: readonly string[]): Promise<string> =>
  (await execute(command, [...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const env = (name: string): string => process.env[name] ?? '';
const publishInput = env('RELEASE_PUBLISH');
if (!['', 'true', 'false'].includes(publishInput)) throw new Error('Floway release publish input must be a boolean');
const plan = planRelease({
  event: env('GITHUB_EVENT_NAME'), refType: env('GITHUB_REF_TYPE'), refName: env('GITHUB_REF_NAME'),
  commit: await run('git', ['rev-parse', 'HEAD']), requestedCommit: env('RELEASE_COMMIT'),
  requestedVersion: env('RELEASE_VERSION'), publish: publishInput === 'true',
}, await readDesktopReleaseVersion(desktopRoot));
await readReleaseNotes(resolve(root, 'docs/releases', `${plan.version}.md`));

if (plan.publish) {
  const repo = env('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Floway release requires a valid GitHub repository');
  const optionalGit = async (args: readonly string[]): Promise<string | undefined> => {
    try {
      return await run('git', args);
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 1) return undefined;
      throw cause;
    }
  };
  const onMain = await optionalGit(['merge-base', '--is-ancestor', plan.sourceCommit, 'origin/main']) !== undefined;
  const existingTagCommit = await optionalGit(['rev-parse', '--verify', '--quiet', `refs/tags/${plan.tag}^{commit}`]);
  // GitHub CLI selects the exact commit and latest owning verification run.
  // https://cli.github.com/manual/gh_run_list
  const runs = JSON.parse(await run('gh', ['run', 'list', '--repo', repo, '--workflow', 'verify.yaml',
    '--commit', plan.sourceCommit, '--limit', '1', '--json', 'headSha,status,conclusion,event'])) as
    Parameters<typeof requirePublishableRelease>[1]['verification'][];
  // Preserve API errors; only the actual empty releases list means a first release.
  // https://cli.github.com/manual/gh_api
  const pages = JSON.parse(await run('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])) as
    Parameters<typeof requirePublishableRelease>[1]['releases'][];
  requirePublishableRelease(plan, { onMain, existingTagCommit, verification: runs[0], releases: pages.flat() });
}
const output = `tag=${plan.tag}\nversion=${plan.version}\nsource_commit=${plan.sourceCommit}\npublish=${String(plan.publish)}\n`;
if (env('GITHUB_OUTPUT')) await appendFile(env('GITHUB_OUTPUT'), output);
console.log(`Floway ${plan.tag}: ${plan.publish ? 'publication' : 'preview'} from ${plan.sourceCommit}`);
