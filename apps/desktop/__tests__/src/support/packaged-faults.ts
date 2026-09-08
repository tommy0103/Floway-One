import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import type { InstalledAppVerificationContext } from './installed-app.ts';
import { type CredentialIdentity, personalEntrySource, runCredentialScript } from './personal-runtime.ts';
import { observePackagedFailureSurface, PERSONAL_DASHBOARD_PORT } from './process-lifecycle.ts';
import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';

export const assertPortAndStorageFailureSurfaces = async (
  nativeWindowProbe: string,
  context: InstalledAppVerificationContext,
  isolatedRoot: string,
  productionEntry: string,
): Promise<void> => await withFailureSafeCleanup(async cleanup => {
  cleanup.defer('production runtime entry restoration after packaged faults', async () => {
    await writeFile(context.entry, productionEntry);
  });

  await withFailureSafeCleanup(async portCleanup => {
    const occupied = createServer();
    portCleanup.defer('occupied personal port', async () => {
      if (!occupied.listening) return;
      await new Promise<void>((resolveClose, rejectClose) => occupied.close(error => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      occupied.once('error', rejectListen);
      occupied.listen(PERSONAL_DASHBOARD_PORT, '127.0.0.1', resolveListen);
    });
    const verificationRoot = resolve(isolatedRoot, 'PersonalData-port-fault');
    const credentialIdentity: CredentialIdentity = {
      service: `Floway desktop package verification ${randomUUID()}`,
      account: `device-master-key-${randomUUID()}`,
    };
    portCleanup.defer('port-fault personal data', async () => await rm(verificationRoot, { force: true, recursive: true }));
    portCleanup.defer('port-fault credential', async () => await runCredentialScript(context, credentialIdentity, 'delete'));
    await writeFile(context.entry, personalEntrySource(verificationRoot, credentialIdentity));
    const expected = ['EADDRINUSE', `127.0.0.1:${PERSONAL_DASHBOARD_PORT}`];
    await observePackagedFailureSurface({
      applicationHome: resolve(isolatedRoot, 'ShellData-port-fault'),
      executable: context.executable,
      expectedFragments: expected,
      failureKind: 'port',
      nativeWindowProbe,
      persistedLogFragments: expected,
    });
  });

  await writeFile(context.entry, productionEntry);
  const applicationHome = resolve(isolatedRoot, 'ShellData-storage-fault');
  const logsDirectory = resolve(applicationHome, 'logs');
  await mkdir(logsDirectory, { recursive: true });
  await chmod(logsDirectory, 0o500);
  await observePackagedFailureSurface({
    applicationHome,
    executable: context.executable,
    expectedFragments: ['Permission denied'],
    failureKind: 'storage',
    nativeWindowProbe,
    sidecarMustNotStart: true,
  });
});
