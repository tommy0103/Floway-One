import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { listenNodeServer } from '../src/node-listener.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(error => error ? reject(error) : resolve());
  })));
});

describe('Node listener', () => {
  it('binds the requested loopback interface', async () => {
    const server = createServer();
    servers.push(server);

    const address = await listenNodeServer(server, {
      displayEndpoint: 'http://127.0.0.1:0',
      hostname: '127.0.0.1',
      port: 0,
      serviceName: 'Floway',
    });

    expect(address.address).toBe('127.0.0.1');
  });

  it('fails on a port conflict with actionable context and the original error', async () => {
    const occupied = createServer();
    servers.push(occupied);
    const occupiedAddress = await new Promise<AddressInfo>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', () => resolve(occupied.address() as AddressInfo));
    });
    const conflicting = createServer();
    servers.push(conflicting);

    try {
      await listenNodeServer(conflicting, {
        displayEndpoint: `http://127.0.0.1:${occupiedAddress.port}`,
        hostname: '127.0.0.1',
        port: occupiedAddress.port,
        serviceName: 'Floway',
      });
      throw new Error('expected the occupied port to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`http://127.0.0.1:${occupiedAddress.port}`);
      expect((error as Error).message).toMatch(/stop the process using it/);
      expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('EADDRINUSE');
    }
  });
});
