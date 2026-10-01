import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BRANCH_PREFIX, command, prepareSync, publishSync, renderReport, resumeVerification, UpstreamConflict } from './sync.ts';

const checkout = process.cwd();
const dryRun = process.argv.includes('--dry-run') || process.env.UPSTREAM_SYNC_DRY_RUN === 'true';
const repository = process.env.GITHUB_REPOSITORY ?? command(checkout, 'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const dispatchVerify = process.env.UPSTREAM_SYNC_DISPATCH_VERIFY !== 'false';
const baseBranch = process.env.UPSTREAM_SYNC_BASE_BRANCH ?? 'main';
const reportDirectory = resolve(process.env.UPSTREAM_SYNC_REPORT_DIR ?? join(checkout, '.tmp', 'upstream-sync'));
mkdirSync(reportDirectory, { recursive: true });
const bodyFile = join(reportDirectory, 'upstream-sync.md');
function record(markdown: string): void {
  writeFileSync(bodyFile, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}
const temporaryRoot = mkdtempSync(join(tmpdir(), 'floway-upstream-sync-'));
try {
  if (!dryRun) {
    if (command(checkout, 'git', ['branch', '--show-current']) !== baseBranch) {
      throw new Error('Publish upstream sync only from the default branch; use --dry-run on work branches');
    }
    const pulls = JSON.parse(command(checkout, 'gh', ['pr', 'list', '--repo', repository, '--base', baseBranch, '--state', 'open', '--json', 'url,headRefName,headRefOid'])) as { url: string; headRefName: string; headRefOid: string }[];
    const pending = pulls.filter(pull => pull.headRefName.startsWith(BRANCH_PREFIX));
    if (pending.length > 1) throw new Error('Multiple upstream sync PRs are open; review them before preparing another batch');
    if (pending.length > 0) {
      const pull = pending[0]!;
      resumeVerification({ repository, branch: pull.headRefName, sha: pull.headRefOid, gh: args => command(checkout, 'gh', args), dispatchOnly: dispatchVerify });
      record(`Existing Floway upstream PR: ${pending.map(pull => pull.url).join(', ')}. No new batch is prepared while it is under review.\n`);
    } else {
      const report = prepareSync({ checkout, directory: join(temporaryRoot, 'candidate'), batchSize: Number(process.env.UPSTREAM_SYNC_BATCH_SIZE ?? '10') });
      record(renderReport(report));
      if (report.status === 'prepared') {
        const url = publishSync({ checkout, directory: join(temporaryRoot, 'candidate'), repository, baseBranch, report, bodyFile, dispatchVerify });
        console.log(`Floway upstream draft PR: ${url}`);
      }
    }
  } else {
    const report = prepareSync({ checkout, directory: join(temporaryRoot, 'candidate'), batchSize: Number(process.env.UPSTREAM_SYNC_BATCH_SIZE ?? '10') });
    record(renderReport(report));
  }
} catch (error) {
  if (error instanceof UpstreamConflict) record(renderReport(error.report));
  else record(`Floway upstream sync failed:\n\n\`\`\`\n${String(error)}\n\`\`\`\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
