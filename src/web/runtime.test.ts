import { describe, expect, it } from 'vitest';

import { createBrowserId } from './runtime.js';

describe('browser runtime IDs', () => {
  it('creates a valid UUID when randomUUID is unavailable on an HTTP LAN page', () => {
    const fallbackCrypto = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array instanceof Uint8Array) array.fill(0xab);
        return array;
      },
    } as Crypto;

    expect(createBrowserId(fallbackCrypto)).toBe('abababab-abab-4bab-abab-abababababab');
  });
});
