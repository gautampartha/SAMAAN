// Contribution points and partner coupons (Contribute tab). A local ledger: the
// phone remembers what this person contributed (photos uploaded, reports sent,
// votes cast, rides recorded, trips completed) and the points each earned. The
// partner list is a hard-coded pilot catalogue for the hackathon demo; the
// server has no rewards model yet (see docs/PROGRESS.md, human tasks).
import { useSyncExternalStore } from 'react';

export type RewardKind = 'photo' | 'report' | 'vote' | 'ride' | 'trip';

/** Points per contribution. Product decision for the pilot, not a measured value. */
export const POINTS: Record<RewardKind, number> = { photo: 2, report: 25, vote: 5, ride: 40, trip: 10 };

export interface RewardEvent {
  kind: RewardKind;
  points: number;
  /** ISO timestamp. */
  at: string;
}

export interface Coupon {
  id: string;
  /** i18n keys: rewards.partners.<id>.name / .offer / .sector */
  cost: number;
}

/** Pilot catalogue (illustrative partners; names are placeholders until CSR agreements are signed). */
export const COUPONS: readonly Coupon[] = [
  { id: 'campus_cafe', cost: 100 },
  { id: 'metro_ride', cost: 150 },
  { id: 'pharmacy', cost: 200 },
  { id: 'bookstore', cost: 250 },
  { id: 'mobility_service', cost: 500 },
] as const;

export const REWARDS_KEY = 'samaan.rewards';
export const REDEEMED_KEY = 'samaan.rewards.redeemed';

interface Ledger {
  events: RewardEvent[];
  redeemed: string[];
}

function read(): Ledger {
  let events: RewardEvent[] = [];
  let redeemed: string[] = [];
  try {
    const raw = localStorage.getItem(REWARDS_KEY);
    if (raw) {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v)) events = v.filter((e): e is RewardEvent => Boolean(e) && typeof (e as RewardEvent).points === 'number');
    }
    const r = localStorage.getItem(REDEEMED_KEY);
    if (r) {
      const v: unknown = JSON.parse(r);
      if (Array.isArray(v)) redeemed = v.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* ignore */
  }
  return { events, redeemed };
}

let ledger: Ledger = read();
const listeners = new Set<() => void>();
let snapshot: RewardsSummary | null = null;

function persist(): void {
  try {
    localStorage.setItem(REWARDS_KEY, JSON.stringify(ledger.events.slice(-500)));
    localStorage.setItem(REDEEMED_KEY, JSON.stringify(ledger.redeemed));
  } catch {
    /* ignore */
  }
  snapshot = null;
  for (const l of listeners) l();
}

/** Record one contribution; returns the points earned. */
export function addPoints(kind: RewardKind, count = 1): number {
  const points = POINTS[kind] * count;
  ledger = { ...ledger, events: [...ledger.events, { kind, points, at: new Date().toISOString() }] };
  persist();
  return points;
}

export function redeem(couponId: string): boolean {
  const s = summarise();
  const c = COUPONS.find((x) => x.id === couponId);
  if (!c || ledger.redeemed.includes(couponId) || s.balance < c.cost) return false;
  ledger = { ...ledger, redeemed: [...ledger.redeemed, couponId] };
  persist();
  return true;
}

export function resetRewards(): void {
  ledger = { events: [], redeemed: [] };
  persist();
}

export interface RewardsSummary {
  earned: number;
  spent: number;
  balance: number;
  counts: Record<RewardKind, number>;
  redeemed: string[];
  /** The next coupon this balance does not yet afford, if any. */
  next: Coupon | null;
}

function summarise(): RewardsSummary {
  if (snapshot) return snapshot;
  const counts: Record<RewardKind, number> = { photo: 0, report: 0, vote: 0, ride: 0, trip: 0 };
  let earned = 0;
  for (const e of ledger.events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    earned += e.points;
  }
  const spent = ledger.redeemed.reduce((acc, id) => acc + (COUPONS.find((c) => c.id === id)?.cost ?? 0), 0);
  const balance = earned - spent;
  const next = COUPONS.find((c) => !ledger.redeemed.includes(c.id) && c.cost > balance) ?? null;
  snapshot = { earned, spent, balance, counts, redeemed: ledger.redeemed, next };
  return snapshot;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useRewards(): RewardsSummary {
  return useSyncExternalStore(subscribe, summarise, summarise);
}
