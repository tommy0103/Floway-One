import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL('./native-accessibility.swift', import.meta.url));

interface AccessibilityRecord {
  readonly description: string;
  readonly enabled?: boolean;
  readonly role: string;
  readonly title: string;
  readonly value: string;
}

export interface NativeApplicationSnapshot {
  readonly pid: number;
  readonly tray: readonly AccessibilityRecord[];
  readonly visibleWindowCount: number;
  readonly windows: readonly AccessibilityRecord[];
}

const recoveryLabels = {
  trayLogs: ['Open Logs', '打开日志'],
  trayRestart: ['Restart Gateway', '重启 Gateway'],
  trayStatus: ['Gateway: Needs attention', 'Gateway：需要处理'],
  windowLogs: ['Open logs', '打开日志'],
  windowRestart: ['Restart Gateway', '重启 Gateway'],
} as const;

const renderedText = (records: readonly AccessibilityRecord[]): string => records
  .flatMap(record => [record.title, record.description, record.value])
  .filter(Boolean)
  .join('\n');

export const compileNativeAccessibilityProbe = async (outputDirectory: string): Promise<string> => {
  const executable = resolve(outputDirectory, 'floway-native-accessibility');
  await execFileAsync('/usr/bin/xcrun', [
    'swiftc',
    '-module-cache-path',
    resolve(outputDirectory, 'swift-module-cache'),
    source,
    '-o',
    executable,
  ], { timeout: 60_000 });
  return executable;
};

export const readNativeApplicationSnapshot = async (
  executable: string,
  pid: number,
): Promise<NativeApplicationSnapshot> => {
  try {
    const { stdout } = await execFileAsync(executable, [String(pid)], { timeout: 10_000 });
    return JSON.parse(stdout) as NativeApplicationSnapshot;
  } catch (cause) {
    throw new Error(
      'Floway packaged verification could not inspect the real native window and tray. '
      + 'If macOS denied Accessibility access, grant it to the process running the verifier and retry.',
      { cause },
    );
  }
};

const hasEnabledEntry = (
  records: readonly AccessibilityRecord[],
  expected: readonly string[],
): boolean => records.some(record =>
  record.enabled !== false
  && expected.some(label => [record.title, record.description, record.value].includes(label)));

const hasDisabledEntry = (
  records: readonly AccessibilityRecord[],
  expected: readonly string[],
): boolean => records.some(record =>
  record.enabled === false
  && expected.some(label => [record.title, record.description, record.value].includes(label)));

export const assertNativeFailureSurface = async (
  executable: string,
  pid: number,
  options: {
    readonly forbiddenWindowText: readonly string[];
    readonly windowTextGroups: readonly (readonly string[])[];
  },
): Promise<NativeApplicationSnapshot> => {
  const deadline = Date.now() + 10_000;
  let latest: NativeApplicationSnapshot | undefined;
  while (Date.now() < deadline) {
    latest = await readNativeApplicationSnapshot(executable, pid);
    const windowText = renderedText(latest.windows);
    const trayText = renderedText(latest.tray);
    const hasWindow = latest.visibleWindowCount > 0
      && options.windowTextGroups.every(group => group.some(text => windowText.includes(text)))
      && recoveryLabels.windowRestart.some(text => windowText.includes(text))
      && recoveryLabels.windowLogs.some(text => windowText.includes(text));
    const hasTray = recoveryLabels.trayStatus.some(text => trayText.includes(text))
      && hasDisabledEntry(latest.tray, recoveryLabels.trayStatus)
      && hasEnabledEntry(latest.tray, recoveryLabels.trayRestart)
      && hasEnabledEntry(latest.tray, recoveryLabels.trayLogs);
    if (hasWindow && hasTray) {
      for (const forbidden of options.forbiddenWindowText) {
        if (windowText.includes(forbidden)) {
          throw new Error(`Floway native failure surface exposed unrestricted diagnostic text: ${JSON.stringify(forbidden)}`);
        }
      }
      return latest;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Floway native failure surface did not expose the required window and tray actions: ${JSON.stringify(latest)}`);
};
