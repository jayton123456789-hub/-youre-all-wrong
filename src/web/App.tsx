import {
  ArrowRight,
  Check,
  CircleNotch,
  Crown,
  DeviceMobile,
  Lightning,
  Play,
  Skull,
  UsersThree,
  WifiHigh,
  WifiSlash,
} from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import type { GameSnapshot } from '../domain/game/types.js';
import type {
  AttachSuccess,
  ClientToServerEvents,
  JoinSuccess,
  ProtocolAck,
  ServerToClientEvents,
} from '../domain/protocol.js';
import {
  clearCredential,
  createBrowserId,
  getOrCreateClientId,
  readCredential,
  readFragmentSecrets,
  writeCredential,
} from './runtime.js';
import { playUiSound } from './sound.js';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface RuntimeInfo {
  protocolVersion: 1;
  socketPath: string;
  sessionId: string;
  sessionCode: string;
  episode: { id: string; title: string };
}

const ANSWER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

function useClock(intervalMs = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useRuntimeSocket(runtimeOrigin: string): {
  socket: GameSocket | null;
  connected: boolean;
} {
  const [socket, setSocket] = useState<GameSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const connection: GameSocket = io(runtimeOrigin, {
      path: '/realtime',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 2_500,
    });
    connection.on('connect', () => setConnected(true));
    connection.on('disconnect', () => setConnected(false));
    setSocket(connection);
    return () => {
      connection.close();
      setSocket(null);
    };
  }, [runtimeOrigin]);

  return { socket, connected };
}

function useRuntimeInfo(runtimeOrigin: string): {
  info: RuntimeInfo | null;
  error: string | null;
} {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${runtimeOrigin}/api/runtime`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Runtime answered ${response.status}.`);
        return (await response.json()) as RuntimeInfo;
      })
      .then(setInfo)
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== 'AbortError') {
          setError('The game runtime is not answering yet.');
        }
      });
    return () => controller.abort();
  }, [runtimeOrigin]);

  return { info, error };
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="You're All Wrong">
      <span className="brand__youre">YOU’RE</span>
      <span className="brand__all">ALL</span>
      <span className="brand__wrong">WRONG!</span>
    </div>
  );
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <div className={`connection ${connected ? 'connection--online' : 'connection--offline'}`}>
      {connected ? <WifiHigh weight="bold" /> : <WifiSlash weight="bold" />}
      <span>{connected ? 'LIVE' : 'RECONNECTING'}</span>
    </div>
  );
}

function Scoreboard({ snapshot, compact = false }: { snapshot: GameSnapshot; compact?: boolean }) {
  return (
    <div className={`scoreboard ${compact ? 'scoreboard--compact' : ''}`}>
      {snapshot.players.map((player) => (
        <div
          className="score-card"
          key={player.id}
          style={{ '--rank': player.rank } as React.CSSProperties}
        >
          <div className="score-card__rank">
            {player.rank === 1 ? <Crown weight="fill" /> : `#${player.rank}`}
          </div>
          <div className="score-card__identity">
            <span className="score-card__name">{player.name}</span>
            {!player.connected && <span className="score-card__away">signal lost</span>}
          </div>
          <span className="score-card__score">{player.score.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function DamageRail({ snapshot }: { snapshot: GameSnapshot }) {
  if (snapshot.players.length === 0) return null;

  return (
    <div className="damage-rail" aria-label="Live player scores">
      {snapshot.players.map((player) => (
        <div className={`damage-rail__player ${player.connected ? '' : 'is-away'}`} key={player.id}>
          <span className="damage-rail__rank">{player.rank}</span>
          <strong>{player.name}</strong>
          <em className={player.score < 0 ? 'is-negative' : ''}>{player.score.toLocaleString()}</em>
        </div>
      ))}
    </div>
  );
}

function Timer({
  deadlineAt,
  openedAt,
  compact = false,
}: {
  deadlineAt: number;
  openedAt: number;
  compact?: boolean;
}) {
  const now = useClock();
  const total = deadlineAt - openedAt;
  const remaining = Math.max(0, deadlineAt - now);
  const progress = total > 0 ? remaining / total : 0;
  const seconds = Math.ceil(remaining / 1_000);
  return (
    <div
      className={`timer ${compact ? 'timer--compact' : ''} ${progress < 0.25 ? 'timer--danger' : ''}`}
      style={{ '--timer-progress': `${progress * 360}deg` } as React.CSSProperties}
      aria-label={`${seconds} seconds remaining`}
    >
      <div className="timer__inside">
        <span>{seconds}</span>
        {!compact && <small>SECONDS</small>}
      </div>
    </div>
  );
}

function LoadingStage({ message }: { message: string }) {
  return (
    <main className="loading-stage">
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <Brand />
      <CircleNotch className="spinner" weight="bold" />
      <p>{message}</p>
    </main>
  );
}

function ErrorStage({ message }: { message: string }) {
  return (
    <main className="error-stage">
      <Skull weight="duotone" />
      <h1>THE SHOW TRIPPED OVER A CABLE</h1>
      <p>{message}</p>
      <button className="button button--primary" onClick={() => window.location.reload()}>
        Try the dramatic entrance again
      </button>
    </main>
  );
}

function HostScreen({ secrets }: { secrets: ReturnType<typeof readFragmentSecrets> }) {
  const { socket, connected } = useRuntimeSocket(secrets.runtimeOrigin);
  const { info, error: runtimeError } = useRuntimeInfo(secrets.runtimeOrigin);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [joinUrls, setJoinUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attachEpoch = useRef(0);

  useEffect(() => {
    if (!socket || !connected || !info || !secrets.hostSecret) return;
    const epoch = ++attachEpoch.current;
    socket.emit(
      'host:attach',
      {
        protocolVersion: 1,
        sessionId: info.sessionId,
        hostSecret: secrets.hostSecret,
      },
      (ack: ProtocolAck<AttachSuccess>) => {
        if (epoch !== attachEpoch.current) return;
        if (ack.ok) {
          setSnapshot(ack.snapshot);
          setJoinUrls(ack.joinUrls);
          setError(null);
        } else {
          setError(ack.message);
        }
      },
    );
  }, [connected, info, secrets.hostSecret, socket]);

  useEffect(() => {
    if (!socket) return;
    const onState: ServerToClientEvents['state'] = ({ snapshot: next }) => setSnapshot(next);
    socket.on('state', onState);
    return () => {
      socket.off('state', onState);
    };
  }, [socket]);

  const sendAction = useCallback(
    (action: 'start' | 'advance' | 'reveal' | 'reset') => {
      if (!socket || !snapshot || busy) return;
      setBusy(true);
      playUiSound(action === 'reveal' ? 'wrong' : 'advance');
      socket.emit(
        'host:command',
        {
          protocolVersion: 1,
          commandId: createBrowserId(),
          expectedRevision: snapshot.revision,
          action,
        },
        (ack) => {
          setBusy(false);
          if (!ack.ok) setError(ack.message);
        },
      );
    },
    [busy, snapshot, socket],
  );

  if (!secrets.hostSecret) {
    return (
      <ErrorStage message="This host link is missing its private control key. Restart from the desktop app." />
    );
  }
  if (runtimeError && !info) return <ErrorStage message={runtimeError} />;
  if (error) return <ErrorStage message={error} />;
  if (!snapshot || !info) return <LoadingStage message="Warming up the insult machinery…" />;

  const nextAction =
    snapshot.phase === 'lobby'
      ? { action: 'start' as const, label: 'Start the show', icon: <Play weight="fill" /> }
      : snapshot.phase === 'question'
        ? { action: 'reveal' as const, label: 'Call it early', icon: <Lightning weight="fill" /> }
        : snapshot.phase === 'complete'
          ? { action: 'reset' as const, label: 'Run it back', icon: <ArrowRight weight="bold" /> }
          : {
              action: 'advance' as const,
              label: snapshot.phase === 'reveal' ? 'Send the next one' : 'Roll the show',
              icon: <ArrowRight weight="bold" />,
            };

  const firstJoinUrl = joinUrls[0] ?? '';

  return (
    <main className={`host host--${snapshot.phase}`} data-build="0.1.0-alpha">
      <div className="scanlines" />
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <header className="host__header">
        <Brand compact />
        <div className="episode-chip">
          <span>EPISODE 00</span>
          <strong>{snapshot.episode.title}</strong>
        </div>
        <ConnectionBadge connected={connected} />
      </header>

      <section className="host__stage">
        {snapshot.phase === 'lobby' && (
          <div className="lobby">
            <div className="lobby__intro">
              <div className="eyebrow">
                <UsersThree weight="fill" /> GET THE HOMIES IN HERE
              </div>
              <h1>SCAN. JOIN. REGRET.</h1>
              <p>No app. Same Wi-Fi. Questionable judgment strongly encouraged.</p>
            </div>
            <div className="join-card">
              <div className="join-card__qr">
                {firstJoinUrl ? (
                  <QRCodeSVG
                    value={firstJoinUrl}
                    level="M"
                    bgColor="#fff8e7"
                    fgColor="#110c1d"
                    size={220}
                  />
                ) : (
                  <DeviceMobile weight="duotone" size={128} />
                )}
              </div>
              <div className="join-card__copy">
                <span>OR ENTER THE ROOM CODE</span>
                <strong>{snapshot.code}</strong>
                <small>{snapshot.players.length} / 8 DAMAGE VOLUNTEERS</small>
              </div>
            </div>
            <div className="player-marquee">
              {snapshot.players.length === 0 ? (
                <div className="empty-lobby">
                  <span className="empty-lobby__pulse" />
                  Waiting for the first brave idiot…
                </div>
              ) : (
                snapshot.players.map((player, index) => (
                  <div
                    className="player-ticket"
                    key={player.id}
                    style={{ '--delay': `${index * 80}ms` } as React.CSSProperties}
                  >
                    <span className={`player-ticket__status ${player.ready ? 'is-ready' : ''}`}>
                      {player.ready ? <Check weight="bold" /> : index + 1}
                    </span>
                    <strong>{player.name}</strong>
                    <small>{player.ready ? 'READY TO BE WRONG' : 'PRETENDING TO THINK'}</small>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {snapshot.phase === 'intro' && (
          <div className="monologue-stage">
            <div className="eyebrow">TONIGHT’S LEGALLY DISTINCT MISTAKE</div>
            <h1>{snapshot.episode.title}</h1>
            <div className="host-voice-card">
              <span>HOST</span>
              <p>“You’ve already agreed to be buried there.”</p>
              <div className="voice-bars">
                {Array.from({ length: 18 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
            </div>
          </div>
        )}

        {snapshot.phase === 'question' && snapshot.question && (
          <div className="question-stage">
            <div className="question-stage__top">
              <div>
                <div className="eyebrow">CATEGORY</div>
                <h2>{snapshot.question.category}</h2>
              </div>
              <Timer
                deadlineAt={snapshot.question.deadlineAt}
                openedAt={snapshot.question.openedAt}
              />
            </div>
            <h1 className="question-stage__prompt">{snapshot.question.promptText}</h1>
            <div className={`answer-grid answer-grid--${snapshot.question.answers.length}`}>
              {snapshot.question.answers.map((answer, index) => (
                <div className="answer-tile" key={answer.id}>
                  <span>{ANSWER_LABELS[index]}</span>
                  <p>{answer.text}</p>
                </div>
              ))}
            </div>
            <div className="lock-meter">
              <div className="lock-meter__track">
                <i
                  style={{
                    width: `${snapshot.question.eligibleCount === 0 ? 0 : (snapshot.question.answeredCount / snapshot.question.eligibleCount) * 100}%`,
                  }}
                />
              </div>
              <strong>
                {snapshot.question.answeredCount} / {snapshot.question.eligibleCount} LOCKED
              </strong>
            </div>
            <DamageRail snapshot={snapshot} />
          </div>
        )}

        {snapshot.phase === 'reveal' && snapshot.reveal && (
          <div className="reveal-stage">
            <div className="reveal-stage__answer">
              <div className="eyebrow">THE DAMAGE REPORT</div>
              <h1>
                {snapshot.reveal.correctAnswerText.toUpperCase()}
                <span>WAS CORRECT</span>
              </h1>
              <div className="distribution">
                {Object.entries(snapshot.reveal.answerCounts).map(([answerId, count]) => (
                  <div
                    className={`distribution__row ${answerId === snapshot.reveal!.correctAnswerId ? 'is-correct' : ''}`}
                    key={answerId}
                  >
                    <span>{answerId.replaceAll('-', ' ')}</span>
                    <i style={{ width: `${Math.max(4, count * 20)}%` }} />
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="roast-card">
              <span className="roast-card__label">LIVE FROM THE HOST’S DISAPPOINTMENT</span>
              <p>
                “{snapshot.reveal.reactionText[0] ?? 'The silence is somehow worse than an answer.'}
                ”
              </p>
              {snapshot.reveal.reactionText[1] && <small>{snapshot.reveal.reactionText[1]}</small>}
            </div>
            <Scoreboard snapshot={snapshot} compact />
          </div>
        )}

        {(snapshot.phase === 'finale' || snapshot.phase === 'complete') && (
          <div className="finale-stage">
            <div className="finale-stage__calm">
              {snapshot.finale?.calmLeadIn[0] ?? 'And after all that, the final results show that…'}
            </div>
            <Brand />
            <Scoreboard snapshot={snapshot} />
            <p className="finale-stage__outro">{snapshot.finale?.outro[0]}</p>
          </div>
        )}
      </section>

      <footer className="host__controls">
        <span className="host__hint">
          {snapshot.phase === 'lobby'
            ? snapshot.players.length === 0
              ? 'At least one player has to volunteer.'
              : 'Everyone in? Make it official.'
            : snapshot.phase === 'question'
              ? 'Answers lock automatically · first tap is final'
              : snapshot.phase === 'reveal'
                ? 'Verdict delivered · advance when the damage settles'
                : snapshot.phase === 'intro'
                  ? 'Opening transmission · the room is listening'
                  : 'Final damage report'}
        </span>
        <button
          className="button button--host"
          disabled={busy || (snapshot.phase === 'lobby' && snapshot.players.length === 0)}
          onClick={() => sendAction(nextAction.action)}
        >
          {busy ? <CircleNotch className="spinner" weight="bold" /> : nextAction.icon}
          {nextAction.label}
        </button>
      </footer>
    </main>
  );
}

function ControllerScreen({
  code,
  secrets,
}: {
  code: string;
  secrets: ReturnType<typeof readFragmentSecrets>;
}) {
  const { socket, connected } = useRuntimeSocket(secrets.runtimeOrigin);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [joined, setJoined] = useState(false);
  const clientId = useMemo(getOrCreateClientId, []);
  const selectedAnswer = snapshot?.self?.selectedAnswerId ?? null;

  const acceptJoin = useCallback(
    (ack: ProtocolAck<JoinSuccess>) => {
      setBusy(false);
      if (!ack.ok) {
        setError(ack.message);
        if (ack.code === 'unauthorized') clearCredential(code);
        return;
      }
      writeCredential(code, { playerId: ack.playerId, resumeToken: ack.resumeToken });
      setSnapshot(ack.snapshot);
      setJoined(true);
      setError(null);
      playUiSound('lock');
    },
    [code],
  );

  useEffect(() => {
    if (!socket || !connected) return;
    const credential = readCredential(code);
    if (!credential) {
      setBusy(false);
      return;
    }
    setBusy(true);
    socket.emit(
      'player:resume',
      {
        protocolVersion: 1,
        commandId: createBrowserId(),
        sessionCode: code,
        playerId: credential.playerId,
        resumeToken: credential.resumeToken,
      },
      acceptJoin,
    );
  }, [acceptJoin, code, connected, socket]);

  useEffect(() => {
    if (!socket) return;
    const onState: ServerToClientEvents['state'] = ({ snapshot: next }) => setSnapshot(next);
    socket.on('state', onState);
    return () => {
      socket.off('state', onState);
    };
  }, [socket]);

  const join = () => {
    if (!socket || !connected || !name.trim()) return;
    setBusy(true);
    playUiSound('tap');
    socket.emit(
      'player:join',
      {
        protocolVersion: 1,
        commandId: createBrowserId(),
        sessionCode: code,
        ...(secrets.joinSecret ? { joinSecret: secrets.joinSecret } : {}),
        clientId,
        displayName: name,
      },
      acceptJoin,
    );
  };

  const setReady = (ready: boolean) => {
    if (!socket) return;
    playUiSound('lock');
    socket.emit(
      'player:ready',
      { protocolVersion: 1, commandId: createBrowserId(), ready },
      (ack) => {
        if (!ack.ok) setError(ack.message);
      },
    );
  };

  const answer = (answerId: string) => {
    if (!socket || !snapshot?.question || !snapshot.self?.phaseToken || selectedAnswer) return;
    playUiSound('lock');
    socket.emit(
      'player:answer',
      {
        protocolVersion: 1,
        commandId: createBrowserId(),
        expectedRevision: snapshot.revision,
        questionId: snapshot.question.id,
        answerId,
        phaseToken: snapshot.self.phaseToken,
      },
      (ack) => {
        if (!ack.ok) setError(ack.message);
      },
    );
  };

  if (busy && !joined) return <LoadingStage message="Finding your seat in the blast radius…" />;

  if (!joined || !snapshot) {
    return (
      <main className="controller controller--join" data-build="0.1.0-alpha">
        <div className="controller__noise" />
        <header>
          <Brand compact />
          <ConnectionBadge connected={connected} />
        </header>
        <section className="join-form">
          <span className="join-form__room">ROOM {code}</span>
          <div className="eyebrow">IDENTIFY THE VICTIM</div>
          <h1>WHAT SHOULD WE CALL YOU?</h1>
          <p>Keep it recognizable. The host needs to know exactly who to blame.</p>
          <label>
            <span>YOUR NAME</span>
            <input
              autoComplete="nickname"
              autoFocus
              enterKeyHint="go"
              maxLength={32}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') join();
              }}
              placeholder="Type something regrettable"
              value={name}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button
            className="button button--primary button--wide"
            disabled={!connected || !name.trim() || busy}
            onClick={join}
          >
            {busy ? <CircleNotch className="spinner" /> : <ArrowRight weight="bold" />}
            ENTER THE DAMAGE ZONE
          </button>
        </section>
      </main>
    );
  }

  const self = snapshot.players.find((player) => player.id === snapshot.self?.playerId);

  return (
    <main className={`controller controller--${snapshot.phase}`} data-build="0.1.0-alpha">
      <div className="controller__noise" />
      <header>
        <Brand compact />
        <div className="controller__identity">
          <span>{self?.name}</span>
          <strong>{self?.score.toLocaleString()} PTS</strong>
        </div>
        <ConnectionBadge connected={connected} />
      </header>

      {error && (
        <button className="toast-error" onClick={() => setError(null)}>
          {error}
        </button>
      )}

      {snapshot.phase === 'lobby' && (
        <section className="controller-lobby">
          <div className="controller-lobby__badge">
            <UsersThree weight="duotone" />
            <span>YOU’RE IN</span>
          </div>
          <h1>LOOK ALIVE, {self?.name?.toUpperCase()}.</h1>
          <p>The host can see you. Unfortunately, so can everyone else.</p>
          <div className="room-roster">
            {snapshot.players.map((player) => (
              <span className={player.ready ? 'is-ready' : ''} key={player.id}>
                {player.ready && <Check weight="bold" />}
                {player.name}
              </span>
            ))}
          </div>
          <button
            className={`ready-button ${self?.ready ? 'is-ready' : ''}`}
            onClick={() => setReady(!self?.ready)}
          >
            {self?.ready ? <Check weight="bold" /> : <Lightning weight="fill" />}
            <strong>{self?.ready ? 'LOCKED & LOADED' : 'I’M READY'}</strong>
            <small>{self?.ready ? 'Tap if cowardice returns' : 'This feeling will pass'}</small>
          </button>
        </section>
      )}

      {snapshot.phase === 'intro' && (
        <section className="controller-wait">
          <div className="controller-wait__orb">
            <i />
            <i />
            <i />
          </div>
          <div className="eyebrow">EYES ON THE BIG SCREEN</div>
          <h1>THE HOST IS TALKING.</h1>
          <p>Enjoy these final seconds before your opinions become evidence.</p>
        </section>
      )}

      {snapshot.phase === 'question' && snapshot.question && (
        <section className="controller-question">
          <div className="controller-question__meta">
            <span>{snapshot.question.category}</span>
            <Timer
              deadlineAt={snapshot.question.deadlineAt}
              openedAt={snapshot.question.openedAt}
              compact
            />
          </div>
          <h1>{selectedAnswer ? 'ANSWER LOCKED.' : 'PICK YOUR DAMAGE.'}</h1>
          <div
            className={`controller-answers controller-answers--${snapshot.question.answers.length}`}
          >
            {snapshot.question.answers.map((choice, index) => (
              <button
                className={`${selectedAnswer === choice.id ? 'is-selected' : ''} ${selectedAnswer && selectedAnswer !== choice.id ? 'is-muted' : ''}`}
                disabled={Boolean(selectedAnswer)}
                key={choice.id}
                onClick={() => answer(choice.id)}
              >
                <span>{ANSWER_LABELS[index]}</span>
                <strong>{choice.text}</strong>
                {selectedAnswer === choice.id && <Check className="answer-check" weight="bold" />}
              </button>
            ))}
          </div>
          <div className="controller-question__status">
            {selectedAnswer ? 'NO TAKE-BACKS. LIVE WITH IT.' : 'FIRST TAP IS FINAL'}
          </div>
        </section>
      )}

      {snapshot.phase === 'reveal' && snapshot.reveal && (
        <section
          className={`controller-result ${selectedAnswer === snapshot.reveal.correctAnswerId ? 'is-correct' : 'is-wrong'}`}
        >
          <div className="result-icon">
            {selectedAnswer === snapshot.reveal.correctAnswerId ? (
              <Check weight="bold" />
            ) : (
              <Skull weight="duotone" />
            )}
          </div>
          <div className="eyebrow">
            {selectedAnswer === snapshot.reveal.correctAnswerId
              ? 'DISGUSTINGLY CORRECT'
              : 'DOCUMENTED FAILURE'}
          </div>
          <h1>
            {selectedAnswer === snapshot.reveal.correctAnswerId
              ? 'YOU GOT AWAY WITH IT.'
              : 'THAT AGED POORLY.'}
          </h1>
          <p>{snapshot.reveal.reactionText[0]}</p>
          <div className="personal-score">
            <span>CURRENT DAMAGE</span>
            <strong>{self?.score.toLocaleString()}</strong>
          </div>
        </section>
      )}

      {(snapshot.phase === 'finale' || snapshot.phase === 'complete') && (
        <section className="controller-finale">
          <div className="eyebrow">THE RESULTS ARE IN</div>
          <Brand />
          <div className="controller-rank">
            <span>YOU FINISHED</span>
            <strong>#{self?.rank}</strong>
            <small>{self?.score.toLocaleString()} POINTS</small>
          </div>
          <p>{snapshot.finale?.outro[0]}</p>
        </section>
      )}
    </main>
  );
}

export function App() {
  const secrets = useMemo(readFragmentSecrets, []);
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const joinMatch = /^\/join\/([A-Z2-9]{5})$/i.exec(path);

  if (joinMatch?.[1]) {
    return <ControllerScreen code={joinMatch[1].toUpperCase()} secrets={secrets} />;
  }
  return <HostScreen secrets={secrets} />;
}
