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
    await runtime.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: runtime.state.revision,
      action: 'answers_presented',
      questionId: runtime.hostSnapshot.question!.id,
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

  it('starts no deadline during the prompt, then runs the full window after answers appear', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const runtime = new SessionRuntime({
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
      now: () => now,
    });
    const joined = await runtime.join(joinInput(runtime));
    expect(joined.ok).toBe(true);

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

    expect(runtime.state.currentQuestion).toMatchObject({
      timingPhase: 'prompt',
      deadlineAt: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.state.phase).toBe('question');
    expect(runtime.state.currentQuestion?.timingPhase).toBe('prompt');

    const question = runtime.hostSnapshot.question!;
    now = 5_000;
    await runtime.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: runtime.state.revision,
      action: 'answers_presented',
      questionId: question.id,
    });

    expect(runtime.state.currentQuestion).toMatchObject({
      timingPhase: 'answering',
      answerWindowOpenedAt: 5_000,
      deadlineAt: 25_000,
    });
    now = 7_000;
    await runtime.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: runtime.state.revision,
      action: 'answer_narration_complete',
      questionId: question.id,
    });
    expect(runtime.state.currentQuestion).toMatchObject({
      answerNarrationStatus: 'completed',
      answerNarrationEndedAt: 7_000,
      answerWindowOpenedAt: 5_000,
      deadlineAt: 25_000,
    });

    now = 25_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtime.state.phase).toBe('reveal');
    expect(runtime.state.reveal?.reason).toBe('timer');
    runtime.close();
    vi.useRealTimers();
  });

  it('cuts answer narration on the first lock without restarting the timer', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const runtime = new SessionRuntime({
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
      now: () => now,
    });
    const first = await runtime.join(joinInput(runtime, 'Riley'));
    const second = await runtime.join(joinInput(runtime, 'Marcus'));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok) return;

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
    now = 3_000;
    await runtime.hostCommand({
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: runtime.state.revision,
      action: 'answers_presented',
      questionId: runtime.hostSnapshot.question!.id,
    });
    const snapshot = runtime.playerSnapshot(first.playerId);

    now = 4_500;
    const accepted = await runtime.submitAnswer(first.playerId, {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: snapshot.revision,
      questionId: snapshot.question!.id,
      answerId: 'correct-a',
      phaseToken: snapshot.self!.phaseToken!,
    });

    expect(accepted.ok).toBe(true);
    expect(runtime.state.currentQuestion).toMatchObject({
      timingPhase: 'answering',
      answerNarrationStatus: 'interrupted',
      answerNarrationEndedAt: 4_500,
      answerNarrationEndReason: 'first_answer',
      answerWindowOpenedAt: 3_000,
      deadlineAt: 23_000,
    });
    expect(runtime.state.currentQuestion?.answers[first.playerId]).toMatchObject({
      answerId: 'correct-a',
      receivedAt: 4_500,
    });
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
