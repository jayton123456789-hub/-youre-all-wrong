import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleNotch,
  Crown,
  DeviceMobile,
  Fire,
  Lightning,
  LockKey,
  Play,
  Skull,
  SpeakerHigh,
  SpeakerSlash,
  UsersThree,
  Waveform,
  WifiHigh,
  WifiSlash,
} from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';

import type { Cue } from '../domain/showpack/schema.js';
import type { GameSnapshot, HostPresentation } from '../domain/game/types.js';
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
import { useEpisodeVoice } from './useEpisodeVoice.js';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type HostAction =
  'start' | 'advance' | 'reveal' | 'reset' | 'answers_presented' | 'answer_narration_complete';

interface RuntimeInfo {
  protocolVersion: 1;
  socketPath: string;
  sessionId: string;
  sessionCode: string;
  episode: { id: string; title: string };
}

const DIRECTIONS = [
  { name: 'UP', className: 'up', icon: ArrowUp },
  { name: 'LEFT', className: 'left', icon: ArrowLeft },
  { name: 'RIGHT', className: 'right', icon: ArrowRight },
  { name: 'DOWN', className: 'down', icon: ArrowDown },
] as const;

function useClock(intervalMs = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function waitForBeat(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Interrupted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Interrupted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  const total = Math.max(1, deadlineAt - openedAt);
  const remaining = Math.max(0, deadlineAt - now);
  const progress = remaining / total;
  const seconds = Math.ceil(remaining / 1_000);
  return (
    <div
      className={`timer ${compact ? 'timer--compact' : ''} ${progress < 0.25 ? 'timer--danger' : ''}`}
      style={{ '--timer-progress': `${progress * 360}deg` } as CSSProperties}
      aria-label={`${seconds} seconds remaining`}
    >
      <div className="timer__inside">
        <span>{seconds}</span>
        {!compact && <small>SECONDS</small>}
      </div>
    </div>
  );
}

function Scoreboard({
  snapshot,
  compact = false,
  scoreOverrides = {},
  changedPlayerIds = new Set<string>(),
}: {
  snapshot: GameSnapshot;
  compact?: boolean;
  scoreOverrides?: Record<string, number>;
  changedPlayerIds?: Set<string>;
}) {
  return (
    <div className={`scoreboard ${compact ? 'scoreboard--compact' : ''}`}>
      {snapshot.players.map((player) => (
        <div
          className={`score-card ${changedPlayerIds.has(player.id) ? 'is-score-hit' : ''}`}
          key={player.id}
        >
          <div className="score-card__rank">
            {player.rank === 1 ? <Crown weight="fill" /> : `#${player.rank}`}
          </div>
          <div className="score-card__identity">
            <span className="score-card__name">{player.name}</span>
            {!player.connected && <span className="score-card__away">signal lost</span>}
          </div>
          <span className="score-card__score">
            {(scoreOverrides[player.id] ?? player.score).toLocaleString()}
          </span>
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

function LoadingStage({ message }: { message: string }) {
  return (
    <main className="loading-stage">
      <div className="signal-field" aria-hidden="true" />
      <Brand />
      <div className="loading-stage__meter">
        <CircleNotch className="spinner" weight="bold" />
        <p>{message}</p>
      </div>
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

function VoiceBars({ active }: { active: boolean }) {
  return (
    <div className={`voice-bars ${active ? 'is-active' : ''}`} aria-hidden="true">
      {Array.from({ length: 21 }, (_, index) => (
        <i key={index} />
      ))}
    </div>
  );
}

function StageCaption({ cue, speaking }: { cue: Cue | null; speaking: boolean }) {
  const text = cue?.type === 'line' ? cue.text : null;
  return (
    <div className={`stage-caption ${speaking && text ? 'is-speaking' : ''}`}>
      <div className="stage-caption__label">
        <Waveform weight="bold" />
        HOST FEED
      </div>
      <p>{text ?? 'The host is choosing the next regrettable sentence.'}</p>
      <VoiceBars active={speaking && Boolean(text)} />
    </div>
  );
}

function VoicePreflightPanel({
  phase,
  completed,
  total,
  rendered,
  cached,
  voiceName,
  message,
}: ReturnType<typeof useEpisodeVoice>['progress']) {
  const progress = total > 0 ? completed / total : 0;
  const ready = phase === 'ready';
  const failed = phase === 'error';
  return (
    <aside
      className={`voice-preflight ${ready ? 'is-ready' : ''} ${failed ? 'is-error' : ''}`}
      aria-live="polite"
    >
      <div className="voice-preflight__top">
        <span className="voice-preflight__icon">
          {ready ? <Check weight="bold" /> : <Waveform weight="bold" />}
        </span>
        <div>
          <small>
            {ready ? 'HOST TRACK LOCKED' : failed ? 'VOICE COOK FAILED' : 'COOKING THE HOST'}
          </small>
          <strong>{voiceName}</strong>
        </div>
        <b>
          {completed}/{total || '—'}
        </b>
      </div>
      <div className="voice-preflight__track">
        <i style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <p>{message}</p>
      {ready && (
        <div className="voice-preflight__facts">
          <span>{rendered} fresh</span>
          <span>{cached} cached</span>
          <span>all branches loaded</span>
        </div>
      )}
    </aside>
  );
}

function findPresentationPart(presentation: HostPresentation, cue: Cue): string | null {
  return (
    presentation.parts.find((part) => part.cues.some((candidate) => candidate.id === cue.id))?.id ??
    null
  );
}

function HostScreen({ secrets }: { secrets: ReturnType<typeof readFragmentSecrets> }) {
  const { socket, connected } = useRuntimeSocket(secrets.runtimeOrigin);
  const { info, error: runtimeError } = useRuntimeInfo(secrets.runtimeOrigin);
  const voice = useEpisodeVoice(secrets.runtimeOrigin, secrets.hostSecret);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [joinUrls, setJoinUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [activeCue, setActiveCue] = useState<Cue | null>(null);
  const [activePart, setActivePart] = useState<string | null>(null);
  const [directorPlaying, setDirectorPlaying] = useState(false);
  const [activeRevealPlayerId, setActiveRevealPlayerId] = useState<string | null>(null);
  const [revealOutcome, setRevealOutcome] = useState<'neutral' | 'correct' | 'wrong'>('neutral');
  const [settledRevealPlayers, setSettledRevealPlayers] = useState<Set<string>>(new Set());
  const attachEpoch = useRef(0);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const completedSequences = useRef(new Set<string>());

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    voice.bank?.setMuted(muted);
  }, [muted, voice.bank]);

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

  const sendHostCommand = useCallback(
    (action: HostAction, questionId?: string): Promise<boolean> =>
      new Promise((resolve) => {
        const current = snapshotRef.current;
        if (!socket || !current) {
          resolve(false);
          return;
        }
        const base = {
          protocolVersion: 1 as const,
          commandId: createBrowserId(),
          expectedRevision: current.revision,
        };
        const payload =
          action === 'answers_presented' || action === 'answer_narration_complete'
            ? { ...base, action, questionId: questionId ?? '' }
            : { ...base, action };
        socket.emit('host:command', payload, (ack) => {
          if (!ack.ok) {
            setError(ack.message);
            resolve(false);
            return;
          }
          resolve(true);
        });
      }),
    [socket],
  );

  const presentation = snapshot?.presentation ?? null;
  const presentationId = presentation?.sequenceId ?? null;

  useEffect(() => {
    if (!presentation || !presentationId || !voice.bank) return;
    if (completedSequences.current.has(presentationId)) return;

    const controller = new AbortController();
    setDirectorPlaying(true);
    setActivePart(presentation.parts[0]?.id ?? null);
    setActiveCue(null);

    const playPart = (part: HostPresentation['parts'][number]) =>
      voice.bank!.playSequence(part.cues, {
        signal: controller.signal,
        onCue: (cue) => {
          setActiveCue(cue);
          setActivePart(part.id);
        },
      });

    const playAuthoredPresentation = async () => {
      if (presentation.stage !== 'reveal') {
        await voice.bank!.playSequence(presentation.cues, {
          signal: controller.signal,
          onCue: (cue) => {
            setActiveCue(cue);
            if (cue) setActivePart(findPresentationPart(presentation, cue));
          },
        });
        return;
      }

      setSettledRevealPlayers(new Set());
      for (const part of presentation.parts) {
        const playerId = part.id.startsWith('player-') ? part.id.slice('player-'.length) : null;
        setActivePart(part.id);
        setActiveRevealPlayerId(playerId);
        setRevealOutcome('neutral');
        setActiveCue(null);
        if (playerId) await waitForBeat(420, controller.signal);
        await playPart(part);
        if (!playerId) continue;

        const result = snapshotRef.current?.reveal?.playerResults.find(
          (candidate) => candidate.playerId === playerId,
        );
        const outcome = result?.correct ? 'correct' : 'wrong';
        setRevealOutcome(outcome);
        playUiSound(outcome === 'correct' ? 'lock' : 'wrong');
        await waitForBeat(700, controller.signal);
        setSettledRevealPlayers((current) => new Set(current).add(playerId));
        await waitForBeat(650, controller.signal);
      }
      setActiveRevealPlayerId(null);
      setRevealOutcome('neutral');
      setActiveCue(null);
    };

    void playAuthoredPresentation()
      .then(async () => {
        if (controller.signal.aborted) return;
        completedSequences.current.add(presentationId);
        setDirectorPlaying(false);
        setActiveCue(null);

        const questionId = snapshotRef.current?.question?.id;
        let advanced = true;
        if (presentation.stage === 'intro') {
          advanced = await sendHostCommand('advance');
        } else if (presentation.stage === 'prompt' && questionId) {
          advanced = await sendHostCommand('answers_presented', questionId);
        } else if (presentation.stage === 'answers' && questionId) {
          advanced = await sendHostCommand('answer_narration_complete', questionId);
        } else if (presentation.stage === 'reveal' || presentation.stage === 'finale') {
          advanced = await sendHostCommand('advance');
        }
        if (!advanced) completedSequences.current.delete(presentationId);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name === 'AbortError') return;
        setDirectorPlaying(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => controller.abort();
  }, [presentationId, sendHostCommand, voice.bank]);

  if (!secrets.hostSecret) {
    return (
      <ErrorStage message="This host link is missing its private control key. Restart from the desktop app." />
    );
  }
  if (runtimeError && !info) return <ErrorStage message={runtimeError} />;
  if (!snapshot || !info) return <LoadingStage message="Warming up the insult machinery…" />;

  const firstJoinUrl = joinUrls[0] ?? '';
  const everyPlayerReady =
    snapshot.players.length > 0 && snapshot.players.every((player) => player.ready);
  const canStart = voice.ready && everyPlayerReady && connected;
  const question = snapshot.question;
  const questionVisual =
    question?.timingPhase === 'answering'
      ? 'answers'
      : activePart === 'prompt'
        ? 'prompt'
        : 'category';
  const finaleScoresVisible =
    snapshot.phase === 'complete' ||
    (activePart !== null && activePart !== 'calm-lead-in' && activePart !== 'title-drop');
  const activeRevealResult = snapshot.reveal?.playerResults.find(
    (result) => result.playerId === activeRevealPlayerId,
  );
  const activeRevealPlayer = snapshot.players.find((player) => player.id === activeRevealPlayerId);
  const revealScoreOverrides = Object.fromEntries(
    (snapshot.reveal?.playerResults ?? []).map((result) => {
      const finalScore =
        snapshot.players.find((player) => player.id === result.playerId)?.score ??
        result.scoreDelta;
      return [
        result.playerId,
        settledRevealPlayers.has(result.playerId) ? finalScore : finalScore - result.scoreDelta,
      ];
    }),
  );

  const startShow = async () => {
    if (!voice.bank || !canStart || busy) return;
    setBusy(true);
    setError(null);
    await voice.bank.unlock();
    playUiSound('advance');
    await sendHostCommand('start');
    setBusy(false);
  };

  const resetShow = async () => {
    setBusy(true);
    completedSequences.current.clear();
    await sendHostCommand('reset');
    setBusy(false);
  };

  return (
    <main
      className={`host host--${snapshot.phase} host--visual-${questionVisual}`}
      data-build="0.1.0-alpha"
    >
      <div className="scanlines" aria-hidden="true" />
      <div className="signal-field" aria-hidden="true" />
      <header className="host__header">
        <Brand compact />
        <div className="episode-chip">
          <span>
            EPISODE{' '}
            {String(snapshot.episode.id === 'terms-and-conditions' ? 0 : 1).padStart(2, '0')}
          </span>
          <strong>{snapshot.episode.title}</strong>
        </div>
        <div className="host__status">
          <button
            className="audio-toggle"
            onClick={() => setMuted((current) => !current)}
            aria-label={muted ? 'Unmute host voice' : 'Mute host voice'}
            title={muted ? 'Unmute host voice' : 'Mute host voice'}
          >
            {muted ? <SpeakerSlash weight="bold" /> : <SpeakerHigh weight="bold" />}
          </button>
          <ConnectionBadge connected={connected} />
        </div>
      </header>

      <section className="host__stage">
        {snapshot.phase === 'lobby' && (
          <div className="lobby">
            <div className="lobby__hero">
              <div className="eyebrow">
                <UsersThree weight="fill" /> ADMIT THE CONTESTANTS
              </div>
              <h1>SCAN. JOIN. REGRET.</h1>
              <p>
                No controller app. Same Wi-Fi. Four arrows and a legally unreasonable amount of
                confidence.
              </p>
              <VoicePreflightPanel {...voice.progress} />
            </div>
            <div className="join-card">
              <div className="join-card__qr">
                {firstJoinUrl ? (
                  <QRCodeSVG
                    value={firstJoinUrl}
                    level="M"
                    bgColor="#fff8e7"
                    fgColor="#100d1a"
                    size={220}
                  />
                ) : (
                  <DeviceMobile weight="duotone" size={128} />
                )}
              </div>
              <div className="join-card__copy">
                <span>SCAN OR ENTER THE ROOM CODE</span>
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
                    style={{ '--delay': `${index * 80}ms` } as CSSProperties}
                  >
                    <span className={`player-ticket__status ${player.ready ? 'is-ready' : ''}`}>
                      {player.ready ? <Check weight="bold" /> : index + 1}
                    </span>
                    <strong>{player.name}</strong>
                    <small>{player.ready ? 'READY TO BE WRONG' : 'CHECK YOUR PHONE'}</small>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {snapshot.phase === 'intro' && (
          <div className="monologue-stage">
            <div className="monologue-stage__copy">
              <div className="eyebrow">TONIGHT’S LEGALLY DISTINCT MISTAKE</div>
              <h1>{snapshot.episode.title}</h1>
              <div className="tutorial-strip">
                <span>
                  <ArrowUp weight="bold" />
                  FOUR ARROWS
                </span>
                <span>
                  <Lightning weight="fill" />
                  FASTER = MORE
                </span>
                <span>
                  <LockKey weight="fill" />
                  FIRST TAP FINAL
                </span>
              </div>
            </div>
            <StageCaption cue={activeCue} speaking={directorPlaying} />
          </div>
        )}

        {snapshot.phase === 'question' && question && questionVisual === 'category' && (
          <div className="category-slate" key={question.id}>
            <span>QUESTION CATEGORY</span>
            <h1>{question.category}</h1>
            <i aria-hidden="true">{question.category}</i>
          </div>
        )}

        {snapshot.phase === 'question' && question && questionVisual === 'prompt' && (
          <div className="prompt-slate" key={`${question.id}-prompt`}>
            <div className="prompt-slate__category">{question.category}</div>
            <h1>{question.promptText}</h1>
            <div className="prompt-slate__listen">
              <VoiceBars active={directorPlaying} />
              <span>QUESTION IN PROGRESS · ANSWERS ARE NEXT</span>
            </div>
            <DamageRail snapshot={snapshot} />
          </div>
        )}

        {snapshot.phase === 'question' && question && questionVisual === 'answers' && (
          <div className="answer-stage" key={`${question.id}-answers`}>
            <div className="answer-stage__header">
              <div>
                <span>{question.category}</span>
                <h1>{question.promptText}</h1>
              </div>
              {question.answerWindowOpenedAt !== null &&
                question.answerWindowDeadlineAt !== null && (
                  <Timer
                    deadlineAt={question.answerWindowDeadlineAt}
                    openedAt={question.answerWindowOpenedAt}
                  />
                )}
            </div>
            <div className="answer-compass">
              <div className="answer-compass__cross" aria-hidden="true">
                <i />
                <i />
              </div>
              {question.answers.map((answer, index) => {
                const direction = DIRECTIONS[index]!;
                const Icon = direction.icon;
                return (
                  <div
                    className={`answer-choice answer-choice--${direction.className}`}
                    key={answer.id}
                  >
                    <span>
                      <Icon weight="bold" />
                    </span>
                    <p>{answer.text}</p>
                  </div>
                );
              })}
            </div>
            <div className="answer-stage__footer">
              <div className="lock-meter">
                <div className="lock-meter__track">
                  <i
                    style={{
                      width: `${question.eligibleCount === 0 ? 0 : (question.answeredCount / question.eligibleCount) * 100}%`,
                    }}
                  />
                </div>
                <strong>
                  {question.answeredCount} / {question.eligibleCount} LOCKED
                </strong>
              </div>
              <div
                className={`narration-chip ${question.answerNarrationStatus === 'interrupted' ? 'is-cut' : ''}`}
              >
                {question.answerNarrationStatus === 'interrupted'
                  ? 'HOST CUT OFF · SOMEONE LOCKED'
                  : question.answerNarrationStatus === 'completed'
                    ? 'CHOICES READ · CLOCK RUNNING'
                    : 'HOST READING · LOCK ANY TIME'}
              </div>
              <DamageRail snapshot={snapshot} />
            </div>
          </div>
        )}

        {snapshot.phase === 'reveal' && snapshot.reveal && (
          <div className="reveal-stage">
            <div
              className={`reveal-player-arena is-${revealOutcome} ${
                activeRevealPlayerId ? 'has-player' : 'is-wrap-up'
              }`}
            >
              <div className="reveal-player-arena__heading">
                <span>ANSWER AUTOPSY</span>
                <strong>
                  {activeRevealPlayer
                    ? `${activeRevealPlayer.name.toUpperCase()}'S CHOICE`
                    : 'THE ACTUAL ANSWER'}
                </strong>
              </div>
              <div className="reveal-compass">
                {snapshot.reveal.answers.map((answer, index) => {
                  const direction = DIRECTIONS[index]!;
                  const Icon = direction.icon;
                  const selected = activeRevealResult?.answerId === answer.id;
                  const verdictClass =
                    selected && revealOutcome !== 'neutral'
                      ? activeRevealResult?.correct
                        ? 'is-correct'
                        : 'is-wrong'
                      : '';
                  return (
                    <div
                      className={`reveal-choice reveal-choice--${direction.className} ${
                        selected ? 'is-selected' : ''
                      } ${verdictClass}`}
                      key={answer.id}
                    >
                      <Icon weight="bold" />
                      <span>{answer.text}</span>
                    </div>
                  );
                })}
                <div className={`reveal-player-token is-${revealOutcome}`}>
                  {revealOutcome === 'correct' ? (
                    <Check weight="bold" />
                  ) : revealOutcome === 'wrong' ? (
                    <Fire weight="fill" />
                  ) : (
                    <LockKey weight="fill" />
                  )}
                  <strong>{activeRevealPlayer?.name ?? 'HOST'}</strong>
                  {activeRevealResult && (
                    <small>
                      {revealOutcome === 'neutral'
                        ? 'LOCKED'
                        : `${activeRevealResult.scoreDelta >= 0 ? '+' : ''}${activeRevealResult.scoreDelta.toLocaleString()}`}
                    </small>
                  )}
                </div>
                {activeRevealResult &&
                  revealOutcome !== 'neutral' &&
                  !settledRevealPlayers.has(activeRevealResult.playerId) && (
                    <div
                      className={`score-projectile ${
                        activeRevealResult.correct ? 'is-credit' : 'is-debit'
                      }`}
                    >
                      {activeRevealResult.scoreDelta >= 0 ? '+' : ''}
                      {activeRevealResult.scoreDelta.toLocaleString()}
                    </div>
                  )}
              </div>
            </div>
            <div className="reveal-stage__broadcast">
              <StageCaption cue={activeCue} speaking={directorPlaying} />
              <div className={`verdict-stamp is-${revealOutcome}`}>
                {revealOutcome === 'correct'
                  ? 'PAID IN FULL'
                  : revealOutcome === 'wrong'
                    ? 'ACCOUNT DAMAGED'
                    : activeRevealPlayerId
                      ? 'VERDICT PENDING'
                      : snapshot.reveal.correctAnswerText}
              </div>
            </div>
            <Scoreboard
              snapshot={snapshot}
              compact
              scoreOverrides={revealScoreOverrides}
              changedPlayerIds={settledRevealPlayers}
            />
          </div>
        )}

        {(snapshot.phase === 'finale' || snapshot.phase === 'complete') && (
          <div
            className={`finale-stage ${finaleScoresVisible ? 'show-scores' : ''} ${
              activePart === 'title-drop' ? 'title-dropping' : ''
            }`}
          >
            <div className="finale-stage__calm">
              {snapshot.finale?.calmLeadIn[0] ??
                'And after all that, the final results show something remarkable…'}
            </div>
            <Brand />
            <div className="finale-stage__results">
              <Scoreboard snapshot={snapshot} />
            </div>
            <StageCaption cue={activeCue} speaking={directorPlaying} />
          </div>
        )}
      </section>

      <footer className="host__controls">
        {snapshot.phase === 'lobby' ? (
          <>
            <div className="host__hint">
              {!voice.ready
                ? 'Start is locked until every reachable voice line is cooked and loaded.'
                : snapshot.players.length === 0
                  ? 'At least one contestant must enter the blast radius.'
                  : !everyPlayerReady
                    ? 'Waiting for every phone to press ready.'
                    : 'Voice track and contestants locked. The show is armed.'}
            </div>
            <button
              className="button button--host"
              disabled={!canStart || busy}
              onClick={startShow}
            >
              {busy ? <CircleNotch className="spinner" /> : <Play weight="fill" />}
              {voice.ready ? 'START THE SHOW' : 'COOKING AUDIO…'}
            </button>
          </>
        ) : snapshot.phase === 'complete' ? (
          <>
            <div className="host__hint">The damage is final. The friendships are under review.</div>
            <button className="button button--host" disabled={busy} onClick={resetShow}>
              <ArrowRight weight="bold" />
              RUN IT BACK
            </button>
          </>
        ) : (
          <>
            <div className="host__hint">
              <span className="auto-live">
                <i /> AUTO DIRECTOR
              </span>
              {snapshot.phase === 'question' && question?.timingPhase === 'answering'
                ? 'Timer, locks, interruptions, and reveal are live.'
                : 'Pre-cooked audio is driving the show timeline.'}
            </div>
            <div className="director-readout">
              <Waveform weight="bold" />
              {directorPlaying ? 'HOST SPEAKING' : 'TIMING THE NEXT BEAT'}
            </div>
          </>
        )}
      </footer>

      {error && (
        <button className="toast-error" onClick={() => setError(null)}>
          {error}
        </button>
      )}
    </main>
  );
}

function DirectionPad({
  answers,
  selectedAnswer,
  onAnswer,
}: {
  answers: NonNullable<GameSnapshot['question']>['answers'];
  selectedAnswer: string | null;
  onAnswer: (answerId: string) => void;
}) {
  return (
    <div className="direction-pad" aria-label="Answer controls">
      <div className="direction-pad__hub">
        {selectedAnswer ? <LockKey weight="fill" /> : <Lightning weight="fill" />}
      </div>
      {answers.map((answer, index) => {
        const direction = DIRECTIONS[index]!;
        const Icon = direction.icon;
        const selected = selectedAnswer === answer.id;
        return (
          <button
            aria-label={`Lock the ${direction.name.toLowerCase()} answer`}
            className={`direction-key direction-key--${direction.className} ${
              selected ? 'is-selected' : ''
            } ${selectedAnswer && !selected ? 'is-muted' : ''}`}
            disabled={Boolean(selectedAnswer)}
            key={answer.id}
            onClick={() => onAnswer(answer.id)}
          >
            <Icon weight="bold" />
            <span>{direction.name}</span>
            {selected && <Check className="direction-key__check" weight="bold" />}
          </button>
        );
      })}
    </div>
  );
}

function ControllerWait({
  eyebrow,
  title,
  copy,
  icon,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  icon?: ReactNode;
}) {
  return (
    <section className="controller-wait">
      <div className="controller-wait__signal">
        {icon ?? <Waveform weight="duotone" />}
        <i />
        <i />
      </div>
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{copy}</p>
    </section>
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
        <div className="controller__noise" aria-hidden="true" />
        <header>
          <Brand compact />
          <ConnectionBadge connected={connected} />
        </header>
        <section className="join-form">
          <div className="join-form__copy">
            <span className="join-form__room">ROOM {code}</span>
            <div className="eyebrow">IDENTIFY THE VICTIM</div>
            <h1>WHAT SHOULD WE CALL YOU?</h1>
            <p>Keep it recognizable. The host needs to know exactly who to blame.</p>
          </div>
          <div className="join-form__action">
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
          </div>
        </section>
      </main>
    );
  }

  const self = snapshot.players.find((player) => player.id === snapshot.self?.playerId);
  const question = snapshot.question;

  return (
    <main className={`controller controller--${snapshot.phase}`} data-build="0.1.0-alpha">
      <div className="controller__noise" aria-hidden="true" />
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
          <div className="controller-lobby__copy">
            <div className="controller-lobby__badge">
              <UsersThree weight="duotone" />
              <span>YOU’RE IN</span>
            </div>
            <div>
              <h1>LOOK ALIVE, {self?.name?.toUpperCase()}.</h1>
              <p>The host can see you. Unfortunately, so can everyone else.</p>
            </div>
          </div>
          <div className="controller-lobby__action">
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
          </div>
        </section>
      )}

      {snapshot.phase === 'intro' && (
        <ControllerWait
          eyebrow="EYES ON THE BIG SCREEN"
          title="THE HOST IS TALKING."
          copy="The rules and insults are being delivered through the television."
        />
      )}

      {snapshot.phase === 'question' && question?.timingPhase === 'prompt' && (
        <ControllerWait
          eyebrow="QUESTION IN PROGRESS"
          title="KEEP YOUR EYES UP."
          copy="The four arrows arm when the answer board appears."
          icon={<ArrowUp weight="bold" />}
        />
      )}

      {snapshot.phase === 'question' && question?.timingPhase === 'answering' && (
        <section className="controller-question">
          <div className="controller-question__meta">
            <span>
              {selectedAnswer
                ? 'ANSWER LOCKED'
                : question.answerNarrationStatus === 'playing'
                  ? 'LOCK NOW TO CUT OFF THE HOST'
                  : 'CLOCK IS RUNNING'}
            </span>
            {question.answerWindowOpenedAt !== null && question.answerWindowDeadlineAt !== null && (
              <Timer
                deadlineAt={question.answerWindowDeadlineAt}
                openedAt={question.answerWindowOpenedAt}
                compact
              />
            )}
          </div>
          <div className="controller-question__title">
            <h1>{selectedAnswer ? 'NO TAKE-BACKS.' : 'PICK A DIRECTION.'}</h1>
            <p>{selectedAnswer ? 'Your evidence has been submitted.' : 'First tap is final.'}</p>
          </div>
          <DirectionPad
            answers={question.answers}
            selectedAnswer={selectedAnswer}
            onAnswer={answer}
          />
        </section>
      )}

      {snapshot.phase === 'reveal' && (
        <ControllerWait
          eyebrow="VERDICT IN PROGRESS"
          title="WATCH THE BIG SCREEN."
          copy="The host is currently converting everybody’s confidence into accounting."
          icon={<Fire weight="fill" />}
        />
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
