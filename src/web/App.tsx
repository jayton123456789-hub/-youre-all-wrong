import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowCounterClockwise,
  ArrowUp,
  Check,
  CircleNotch,
  Copy,
  Crown,
  DeviceMobile,
  DownloadSimple,
  Fire,
  FileArrowUp,
  Lightning,
  LockKey,
  Package,
  Play,
  Sparkle,
  Skull,
  SpeakerHigh,
  SpeakerSlash,
  UsersThree,
  Waveform,
  WifiHigh,
  WifiSlash,
  Wrench,
  X,
} from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';

import type { Cue } from '../domain/showpack/schema.js';
import { EPISODE_AI_STARTER_PROMPT } from '../domain/showpack/author-prompt.js';
import type { VoicePreflightActivity } from '../domain/voice/preflight.js';
import type { GameSnapshot, HostPresentation } from '../domain/game/types.js';
import type { DesktopEpisodeState } from '../desktop/episode-contract.js';
import type {
  DesktopVoiceBootstrapState,
  VoiceInstallationProgress,
} from '../desktop/voice-installation.js';
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
import { usePrivateSoundtrack } from './private-soundtrack.js';

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

// The projectile waits 100 ms, flies for 700 ms, then gets a small render margin
// before the score card settles and removes it from the tree.
const SCORE_PROJECTILE_SETTLE_MS = 850;
const CATEGORY_CARD_MINIMUM_MS = 1_800;
const ANSWER_NARRATION_RATE = 1.16;
const ANSWER_NARRATION_PAUSE_SCALE = 0.3;

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

export function orderScoreboardPlayers(
  players: GameSnapshot['players'],
  scoreOverrides: Record<string, number> = {},
  stableTieOrder?: readonly string[],
): Array<{ player: GameSnapshot['players'][number]; score: number }> {
  const sourceOrder = new Map(players.map((player, index) => [player.id, index]));
  const stableOrder = stableTieOrder
    ? new Map(stableTieOrder.map((playerId, index) => [playerId, index]))
    : null;
  const compareTiedPlayers = (
    a: GameSnapshot['players'][number],
    b: GameSnapshot['players'][number],
  ): number => {
    if (!stableOrder) {
      return (
        (sourceOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (sourceOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
      );
    }

    const aPosition = stableOrder.get(a.id);
    const bPosition = stableOrder.get(b.id);
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
    if (aPosition !== undefined) return -1;
    if (bPosition !== undefined) return 1;
    return a.id.localeCompare(b.id);
  };

  return [...players]
    .map((player) => ({
      player,
      score: scoreOverrides[player.id] ?? player.score,
    }))
    .sort((a, b) => b.score - a.score || compareTiedPlayers(a.player, b.player));
}

function Scoreboard({
  snapshot,
  compact = false,
  scoreOverrides = {},
  changedPlayerIds = new Set<string>(),
  stableTieOrder,
}: {
  snapshot: GameSnapshot;
  compact?: boolean;
  scoreOverrides?: Record<string, number>;
  changedPlayerIds?: Set<string>;
  stableTieOrder?: readonly string[];
}) {
  const displayedPlayers = orderScoreboardPlayers(snapshot.players, scoreOverrides, stableTieOrder);
  let previousScore: number | null = null;
  let previousRank = 0;

  return (
    <div className={`scoreboard ${compact ? 'scoreboard--compact' : ''}`}>
      {displayedPlayers.map(({ player, score }, index) => {
        const rank = previousScore === score ? previousRank : index + 1;
        previousScore = score;
        previousRank = rank;
        return (
          <div
            className={`score-card ${changedPlayerIds.has(player.id) ? 'is-score-hit' : ''}`}
            data-score-player-id={player.id}
            key={player.id}
          >
            <div className="score-card__rank">
              {rank === 1 ? <Crown weight="fill" /> : `#${rank}`}
            </div>
            <div className="score-card__identity">
              <span className="score-card__name">{player.name}</span>
              {!player.connected && <span className="score-card__away">signal lost</span>}
            </div>
            <span className="score-card__score">{score.toLocaleString()}</span>
          </div>
        );
      })}
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
      <div className="loading-stage__console">
        <div className="loading-stage__status">
          <Waveform weight="bold" />
          <span>BOOTING SHOW CONTROL</span>
        </div>
        <div className="loading-stage__meter">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <p>{message}</p>
        <div className="loading-stage__subline">
          <CircleNotch className="spinner" weight="bold" />
          <span>Checking room, voice cache, and local network</span>
        </div>
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

export function voiceActivityPresentation(activity: VoicePreflightActivity | null): {
  mode: 'cooking' | 'retry' | 'rescue';
  label: 'COOKING THE HOST' | 'QUALITY PASS' | 'QUALITY RESCUE';
  recovered: boolean;
} {
  if (!activity) return { mode: 'cooking', label: 'COOKING THE HOST', recovered: false };
  if (activity.type === 'quality-retry') {
    return { mode: 'retry', label: 'QUALITY PASS', recovered: false };
  }
  return {
    mode: 'rescue',
    label: 'QUALITY RESCUE',
    recovered:
      activity.type === 'quality-rescue-recovered' ||
      (activity.type === 'quality-rescue-complete' && activity.failedCount === 0),
  };
}

function VoicePreflightPanel({
  progress: { phase, completed, total, rendered, cached, voiceName, message, activity },
  installationState,
  installationProgress,
  installationBusy,
  onInstall,
}: {
  progress: ReturnType<typeof useEpisodeVoice>['progress'];
  installationState: DesktopVoiceBootstrapState | null;
  installationProgress: VoiceInstallationProgress | null;
  installationBusy: boolean;
  onInstall: () => void;
}) {
  const progress = total > 0 ? completed / total : 0;
  const ready = phase === 'ready';
  const failed = phase === 'error';
  const activityPresentation = voiceActivityPresentation(activity);
  const retrying = activityPresentation.mode === 'retry';
  const rescuing = activityPresentation.mode === 'rescue';
  const recovered = activityPresentation.recovered;
  const canInstall =
    failed &&
    (installationState?.state === 'installable' || installationState?.state === 'repairable');
  const displayedMessage = installationProgress?.message ?? message;
  return (
    <aside
      className={`voice-preflight ${ready ? 'is-ready' : ''} ${failed ? 'is-error' : ''} ${
        retrying ? 'is-retrying' : ''
      } ${rescuing ? 'is-rescuing' : ''} ${recovered ? 'is-recovered' : ''}`}
      aria-live="polite"
    >
      <div className="voice-preflight__top">
        <span className="voice-preflight__icon">
          {ready ? (
            <Check weight="bold" />
          ) : recovered ? (
            <Check weight="bold" />
          ) : retrying ? (
            <ArrowCounterClockwise weight="bold" />
          ) : rescuing ? (
            <ArrowCounterClockwise weight="bold" />
          ) : (
            <Waveform weight="bold" />
          )}
        </span>
        <div>
          <small>
            {ready
              ? 'HOST TRACK LOCKED'
              : failed
                ? 'VOICE COOK FAILED'
                : activityPresentation.label}
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
      <p>{displayedMessage}</p>
      {canInstall && (
        <div className="voice-preflight__repair">
          <span>One-time local setup may download several gigabytes.</span>
          <button type="button" disabled={installationBusy} onClick={onInstall}>
            {installationBusy ? (
              <CircleNotch className="spinner" weight="bold" />
            ) : (
              <Wrench weight="bold" />
            )}
            {installationBusy
              ? 'INSTALLING HOST…'
              : installationState.state === 'repairable'
                ? 'REPAIR HOST'
                : 'INSTALL HOST'}
          </button>
        </div>
      )}
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

function EpisodeLibraryPanel({
  active,
  busy,
  notice,
  error,
  desktopAvailable,
  onChoose,
  onUseDemo,
  onOpenAuthorKit,
}: {
  active: DesktopEpisodeState | null;
  busy: boolean;
  notice: string | null;
  error: string | null;
  desktopAvailable: boolean;
  onChoose: () => void;
  onUseDemo: () => void;
  onOpenAuthorKit: () => void;
}) {
  return (
    <aside className={`episode-library ${notice || error ? 'has-notice' : ''}`} aria-live="polite">
      <div className="episode-library__identity">
        <span>
          ACTIVE SHOW ·{' '}
          {active?.episode.source === 'custom' ? 'CUSTOM EPISODE' : 'BUNDLED PREMIERE'}
        </span>
        <strong>{active?.episode.title ?? 'Current runtime episode'}</strong>
        {active?.episode.author && <small>Written by {active.episode.author}</small>}
      </div>
      <div className="episode-library__actions">
        <button
          className="episode-library__button episode-library__button--author"
          disabled={busy}
          onClick={onOpenAuthorKit}
          title="Download the complete AI episode author kit"
        >
          <Sparkle weight="fill" />
          MAKE EPISODE
        </button>
        {desktopAvailable && (
          <>
            <button
              className="episode-library__button"
              disabled={busy}
              onClick={onChoose}
              title="Load a validated .json or .showpack episode"
            >
              {busy ? (
                <CircleNotch className="spinner" weight="bold" />
              ) : (
                <FileArrowUp weight="bold" />
              )}
              LOAD EPISODE
            </button>
            {(active?.episode.source === 'custom' || active?.warning) && (
              <button
                className="episode-library__button episode-library__button--quiet"
                disabled={busy}
                onClick={onUseDemo}
                title="Return to the bundled premiere episode"
              >
                <ArrowCounterClockwise weight="bold" />
                USE DEMO
              </button>
            )}
          </>
        )}
      </div>
      {!desktopAvailable && (
        <small className="episode-library__browser-note">
          Download and loading are available in the desktop host.
        </small>
      )}
      {(error || notice || active?.warning) && (
        <p className={error || active?.warning ? 'is-error' : ''}>
          {error ?? active?.warning ?? notice}
        </p>
      )}
    </aside>
  );
}

function EpisodeAuthorKitModal({
  open,
  busy,
  notice,
  error,
  desktopAvailable,
  onClose,
  onDownload,
}: {
  open: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
  desktopAvailable: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose, open]);

  if (!open) return null;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(EPISODE_AI_STARTER_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
      playUiSound('lock');
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="author-kit-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="author-kit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="author-kit-title"
      >
        <div className="author-kit-dialog__flare" aria-hidden="true" />
        <header className="author-kit-dialog__header">
          <div className="author-kit-dialog__mark" aria-hidden="true">
            <Package weight="duotone" />
          </div>
          <div>
            <span>THE UNREASONABLY COMPLETE AI AUTHOR KIT</span>
            <h2 id="author-kit-title">BUILD A SHOW. SPOIL NOTHING.</h2>
            <p>
              Download one ZIP, attach it to any capable AI, describe your group, and get back an
              episode this game can validate, voice, cache, and play.
            </p>
          </div>
          <button
            className="author-kit-dialog__close"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close episode author kit"
          >
            <X weight="bold" />
          </button>
        </header>

        <div className="author-kit-dialog__steps" aria-label="Episode creation steps">
          <article>
            <b>01</b>
            <span>ATTACH</span>
            <p>Give the untouched ZIP to ChatGPT, Claude, Gemini, or another file-capable AI.</p>
          </article>
          <article>
            <b>02</b>
            <span>DESCRIBE</span>
            <p>Tell it the topics, inside jokes, rating, player knowledge, and desired length.</p>
          </article>
          <article>
            <b>03</b>
            <span>IMPORT</span>
            <p>Keep the returned episode.json unread, then bring it back with LOAD EPISODE.</p>
          </article>
        </div>

        <div className="author-kit-dialog__body">
          <div className="author-kit-dialog__included">
            <span>WHAT THE ZIP TEACHES THE AI</span>
            <ul>
              <li>Every supported scene, question, reaction, callback, and finale rule</li>
              <li>Display text versus natural spoken performance text</li>
              <li>Voice timing, comedy beats, interruption safety, and pronunciation</li>
              <li>Three full 2011 transcript references with a tone and pacing study</li>
              <li>Strict JSON Schema, validated starter, and a complete working episode</li>
              <li>Fact sourcing, asset licensing, content boundaries, and final QA</li>
            </ul>
          </div>
          <div className="author-kit-dialog__prompt">
            <div>
              <span>COPY THIS WITH YOUR TOPICS FILLED IN</span>
              <button type="button" onClick={() => void copyPrompt()}>
                {copied ? <Check weight="bold" /> : <Copy weight="bold" />}
                {copied ? 'COPIED' : 'COPY PROMPT'}
              </button>
            </div>
            <textarea
              aria-label="AI episode starter prompt"
              readOnly
              spellCheck={false}
              value={EPISODE_AI_STARTER_PROMPT}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        </div>

        <footer className="author-kit-dialog__footer">
          <div>
            <strong>YOUR ANSWERS STAY A SURPRISE.</strong>
            <span>The game rejects broken packs before they can wreck show night.</span>
          </div>
          <button
            className="author-kit-dialog__download"
            type="button"
            disabled={!desktopAvailable || busy}
            onClick={onDownload}
          >
            {busy ? (
              <CircleNotch className="spinner" weight="bold" />
            ) : (
              <DownloadSimple weight="bold" />
            )}
            {busy ? 'BUILDING KIT…' : 'DOWNLOAD AUTHOR KIT'}
          </button>
        </footer>
        {(notice || error || !desktopAvailable) && (
          <p className={`author-kit-dialog__notice ${error ? 'is-error' : ''}`}>
            {error ??
              notice ??
              'Open this screen in the desktop host to save the complete ZIP author kit.'}
          </p>
        )}
      </section>
    </div>
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
  const [scoreFlight, setScoreFlight] = useState<{ x: number; y: number } | null>(null);
  const [settledRevealPlayers, setSettledRevealPlayers] = useState<Set<string>>(new Set());
  const [episodeLibrary, setEpisodeLibrary] = useState<DesktopEpisodeState | null>(null);
  const [episodeLibraryBusy, setEpisodeLibraryBusy] = useState(false);
  const [episodeLibraryNotice, setEpisodeLibraryNotice] = useState<string | null>(null);
  const [episodeLibraryError, setEpisodeLibraryError] = useState<string | null>(null);
  const [episodeRestarting, setEpisodeRestarting] = useState(false);
  const [authorKitOpen, setAuthorKitOpen] = useState(false);
  const [authorKitBusy, setAuthorKitBusy] = useState(false);
  const [authorKitNotice, setAuthorKitNotice] = useState<string | null>(null);
  const [authorKitError, setAuthorKitError] = useState<string | null>(null);
  const [voiceInstallationState, setVoiceInstallationState] =
    useState<DesktopVoiceBootstrapState | null>(null);
  const [voiceInstallationProgress, setVoiceInstallationProgress] =
    useState<VoiceInstallationProgress | null>(null);
  const [voiceInstallationBusy, setVoiceInstallationBusy] = useState(false);
  const attachEpoch = useRef(0);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const completedSequences = useRef(new Set<string>());
  usePrivateSoundtrack(secrets.runtimeOrigin, secrets.hostSecret, snapshot?.phase, muted);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    voice.bank?.setMuted(muted);
  }, [muted, voice.bank]);

  useEffect(() => {
    const desktop = window.youreAllWrongDesktop;
    if (!desktop) return;
    let mounted = true;
    const removeRuntimeFailureListener = desktop.episode.onRuntimeFailure((state) => {
      if (!mounted) return;
      setEpisodeLibrary(state);
      setEpisodeRestarting(false);
      setEpisodeLibraryBusy(false);
      setEpisodeLibraryNotice(null);
      setEpisodeLibraryError(
        state.warning ?? 'The custom episode failed. The bundled demo is being restored.',
      );
    });
    void desktop.episode
      .getActive()
      .then((state) => {
        if (mounted) setEpisodeLibrary(state);
      })
      .catch((reason: unknown) => {
        if (mounted) {
          setEpisodeLibraryError(
            reason instanceof Error ? reason.message : 'The episode library did not answer.',
          );
        }
      });
    return () => {
      mounted = false;
      removeRuntimeFailureListener();
    };
  }, []);

  useEffect(() => {
    const desktop = window.youreAllWrongDesktop;
    if (!desktop) return;
    let mounted = true;
    const removeProgressListener = desktop.voice.onInstallationProgress((progress) => {
      if (mounted) setVoiceInstallationProgress(progress);
    });
    void desktop.voice
      .getInstallationState()
      .then((state) => {
        if (mounted) setVoiceInstallationState(state);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      removeProgressListener();
    };
  }, []);

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
      if (presentation.stage === 'prompt') {
        for (const part of presentation.parts) {
          const startedAt = performance.now();
          await playPart(part);
          if (part.id === 'category') {
            await waitForBeat(
              Math.max(0, CATEGORY_CARD_MINIMUM_MS - (performance.now() - startedAt)),
              controller.signal,
            );
          }
        }
        return;
      }

      if (presentation.stage === 'answers') {
        await voice.bank!.playSequence(presentation.cues, {
          signal: controller.signal,
          playbackRate: ANSWER_NARRATION_RATE,
          pauseScale: ANSWER_NARRATION_PAUSE_SCALE,
          onCue: (cue) => {
            setActiveCue(cue);
            if (cue) setActivePart(findPresentationPart(presentation, cue));
          },
        });
        return;
      }

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
      const pendingCorrectPlayerIds: string[] = [];
      const settlePlayer = async (playerId: string, outcome: 'correct' | 'wrong') => {
        setActiveRevealPlayerId(playerId);
        setRevealOutcome(outcome);
        playUiSound(outcome === 'correct' ? 'lock' : 'wrong');
        await waitForBeat(SCORE_PROJECTILE_SETTLE_MS, controller.signal);
        setSettledRevealPlayers((current) => new Set(current).add(playerId));
        await waitForBeat(650, controller.signal);
      };
      for (const part of presentation.parts) {
        const playerId = part.id.startsWith('player-') ? part.id.slice('player-'.length) : null;
        setActivePart(part.id);
        setActiveRevealPlayerId(playerId);
        setRevealOutcome('neutral');
        setActiveCue(null);
        if (playerId || part.id.startsWith('reaction-')) {
          await waitForBeat(520, controller.signal);
        }
        await playPart(part);
        if (!playerId) {
          if (part.id === 'explanation') {
            for (const pendingPlayerId of pendingCorrectPlayerIds.splice(0)) {
              await settlePlayer(pendingPlayerId, 'correct');
            }
          }
          continue;
        }

        const result = snapshotRef.current?.reveal?.playerResults.find(
          (candidate) => candidate.playerId === playerId,
        );
        if (result?.correct) {
          pendingCorrectPlayerIds.push(playerId);
          continue;
        }
        await settlePlayer(playerId, 'wrong');
      }
      for (const playerId of pendingCorrectPlayerIds.splice(0)) {
        await settlePlayer(playerId, 'correct');
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

  useLayoutEffect(() => {
    const result = snapshotRef.current?.reveal?.playerResults.find(
      (candidate) => candidate.playerId === activeRevealPlayerId,
    );
    if (!result || revealOutcome === 'neutral') {
      setScoreFlight(null);
      return;
    }
    const source = document.querySelector<HTMLElement>('.reveal-compass');
    const target = [...document.querySelectorAll<HTMLElement>('[data-score-player-id]')].find(
      (element) => element.dataset.scorePlayerId === result.playerId,
    );
    if (!source || !target) {
      setScoreFlight(null);
      return;
    }
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    setScoreFlight({
      x: targetBounds.left + targetBounds.width / 2 - (sourceBounds.left + sourceBounds.width / 2),
      y: targetBounds.top + targetBounds.height / 2 - (sourceBounds.top + sourceBounds.height / 2),
    });
  }, [activeRevealPlayerId, revealOutcome, snapshot?.revision]);

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
  const canStart = voice.ready && everyPlayerReady && connected && !episodeRestarting;
  const question = snapshot.question;
  const questionVisual =
    question?.timingPhase === 'answering'
      ? 'answers'
      : activePart === 'prompt'
        ? 'prompt'
        : activePart === 'question-number'
          ? 'number'
          : 'category';
  const finaleScoresVisible =
    snapshot.phase === 'complete' ||
    (activePart !== null && activePart !== 'calm-lead-in' && activePart !== 'title-drop');
  const activeRevealResult = snapshot.reveal?.playerResults.find(
    (result) => result.playerId === activeRevealPlayerId,
  );
  const activeRevealPlayer = snapshot.players.find((player) => player.id === activeRevealPlayerId);
  const activeReactionKey = activePart?.startsWith('reaction-')
    ? activePart.slice('reaction-'.length)
    : null;
  const activeReactionAnswerId =
    activeReactionKey === null || activeReactionKey.startsWith('conditional-')
      ? undefined
      : activeReactionKey === 'no-answer'
        ? null
        : activeReactionKey;
  const activeReactionResults =
    activeReactionKey === null
      ? []
      : activeReactionKey.startsWith('conditional-')
        ? (snapshot.reveal?.playerResults ?? [])
        : (snapshot.reveal?.playerResults ?? []).filter(
            (result) => result.answerId === activeReactionAnswerId,
          );
  const revealingCorrectAnswer = activePart === 'correct-answer' || activePart === 'explanation';
  const activeReactionNames = activeReactionResults
    .map(
      (result) =>
        snapshot.players.find((player) => player.id === result.playerId)?.name ?? 'UNKNOWN',
    )
    .join(', ');
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

  const chooseEpisode = async () => {
    const desktop = window.youreAllWrongDesktop;
    if (!desktop || episodeLibraryBusy) return;
    setEpisodeLibraryBusy(true);
    setEpisodeLibraryNotice(null);
    setEpisodeLibraryError(null);
    try {
      const result = await desktop.episode.choose();
      if (!result.ok) {
        if (!result.cancelled) setEpisodeLibraryError(result.message);
        return;
      }
      setEpisodeLibrary({ episode: result.episode, warning: null });
      setEpisodeRestarting(result.restarting);
      setEpisodeLibraryNotice(
        result.restarting ? 'Episode accepted. Rebuilding the room and cooking its audio…' : null,
      );
    } catch (reason) {
      setEpisodeLibraryError(
        reason instanceof Error ? reason.message : 'The episode could not be loaded.',
      );
    } finally {
      setEpisodeLibraryBusy(false);
    }
  };

  const useDemoEpisode = async () => {
    const desktop = window.youreAllWrongDesktop;
    if (!desktop || episodeLibraryBusy) return;
    setEpisodeLibraryBusy(true);
    setEpisodeLibraryNotice(null);
    setEpisodeLibraryError(null);
    try {
      const result = await desktop.episode.useDemo();
      if (!result.ok) {
        if (!result.cancelled) setEpisodeLibraryError(result.message);
        return;
      }
      setEpisodeLibrary({ episode: result.episode, warning: null });
      setEpisodeRestarting(result.restarting);
      setEpisodeLibraryNotice(
        result.restarting ? 'Demo restored. Rebuilding the room and checking its audio…' : null,
      );
    } catch (reason) {
      setEpisodeLibraryError(
        reason instanceof Error ? reason.message : 'The bundled demo could not be restored.',
      );
    } finally {
      setEpisodeLibraryBusy(false);
    }
  };

  const downloadAuthorKit = async () => {
    const desktop = window.youreAllWrongDesktop;
    if (!desktop || authorKitBusy) return;
    setAuthorKitBusy(true);
    setAuthorKitNotice(null);
    setAuthorKitError(null);
    try {
      const result = await desktop.episode.downloadAuthorKit();
      if (!result.ok) {
        if (!result.cancelled) setAuthorKitError(result.message);
        return;
      }
      const fileName = result.filePath.split(/[\\/]/u).at(-1) ?? 'episode author kit';
      setAuthorKitNotice(`${fileName} saved. Attach that ZIP to your AI and use the prompt above.`);
      playUiSound('advance');
    } catch (reason) {
      setAuthorKitError(
        reason instanceof Error ? reason.message : 'The episode author kit could not be saved.',
      );
    } finally {
      setAuthorKitBusy(false);
    }
  };

  const installHostVoice = async () => {
    const desktop = window.youreAllWrongDesktop;
    if (!desktop || voiceInstallationBusy) return;
    setVoiceInstallationBusy(true);
    setVoiceInstallationProgress({
      stage: 'validating',
      message: 'Validating the packaged host installer…',
    });
    try {
      const result = await desktop.voice.install();
      if (!result.ok) {
        setVoiceInstallationProgress(null);
        setError(result.message);
        const state = await desktop.voice.getInstallationState();
        setVoiceInstallationState(state);
        return;
      }
      setVoiceInstallationState(result.state);
      setVoiceInstallationProgress({
        stage: 'ready',
        message: 'Neural host verified. Restarting the room…',
      });
    } catch (reason) {
      setVoiceInstallationProgress(null);
      setError(reason instanceof Error ? reason.message : 'The neural host setup could not start.');
    } finally {
      setVoiceInstallationBusy(false);
    }
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
              <VoicePreflightPanel
                progress={voice.progress}
                installationState={voiceInstallationState}
                installationProgress={voiceInstallationProgress}
                installationBusy={voiceInstallationBusy}
                onInstall={() => void installHostVoice()}
              />
              <EpisodeLibraryPanel
                active={
                  episodeLibrary ?? {
                    episode: {
                      id: snapshot.episode.id,
                      title: snapshot.episode.title,
                      author: '',
                      source: 'demo',
                    },
                    warning: null,
                  }
                }
                busy={episodeLibraryBusy || episodeRestarting}
                notice={episodeLibraryNotice}
                error={episodeLibraryError}
                desktopAvailable={Boolean(window.youreAllWrongDesktop)}
                onChoose={() => void chooseEpisode()}
                onUseDemo={() => void useDemoEpisode()}
                onOpenAuthorKit={() => {
                  setAuthorKitOpen(true);
                  setAuthorKitNotice(null);
                  setAuthorKitError(null);
                  playUiSound('advance');
                }}
              />
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
                      <b>{index + 1}</b>
                      {player.ready && <Check weight="bold" />}
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

        {snapshot.phase === 'question' && question && questionVisual === 'number' && (
          <div className="question-number-slate" key={`${question.id}-number`}>
            <div className="question-number-slate__ghost" aria-hidden="true">
              {String(question.number).padStart(2, '0')}
            </div>
            <div className="question-number-slate__label">NEXT LIABILITY</div>
            <div className="question-number-slate__number">
              <span>QUESTION</span>
              <strong>{String(question.number).padStart(2, '0')}</strong>
            </div>
            <div className="question-number-slate__progress" aria-label="Question progress">
              {Array.from({ length: question.total }, (_, index) => (
                <i className={index < question.number ? 'is-lit' : ''} key={index} />
              ))}
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
            <div className="reveal-stage__question">
              <span>{snapshot.reveal.category}</span>
              <h1>{snapshot.reveal.promptText}</h1>
            </div>
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
                    : activeReactionKey
                      ? `${activeReactionNames.toUpperCase()} LOCKED THIS`
                      : 'THE ACTUAL ANSWER'}
                </strong>
              </div>
              <div className="reveal-compass">
                {snapshot.reveal.answers.map((answer, index) => {
                  const direction = DIRECTIONS[index]!;
                  const Icon = direction.icon;
                  const selected =
                    activeRevealResult?.answerId === answer.id ||
                    activeReactionAnswerId === answer.id ||
                    (revealingCorrectAnswer && snapshot.reveal?.correctAnswerId === answer.id);
                  const verdictClass =
                    selected && (revealOutcome !== 'neutral' || revealingCorrectAnswer)
                      ? revealingCorrectAnswer || activeRevealResult?.correct
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
                  ) : activeReactionKey ? (
                    <UsersThree weight="fill" />
                  ) : (
                    <LockKey weight="fill" />
                  )}
                  <strong>
                    {activeRevealPlayer?.name ??
                      (activeReactionKey
                        ? `${activeReactionResults.length} PLAYER${activeReactionResults.length === 1 ? '' : 'S'}`
                        : 'HOST')}
                  </strong>
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
                  !settledRevealPlayers.has(activeRevealResult.playerId) &&
                  scoreFlight && (
                    <div
                      className={`score-projectile ${
                        activeRevealResult.correct ? 'is-credit' : 'is-debit'
                      }`}
                      key={`${activeRevealResult.playerId}-${revealOutcome}`}
                      style={
                        {
                          '--score-flight-x': `${scoreFlight.x}px`,
                          '--score-flight-y': `${scoreFlight.y}px`,
                        } as CSSProperties
                      }
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
                      : activeReactionKey
                        ? 'GROUP VERDICT IN PROGRESS'
                        : snapshot.reveal.correctAnswerText}
              </div>
            </div>
            <Scoreboard
              snapshot={snapshot}
              compact
              scoreOverrides={revealScoreOverrides}
              changedPlayerIds={settledRevealPlayers}
              stableTieOrder={snapshot.reveal.playerResults.map((result) => result.playerId)}
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
              {episodeRestarting
                ? 'The old room is closing while the new episode takes over.'
                : !voice.ready
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
              {episodeRestarting
                ? 'SWITCHING EPISODE…'
                : voice.ready
                  ? 'START THE SHOW'
                  : 'COOKING AUDIO…'}
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

      <EpisodeAuthorKitModal
        open={authorKitOpen}
        busy={authorKitBusy}
        notice={authorKitNotice}
        error={authorKitError}
        desktopAvailable={Boolean(window.youreAllWrongDesktop)}
        onClose={() => setAuthorKitOpen(false)}
        onDownload={() => void downloadAuthorKit()}
      />

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
