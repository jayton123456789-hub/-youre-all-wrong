import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '../domain/canonical.js';
import type { EventEnvelope, GameEvent } from '../domain/game/types.js';

const GENESIS_HASH = '0'.repeat(64);

interface SequenceRow {
  sequence: number;
  hash: string;
}

interface EventRow {
  session_id: string;
  sequence: number;
  event_id: string;
  event_json: string;
  previous_hash: string;
  hash: string;
}

export interface CredentialRecord {
  playerId: string;
  clientId: string;
  tokenHash: string;
  connectionEpoch: number;
}

export interface CommandRecord {
  actorId: string;
  commandId: string;
  result: unknown;
  createdAt: number;
}

export interface AppendOptions {
  command?: CommandRecord;
  credential?: CredentialRecord;
}

export class SqliteEventStore {
  readonly #database: DatabaseSync;

  constructor(path: string = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const sqlite = process.getBuiltinModule('node:sqlite') as
      typeof import('node:sqlite') | undefined;
    if (!sqlite) {
      throw new Error('This runtime does not provide the required built-in SQLite module.');
    }
    this.#database = new sqlite.DatabaseSync(path);
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS command_results (
        session_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, actor_id, command_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS player_credentials (
        session_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        connection_epoch INTEGER NOT NULL,
        PRIMARY KEY (session_id, player_id),
        UNIQUE (session_id, client_id)
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  latestSequence(sessionId: string): number {
    const row = this.#database
      .prepare(
        `SELECT sequence, hash
         FROM session_events
         WHERE session_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(sessionId) as SequenceRow | undefined;
    return row?.sequence ?? 0;
  }

  append(
    sessionId: string,
    expectedSequence: number,
    events: GameEvent[],
    options: AppendOptions = {},
  ): EventEnvelope[] {
    if (events.length === 0) return [];
    this.#database.exec('BEGIN IMMEDIATE');

    try {
      const latest = this.#database
        .prepare(
          `SELECT sequence, hash
           FROM session_events
           WHERE session_id = ?
           ORDER BY sequence DESC
           LIMIT 1`,
        )
        .get(sessionId) as SequenceRow | undefined;
      const actualSequence = latest?.sequence ?? 0;
      if (actualSequence !== expectedSequence) {
        throw new Error(
          `Event stream conflict for ${sessionId}: expected ${expectedSequence}, found ${actualSequence}.`,
        );
      }

      let previousHash = latest?.hash ?? GENESIS_HASH;
      const envelopes: EventEnvelope[] = [];
      const insertEvent = this.#database.prepare(`
        INSERT INTO session_events (
          session_id, sequence, event_id, event_json, previous_hash, hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      events.forEach((event, index) => {
        const sequence = expectedSequence + index + 1;
        const eventId = randomUUID();
        const hash = createHash('sha256')
          .update(
            canonicalJson({
              sessionId,
              sequence,
              eventId,
              event,
              previousHash,
            }),
          )
          .digest('hex');
        const envelope: EventEnvelope = {
          sessionId,
          sequence,
          eventId,
          event,
          previousHash,
          hash,
        };
        insertEvent.run(
          sessionId,
          sequence,
          eventId,
          JSON.stringify(event),
          previousHash,
          hash,
          event.at,
        );
        envelopes.push(envelope);
        previousHash = hash;
      });

      if (options.command) {
        this.#database
          .prepare(
            `INSERT INTO command_results (
              session_id, actor_id, command_id, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            options.command.actorId,
            options.command.commandId,
            JSON.stringify(options.command.result),
            options.command.createdAt,
          );
      }

      if (options.credential) {
        this.#database
          .prepare(
            `INSERT INTO player_credentials (
              session_id, player_id, client_id, token_hash, connection_epoch
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, player_id) DO UPDATE SET
              client_id = excluded.client_id,
              token_hash = excluded.token_hash,
              connection_epoch = excluded.connection_epoch`,
          )
          .run(
            sessionId,
            options.credential.playerId,
            options.credential.clientId,
            options.credential.tokenHash,
            options.credential.connectionEpoch,
          );
      }

      this.#database.exec('COMMIT');
      return envelopes;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  readEvents(sessionId: string): EventEnvelope[] {
    const rows = this.#database
      .prepare(
        `SELECT session_id, sequence, event_id, event_json, previous_hash, hash
         FROM session_events
         WHERE session_id = ?
         ORDER BY sequence`,
      )
      .all(sessionId) as unknown as EventRow[];

    return rows.map((row) => ({
      sessionId: row.session_id,
      sequence: row.sequence,
      eventId: row.event_id,
      event: JSON.parse(row.event_json) as GameEvent,
      previousHash: row.previous_hash,
      hash: row.hash,
    }));
  }

  verifyEventChain(sessionId: string): boolean {
    let expectedPrevious = GENESIS_HASH;
    for (const envelope of this.readEvents(sessionId)) {
      if (envelope.previousHash !== expectedPrevious) return false;
      const expectedHash = createHash('sha256')
        .update(
          canonicalJson({
            sessionId: envelope.sessionId,
            sequence: envelope.sequence,
            eventId: envelope.eventId,
            event: envelope.event,
            previousHash: envelope.previousHash,
          }),
        )
        .digest('hex');
      if (expectedHash !== envelope.hash) return false;
      expectedPrevious = envelope.hash;
    }
    return true;
  }

  readCommandResult(sessionId: string, actorId: string, commandId: string): unknown | undefined {
    const row = this.#database
      .prepare(
        `SELECT result_json
         FROM command_results
         WHERE session_id = ? AND actor_id = ? AND command_id = ?`,
      )
      .get(sessionId, actorId, commandId) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as unknown) : undefined;
  }

  readCredential(sessionId: string, playerId: string): CredentialRecord | null {
    const row = this.#database
      .prepare(
        `SELECT player_id, client_id, token_hash, connection_epoch
         FROM player_credentials
         WHERE session_id = ? AND player_id = ?`,
      )
      .get(sessionId, playerId) as
      | {
          player_id: string;
          client_id: string;
          token_hash: string;
          connection_epoch: number;
        }
      | undefined;

    return row
      ? {
          playerId: row.player_id,
          clientId: row.client_id,
          tokenHash: row.token_hash,
          connectionEpoch: row.connection_epoch,
        }
      : null;
  }
}
