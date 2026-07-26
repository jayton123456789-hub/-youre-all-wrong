import { createReadStream, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, resolve } from 'node:path';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { Server as SocketServer, type Socket } from 'socket.io';

import {
  HostAttachSchema,
  HostCommandSchema,
  PlayerAnswerSchema,
  PlayerJoinSchema,
  PlayerReadySchema,
  PlayerResumeSchema,
  type AckCallback,
  type AttachSuccess,
  type ClientToServerEvents,
  type JoinSuccess,
  type ProtocolAck,
  type ServerToClientEvents,
  type StatePush,
} from '../domain/protocol.js';
import type { Showpack } from '../domain/showpack/schema.js';
import { SqliteEventStore } from './event-store.js';
import { SessionRuntime } from './session-runtime.js';
import type { RuntimeShowpackAsset, ShowpackAssetLibrary } from './showpack-assets.js';
import type { VoicePreflightService } from './voice-preflight.js';

const PROTOCOL_VERSION = 1;
const SOCKET_PATH = '/realtime';
const MAX_SOCKET_EVENTS_PER_WINDOW = 100;
const SOCKET_RATE_WINDOW_MS = 10_000;

interface SocketData {
  role?: 'host' | 'player';
  playerId?: string;
  connectionEpoch?: number;
}

type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface GameServerOptions {
  pack: Showpack;
  packHash: string;
  sessionId?: string;
  code?: string;
  hostSecret?: string;
  joinSecret?: string;
  host?: string;
  port?: number;
  publicWebPort?: number;
  webRoot?: string;
  databasePath?: string;
  logger?: boolean;
  voice?: VoicePreflightService;
  showpackAssets?: ShowpackAssetLibrary;
}

export interface StartedGameServer {
  hostUrl: string;
  joinUrls: string[];
  port: number;
}

export interface GameServer {
  app: FastifyInstance;
  io: SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  runtime: SessionRuntime;
  start(): Promise<StartedGameServer>;
  stop(): Promise<void>;
}

function privateLanAddresses(): string[] {
  const candidates: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (
        entry.address.startsWith('10.') ||
        entry.address.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)
      ) {
        candidates.push(entry.address);
      }
    }
  }
  return [...new Set(candidates)];
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function badRequest(error: unknown): Extract<ProtocolAck, { ok: false }> {
  let message = 'That message did not match the game protocol.';
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues?: Array<{ message?: string }> }).issues;
    message = issues?.[0]?.message ?? message;
  }
  return {
    ok: false,
    code: 'bad_request',
    message,
    retryable: true,
  };
}

function showpackAssetContentType(asset: RuntimeShowpackAsset): string {
  const extension = extname(asset.filePath).toLocaleLowerCase('en-US');
  const known: Record<string, string> = {
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.mp3': 'audio/mpeg',
    '.mp4': asset.kind === 'audio' ? 'audio/mp4' : 'video/mp4',
    '.ogg': asset.kind === 'video' ? 'video/ogg' : 'audio/ogg',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.wav': 'audio/wav',
    '.webm': asset.kind === 'audio' ? 'audio/webm' : 'video/webm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return known[extension] ?? 'application/octet-stream';
}

function requireAck<T>(acknowledge: unknown): AckCallback<T> | null {
  return typeof acknowledge === 'function' ? (acknowledge as AckCallback<T>) : null;
}

export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? 4310;
  const store = new SqliteEventStore(options.databasePath);
  const runtime = new SessionRuntime({
    pack: options.pack,
    packHash: options.packHash,
    store,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.code ? { code: options.code } : {}),
    ...(options.hostSecret ? { hostSecret: options.hostSecret } : {}),
    ...(options.joinSecret ? { joinSecret: options.joinSecret } : {}),
  });
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers.x-yaw-host-key',
                '*.hostSecret',
                '*.joinSecret',
                '*.resumeToken',
              ],
              censor: '[REDACTED]',
            },
          },
    bodyLimit: 256 * 1024,
    requestTimeout: 10_000,
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    methods: ['GET', 'POST'],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        // The host eagerly downloads every cooked WAV and plays it from an
        // in-memory object URL. Keep that preload architecture CSP-safe.
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: false,
  });
  await app.register(rateLimit, {
    // A host intentionally preloads every authored voice clip before Start unlocks.
    // Full episodes can contain hundreds of clips, all protected by the host secret.
    max: 2_000,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'youre-all-wrong-runtime',
    protocolVersion: PROTOCOL_VERSION,
    sessionPhase: runtime.state.phase,
    revision: runtime.state.revision,
  }));

  app.get('/api/runtime', async () => ({
    protocolVersion: PROTOCOL_VERSION,
    socketPath: SOCKET_PATH,
    sessionId: runtime.identity.sessionId,
    sessionCode: runtime.identity.code,
    episode: {
      id: runtime.pack.episode.id,
      title: runtime.pack.episode.title,
    },
  }));

  const hostKey = (header: string | string[] | undefined): string =>
    Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  const authorizeVoiceRequest = (header: string | string[] | undefined): boolean =>
    runtime.verifyHostSecret(hostKey(header));

  app.get('/api/voice/status', async (request, reply) => {
    if (!authorizeVoiceRequest(request.headers['x-yaw-host-key'])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!options.voice) {
      return reply.code(503).send({
        state: 'error',
        completed: 0,
        total: 0,
        rendered: 0,
        cached: 0,
        voiceName: 'Unavailable',
        message: 'This runtime was launched without a local voice renderer.',
        activity: null,
      });
    }
    return options.voice.status;
  });

  app.get('/api/voice/manifest', async (request, reply) => {
    if (!authorizeVoiceRequest(request.headers['x-yaw-host-key'])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const manifest = options.voice?.manifest;
    if (!manifest) {
      return reply.code(409).send({
        error: 'voice_not_ready',
        status: options.voice?.status ?? null,
      });
    }
    return manifest;
  });

  app.get<{ Params: { cueId: string } }>('/api/voice/audio/:cueId', async (request, reply) => {
    if (!authorizeVoiceRequest(request.headers['x-yaw-host-key'])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const path = options.voice?.fileForCue(request.params.cueId);
    if (!path || !existsSync(path)) {
      return reply.code(404).send({ error: 'voice_asset_not_found' });
    }
    return reply
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .type('audio/wav')
      .send(createReadStream(path));
  });

  app.get('/api/showpack/assets', async (request, reply) => {
    if (!authorizeVoiceRequest(request.headers['x-yaw-host-key'])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return {
      assets: (options.showpackAssets?.assets ?? []).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        bytes: asset.bytes,
        sha256: asset.sha256,
      })),
    };
  });

  app.get<{ Params: { assetId: string } }>(
    '/api/showpack/assets/:assetId',
    async (request, reply) => {
      if (!authorizeVoiceRequest(request.headers['x-yaw-host-key'])) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const asset = options.showpackAssets?.fileForId(request.params.assetId);
      if (!asset || !existsSync(asset.filePath)) {
        return reply.code(404).send({ error: 'showpack_asset_not_found' });
      }
      return reply
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .type(showpackAssetContentType(asset))
        .send(createReadStream(asset.filePath));
    },
  );

  const resolvedWebRoot = options.webRoot ? resolve(options.webRoot) : null;
  if (resolvedWebRoot && existsSync(resolve(resolvedWebRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: resolvedWebRoot,
      wildcard: false,
      index: false,
      maxAge: '1h',
      immutable: false,
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('index.html')) {
          response.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
        return reply.header('Cache-Control', 'no-cache').type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.get('/', async () => ({
      name: "YOU'RE ALL WRONG!",
      message: 'The runtime is healthy. Build the web client to serve the game screen.',
    }));
  }

  const io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(app.server, {
    path: SOCKET_PATH,
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    transports: ['websocket', 'polling'],
    connectionStateRecovery: {
      maxDisconnectionDuration: 30_000,
      skipMiddlewares: false,
    },
    cors: {
      origin: (origin, callback) => callback(null, originAllowed(origin)),
      methods: ['GET', 'POST'],
    },
  });

  let started: StartedGameServer | null = null;

  const currentJoinUrls = (): string[] => {
    const webPort = options.publicWebPort ?? started?.port ?? requestedPort;
    const fragment = runtime.identity.joinSecret;
    return privateLanAddresses().map(
      (address) =>
        `http://${address}:${webPort}/join/${runtime.identity.code}#${encodeURIComponent(fragment)}`,
    );
  };

  const pushState = () => {
    io.to(`host:${runtime.identity.sessionId}`).emit('state', {
      sequence: runtime.state.revision,
      snapshot: runtime.hostSnapshot,
    });
    for (const playerId of Object.keys(runtime.state.players)) {
      io.to(`player:${playerId}`).emit('state', {
        sequence: runtime.state.revision,
        snapshot: runtime.playerSnapshot(playerId),
      });
    }
  };

  runtime.subscribe(pushState);

  io.on('connection', (socket: GameSocket) => {
    const eventTimes: number[] = [];
    socket.use(([eventName], next) => {
      const now = Date.now();
      while (eventTimes[0] !== undefined && eventTimes[0] < now - SOCKET_RATE_WINDOW_MS) {
        eventTimes.shift();
      }
      if (eventTimes.length >= MAX_SOCKET_EVENTS_PER_WINDOW) {
        next(new Error(`Rate limit exceeded for ${eventName}.`));
        return;
      }
      eventTimes.push(now);
      next();
    });

    socket.on('host:attach', (raw, rawAck) => {
      const acknowledge = requireAck<AttachSuccess>(rawAck);
      if (!acknowledge) return;
      const parsed = HostAttachSchema.safeParse(raw);
      if (!parsed.success) {
        acknowledge(badRequest(parsed.error));
        return;
      }
      if (
        parsed.data.sessionId !== runtime.identity.sessionId ||
        !runtime.verifyHostSecret(parsed.data.hostSecret)
      ) {
        acknowledge({
          ok: false,
          code: 'unauthorized',
          message: 'This window is not authorized to control the show.',
          retryable: false,
        });
        return;
      }
      socket.data.role = 'host';
      void socket.join(`host:${runtime.identity.sessionId}`);
      acknowledge({
        ok: true,
        snapshot: runtime.hostSnapshot,
        joinUrls: currentJoinUrls(),
      });
    });

    socket.on('host:command', async (raw, rawAck) => {
      const acknowledge = requireAck(rawAck);
      if (!acknowledge) return;
      if (socket.data.role !== 'host') {
        acknowledge({
          ok: false,
          code: 'unauthorized',
          message: 'Only the host can control the show.',
          retryable: false,
        });
        return;
      }
      const parsed = HostCommandSchema.safeParse(raw);
      if (!parsed.success) {
        acknowledge(badRequest(parsed.error));
        return;
      }
      if (parsed.data.action === 'start' && options.voice?.status.state !== 'ready') {
        acknowledge({
          ok: false,
          code: 'command_rejected',
          message:
            options.voice?.status.message ??
            'The show cannot start without a fully pre-cooked local voice track.',
          retryable: true,
          currentRevision: runtime.state.revision,
        });
        return;
      }
      acknowledge(await runtime.hostCommand(parsed.data));
    });

    socket.on('player:join', async (raw, rawAck) => {
      const acknowledge = requireAck<JoinSuccess>(rawAck);
      if (!acknowledge) return;
      const parsed = PlayerJoinSchema.safeParse(raw);
      if (!parsed.success) {
        acknowledge(badRequest(parsed.error));
        return;
      }
      const result = await runtime.join(parsed.data);
      if (result.ok) {
        socket.data.role = 'player';
        socket.data.playerId = result.playerId;
        socket.data.connectionEpoch = result.connectionEpoch;
        void socket.join(`player:${result.playerId}`);
      }
      acknowledge(result);
    });

    socket.on('player:resume', async (raw, rawAck) => {
      const acknowledge = requireAck<JoinSuccess>(rawAck);
      if (!acknowledge) return;
      const parsed = PlayerResumeSchema.safeParse(raw);
      if (!parsed.success) {
        acknowledge(badRequest(parsed.error));
        return;
      }
      const result = await runtime.resume(parsed.data);
      if (result.ok) {
        socket.data.role = 'player';
        socket.data.playerId = result.playerId;
        socket.data.connectionEpoch = result.connectionEpoch;
        void socket.join(`player:${result.playerId}`);
      }
      acknowledge(result);
    });

    socket.on('player:ready', async (raw, rawAck) => {
      const acknowledge = requireAck(rawAck);
      if (!acknowledge) return;
      if (socket.data.role !== 'player' || !socket.data.playerId) {
        acknowledge({
          ok: false,
          code: 'unauthorized',
          message: 'Join the room before changing ready state.',
          retryable: true,
        });
        return;
      }
      if (
        socket.data.connectionEpoch === undefined ||
        !runtime.verifyConnectionLease(socket.data.playerId, socket.data.connectionEpoch)
      ) {
        acknowledge({
          ok: false,
          code: 'unauthorized',
          message: 'This controller was replaced by a newer connection.',
          retryable: false,
        });
        return;
      }
      const parsed = PlayerReadySchema.safeParse(raw);
      if (!parsed.success) {
        acknowledge(badRequest(parsed.error));
        return;
      }
      acknowledge(await runtime.setReady(socket.data.playerId, parsed.data));
    });

    socket.on('player:answer', async (raw, rawAck) => {
      const acknowledge = requireAck(rawAck);
      if (!acknowledge) return;
      if (socket.data.role !== 'player' || !socket.data.playerId) {
        acknowledge({
          ok: false,
          code: 'unauthorized',
          message: 'Join the room before answering.',
          retryable: true,
        });
        return;
      }
      if (
        socket.data.connectionEpoch === undefined ||
        !runtime.verifyConnectionLease(socket.data.playerId, socket.data.connectionEpoch)
      ) {
        acknowledge({
          ok: false,
          code: 'unauthorized',
          message: 'This controller was replaced by a newer connection.',
          retryable: false,
        });
        return;
      }
      const parsed = PlayerAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        acknowledge(badRequest(parsed.error));
        return;
      }
      acknowledge(await runtime.submitAnswer(socket.data.playerId, parsed.data));
    });

    socket.on('disconnect', () => {
      if (
        socket.data.role === 'player' &&
        socket.data.playerId &&
        socket.data.connectionEpoch !== undefined
      ) {
        runtime.markDisconnected(socket.data.playerId, socket.data.connectionEpoch);
      }
    });
  });

  return {
    app,
    io,
    runtime,
    async start() {
      const address = await app.listen({ host, port: requestedPort });
      const parsedAddress = new URL(address);
      const port = Number(parsedAddress.port);
      const webPort = options.publicWebPort ?? port;
      started = {
        port,
        hostUrl: `http://127.0.0.1:${webPort}/host#host=${encodeURIComponent(
          runtime.identity.hostSecret,
        )}&runtime=${encodeURIComponent(`http://127.0.0.1:${port}`)}`,
        joinUrls: currentJoinUrls(),
      };
      if (options.voice) {
        void options.voice.prepare().catch((error: unknown) => {
          app.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Episode voice preflight failed.',
          );
        });
      }
      return started;
    },
    async stop() {
      await io.close();
      await app.close();
      runtime.close();
      store.close();
    },
  };
}
