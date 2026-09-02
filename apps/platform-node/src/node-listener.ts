import type { AddressInfo } from 'node:net';

import type { ServerType } from '@hono/node-server';

interface NodeListenerOptions {
  readonly displayEndpoint: string;
  readonly hostname?: string;
  readonly port: number;
  readonly serviceName: string;
}

export const listenNodeServer = (
  server: ServerType,
  options: NodeListenerOptions,
): Promise<AddressInfo> => new Promise((resolve, reject) => {
  const onError = (cause: Error): void => {
    reject(new Error(
      `${options.serviceName} failed to listen on ${options.displayEndpoint}. The configured port is unavailable; stop the process using it or persist a different port before retrying.`,
      { cause },
    ));
  };
  const onListening = (): void => {
    server.off('error', onError);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error(`${options.serviceName} listener did not expose a TCP address`));
      return;
    }
    resolve(address);
  };

  server.once('error', onError);
  if (options.hostname === undefined) server.listen(options.port, onListening);
  else server.listen(options.port, options.hostname, onListening);
});
