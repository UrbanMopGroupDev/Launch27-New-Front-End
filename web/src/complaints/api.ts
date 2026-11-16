// Client for the Complaint Resolution Engine (/api/complaints on our own server).
import { ApiError, describeErrors } from '../api';

export type Outcome = 'saved' | 'partial_save' | 'lost' | 'pending';
export type Confidence = 'good' | 'fair' | 'thin' | 'none';

export interface OutcomeStats {
  n: number;
  decided: number;
  saved: number | null;
  partial: number | null;
  lost: number | null;
  avg_cost: number | null;
  median_cost: number | null;
  confidence: Confidence;
}

export interface Rung { rung: string; tier: string; action: string; label: string; amount?: number; pct?: number }

export interface Playbook {
  window: { from: string; to: string };
  totals: OutcomeStats & { cases: number; hard_routed: number; by_source: Record<string, number>; total_cost: number };
  taxonomy: (OutcomeStats & {
    key: string;
    label: string;
    share: number | null;
    hard_routed: number;
    typical_rung: string | null;
    tones: Record<string, number>;
    by_rung: (OutcomeStats & { rung: string })[];
    cheapest_that_works: { rung: string; saved: number; avg_cost: number | null; n: number } | null;
  })[];
  ladder: (Rung & OutcomeStats)[];
  reclean_vs_refund: { key: string; label: string; reclean: OutcomeStats; refund: OutcomeStats; neither: OutcomeStats; verdict: string }[];
  root_causes: null | {
    base_rate_per_100: number;
    visits: number;
    linked_complaints: number;
    rows: { key: string; label: string; visits: number; complaints: number; rate_per_100: number | null; vs_base: number | null; confidence: Confidence }[];
  };
  hard_routes: { key: string; label: string; n: number }[];
  response: { first_response_median_hours: number | null; with_response_time: number; decided_by: Record<string, number> };
  baseline: {
    months: { month: string; revenue: number; cost: number; rate: number | null; cases: number; refunds: number; credits: number; recleans: number }[];
    average: number | null;
    best: { month: string; rate: number | null } | null;
    worst: { month: string; rate: number | null } | null;
    default_target: number | null;
    caveat: string;
  };
  gaps: string[];
  thin_threshold: number;
}

export interface CaseRow {
  id: number;
  source: string;
  opened_at: string;
  service_date: string | null;
  customer_name: string | null;
  l27_customer_id: number | null;
  l27_booking_id: number | null;
  category: string;
  tone: string | null;
  severity: number | null;
  hard_route: string | null;
  summary: string | null;
  status: string;
  source_status: string | null;
  classified_by: string;
  total_cost: string | number;
  rungs: string | null;
  outcome_60: Outcome | null;
  tenure_days: number | null;
  cleaner_name: string | null;
}

export interface CaseDetail extends CaseRow {
  areas_cited: string[];
  exchanges: number | null;
  first_response_at: string | null;
  journey: Record<string, string | number | boolean | null> | null;
  resolutions: { rung: string | null; action: string; pct: number | null; amount: string | null; decided_by: string | null; approved_by: string | null; source: string; offered_at: string | null }[];
  costs: { kind: string; amount: string; source: string; estimated: boolean }[];
  outcomes: { day: number; outcome: Outcome; still_booking: boolean | null; next_booking_on: string | null; last_booking_on: string | null; repeat_case_id: number | null }[];
  also_seen_in: { id: number; source: string; opened_at: string }[];
}

export interface Settings {
  approval_preset: 'today' | 'target';
  max_rung: Record<string, string>;
  roles: Record<string, string>;
  hard_route_role: string;
  credit_expiry_days: number;
  budget: { target_pct: number | null; below_average_by: number; amber_at: number; red_at: number; alert_slack_user: string | null; qbo_tolerance: number };
  costs: { cleaner_hourly_default: number; margin_per_hour_default: number; travel_per_visit: number; reclean_default_hours: number; reclean_spot_share: number };
  pilot_months: number;
}

export interface Status {
  running: boolean;
  sources: Record<string, string>;
  window: { from: string; to: string };
  last_run: null | { id: number; started_at: string; finished_at: string | null; status: string; window_from: string; window_to: string; log: { at: string; level: string; msg: string }[] };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/complaints${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}

const qs = (w?: { from?: string; to?: string; category?: string }) => {
  const p = new URLSearchParams(Object.entries(w || {}).filter(([, v]) => v) as [string, string][]).toString();
  return p ? `?${p}` : '';
};

export const complaintsApi = {
  status: () => call<Status>('GET', '/status'),
  playbook: (w?: { from?: string; to?: string }) => call<Playbook>('GET', `/playbook${qs(w)}`),
  cases: (w?: { from?: string; to?: string; category?: string }) => call<CaseRow[]>('GET', `/cases${qs(w)}`),
  case: (id: number) => call<CaseDetail>('GET', `/cases/${id}`),
  reclassify: (id: number, patch: { category?: string; hard_route?: string | null }) => call<CaseDetail>('PATCH', `/cases/${id}`, patch),
  run: (w?: { from?: string; to?: string }) => call<{ started: boolean }>('POST', '/run', w || {}),
  settings: () => call<{ settings: Settings; rungs: Rung[]; presets: Record<string, { label: string }>; categories: string[]; hard_routes: Record<string, string> }>('GET', '/settings'),
  saveSettings: (s: Settings) => call<{ settings: Settings }>('PUT', '/settings', s),
};

export const OUTCOME_LABEL: Record<string, string> = { saved: 'Saved', partial_save: 'Partial save', lost: 'Lost', pending: 'Too early' };
export const TONE_LABEL: Record<string, string> = { mild: 'Mild', frustrated: 'Frustrated', angry: 'Angry', threat_leave: 'Threatens to leave', threat_review: 'Threatens a review' };
export const SOURCE_LABEL: Record<string, string> = { kustomer: 'Kustomer', gmail: 'info@ email', slack: 'Slack refund post', launch27_rating: 'Launch27 rating', ops_inbox: 'Ops inbox', manual: 'Manual' };
