// Citizen identity for the report/validate loop (hackathon: no auth). The user
// record lives in localStorage under `samaan.user` and is shared app-wide through
// a tiny external store so the report sheet, the validate page and the header
// chip all see the same name and trust score.
import { useSyncExternalStore } from 'react';
import { userApi, type Profile, type User } from './api';
import type { Lang } from './i18n';

export const USER_KEY = 'samaan.user';

export interface StoredUser {
  id: number | string;
  display_name: string;
  /** 0-1 */
  trust_score: number;
  profile: Profile;
}

export type TrustLevel = 'new' | 'regular' | 'trusted';

export function trustLevel(score: number): TrustLevel {
  if (score >= 0.7) return 'trusted';
  if (score >= 0.4) return 'regular';
  return 'new';
}

function read(): StoredUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (
      v &&
      typeof v === 'object' &&
      (typeof (v as StoredUser).id === 'number' || typeof (v as StoredUser).id === 'string') &&
      typeof (v as StoredUser).display_name === 'string'
    ) {
      const u = v as StoredUser;
      return {
        id: u.id,
        display_name: u.display_name,
        trust_score: typeof u.trust_score === 'number' ? u.trust_score : 0,
        profile: u.profile ?? 'walker',
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

let current: StoredUser | null = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUser(): StoredUser | null {
  return current;
}

export function setUser(user: StoredUser | null): void {
  current = user;
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

function fromApi(u: User): StoredUser {
  return { id: u.id, display_name: u.display_name, trust_score: u.trust_score, profile: u.profile };
}

/** POST /users and store the result. */
export async function createUser(display_name: string, profile: Profile, language: Lang, team = false, signal?: AbortSignal): Promise<StoredUser> {
  const u = await userApi.create({ display_name, profile, language, team }, signal);
  const stored = fromApi(u);
  setUser(stored);
  return stored;
}

/** GET /users/{id} to refresh the trust score after a report or a vote. Errors are swallowed;
 *  a 404 (unknown user, e.g. the API was reseeded) clears the stored user so the dialog shows again. */
export async function refreshUser(): Promise<void> {
  const u = current;
  if (!u) return;
  try {
    const fresh = await userApi.get(u.id);
    if (current && current.id === u.id) setUser(fromApi(fresh));
  } catch (err) {
    if (err && typeof err === 'object' && (err as { status?: number }).status === 404) setUser(null);
  }
}

/** Current stored user (null until "Who are you?" has been answered). */
export function useUser(): StoredUser | null {
  return useSyncExternalStore(subscribe, getUser, getUser);
}
