const RUNTIME_STORAGE_KEY = 'yaw.runtime-origin';

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
  const created = crypto.randomUUID();
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
