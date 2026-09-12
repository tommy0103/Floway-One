import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import { labels, recoveryCopy } from './support/native-surface.ts';

const desktopRoot = resolve(import.meta.dirname, '../..');

test('packaged verifier orchestrates cohesive test-support modules', async () => {
  const source = await readFile(resolve(desktopRoot, '__tests__/src/packaged-desktop-verifier.ts'), 'utf8');
  expect(source.split('\n').length).toBeLessThan(350);
  for (const module of ['installed-app', 'native-surface', 'package-contract', 'packaged-faults', 'personal-runtime', 'process-lifecycle']) {
    expect(source).toContain(`./support/${module}.ts`);
  }
  for (const lowLevelBoundary of ['node:sqlite', 'node:net', 'ChildProcessByStdio', 'parseDependencyAssociations']) {
    expect(source).not.toContain(lowLevelBoundary);
  }
});

test('verifier-only output cleanup support lives outside production src', async () => {
  const entry = await readFile(resolve(desktopRoot, 'src/test-desktop.ts'), 'utf8');
  expect(entry).toContain('../__tests__/src/desktop-verification.ts');
  await expect(readFile(resolve(desktopRoot, 'src/desktop-verification.ts'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

test('packaged native observation combines actual Tauri objects, rendered pixels, and an external window-server probe', async () => {
  const [probe, surface, controller, renderedSnapshot] = await Promise.all([
    readFile(resolve(desktopRoot, '__tests__/src/support/native-window.swift'), 'utf8'),
    readFile(resolve(desktopRoot, '__tests__/src/support/native-surface.ts'), 'utf8'),
    readFile(resolve(desktopRoot, 'src-tauri/src/runtime_controller.rs'), 'utf8'),
    readFile(resolve(desktopRoot, 'src-tauri/src/rendered_snapshot.rs'), 'utf8'),
  ]);
  for (const boundary of [
    'CGWindowListCopyWindowInfo(',
    'kCGWindowOwnerPID',
    'kCGWindowLayer',
    'VNRecognizeTextRequest',
    'SHA256.hash',
  ]) {
    expect(probe).toContain(boundary);
  }
  expect(probe).not.toContain('ApplicationServices');
  expect(probe).not.toContain('AXUIElement');
  for (const actualObjectRead of [
    'controller.tray.diagnostic_snapshot()',
    'window.is_visible()',
    'window.title()',
    'payload.url()',
  ]) {
    expect(controller).toContain(actualObjectRead);
  }
  expect(controller).toContain('.on_page_load(');
  expect(controller).toContain('FLOWAY_DESKTOP_PAGE_LOAD ');
  expect(controller).toContain('recovery-surface.png');
  expect(controller).toContain('renderedSnapshot');
  expect(controller).not.toContain('FLOWAY_DESKTOP_TEST_SURFACE_PROBE');
  expect(controller).not.toContain('window.eval(');
  for (const browserObservation of [
    'webview.inner()',
    'takeSnapshotWithConfiguration',
    'WKSnapshotConfiguration',
  ]) {
    expect(renderedSnapshot).toContain(browserObservation);
  }
  expect(renderedSnapshot).not.toContain('AXUIElement');
  expect(renderedSnapshot).not.toContain('Floway could not start the local Gateway');
  expect(renderedSnapshot).not.toContain('Floway 无法启动本机 Gateway');
  expect(surface).toContain('FLOWAY_DESKTOP_SURFACE ');
  expect(surface).toContain('FLOWAY_DESKTOP_RECOVERY_SURFACE ');
  expect(surface).toContain('recovery-surface.png');
  expect(surface).toContain('visibleWindowCount');
  expect(surface).toContain('ocrCandidates');
  expect(surface).not.toContain('AXUIElement');
});

test('desktop process helpers avoid System Events automation', async () => {
  const [lifecycle, surface] = await Promise.all([
    readFile(resolve(desktopRoot, '__tests__/src/support/process-lifecycle.ts'), 'utf8'),
    readFile(resolve(desktopRoot, '__tests__/src/support/native-surface.ts'), 'utf8'),
  ]);
  expect(lifecycle).not.toContain('System Events');
  expect(surface).not.toContain('System Events');
});

test('Tauri composition stays thin while runtime recovery has one owning module', async () => {
  const [app, controller] = await Promise.all([
    readFile(resolve(desktopRoot, 'src-tauri/src/app.rs'), 'utf8'),
    readFile(resolve(desktopRoot, 'src-tauri/src/runtime_controller.rs'), 'utf8'),
  ]);
  expect(app.split('\n').length).toBeLessThan(10);
  expect(app).toContain('crate::runtime_controller::run()');
  expect(controller).toContain('struct DesktopController');
  expect(controller).toContain('fn begin_health_probe(');
  expect(controller).toContain('fn fail_startup_attempt(');
  expect(controller).toContain('fn fail_current_attempt(');
});

test('recovery surface expectations stay verbatim in the locale resources', async () => {
  const [en, zhHans, nativeMessages] = await Promise.all([
    readFile(resolve(desktopRoot, '../web/src/i18n/locales/en.ts'), 'utf8'),
    readFile(resolve(desktopRoot, '../web/src/i18n/locales/zh-Hans.ts'), 'utf8'),
    readFile(resolve(desktopRoot, 'src-tauri/src/desktop_i18n.rs'), 'utf8'),
  ]);
  const localeResources = { en, 'zh-Hans': zhHans } as const;
  const leafStrings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (value !== null && typeof value === 'object') {
      return Object.values(value).flatMap(leafStrings);
    }
    return [];
  };
  for (const [locale, resource] of Object.entries(localeResources)) {
    for (const copy of leafStrings(recoveryCopy[locale as keyof typeof recoveryCopy])) {
      expect(resource).toContain(copy);
    }
    for (const label of leafStrings(labels[locale as keyof typeof labels])) {
      expect(nativeMessages).toContain(label);
    }
  }
});
