import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { type InstalledAppVerificationContext, writeContractedEntry } from './installed-app.ts';
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
    await writeContractedEntry(context, productionEntry);
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
    await writeContractedEntry(context, personalEntrySource(verificationRoot, credentialIdentity));
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

  await writeContractedEntry(context, productionEntry);
  const applicationHome = resolve(isolatedRoot, 'ShellData-storage-fault');
  const logsDirectory = resolve(applicationHome, 'logs');
  await mkdir(logsDirectory, { recursive: true });
  await chmod(logsDirectory, 0o500);
  await observePackagedFailureSurface({
    applicationHome,
    executable: context.executable,
    expectedFragments: ['Permission denied'],
    expectedLogsAvailable: false,
    failureKind: 'storage',
    nativeWindowProbe,
  });
});

export const assertMigrationFailureSurface = async (
  nativeWindowProbe: string,
  context: InstalledAppVerificationContext,
  isolatedRoot: string,
  migrationName: string,
  productionEntry: string,
  productionContract: string,
): Promise<void> => await withFailureSafeCleanup(async cleanup => {
  const migrationPath = resolve(context.migrations, migrationName);
  const originalMigration = await readFile(migrationPath);
  cleanup.defer('migration-fault runtime entry', async () => await writeContractedEntry(context, productionEntry));
  cleanup.defer('migration-fault bundle contract', async () => await writeFile(context.contract, productionContract));
  cleanup.defer('migration-fault SQL', async () => await writeFile(migrationPath, originalMigration));

  const invalidMigration = Buffer.concat([originalMigration, Buffer.from('\nTHIS IS NOT SQL;\n')]);
  await writeFile(migrationPath, invalidMigration);
  const contract = JSON.parse(productionContract) as {
    migrations: { files: Array<{ path: string; sha256: string }> };
  };
  const entry = contract.migrations.files.find(file => file.path === migrationName);
  if (entry === undefined) throw new Error(`Migration contract omits ${migrationName}`);
  entry.sha256 = createHash('sha256').update(invalidMigration).digest('hex');
  await writeFile(context.contract, `${JSON.stringify(contract, undefined, 2)}\n`);

  const verificationRoot = resolve(isolatedRoot, 'PersonalData-migration-fault');
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  cleanup.defer('migration-fault personal data', async () => await rm(verificationRoot, { force: true, recursive: true }));
  cleanup.defer('migration-fault credential', async () => await runCredentialScript(context, credentialIdentity, 'delete'));
  await writeContractedEntry(context, personalEntrySource(verificationRoot, credentialIdentity));
  const expected = ['Floway could not apply its local database migrations', 'near "THIS": syntax error'];
  await observePackagedFailureSurface({
    applicationHome: resolve(isolatedRoot, 'ShellData-migration-fault'),
    executable: context.executable,
    expectedFragments: expected,
    failureKind: 'migration',
    nativeWindowProbe,
    persistedLogFragments: expected,
  });
});
