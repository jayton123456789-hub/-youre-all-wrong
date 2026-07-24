import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { makeTestShowpack } from '../domain/testkit/showpack.js';
import { SqliteEventStore } from './event-store.js';
import { SessionRuntime } from './session-runtime.js';

function joinInput(runtime: SessionRuntime, name = 'Riley') {
  return {
    protocolVersion: 1 as const,
    commandId: randomUUID(),
    sessionCode: runtime.identity.code,
    joinSecret: runtime.identity.joinSecret,
    clientId: randomUUID(),
    displayName: name,
  };
}

describe('SessionRuntime', () => {
  it('joins, resumes, and never stores the raw resume token in state', async () => {
    const runtime = new SessionRuntime({
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
    });
    const joined = await runtime.join(joinInput(runtime));

    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.snapshot.self?.playerId).toBe(joined.playerId);
      expect(JSON.stringify(runtime.state)).not.toContain(joined.resumeToken);
      const resumed = await runtime.resume({
        protocolVersion: 1,
        commandId: randomUUID(),
        sessionCode: runtime.identity.code,
        playerId: joined.playerId,
        resumeToken: joined.resumeToken,
      });
      expect(resumed.ok).toBe(true);
    }
    runtime.close();
  });

  it('automatically reveals shortly after everyone answers', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const runtime = new SessionRuntime({
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
      now: () => now,
    });
    const joined = await runtime.join(joinInput(runtime));
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    await runtime.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: runtime.state.revision,
      action: 'start',
    });
    await runtime.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: runtime.state.revision,
      action: 'advance',
    });
    const snapshot = runtime.playerSnapshot(joined.playerId);
    now += 1_000;
    await runtime.submitAnswer(joined.playerId, {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: snapshot.revision,
      questionId: snapshot.question!.id,
      answerId: 'correct-a',
      phaseToken: snapshot.self!.phaseToken!,
    });

    await vi.advanceTimersByTimeAsync(700);

    expect(runtime.state.phase).toBe('reveal');
    runtime.close();
    vi.useRealTimers();
  });

  it('verifies and recovers an in-progress event stream after a runtime restart', async () => {
    const store = new SqliteEventStore();
    const identity = {
      sessionId: randomUUID(),
      code: 'WRNG2',
      hostSecret: 'host-secret-that-is-long-enough-to-be-secure',
      joinSecret: 'join-secret-that-is-long-enough',
    };
    const options = {
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
      store,
      ...identity,
    };
    const first = new SessionRuntime(options);
    const joined = await first.join(joinInput(first));
    expect(joined.ok).toBe(true);
    await first.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: first.state.revision,
      action: 'start',
    });
    await first.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: first.state.revision,
      action: 'advance',
    });
    const revisionBeforeRestart = first.state.revision;
    first.close();

    const recovered = new SessionRuntime(options);

    expect(recovered.state.phase).toBe('question');
    expect(recovered.state.revision).toBe(revisionBeforeRestart);
    expect(Object.values(recovered.state.players).map((player) => player.name)).toEqual(['Riley']);
    recovered.close();
    store.close();
  });
});
