import { describe, expect, it } from 'vitest';

import type { GameEvent } from '../domain/game/types.js';
import { SqliteEventStore } from './event-store.js';

describe('SqliteEventStore', () => {
  it('atomically appends a hash-chained event stream', () => {
    const store = new SqliteEventStore();
    const genesis: GameEvent = {
      type: 'session.created',
      at: 100,
      sessionId: 'session-1',
      code: 'WRONG',
      packHash: 'a'.repeat(64),
      seed: 42,
    };
    const joined: GameEvent = {
      type: 'player.joined',
      at: 200,
      player: {
        id: 'p1',
        name: 'Riley',
        joinOrder: 0,
        connected: true,
        ready: false,
        score: 0,
        currentStreak: 0,
        bestStreak: 0,
      },
    };

    store.append('session-1', 0, [genesis]);
    store.append('session-1', 1, [joined], {
      command: {
        actorId: 'client-1',
        commandId: 'command-1',
        result: { ok: true },
        createdAt: 200,
      },
      credential: {
        playerId: 'p1',
        clientId: 'client-1',
        tokenHash: 'hash',
        connectionEpoch: 1,
      },
    });

    expect(store.latestSequence('session-1')).toBe(2);
    expect(store.verifyEventChain('session-1')).toBe(true);
    expect(store.readCommandResult('session-1', 'client-1', 'command-1')).toEqual({ ok: true });
    expect(store.readCredential('session-1', 'p1')).toMatchObject({ tokenHash: 'hash' });
    store.close();
  });

  it('refuses a stale expected sequence without a partial write', () => {
    const store = new SqliteEventStore();
    store.append('session-1', 0, [
      {
        type: 'session.created',
        at: 100,
        sessionId: 'session-1',
        code: 'WRONG',
        packHash: 'a'.repeat(64),
        seed: 42,
      },
    ]);

    expect(() => store.append('session-1', 0, [{ type: 'show.started', at: 200 }])).toThrow(
      /conflict/,
    );
    expect(store.readEvents('session-1')).toHaveLength(1);
    store.close();
  });
});
