const RUNTIME_STORAGE_KEY = 'yaw.runtime-origin';

export function createBrowserId(random: Crypto = crypto): string {
  if (typeof random.randomUUID === 'function') return random.randomUUID();

  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export interface FragmentSecrets {
  hostSecret: string | null;
  joinSecret: string | null;
  runtimeOrigin: string;
}

export function readFragmentSecrets(): FragmentSecrets {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fragmentRuntime = fragment.get('runtime');
  if (fragmentRuntime) sessionStorage.setItem(RUNTIME_STORAGE_KEY, fragmentRuntime);

  const storedRuntime = sessionStorage.getItem(RUNTIME_STORAGE_KEY);
  const defaultOrigin = import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:4310`
    : window.location.origin;
  const runtimeOrigin = fragmentRuntime ?? storedRuntime ?? defaultOrigin;

  const hostKey = 'yaw.host-secret';
  const joinKey = `yaw.join-secret.${window.location.pathname}`;
  const hostFromFragment = fragment.get('host');
  const joinFromFragment =
    fragment.get('join') ??
    ([...fragment.keys()].length === 1 && !hostFromFragment && !fragmentRuntime
      ? ([...fragment.keys()][0] ?? null)
      : null);

  if (hostFromFragment) sessionStorage.setItem(hostKey, hostFromFragment);
  if (joinFromFragment) sessionStorage.setItem(joinKey, joinFromFragment);

  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }

  return {
    hostSecret: hostFromFragment ?? sessionStorage.getItem(hostKey),
    joinSecret: joinFromFragment ?? sessionStorage.getItem(joinKey),
    runtimeOrigin,
  };
}

export function getOrCreateClientId(): string {
  const key = 'yaw.controller-client-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = createBrowserId();
  localStorage.setItem(key, created);
  return created;
}

export interface StoredCredential {
  playerId: string;
  resumeToken: string;
}

export function readCredential(code: string): StoredCredential | null {
  try {
    const value = localStorage.getItem(`yaw.credential.${code}`);
    return value ? (JSON.parse(value) as StoredCredential) : null;
  } catch {
    return null;
  }
}

export function writeCredential(code: string, credential: StoredCredential): void {
  localStorage.setItem(`yaw.credential.${code}`, JSON.stringify(credential));
}

export function clearCredential(code: string): void {
  localStorage.removeItem(`yaw.credential.${code}`);
}
