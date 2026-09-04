import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { InitializedPersonalStorage } from './personal-storage.ts';

export const PERSONAL_STDOUT_LOG = 'floway.stdout.log';
export const PERSONAL_STDERR_LOG = 'floway.stderr.log';
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_FILE_COUNT = 3;

interface PersonalLoggingOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly permissions?: InitializedPersonalStorage;
  readonly stderr?: NodeJS.WriteStream;
  readonly stdout?: NodeJS.WriteStream;
}

export interface InstalledPersonalLogging {
  restore(): void;
}

type WriteCallback = (error?: Error | null) => void;

class RotatingFileSink {
  private size: number;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
    private readonly permissions?: InitializedPersonalStorage,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Log maxBytes must be a positive integer');
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('Log maxFiles must be a positive integer');

    writeFileSync(path, '', { flag: 'a', mode: 0o600 });
    chmodSync(path, 0o600);
    permissions?.hardenFile(path);
    this.size = statSync(path).size;
    if (this.size > maxBytes) {
      truncateSync(path, maxBytes);
      this.size = maxBytes;
    }
  }

  write(chunk: string | Uint8Array, encoding?: BufferEncoding): void {
    try {
      let bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      if (bytes.byteLength > this.maxBytes) bytes = bytes.subarray(bytes.byteLength - this.maxBytes);
      if (this.size > 0 && this.size + bytes.byteLength > this.maxBytes) this.rotate();

      appendFileSync(this.path, bytes);
      this.size += bytes.byteLength;
    } catch (cause) {
      throw new Error(`Floway could not write bounded log ${this.path}`, { cause });
    }
  }

  private rotate(): void {
    for (let index = this.maxFiles - 1; index >= 1; index--) {
      const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
      const destination = `${this.path}.${index}`;
      if (!existsSync(source)) continue;
      rmSync(destination, { force: true });
      renameSync(source, destination);
    }
    writeFileSync(this.path, '', { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.permissions?.hardenFile(this.path);
    this.size = 0;
  }
}

const teeStream = (
  stream: NodeJS.WriteStream,
  sink: RotatingFileSink,
  reportRuntimeFailure: (error: Error) => void,
): (() => void) => {
  const originalWrite = stream.write;
  const write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const args: unknown[] = [chunk];
    if (encodingOrCallback !== undefined) args.push(encodingOrCallback);
    if (callback !== undefined) args.push(callback);
    let forwarded = false;
    let forwardFailure: unknown;
    try {
      forwarded = Reflect.apply(originalWrite, stream, args) as boolean;
    } catch (cause) {
      forwardFailure = cause;
    }

    try {
      sink.write(chunk, encoding);
    } catch (cause) {
      reportRuntimeFailure(cause instanceof Error
        ? cause
        : new Error('Floway bounded logging failed with a non-Error value', { cause }));
    }

    if (forwardFailure !== undefined) throw forwardFailure;
    return forwarded;
  }) as NodeJS.WriteStream['write'];
  stream.write = write;

  return () => {
    if (stream.write === write) stream.write = originalWrite;
  };
};

const formatFatalError = (cause: unknown): string => {
  const sections = ['FATAL: Floway runtime failed'];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  let first = true;

  while (!seen.has(current)) {
    seen.add(current);
    if (!first) sections.push('Caused by:');
    sections.push(current instanceof Error ? (current.stack ?? current.toString()) : String(current));
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
    first = false;
  }

  return `${sections.join('\n')}\n`;
};

export const installPersonalLogging = (
  logsDir: string,
  options: PersonalLoggingOptions = {},
): InstalledPersonalLogging => {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_LOG_FILE_COUNT;
  try {
    if (options.permissions === undefined) {
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(logsDir, 0o700);
    }
    const stdoutSink = new RotatingFileSink(
      join(logsDir, PERSONAL_STDOUT_LOG),
      maxBytes,
      maxFiles,
      options.permissions,
    );
    const stderrSink = new RotatingFileSink(
      join(logsDir, PERSONAL_STDERR_LOG),
      maxBytes,
      maxFiles,
      options.permissions,
    );
    let runtimeFailureReported = false;
    let fatalReported = false;
    const writeFatalOnce = (cause: unknown): void => {
      if (fatalReported) return;
      fatalReported = true;
      stderrSink.write(formatFatalError(cause));
    };
    const monitorFatal = (cause: Error): void => {
      try {
        writeFatalOnce(cause);
      } catch {
        // The original fatal error still reaches Node's native stderr path.
        // Throwing here would replace it and change uncaught-exception semantics.
      }
    };
    process.on('uncaughtExceptionMonitor', monitorFatal);
    const reportRuntimeFailure = (error: Error): void => {
      if (runtimeFailureReported) return;
      runtimeFailureReported = true;
      // Node's Console suppresses exceptions thrown by its destination stream.
      // Leave that call stack before failing so a broken durable sink cannot be hidden.
      process.nextTick(() => { throw error; });
    };
    const restoreStdout = teeStream(options.stdout ?? process.stdout, stdoutSink, reportRuntimeFailure);
    const restoreStderr = teeStream(options.stderr ?? process.stderr, stderrSink, reportRuntimeFailure);
    return {
      restore: () => {
        process.off('uncaughtExceptionMonitor', monitorFatal);
        restoreStderr();
        restoreStdout();
      },
    };
  } catch (cause) {
    throw new Error(`Floway could not initialize bounded logs in ${logsDir}`, { cause });
  }
};
