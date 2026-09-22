import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { InstalledAppVerificationContext } from './installed-app.ts';
import { waitForHealthyRuntime } from './personal-runtime.ts';
import {
  PERSONAL_DASHBOARD_PORT,
  appEnvironmentWithoutPortOverride,
  assertLoopbackPortReleased,
  captureApp,
  sendDesktopControl,
  terminateProcessGroup,
  waitForDirectChild,
} from './process-lifecycle.ts';
import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';

// The shell emits `FLOWAY_EXTERNAL_OPEN <url> <outcome>` from
// `handle_navigation` when the packaged verifier drives the
// `floway-action://verify-external-open` action through its control channel
// (issue #45).
const EXTERNAL_OPEN_MARKER = 'FLOWAY_EXTERNAL_OPEN ';

const waitForMarker = async (output: () => string, needle: string, timeoutMs = 30_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = output()
      .split('\n')
      .find(candidate => candidate.startsWith(EXTERNAL_OPEN_MARKER) && candidate.includes(needle));
    if (line !== undefined) return line;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Floway external-open gate marker did not arrive: ${needle}`);
};

// Real-machine gate for the external-link → system-browser path (#45). The
// control channel (a debug-build-only command) tells the packaged shell to
// navigate its webview to the `floway-action://verify-external-open` action,
// so the request walks the shell's `handle_navigation` segment a Dashboard
// link click takes, and each marker line records what the navigation policy
// decided and whether the system-browser handoff succeeded.
export const assertExternalOpenGate = async (
  context: InstalledAppVerificationContext,
  isolatedRoot: string,
): Promise<void> => {
  const applicationHome = resolve(isolatedRoot, 'PersonalData-external-open-gate');
  const port = PERSONAL_DASHBOARD_PORT;
  const origin = `http://127.0.0.1:${port}`;
  await withFailureSafeCleanup(async cleanup => {
    await assertLoopbackPortReleased(port);
    await mkdir(applicationHome, { recursive: true });
    cleanup.defer('external-open gate application data', async () => await rm(applicationHome, { force: true, recursive: true }));
    const { child, output } = captureApp(
      context.executable,
      appEnvironmentWithoutPortOverride(),
      ['--data-dir', applicationHome],
    );
    cleanup.defer('external-open gate application process group', async () => await terminateProcessGroup(child));
    await waitForDirectChild(child, output);
    await waitForHealthyRuntime(child, output, origin);

    const openAction = async (url: string): Promise<void> => {
      await sendDesktopControl(context.executable, applicationHome, `verify-external-open?url=${encodeURIComponent(url)}`);
    };

    // A policy-legitimate https target reaches the system browser.
    const authorizeUrl = 'https://auth.openai.com/oauth/authorize?client_id=app_gate&state=gate';
    await openAction(authorizeUrl);
    const okLine = await waitForMarker(output, `${authorizeUrl} ok`);
    if (!okLine.startsWith(`${EXTERNAL_OPEN_MARKER}${authorizeUrl} ok`)) {
      throw new Error(`Floway external-open gate emitted an unexpected marker: ${okLine}`);
    }

    // Plain-http, malformed, and bootstrap-authority-carrying targets are
    // refused by the same policy that guards link clicks.
    const rejectedUrl = 'http://floway-gate-rejected.example.test/';
    await openAction(rejectedUrl);
    const rejectedLine = await waitForMarker(output, `${rejectedUrl} rejected external-open:rejected`);
    if (!rejectedLine.startsWith(`${EXTERNAL_OPEN_MARKER}${rejectedUrl} rejected`)) {
      throw new Error(`Floway external-open gate emitted an unexpected marker: ${rejectedLine}`);
    }

    const bootstrapUrl = `https://floway-gate-bootstrap.example.test/?floway-bootstrap=${'12'.repeat(32)}`;
    await openAction(bootstrapUrl);
    await waitForMarker(output, `${bootstrapUrl} rejected external-open:rejected`);

    await openAction('not a url at all');
    await waitForMarker(output, 'invalid-url');
  });
  await assertLoopbackPortReleased(port);
};
