import {
  appendFileSync,
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const PERSONAL_STDOUT_LOG = 'floway.stdout.log';
export const PERSONAL_STDERR_LOG = 'floway.stderr.log';
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_FILE_COUNT = 3;

interface PersonalLoggingOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
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
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Log maxBytes must be a positive integer');
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('Log maxFiles must be a positive integer');

    writeFileSync(path, '', { flag: 'a', mode: 0o600 });
    chmodSync(path, 0o600);
    this.size = statSync(path).size;
    if (this.size > maxBytes) {
      truncateSync(path, maxBytes);
      this.size = maxBytes;
    }
  }

  write(chunk: string | Uint8Array, encoding?: BufferEncoding): void {
    let bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    if (bytes.byteLength > this.maxBytes) bytes = bytes.subarray(bytes.byteLength - this.maxBytes);
    if (this.size > 0 && this.size + bytes.byteLength > this.maxBytes) this.rotate();

    appendFileSync(this.path, bytes);
    this.size += bytes.byteLength;
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
    this.size = 0;
  }
}

const teeStream = (stream: NodeJS.WriteStream, sink: RotatingFileSink): (() => void) => {
  const originalWrite = stream.write;
  const write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    sink.write(chunk, encoding);
    const args: unknown[] = [chunk];
    if (encodingOrCallback !== undefined) args.push(encodingOrCallback);
    if (callback !== undefined) args.push(callback);
    return Reflect.apply(originalWrite, stream, args) as boolean;
  }) as NodeJS.WriteStream['write'];
  stream.write = write;

  return () => {
    if (stream.write === write) stream.write = originalWrite;
  };
};

export const installPersonalLogging = (
  logsDir: string,
  options: PersonalLoggingOptions = {},
): InstalledPersonalLogging => {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_LOG_FILE_COUNT;
  try {
    const stdoutSink = new RotatingFileSink(join(logsDir, PERSONAL_STDOUT_LOG), maxBytes, maxFiles);
    const stderrSink = new RotatingFileSink(join(logsDir, PERSONAL_STDERR_LOG), maxBytes, maxFiles);
    const restoreStdout = teeStream(options.stdout ?? process.stdout, stdoutSink);
    const restoreStderr = teeStream(options.stderr ?? process.stderr, stderrSink);
    return {
      restore: () => {
        restoreStderr();
        restoreStdout();
      },
    };
  } catch (cause) {
    throw new Error(`Floway One could not initialize bounded logs in ${logsDir}`, { cause });
  }
};
