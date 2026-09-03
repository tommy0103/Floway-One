import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import ts from 'typescript';

const execFileAsync = promisify(execFile);

const isProductionTypeScript = (path: string): boolean =>
  extname(path) === '.ts'
  && !path.endsWith('.d.ts')
  && !path.split('/').includes('__tests__')
  && !path.split('\\').includes('__tests__');

const collectTypeScript = async (root: string): Promise<string[]> => {
  const pending = [root];
  const sources: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && isProductionTypeScript(path)) sources.push(path);
    }
  }
  return sources;
};

const rewriteRuntimeCondition = (value: unknown, condition?: string): unknown => {
  if (typeof value === 'string') {
    return condition === 'types' ? value : value.replace(/\.ts$/, '.js');
  }
  if (Array.isArray(value)) return value.map(item => rewriteRuntimeCondition(item, condition));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteRuntimeCondition(child, key)]),
    );
  }
  return value;
};

const rewritePackageRuntimeEntries = async (packageRoot: string): Promise<void> => {
  const manifestPath = resolve(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  for (const field of ['exports', 'main', 'module'] as const) {
    if (manifest[field] !== undefined) {
      manifest[field] = rewriteRuntimeCondition(manifest[field], field);
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
};

const transpileSource = async (sourcePath: string): Promise<void> => {
  const source = await readFile(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const failures = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (failures.length > 0) {
    throw new Error(`Failed to compile packaged Floway source ${sourcePath}: ${failures.map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')}`);
  }
  const outputPath = sourcePath.replace(/\.ts$/, '.js');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.outputText);
};

export const compilePackagedRuntime = async (runtimeRoot: string): Promise<void> => {
  const platformNodeRoot = resolve(runtimeRoot, 'apps/platform-node');
  const flowayPackagesRoot = resolve(platformNodeRoot, 'node_modules/@floway-dev');
  const flowayPackageRoots = (await readdir(flowayPackagesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => resolve(flowayPackagesRoot, entry.name));
  const sourceRoots = [
    resolve(platformNodeRoot, 'src'),
    ...flowayPackageRoots.map(packageRoot => resolve(packageRoot, 'src')),
  ];
  const sources = [
    resolve(platformNodeRoot, 'entry.ts'),
    ...(await Promise.all(sourceRoots.map(collectTypeScript))).flat(),
  ];
  await Promise.all(sources.map(transpileSource));
  await Promise.all(flowayPackageRoots.map(rewritePackageRuntimeEntries));
};

export const probePackagedRuntime = async (
  runtimeRoot: string,
  nodeExecutable: string,
): Promise<void> => {
  const platformNodeRoot = resolve(runtimeRoot, 'apps/platform-node');
  try {
    await execFileAsync(nodeExecutable, [
      '--input-type=module',
      '--eval',
      "await import('@floway-dev/gateway'); await import('./entry.js');",
    ], { cwd: platformNodeRoot });
  } catch (cause) {
    throw new Error('Embedded Node could not import the packaged Floway gateway and production entry', { cause });
  }
};
