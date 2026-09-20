// The desktop shell owns this sidecar through two observable channels:
//
// - The shell spawns the sidecar with a piped stdin whose write end stays open
//   inside the shell's CommandChild for the sidecar's whole lifetime. Any
//   shell termination — including SIGKILL, which runs no Rust cleanup — makes
//   the kernel close that write end, so stdin EOF is a forced-termination
//   signal the sidecar can act on instead of leaking a listener on the
//   endpoint. https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/process/mod.rs#L300-L367
//   https://nodejs.org/docs/latest-v24.x/api/process.html#processstdin
// - The shell stops the sidecar gracefully with SIGTERM before it would fall
//   back to SIGKILL. Handling it keeps the exit code clean and the lifecycle
//   log line ordered ahead of process exit.
//   https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events
//
// Both behaviors activate only when the desktop contract environment marks
// this process as a packaged desktop sidecar; plain Node and server-profile
// runs keep Node's default signal and stdin behavior.
import { DESKTOP_RUNTIME_CONTRACT_ENV } from './desktop-runtime-compatibility.ts';

export const DESKTOP_SIDECAR_GRACEFUL_STOP_LINE = "Floway desktop sidecar is stopping on its owner's request";
export const DESKTOP_SIDECAR_OWNER_LOST_LINE = 'Floway desktop sidecar is exiting because its owner shell is gone';

interface OwnerLifetimeChannel {
  on(event: 'end' | 'error', listener: () => void): unknown;
  resume(): unknown;
}

export interface DesktopSidecarLifecycleHost {
  on(signal: 'SIGTERM', listener: () => void): unknown;
  exit(code: number): void;
  stderr: {
    write(chunk: string, callback: () => void): unknown;
  };
}

export interface DesktopSidecarLifecycleOverrides {
  readonly environment?: NodeJS.ProcessEnv;
  readonly host?: DesktopSidecarLifecycleHost;
  readonly stdin?: OwnerLifetimeChannel;
}

const EXIT_FLUSH_FALLBACK_MS = 250;

export const installDesktopSidecarLifecycle = (
  overrides: DesktopSidecarLifecycleOverrides = {},
): void => {
  const environment = overrides.environment ?? process.env;
  if (environment[DESKTOP_RUNTIME_CONTRACT_ENV] === undefined) return;
  const host = overrides.host ?? process;
  const stdin = overrides.stdin ?? process.stdin;
  let exitStarted = false;
  const exitAfterFlush = (line: string): void => {
    if (exitStarted) return;
    exitStarted = true;
    let exited = false;
    const exitOnce = (): void => {
      if (exited) return;
      exited = true;
      host.exit(0);
    };
    host.stderr.write(`${line}\n`, exitOnce);
    // A dead owner also closed this sidecar's stderr reader, so the flush
    // callback is not guaranteed to fire; exit on a bounded fallback instead.
    setTimeout(exitOnce, EXIT_FLUSH_FALLBACK_MS).unref();
  };
  host.on('SIGTERM', () => exitAfterFlush(DESKTOP_SIDECAR_GRACEFUL_STOP_LINE));
  stdin.on('end', () => exitAfterFlush(DESKTOP_SIDECAR_OWNER_LOST_LINE));
  stdin.on('error', () => exitAfterFlush(DESKTOP_SIDECAR_OWNER_LOST_LINE));
  stdin.resume();
};
