// Client for the support workspace API (/api on our own server).
import { ApiError, describeErrors } from '../api';

export type Channel = 'email' | 'sms' | 'voice' | 'chat';
export type Status = 'open' | 'snoozed' | 'done';
export type Role = 'customer' | 'cleaner' | 'applicant' | 'system';
export type Presence = 'available' | 'busy' | 'offline';

export interface User {
  id: number;
  email: string;
  name: string | null;
  role: 'agent' | 'supervisor' | 'admin';
  presence: Presence;
  queues?: { id: number; slug: string; name: string }[];
  open_count?: number;
  queue_ids?: number[];
  status?: (AgentStatus & { status_since: string | null }) | null;
  statuses?: AgentStatus[];
}

export type StatusKind = 'available' | 'away' | 'offline';
export interface AgentStatus {
  id: number;
  slug: string;
  name: string;
  kind: StatusKind;
  color: string;
  keeps_work?: boolean;
  max_minutes: number | null;
  selectable: boolean;
  position?: number;
  in_use?: number;
}
export type Capacity = Partial<Record<'email' | 'sms' | 'chat' | 'voice', number>>;
export interface Team {
  id?: number;
  name: string;
  description: string | null;
  lead_user_id: number | null;
  member_ids: number[];
  queue_ids: number[];
}
export interface QueueSettings extends Queue {
  position: number;
  routing_mode: 'least_busy' | 'round_robin' | 'manual';
  schedule_id: number | null;
  default_sla_id: number | null;
  overflow_minutes: number | null;
  overflow_queue_id: number | null;
  priority_boost: number;
}
export interface Schedule {
  id?: number;
  name: string;
  time_zone: string;
  week: Record<string, [string, string] | null>;
  is_default: boolean;
}
export interface WorkspaceSettings {
  default_capacity: Capacity;
  offline_returns_work: boolean;
  auto_offline_idle_minutes: number;
  pull_waiting_on_available: boolean;
  assign_on_reply: boolean;
  reopen_to_previous_owner: boolean;
  reopen_window_hours: number;
  require_disposition: boolean;
  alert_on_long_away: boolean;
  settings_editors: SettingsEditors;
  email_from_name: string;
}
export type SettingsEditors = 'everyone' | 'supervisors' | 'admins';

export interface HistoryEntry {
  id: number;
  action: string;
  object_type: string;
  object_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
}
export interface WorkforceAgent {
  id: number;
  email: string;
  name: string | null;
  role: User['role'];
  active: boolean;
  capacity: Capacity;
  status_id: number | null;
  status_since: string | null;
  queue_ids: number[];
  team_ids: number[];
}
export interface QaCopySummary {
  created_at: string;
  window: { from: string; to: string };
  bookings: number;
  customers: number;
  cleaners: number;
}
export interface L27Write {
  id: number;
  at: string;
  user_email: string | null;
  source: string;
  method: string;
  path: string;
  booking_id: number | null;
  outcome: 'done' | 'refused' | 'blocked' | 'failed';
  status: number | null;
  request: unknown;
  error: string | null;
}
export interface L27Writes { rows: L27Write[]; counts: { total: number; day: number; done: number }; allow_writes: boolean }

export interface QaCopyStatus {
  env: string;
  can_send: boolean;
  receiving: boolean;
  current: QaCopySummary | null;
  job: { state: 'idle' | 'running' | 'done' | 'failed'; started_at?: string; finished_at?: string; by?: string; step?: string; summary?: QaCopySummary; error?: string } | null;
}

export interface Workforce {
  statuses: AgentStatus[];
  teams: Team[];
  queues: QueueSettings[];
  schedules: Schedule[];
  sla_policies: { id: number; slug: string; name: string }[];
  settings: WorkspaceSettings;
  channels: ('email' | 'sms' | 'chat' | 'voice')[];
  agents: WorkforceAgent[];
}

export interface Queue {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  restricted: boolean;
}

export interface SlaPolicy {
  id: number;
  slug: string;
  name: string;
  first_response_minutes: number;
  warn_minutes: number;
  business_hours: boolean;
}

export interface Disposition {
  audience?: string;
  reason?: string;
  outcome?: string;
  note?: string;
  cancellation_reason?: string;
}

export interface Complaint {
  booking_id?: number | null;
  cleaner?: string | null;
  issue?: string;
  outcome?: 'return clean' | 'credit' | 'refund' | 'none' | 'pending';
  monetary_impact?: number | null;
  status?: 'open' | 'resolved';
}

export interface ConversationRow {
  id: number;
  channel: Channel;
  status: Status;
  subject: string | null;
  last_preview: string | null;
  last_message_at: string;
  priority: number;
  sla_due_at: string | null;
  sla_breached_at: string | null;
  awaiting_reply_since: string | null;
  l27_booking_id: number | null;
  their_identity: string | null;
  our_identity: string | null;
  snooze_until: string | null;
  queue_id: number | null;
  queue_name: string | null;
  owner_id: number | null;
  owner_name: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_roles: Role[] | null;
  has_complaint: boolean;
}

export interface Conversation extends Omit<ConversationRow, 'queue_name' | 'owner_name' | 'contact_name' | 'contact_roles' | 'has_complaint'> {
  disposition: Disposition | null;
  complaint: Complaint | null;
  // The cleaner the conversation is about (feeds complaint counts on Cleaner reports).
  cleaner_id: number | null;
  cleaner_name: string | null;
  routed_by: string | null;
  // Unsent reply on a conversation an agent started ("New conversation"); cleared when sent.
  draft?: string | null;
  first_response_at: string | null;
  created_at: string;
  reopened_count: number;
  sla_policy_id: number | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  kind: 'message' | 'note' | 'call' | 'event';
  direction: 'in' | 'out' | null;
  channel: Channel | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  author_id: number | null;
  author_name: string | null;
  delivery_state: string | null;
  meta: Record<string, unknown> & { note?: string; result?: string; duration_seconds?: number; recording_url?: string; type?: string; via?: string; gmail_id?: string; mailbox?: string; cc?: string[]; attachments?: { filename: string; type?: string; size: number }[] };
  created_at: string;
}

// People offered first in "New conversation": recently contacted by this agent, or often by the team.
export type SuggestedContact = Pick<Contact, 'id' | 'name' | 'roles' | 'l27_customer_id' | 'l27_team_id' | 'identities'> & { last_at: string; last_channel: Channel; times?: number };

export interface Identity {
  id: number;
  contact_id: number;
  kind: 'email' | 'phone';
  value: string;
  label: string | null;
  opted_out: boolean;
  // 'stop': they texted STOP (only their START undoes it); 'agent': ticked by hand.
  opted_out_by?: 'stop' | 'agent' | null;
}

export interface CallLogRow {
  id: number;
  conversation_id: number;
  direction: 'in' | 'out';
  from_addr: string | null;
  to_addr: string | null;
  created_at: string;
  result: 'answered' | 'missed' | 'voicemail' | 'no_answer' | string;
  duration_seconds: number | null;
  recording_url: string | null;
  agent_id: number | null;
  agent_name: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_roles: Role[] | null;
  l27_customer_id: number | null;
  l27_team_id: number | null;
  caller_flag: 'spam' | 'wrong_number' | null;
  lead_stage: string | null;
  queue_name: string | null;
  callback: 'open' | 'tried' | 'called_back' | null;
}

export type ContactList = 'all' | 'leads' | 'applicants' | 'other' | 'number_only' | 'flagged';
export interface ContactListRow {
  id: number;
  name: string | null;
  roles: Role[];
  l27_customer_id: number | null;
  l27_team_id: number | null;
  lead_stage: string | null;
  lead_source: string | null;
  caller_flag: 'spam' | 'wrong_number' | null;
  notes: string | null;
  created_at: string;
  last_activity: string | null;
  identities: { kind: 'phone' | 'email'; value: string; opted_out?: boolean }[];
}

// What "Add contact" may set. An email or phone already on a contact reuses that contact.
export interface NewContactInput {
  name: string;
  roles: Role[];
  email?: string;
  phone?: string;
  notes?: string;
  lead_stage?: string;
  lead_source?: string;
}
export type ContactSummary = { id: number; name: string | null; l27_customer_id: number | null; l27_team_id: number | null };

// The contact that already has an email or phone, from a 409 answer (or the several contacts
// the details given are spread over).
export function contactsInConflict(err: unknown): ContactSummary[] {
  if (!(err instanceof ApiError) || err.status !== 409) return [];
  const f = (err.fields || {}) as { contact?: ContactSummary; contacts?: ContactSummary[] };
  return f.contacts || (f.contact ? [f.contact] : []);
}

export interface Contact {
  id: number;
  name: string | null;
  roles: Role[];
  l27_customer_id: number | null;
  l27_team_id: number | null;
  lead_stage: string | null;
  lead_source: string | null;
  communication_preference: string | null;
  notes: string | null;
  caller_flag?: 'spam' | 'wrong_number' | null;
  identities: Identity[];
  conversations?: (Pick<Conversation, 'id' | 'channel' | 'status' | 'subject' | 'l27_booking_id' | 'disposition' | 'complaint'> & { last_preview: string | null; last_message_at: string })[];
}

export type ContactConversation = NonNullable<Contact['conversations']>[number];
export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  contact: Contact | null;
  others: { id: number; channel: Channel; status: Status; subject: string | null; last_preview: string | null; last_message_at: string; l27_booking_id: number | null }[];
  queue: Queue | null;
  owner: { id: number; name: string | null; email: string; presence: Presence } | null;
  sla_policy: SlaPolicy | null;
  // The linked booking's cleaner, when the conversation has no Cleaner set yet.
  cleaner_from_booking?: { id: number; name: string } | null;
}

export interface Canned {
  id: number;
  shortcut: string;
  title: string;
  body: string;
  channels: Channel[];
}

export type ChannelState = 'live' | 'sandbox' | 'not_connected';
export interface ChannelAccount {
  address: string;
  provider: string;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  ingested_count: number;
}
export interface SmsProviderStatus {
  provider: 'twilio';
  enabled: boolean;
  health_ok: boolean;
  health: {
    sms_numbers: string[];
    not_sms_capable: string[];
    checked_at: string;
    account?: { sid: string; name: string | null; status: string | null; type: string | null };
    webhook_elsewhere?: string[];
  } | null;
  webhook_url?: string | null;
  status_callback_url?: string | null;
  configured_numbers: string[];
  numbers: { number: string; can_send: boolean; queue: string }[];
  receiving: string;
  handed_over?: string[];
  last_webhook_at: string | null;
  last_received_at: string | null;
  last_reconcile_at: string | null;
  last_health_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  events: Record<string, number>;
}
export type KustomerMatchKind = 'confident' | 'phone' | 'picked' | 'cleaner' | 'existing' | 'internal' | 'new_profile';
/** Where a Kustomer profile's conversations go: a Launch27 customer, a cleaner, an inbox contact, or a new profile. */
export type KustomerTarget = 'customer' | 'cleaner' | 'contact' | 'new';
export interface KustomerExport {
  id: number;
  kind: 'full' | 'catchup';
  status: 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
  phase: 'customers' | 'conversations' | 'done';
  source: 'kustomer' | 'synthetic';
  scope: { since: string | null; attachments: boolean };
  pages: number;
  requests: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  customers: { pending: number; done: number; failed: number; skipped: number };
  errors: { customer_id: string; state: string; attempts: number; error: string | null }[];
}
export interface KustomerDryRunResults {
  customers: number;
  conversations: number;
  messages: number;
  notes: number;
  attachments: number;
  duplicate_messages: number;
  preview_only_messages: number;
  new_conversations: number;
  already_imported: number;
  match: Partial<Record<KustomerMatchKind, number>>;
  conversations_by_match: Partial<Record<KustomerMatchKind, number>>;
  /** 2 since every conversation gets a customer; earlier dry runs can't be imported. */
  plan_version?: number;
  by_target?: Record<KustomerTarget, number>;
  /** About how many new profiles the import will make. */
  new_profiles?: number;
  by_channel: Record<string, number>;
  by_direction: { in: number; out: number; unknown: number };
  oldest: string | null;
  newest: string | null;
  duplicate_identities: number;
  l27_customers: number;
  errors: { kind: string; kustomer_id: string; error: string }[];
}
export interface KustomerDryRun { id: number; status: 'running' | 'completed' | 'failed'; results: KustomerDryRunResults | null; created_at: string; finished_at: string | null; last_error: string | null }
export interface KustomerOverview {
  available: boolean;
  source: 'kustomer' | 'synthetic' | null;
  setup_problem: string | null;
  import_enabled: boolean;
  stored: Partial<Record<'customer' | 'conversation' | 'message' | 'note' | 'attachment', { count: number; oldest: string | null; newest: string | null }>>;
  export: KustomerExport | null;
  exports: Pick<KustomerExport, 'id' | 'kind' | 'status' | 'phase' | 'source' | 'created_at' | 'finished_at' | 'last_error'>[];
  dry_run: KustomerDryRun | null;
  imports: KustomerImport[];
}
export interface KustomerImport {
  id: number;
  dry_run_id: number;
  status: 'running' | 'stopped' | 'completed' | 'failed' | 'rolled_back';
  planned: number;
  processed: number;
  batches: number;
  conversations: number;
  messages: number;
  notes: number;
  skipped: number;
  /** New profiles the import made. */
  profiles: number;
  reconcile: { planned: number; imported: number; missing: number; different: number; without_customer?: number; missing_ids: string[]; different_ids: string[] } | null;
  created_by_name: string | null;
  created_at: string;
  finished_at: string | null;
  rolled_back_at: string | null;
  rolled_back_conversations: number | null;
  rolled_back_profiles: number | null;
  last_error: string | null;
}
export interface KustomerTest { source: string; ok: boolean; checks: { name: string; ok: boolean; status?: number | null; error?: string; hint?: string | null }[]; sample: { customers_on_first_page: number; more_pages: boolean; total_reported: number | null } }
export interface KustomerScope { source: string; customers_total: number | null; customers_on_first_page: number; more_pages: boolean; oldest_on_first_page: string | null; rate_per_minute: number | null; note: string }
export interface KustomerMatch { kustomer_customer_id: string; name: string | null; match: KustomerMatchKind; target: KustomerTarget | null; method: string | null; l27_customer_id: number | null; l27_team_id: number | null; contact_id: number | null; candidates: number[]; reason: string | null; conversations: number; messages: number; notes: number }
export interface KustomerPlanConversation { kustomer_conversation_id: string; l27_customer_id: number | null; action: 'new' | 'already_imported' | 'skip'; match: string; channels: string[]; messages: number; notes: number; duplicate_messages: number; preview_only_messages: number; first_at: string | null; last_at: string | null; reason: string | null }

export interface ChannelStatus {
  email: { state: ChannelState; provider: string | null; send_from?: string[]; accounts: ChannelAccount[]; read_only: boolean };
  sms: { state: ChannelState; provider: string | null; providers: SmsProviderStatus[]; problems?: { provider: 'twilio' | null; problem: string }[] };
}

export interface Meta {
  queues: Queue[];
  sla_policies: SlaPolicy[];
  dispositions: { audience: string[]; reason: string[]; outcome: string[]; cancellationReasons: string[] };
  canned: Canned[];
  identities: { email: string[]; sms: string[] };
  connected_channels: Channel[];
  channels: ChannelStatus;
  portal?: { name: string; links: { name: string; url: string }[] };
  ringcentral: { clientId: string; appServer: string | null; record?: boolean } | null;
  holidays: { day: string; name: string }[];
}

export interface Counts {
  mine: number;
  unassigned: number;
  breached: number;
  mentions: number;
  queues: Record<string, number>;
}

export interface Rule {
  id?: number;
  position?: number;
  name: string;
  enabled: boolean;
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
  replaces?: string | null;
}

export interface Notification {
  id: number;
  kind: string;
  conversation_id: number | null;
  // A mention or assignment on a complaint (Complaint tracking) opens that complaint.
  complaint_record_id?: number | null;
  // A page to open instead of a conversation (e.g. the monthly raise check).
  link: string | null;
  text: string;
  read_at: string | null;
  created_at: string;
  contact_name: string | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : '';
};

export const inbox = {
  me: () => call<User>('GET', '/me'),
  setPresence: (presence: Presence) => call<{ presence: Presence; requeued: number }>('PUT', '/me/presence', { presence }),
  rename: (name: string) => call<User>('PATCH', '/me', { name }),
  users: () => call<User[]>('GET', '/users'),
  updateUser: (id: number, patch: { role?: string; queue_ids?: number[]; name?: string; team_ids?: number[]; capacity?: Capacity; active?: boolean }) => call<User>('PATCH', `/users/${id}`, patch),
  setStatus: (status_id: number) => call<{ status_id: number; status: string; presence: Presence; requeued: number }>('PUT', '/me/status', { status_id }),
  setUserStatus: (userId: number, status_id: number) => call<{ requeued: number }>('PUT', `/users/${userId}/status`, { status_id }),
  workforce: () => call<Workforce>('GET', '/admin/workforce'),
  signature: () => call<{ body: string; custom: boolean; fallback: string }>('GET', '/me/signature'),
  saveSignature: (body: string) => call<{ body: string; custom: boolean; fallback: string }>('PUT', '/me/signature', { body }),
  saveSettings: (patch: Partial<WorkspaceSettings>) => call<WorkspaceSettings>('PUT', '/admin/settings', patch),
  saveStatuses: (statuses: Partial<AgentStatus>[]) => call<AgentStatus[]>('PUT', '/admin/statuses', { statuses }),
  saveTeams: (teams: Team[]) => call<void>('PUT', '/admin/teams', { teams }),
  createQueue: (name: string, description?: string) => call<QueueSettings>('POST', '/admin/queues', { name, description }),
  updateQueue: (id: number, patch: Partial<QueueSettings>) => call<QueueSettings>('PATCH', `/admin/queues/${id}`, patch),
  placementAudit: (days: number) => call<{ enabled: boolean; booking?: boolean; callers: { name: string; actions: string[]; brands: string[] | null }[]; allowed_ips?: number; rows: { id: number; at: string; caller: string | null; ip: string | null; method: string; operation: string | null; path: string; status: number; code: string | null; ms: number; ref: string | null }[] }>('GET', `/admin/placement-audit?days=${days}`),
  l27Writes: (before?: number) => call<L27Writes>('GET', `/admin/l27-writes?limit=100${before ? `&before=${before}` : ''}`),
  qaCopy: () => call<QaCopyStatus>('GET', '/admin/qa-copy'),
  sendQaCopy: () => call<{ job: QaCopyStatus['job'] }>('POST', '/admin/qa-copy'),
  clearQaCopy: () => call<void>('DELETE', '/admin/qa-copy'),
  saveSchedule: (s: Schedule) => call<Schedule>('PUT', s.id ? `/admin/schedules/${s.id}` : '/admin/schedules', s),
  meta: () => call<Meta>('GET', '/meta'),
  channels: () => call<ChannelStatus>('GET', '/channels'),
  kustomer: () => call<KustomerOverview>('GET', '/admin/kustomer'),
  kustomerTest: () => call<KustomerTest>('POST', '/admin/kustomer/test'),
  kustomerScope: () => call<KustomerScope>('GET', '/admin/kustomer/scope'),
  kustomerExport: (body: { kind: 'full' | 'catchup'; since?: string | null; attachments: boolean }) => call<KustomerExport>('POST', '/admin/kustomer/exports', body),
  kustomerExportAction: (id: number, action: 'pause' | 'resume' | 'cancel') => call<KustomerExport>('POST', `/admin/kustomer/exports/${id}/${action}`),
  kustomerDryRun: () => call<KustomerDryRun>('POST', '/admin/kustomer/dry-runs'),
  kustomerMatches: (match: string | null, offset = 0) => call<{ run: KustomerDryRun | null; rows: KustomerMatch[] }>('GET', `/admin/kustomer/matches?limit=100&offset=${offset}${match ? `&match=${match}` : ''}`),
  kustomerConversations: (kid: string) => call<KustomerPlanConversation[]>('GET', `/admin/kustomer/customers/${encodeURIComponent(kid)}/conversations`),
  kustomerImport: () => call<KustomerImport>('POST', '/admin/kustomer/imports'),
  kustomerImportAction: (id: number, action: 'stop' | 'resume' | 'rollback') => call<KustomerImport>('POST', `/admin/kustomer/imports/${id}/${action}`),
  kustomerPurge: () => call<{ purged: boolean }>('POST', '/admin/kustomer/purge'),
  smsAction: (provider: string, action: 'check' | 'disconnect' | 'connect' | 'take-over' | 'hand-back') => call<ChannelStatus>('POST', `/admin/sms/${provider}/${action}`),
  counts: () => call<Counts>('GET', '/counts'),
  list: (params: { view?: string; status?: string; channel?: string; role?: string; q?: string; contact_id?: number; booking_id?: number; sort?: 'newest' | 'oldest' | 'due'; since?: string }) => call<ConversationRow[]>('GET', `/conversations${qs(params)}`),
  get: (id: number) => call<ConversationDetail>('GET', `/conversations/${id}`),
  reply: (id: number, body: { body: string; channel?: Channel; to?: string; subject?: string; from?: string; cc?: string[]; idempotency_key?: string; attachments?: { filename: string; type: string; data: string }[] }) => call<Message>('POST', `/conversations/${id}/messages`, body),
  note: (id: number, body: string) => call<Message>('POST', `/conversations/${id}/notes`, { body }),
  saveDraft: (id: number, text: string) => call<{ ok: true }>('PUT', `/conversations/${id}/draft`, { text }),
  bulkDone: (ids: number[], disposition?: Disposition) => call<{ done: number[]; failed: { id: number; error: string }[] }>('POST', '/conversations/bulk/done', { ids, disposition }),
  personHistory: (id: number) => call<{ messages: Message[]; conversations: number }>('GET', `/conversations/${id}/history`),
  suggested: () => call<{ recent: SuggestedContact[]; frequent: SuggestedContact[] }>('GET', '/contacts/suggested'),
  addEvent: (id: number, text: string, meta: Record<string, unknown> = {}) => call<Message>('POST', `/conversations/${id}/events`, { text, meta }),
  patch: (id: number, patch: Partial<{ status: Status; snooze_until: string; disposition: Disposition; queue_id: number; priority: number; l27_booking_id: number | null; complaint: Complaint | null; subject: string; cleaner_id: number | null; cleaner_name: string | null; contact_id: number }>) => call<Conversation>('PATCH', `/conversations/${id}`, patch),
  claim: (id: number) => call<Conversation>('POST', `/conversations/${id}/claim`),
  assign: (id: number, userId: number | null, reason?: string) => call<Conversation>('POST', `/conversations/${id}/assign`, { user_id: userId, reason }),
  start: (body: { contact_id: number; channel: 'email' | 'sms'; to?: string; from?: string; subject?: string; body?: string; l27_booking_id?: number }) => call<Conversation>('POST', '/conversations', body),
  contact: (id: number) => call<Contact>('GET', `/contacts/${id}`),
  /** Every conversation of a contact, newest first; pass the previous page's `next` to continue. */
  contactConversations: (id: number, before?: string | null, limit = 100) => call<{ rows: ContactConversation[]; next: string | null }>('GET', `/contacts/${id}/conversations${qs({ before: before || undefined, limit })}`),
  findContacts: (q: string) => call<Contact[]>('GET', `/contacts${qs({ q })}`),
  createContact: (body: NewContactInput) => call<Contact & { existing: boolean }>('POST', '/contacts', body),
  // merged_into: linking to a Launch27 customer or cleaner who already had a contact merged
  // this one into theirs (the id to open from now on).
  updateContact: (id: number, patch: Partial<Omit<Contact, 'id' | 'identities' | 'conversations'>>) => call<Contact & { merged_into: number | null }>('PATCH', `/contacts/${id}`, patch),
  deleteContact: (id: number) => call<{ id: number; conversations: number }>('DELETE', `/contacts/${id}`),
  mergeContact: (id: number, otherId: number) => call<Contact>('POST', `/contacts/${id}/merge`, { contact_id: otherId }),
  addIdentity: (id: number, kind: 'email' | 'phone', value: string, label?: string) => call<Identity>('POST', `/contacts/${id}/identities`, { kind, value, label }),
  updateIdentity: (identityId: number, patch: { value?: string; label?: string | null; opted_out?: boolean }) => call<Identity>('PATCH', `/identities/${identityId}`, patch),
  removeIdentity: (identityId: number) => call<Identity>('DELETE', `/identities/${identityId}`),
  setOptOut: (identityId: number, optedOut: boolean) => call<Identity>('PATCH', `/identities/${identityId}`, { opted_out: optedOut }),
  fromL27: (body: { customer_id?: number; team_id?: number }) => call<Contact>('POST', '/contacts/from-l27', body),
  search: (q: string) => call<{ contacts: (Pick<Contact, 'id' | 'name' | 'roles' | 'l27_customer_id' | 'l27_team_id'> & { identities: string | null })[]; conversations: { id: number; channel: Channel; status: Status; subject: string | null; contact_name: string | null; snippet: string | null; last_message_at: string }[] }>('GET', `/search${qs({ q })}`),
  notifications: () => call<Notification[]>('GET', '/notifications'),
  readNotifications: () => call<void>('POST', '/notifications/read'),
  supervisor: () => call<{ queues: { id: number; name: string; slug: string; open: number; unassigned: number; breached: number; oldest_waiting: string | null; done_today: number }[]; agents: { id: number; name: string | null; email: string; presence: Presence; role: string; open: number; breached: number; done_today: number; status_id: number | null; status: string | null; status_kind: StatusKind | null; status_color: string | null; status_max: number | null; status_since: string | null; away_minutes_today: number }[]; first_response: { median_minutes: number | null; n: number } }>('GET', '/supervisor'),
  rules: () => call<{ rules: Rule[]; warnings: { ruleId: number; message: string }[] }>('GET', '/admin/rules'),
  saveRules: (rules: Rule[]) => call<{ rules: Rule[]; warnings: { ruleId: number; message: string }[] }>('PUT', '/admin/rules', { rules }),
  testRules: (body: { channel: Channel; to?: string; from: string; subject?: string; body?: string; roles?: Role[]; lead_stage?: string; rules?: Rule[] }) => call<{ rule: string | null; action: Record<string, unknown> }>('POST', '/admin/rules/test', body),
  saveCanned: (c: Partial<Canned>) => call<Canned>('PUT', `/admin/canned${c.id ? `/${c.id}` : ''}`, c),
  deleteCanned: (id: number) => call<void>('DELETE', `/admin/canned/${id}`),
  history: () => call<HistoryEntry[]>('GET', '/admin/history'),
  saveSla: (id: number, patch: { first_response_minutes: number; warn_minutes?: number; business_hours?: boolean }) => call<SlaPolicy>('PUT', `/admin/sla/${id}`, patch),
  simulate: (body: { channel: Channel; from: string; to?: string; subject?: string; body: string; from_name?: string; thread_key?: string }) => call<{ conversationId: number; isNew: boolean; reopened: boolean }>('POST', '/simulate/inbound', body),
  logCall: (body: Record<string, unknown>) => call<{ conversationId?: number; saved?: boolean; hidden?: boolean }>('POST', '/calls', body),
  callLog: (days: number) => call<{ days: number; rows: CallLogRow[] }>('GET', `/calls${qs({ days })}`),
  contactList: (list: ContactList, q?: string) => call<{ rows: ContactListRow[]; counts: Record<ContactList, number>; limit: number }>('GET', `/contact-list${qs({ list, q })}`),
  callerChoice: (phone: string) => call<{ l27_customer_id: number | null }>('GET', `/caller-choice${qs({ phone })}`),
  rememberCallerChoice: (phone: string, customerId: number) => call<{ saved: boolean }>('PUT', '/caller-choice', { phone, l27_customer_id: customerId }),
  lookup: (kind: 'phone' | 'email', value: string, simulated = false) => call<{ contacts: Contact[]; open: { id: number; channel: Channel; subject: string | null }[]; l27: { name: string; roles: Role[]; l27_customer_id?: number | null; l27_team_id?: number | null } | null }>('GET', `/lookup${qs({ kind, value, ...(simulated ? { simulated: '1' } : {}) })}`),
};
