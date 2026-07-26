import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AttachSuccess,
  ClientToServerEvents,
  JoinSuccess,
  ProtocolAck,
  ServerToClientEvents,
} from '../domain/protocol.js';
import { makeTestShowpack } from '../domain/testkit/showpack.js';
import { createGameServer, type GameServer } from './app.js';
import type { VoicePreflightService } from './voice-preflight.js';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const resources: Array<{ server: GameServer; sockets: TestClient[] }> = [];
const temporaryDirectories: string[] = [];
const readyVoice: VoicePreflightService = {
  status: {
    state: 'ready',
    completed: 1,
    total: 1,
    rendered: 0,
    cached: 1,
    voiceName: 'Test Host',
    message: 'Test voice is ready.',
    activity: null,
  },
  manifest: null,
  fileForCue: () => null,
  prepare: async () => undefined,
};

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const socket of resource.sockets) socket.close();
    await resource.server.stop();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function testServer(): Promise<{
  server: GameServer;
  origin: string;
  socket: TestClient;
}> {
  const server = await createGameServer({
    pack: makeTestShowpack(),
    packHash: 'a'.repeat(64),
    port: 0,
    logger: false,
    voice: readyVoice,
  });
  const started = await server.start();
  const origin = `http://127.0.0.1:${started.port}`;
  const socket: TestClient = createClient(origin, {
    path: '/realtime',
    transports: ['websocket'],
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  resources.push({ server, sockets: [socket] });
  return { server, origin, socket };
}

describe('LAN game server', () => {
  it('keeps HTTP LAN assets loadable instead of forcing nonexistent HTTPS', async () => {
    const { origin } = await testServer();
    const response = await fetch(`${origin}/api/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(response.headers.get('content-security-policy')).toContain("media-src 'self' blob:");
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('rejects a fake host secret', async () => {
    const { server, socket } = await testServer();
    const ack = await new Promise<ProtocolAck<AttachSuccess>>((resolve) => {
      socket.emit(
        'host:attach',
        {
          protocolVersion: 1,
          sessionId: server.runtime.identity.sessionId,
          hostSecret: 'x'.repeat(48),
        },
        resolve,
      );
    });

    expect(ack).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('keeps Start locked with the voice setup message until preflight is ready', async () => {
    const setupMessage =
      'No approved neural host profile is installed. Install the local voice runtime first.';
    const unavailableVoice: VoicePreflightService = {
      status: {
        state: 'error',
        completed: 0,
        total: 0,
        rendered: 0,
        cached: 0,
        voiceName: 'Neural host unavailable',
        message: setupMessage,
        activity: null,
      },
      manifest: null,
      fileForCue: () => null,
      prepare: async () => undefined,
    };
    const server = await createGameServer({
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
      port: 0,
      logger: false,
      voice: unavailableVoice,
    });
    const started = await server.start();
    const socket: TestClient = createClient(`http://127.0.0.1:${started.port}`, {
      path: '/realtime',
      transports: ['websocket'],
      forceNew: true,
    });
    resources.push({ server, sockets: [socket] });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const attached = await new Promise<ProtocolAck<AttachSuccess>>((resolve) => {
      socket.emit(
        'host:attach',
        {
          protocolVersion: 1,
          sessionId: server.runtime.identity.sessionId,
          hostSecret: server.runtime.identity.hostSecret,
        },
        resolve,
      );
    });
    expect(attached.ok).toBe(true);

    const start = await new Promise<ProtocolAck>((resolve) => {
      socket.emit(
        'host:command',
        {
          protocolVersion: 1,
          commandId: randomUUID(),
          expectedRevision: server.runtime.state.revision,
          action: 'start',
        },
        resolve,
      );
    });

    expect(start).toMatchObject({
      ok: false,
      code: 'command_rejected',
      message: setupMessage,
      retryable: true,
      currentRevision: server.runtime.state.revision,
    });
    expect(server.runtime.state.phase).toBe('lobby');
  });

  it('serves persisted showpack media by declared ID only to the host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yaw-app-assets-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'sting.wav');
    const bytes = Buffer.from('test wave bytes');
    await writeFile(path, bytes);
    const asset = {
      id: 'sting',
      kind: 'audio' as const,
      bytes: bytes.length,
      sha256: 'a'.repeat(64),
      filePath: path,
    };
    const server = await createGameServer({
      pack: makeTestShowpack(),
      packHash: 'a'.repeat(64),
      port: 0,
      logger: false,
      voice: readyVoice,
      showpackAssets: {
        root: directory,
        assets: [asset],
        fileForId: (id) => (id === asset.id ? asset : null),
      },
    });
    const started = await server.start();
    resources.push({ server, sockets: [] });
    const origin = `http://127.0.0.1:${started.port}`;

    expect((await fetch(`${origin}/api/showpack/assets/sting`)).status).toBe(401);
    const response = await fetch(`${origin}/api/showpack/assets/sting`, {
      headers: { 'x-yaw-host-key': server.runtime.identity.hostSecret },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it('runs a complete networked question without leaking its solution', async () => {
    const { server, origin, socket: host } = await testServer();
    const player: TestClient = createClient(origin, {
      path: '/realtime',
      transports: ['websocket'],
      forceNew: true,
    });
    resources[0]!.sockets.push(player);
    await new Promise<void>((resolve, reject) => {
      player.once('connect', resolve);
      player.once('connect_error', reject);
    });

    const attached = await new Promise<ProtocolAck<AttachSuccess>>((resolve) => {
      host.emit(
        'host:attach',
        {
          protocolVersion: 1,
          sessionId: server.runtime.identity.sessionId,
          hostSecret: server.runtime.identity.hostSecret,
        },
        resolve,
      );
    });
    expect(attached.ok).toBe(true);

    const joined = await new Promise<ProtocolAck<JoinSuccess>>((resolve) => {
      player.emit(
        'player:join',
        {
          protocolVersion: 1,
          commandId: randomUUID(),
          sessionCode: server.runtime.identity.code,
          joinSecret: server.runtime.identity.joinSecret,
          clientId: randomUUID(),
          displayName: 'Riley',
        },
        resolve,
      );
    });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    for (const action of ['start', 'advance'] as const) {
      const ack = await new Promise<ProtocolAck>((resolve) => {
        host.emit(
          'host:command',
          {
            protocolVersion: 1,
            commandId: randomUUID(),
            expectedRevision: server.runtime.state.revision,
            action,
          },
          resolve,
        );
      });
      expect(ack.ok).toBe(true);
    }

    const questionSnapshot = server.runtime.playerSnapshot(joined.playerId);
    expect(questionSnapshot.phase).toBe('question');
    expect(questionSnapshot.question?.timingPhase).toBe('prompt');
    expect(questionSnapshot.question?.answers).toEqual([]);
    expect(questionSnapshot.self?.phaseToken).toBeNull();
    expect(questionSnapshot.presentation).toBeNull();
    const serialized = JSON.stringify(questionSnapshot);
    expect(serialized).not.toContain('correctAnswerId');
    expect(serialized).not.toContain('wrongAnswerReactions');

    const answersPresentedAck = await new Promise<ProtocolAck>((resolve) => {
      host.emit(
        'host:command',
        {
          protocolVersion: 1,
          commandId: randomUUID(),
          expectedRevision: server.runtime.state.revision,
          action: 'answers_presented',
          questionId: questionSnapshot.question!.id,
        },
        resolve,
      );
    });
    expect(answersPresentedAck.ok).toBe(true);
    expect(server.runtime.state.currentQuestion?.timingPhase).toBe('answering');
    const answerSnapshot = server.runtime.playerSnapshot(joined.playerId);
    expect(answerSnapshot.question?.answers).toHaveLength(4);
    expect(answerSnapshot.self?.phaseToken).toBeTruthy();

    const revealPush = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Reveal push timed out.')), 3_000);
      player.on('state', (push) => {
        if (push.snapshot.phase === 'reveal') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const answerAck = await new Promise<ProtocolAck>((resolve) => {
      player.emit(
        'player:answer',
        {
          protocolVersion: 1,
          commandId: randomUUID(),
          expectedRevision: answerSnapshot.revision,
          questionId: answerSnapshot.question!.id,
          answerId: 'correct-a',
          phaseToken: answerSnapshot.self!.phaseToken!,
        },
        resolve,
      );
    });
    expect(answerAck.ok).toBe(true);
    await revealPush;

    expect(server.runtime.state.phase).toBe('reveal');
    expect(server.runtime.state.players[joined.playerId]?.score).toBeGreaterThan(1_000);
  });
});
