import { useQuery } from '@tanstack/react-query';
import { inbox, type Channel, type Contact, type Role } from './api';
import { TIMEZONE } from '../format';

export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', sms: 'Text', voice: 'Call', chat: 'Chat' };
export const CHANNEL_ICON: Record<Channel, string> = { email: '✉', sms: '💬', voice: '☎', chat: '🗨' };
export const ROLE_LABEL: Record<Role, string> = { customer: 'Customer', cleaner: 'Cleaner', applicant: 'Applicant', system: 'System' };

export function useMeta() {
  return useQuery({ queryKey: ['inbox', 'meta'], queryFn: inbox.meta, staleTime: 5 * 60_000 });
}

export function useInboxMe() {
  return useQuery({ queryKey: ['inbox', 'me'], queryFn: inbox.me, staleTime: 30_000 });
}

export function useCounts() {
  return useQuery({ queryKey: ['inbox', 'counts'], queryFn: inbox.counts, refetchInterval: 10_000 });
}

// "3m", "2h", "4d"
export function ago(iso?: string | null, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// SLA countdown: "12m left", "due 9:05am", "3m late".
export function slaText(due?: string | null, now = Date.now()): { text: string; tone: 'ok' | 'warn' | 'late' } | null {
  if (!due) return null;
  const ms = new Date(due).getTime() - now;
  const mins = Math.round(ms / 60_000);
  if (ms < 0) return { text: `${fmtDur(-mins)} late`, tone: 'late' };
  if (mins <= 15) return { text: `${fmtDur(mins)} left`, tone: 'warn' };
  if (mins < 120) return { text: `${fmtDur(mins)} left`, tone: 'ok' };
  return { text: `due ${new Date(due).toLocaleString('en-CA', { timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, tone: 'ok' };
}

function fmtDur(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
}

export function firstName(contact?: Pick<Contact, 'name'> | null) {
  return (contact?.name || '').trim().split(/\s+/)[0] || 'there';
}

// Fill {{placeholders}} in a canned reply. Unknown ones stay visible so the agent sees them.
export function fillTemplate(body: string, vars: Record<string, string | undefined>) {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => vars[key] ?? m);
}

export function displayIdentity(value?: string | null) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : value || '';
}

// localStorage can be missing or throw (private windows); drafts are a convenience only.
export const drafts = {
  get(key: string) {
    try {
      return localStorage.getItem(`draft:${key}`) || '';
    } catch {
      return '';
    }
  },
  set(key: string, value: string) {
    try {
      if (value) localStorage.setItem(`draft:${key}`, value);
      else localStorage.removeItem(`draft:${key}`);
    } catch {
      /* ignore */
    }
  },
};


// Calendar day (YYYY-MM-DD) in the business time zone.
function dayKey(t: number) {
  return new Date(t).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// Days between two YYYY-MM-DD keys (b - a), ignoring DST shifts.
function dayDiff(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// Section heading for the work list: "Today", "Yesterday", "Earlier this week", "Last week", or "October 2026".
export function dayBucket(iso?: string | null, now = Date.now()): string {
  if (!iso) return 'No messages yet';
  const diff = dayDiff(dayKey(new Date(iso).getTime()), dayKey(now));
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Earlier this week';
  if (diff < 14) return 'Last week';
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE, month: 'long', year: 'numeric' });
}

// Short timestamp on a row: "2:15 p.m." today, "Mon 2:15 p.m." this week, "Oct 3" before that.
export function rowTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return '';
  const diff = dayDiff(dayKey(new Date(iso).getTime()), dayKey(now));
  const opts: Intl.DateTimeFormatOptions =
    diff <= 0 ? { hour: 'numeric', minute: '2-digit' } : diff < 7 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' };
  return new Date(iso).toLocaleString('en-CA', { timeZone: TIMEZONE, ...opts });
}

export type Since = '' | 'today' | '7d' | '30d';

// Start of the chosen time range as an ISO timestamp, or undefined for "any time".
export function sinceISO(since: Since, now = Date.now()): string | undefined {
  if (!since) return undefined;
  if (since === '7d') return new Date(now - 7 * 86_400_000).toISOString();
  if (since === '30d') return new Date(now - 30 * 86_400_000).toISOString();
  // Midnight today in the business time zone: step back by the elapsed local time.
  const local = new Date(now).toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false });
  const [h, m, s] = local.split(':').map(Number);
  const start = now - ((h % 24) * 3600 + m * 60 + s) * 1000;
  return new Date(start - (start % 1000)).toISOString();
}

// Small per-viewer preference store; storage can be unavailable, so fall back silently.
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`inbox:${key}`);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`inbox:${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
