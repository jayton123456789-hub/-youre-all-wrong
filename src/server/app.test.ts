import { randomUUID } from 'node:crypto';

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

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const resources: Array<{ server: GameServer; sockets: TestClient[] }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const socket of resource.sockets) socket.close();
    await resource.server.stop();
  }
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
    const serialized = JSON.stringify(questionSnapshot);
    expect(serialized).not.toContain('correctAnswerId');
    expect(serialized).not.toContain('wrongAnswerReactions');

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
          expectedRevision: questionSnapshot.revision,
          questionId: questionSnapshot.question!.id,
          answerId: 'correct-a',
          phaseToken: questionSnapshot.self!.phaseToken!,
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
