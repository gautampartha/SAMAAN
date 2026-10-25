// Client for the /admin API. Base URL: VITE_ADMIN_API_URL, else the page's own origin when the
// console is served by the API at /admin, else the local dev API.
export const ADMIN_API: string = (() => {
  const env = (import.meta.env.VITE_ADMIN_API_URL as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (typeof location !== 'undefined' && location.pathname.startsWith('/admin')) return location.origin;
  return 'http://127.0.0.1:8000';
})();

const TOKEN_KEY = 'samaan.admin.token';
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setToken(t: string): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class AdminError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(`${status}: ${detail}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers['X-Admin-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${ADMIN_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new AdminError(res.status, detail);
  }
  return (await res.json()) as T;
}

export function photoUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `${ADMIN_API}${path}`;
}

export type OrderStatus = 'open' | 'assigned' | 'in_progress' | 'done' | 'cant_fix' | 'cancelled';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export const OPEN_STATUSES: readonly OrderStatus[] = ['open', 'assigned', 'in_progress'];
export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];
/** Mirrors api/routers/admin.py TRANSITIONS. */
export const NEXT: Record<OrderStatus, OrderStatus[]> = {
  open: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'done', 'cant_fix', 'cancelled'],
  in_progress: ['done', 'cant_fix', 'cancelled'],
  cant_fix: ['assigned', 'cancelled'],
  done: [],
  cancelled: [],
};

export interface Summary {
  auth: 'open' | 'token';
  zone: { en: string; hi?: string } | null;
  reports: { pending: number; verified: number; rejected: number; total: number; today: number };
  barriers: { active: number; active_real: number; active_synthetic: number; fixed: number; unassigned: number; impassable: number };
  work_orders: Record<OrderStatus, number> & { overdue: number };
  fixed_last_7_days: number;
  median_hours_to_close: number | null;
  workers: { total: number; active: number };
}

export interface WorkOrder {
  id: number;
  barrier_id: number;
  worker_id: number | null;
  worker_name: string | null;
  status: OrderStatus;
  priority: Priority;
  due_date: string | null;
  note: string | null;
  resolution_note: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  overdue: boolean;
  history: { at: string; status: string; by: string | null; note: string | null }[];
  barrier?: { class_id: string; name_en: string; name_hi: string; severity: number; lat: number; lon: number; status: string; synthetic: boolean } | null;
}

export interface BarrierRow {
  id: number;
  class_id: string;
  name_en: string;
  name_hi: string;
  severity: number;
  status: string;
  confidence: number;
  lat: number;
  lon: number;
  synthetic: boolean;
  sources: string[];
  note: string | null;
  created_at: string | null;
  fixed_at: string | null;
  age_days: number | null;
  n_reports: number;
  work_order: WorkOrder | null;
}

export interface ReportRow {
  id: number;
  kind: 'barrier' | 'fixed';
  status: 'pending' | 'verified' | 'rejected';
  class_id: string;
  name_en?: string;
  name_hi?: string;
  severity: number;
  lat: number;
  lon: number;
  photo_url: string | null;
  note: string | null;
  votes: { agree: number; disagree: number; unsure: number };
  score: number;
  created_at: string | null;
  resolved_at: string | null;
  barrier_id: number | null;
  target_barrier_id: number | null;
  sources_note: string | null;
  model_prescreen_score?: number | null;
  reporter: { name: string; trust: number; profile: string } | null;
}

export interface Worker {
  id: number;
  name: string;
  phone: string | null;
  department: string | null;
  area: string | null;
  active: boolean;
  open_jobs: number;
}

export interface Zone {
  center: { lat: number; lon: number };
  bbox: { south: number; west: number; north: number; east: number };
  basemap: { style_url: string; attribution: string };
  display_name: { en: string; hi?: string };
}

export const adminApi = {
  zone: () => call<Zone>('GET', '/zone'),
  summary: () => call<Summary>('GET', '/admin/summary'),
  reports: (status: string) => call<{ results: ReportRow[] }>('GET', `/admin/reports?status=${encodeURIComponent(status)}&limit=200`),
  decide: (id: number, decision: 'verify' | 'reject', note?: string) => call<{ status: string; barrier_id: number | null }>('POST', `/admin/reports/${id}/decision`, { decision, note }),
  barriers: (status: string) => call<{ results: BarrierRow[] }>('GET', `/admin/barriers?status=${encodeURIComponent(status)}`),
  workers: () => call<{ results: Worker[] }>('GET', '/admin/workers'),
  addWorker: (w: { name: string; phone?: string; department?: string; area?: string }) => call<Worker>('POST', '/admin/workers', w),
  updateWorker: (id: number, patch: Partial<Worker>) => call<Worker>('PATCH', `/admin/workers/${id}`, patch),
  orders: (status: string) => call<{ results: WorkOrder[] }>('GET', `/admin/workorders?status=${encodeURIComponent(status)}`),
  createOrder: (o: { barrier_id: number; worker_id?: number | null; priority: Priority; due_date?: string | null; note?: string; created_by?: string }) =>
    call<WorkOrder>('POST', '/admin/workorders', o),
  updateOrder: (id: number, patch: { status?: OrderStatus; worker_id?: number | null; priority?: Priority; due_date?: string | null; note?: string; resolution_note?: string; by?: string }) =>
    call<WorkOrder>('PATCH', `/admin/workorders/${id}`, patch),
};
