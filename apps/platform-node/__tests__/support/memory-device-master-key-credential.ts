import type { DeviceMasterKeyCredential } from '../../src/device-master-key.ts';

export class MemoryDeviceMasterKeyCredential implements DeviceMasterKeyCredential {
  reads = 0;
  writes: Uint8Array[] = [];

  constructor(private secret: ArrayLike<number> | null) {}

  getSecret(): ArrayLike<number> | null {
    this.reads++;
    return this.secret;
  }

  setSecret(secret: Uint8Array): void {
    this.secret = [...secret];
    this.writes.push(new Uint8Array(secret));
  }
}
