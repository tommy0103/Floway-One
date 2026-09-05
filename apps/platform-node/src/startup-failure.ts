export const DESKTOP_FAILURE_EVENT_PREFIX = 'FLOWAY_DESKTOP_FAILURE ';

export type DesktopFailureKind =
  | 'asset'
  | 'compatibility'
  | 'migration'
  | 'native-dependency'
  | 'port'
  | 'storage'
  | 'unknown';

export class DesktopStartupError extends Error {
  readonly kind: DesktopFailureKind;

  constructor(kind: DesktopFailureKind, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'DesktopStartupError';
    this.kind = kind;
  }
}

export const startupFailure = (
  kind: DesktopFailureKind,
  message: string,
  cause: unknown,
): DesktopStartupError => new DesktopStartupError(kind, message, cause);

const errorChain = (failure: unknown): Error[] => {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current = failure;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
};

const errnoCode = (error: Error): string | undefined =>
  'code' in error && typeof error.code === 'string' ? error.code : undefined;

export const classifyDesktopStartupFailure = (
  failure: unknown,
  fallback: DesktopFailureKind = 'unknown',
): DesktopFailureKind => {
  const chain = errorChain(failure);
  const explicit = chain.find((error): error is DesktopStartupError => error instanceof DesktopStartupError);
  if (explicit !== undefined) return explicit.kind;

  const codes = new Set(chain.map(errnoCode).filter(code => code !== undefined));
  if (codes.has('EADDRINUSE')) return 'port';
  if (codes.has('ERR_DLOPEN_FAILED') || codes.has('MODULE_NOT_FOUND')) return 'native-dependency';
  if ([...codes].some(code => ['EACCES', 'EDQUOT', 'ENOSPC', 'EPERM', 'EROFS'].includes(code))) {
    return 'storage';
  }
  return fallback;
};

export interface DesktopFailureEvent {
  readonly chain: readonly string[];
  readonly kind: DesktopFailureKind;
}

export const desktopFailureEvent = (
  failure: unknown,
  fallback?: DesktopFailureKind,
): DesktopFailureEvent => {
  const chain = errorChain(failure).map(error => error.stack ?? `${error.name}: ${error.message}`);
  if (chain.length === 0) chain.push(String(failure));
  return {
    chain,
    kind: classifyDesktopStartupFailure(failure, fallback),
  };
};

export const reportDesktopStartupFailure = (
  failure: unknown,
  fallback?: DesktopFailureKind,
): boolean => {
  if (process.env.FLOWAY_DESKTOP_CONTRACT === undefined) return false;
  process.stderr.write(`${DESKTOP_FAILURE_EVENT_PREFIX}${JSON.stringify(desktopFailureEvent(failure, fallback))}\n`);
  return true;
};
