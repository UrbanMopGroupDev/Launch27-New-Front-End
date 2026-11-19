// Client for the KPI scorecard (/api/kpi on our own server). Read-only, apart from the
// dev/QA-only manual Google review entry.
import { ApiError, describeErrors } from '../api';

export type Kpi = 'ocr' | 'churn' | 'fulfilment' | 'complaints' | 'reviews' | 'billing';
export type Mode = 'month' | 't12';
export type Tone = 'good' | 'warning' | 'critical' | 'neutral';

export interface Tile {
  kpi: Kpi;
  label: string;
  period: string;
  formula: string;
  unit: 'pct' | 'per100' | 'count' | null;
  state: 'ok' | 'no_data' | 'stale' | 'disabled';
  value: number | null;
  delta: { value: number; unit: 'pp' | 'per100' | 'count'; better: boolean | null; versus: string } | null;
  status: { label: string; tone: Tone } | null;
  badges: { tone: Tone; text: string }[];
  details: { label: string; value: string; drill?: string }[];
  breakdown?: { label: string; n: number; kind: 'company' | 'client' | 'unclassified'; group: string }[];
  weeks?: { from: string; to: string; value: number | null; num: number; den: number }[];
  sources: { key: string; label: string; refreshed_at: string | null; state: 'ok' | 'stale' | 'missing' }[];
  refreshed_at: string | null;
  target: string | null;
  last12: string | null;
  note?: string;
}
export interface Reference { line?: number; band?: [number, number]; label: string }
export interface TrendPoint { month: string; value: number | null; num: number; den: number | null; tone: Tone | null; flag: string | null }
export interface Scorecard {
  brand: { key: string; name: string; detail: string };
  brands: { key: string; name: string; detail: string }[];
  month: string;
  mode: Mode;
  period: string;
  today: string;
  env: string;
  synthetic: boolean;
  tiles: Tile[];
  trends: Partial<Record<Kpi, TrendPoint[]>>;
  references: Partial<Record<Kpi, Reference>>;
  months: { value: string; label: string }[];
  default_month: string;
  sources: { key: string; label: string; mode: string; refreshed_at: string | null; note: string | null }[];
  outage: string | null;
  outages: Record<string, string> | null;
  manual_reviews: { can_enter: boolean; entry: ManualReviews | null };
}
export interface ManualReviews { new_reviews: number; avg_rating: number; alltime_avg: number; alltime_count: number }
export interface DrillColumn { key: string; label: string; kind?: 'money' | 'pct' | 'num' }
export type DrillRow = Record<string, string | number | boolean | null> & { counted?: boolean; outcome?: string };
export interface Drill { title: string; tabs: { key: string; label: string; columns: DrillColumn[]; rows: DrillRow[]; defaultFilter?: string }[] }

export interface Query { brand?: string | null; month?: string | null; mode: Mode; outage?: string | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/kpi${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}
const qs = (q: Query, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams({ mode: q.mode, ...extra });
  if (q.brand) p.set('brand', q.brand);
  if (q.month) p.set('month', q.month);
  if (q.outage) p.set('outage', q.outage);
  return p.toString();
};

export const kpiApi = {
  scorecard: (q: Query) => call<Scorecard>('GET', `/scorecard?${qs(q)}`),
  drill: (q: Query, kpi: string) => call<Drill>('GET', `/drill?${qs(q, { kpi })}`),
  saveReviews: (brand: string, month: string, entry: ManualReviews) => call<unknown>('PUT', `/reviews/${month}`, { brand, ...entry }),
  clearReviews: (brand: string, month: string) => call<unknown>('DELETE', `/reviews/${month}?brand=${brand}`),
};
