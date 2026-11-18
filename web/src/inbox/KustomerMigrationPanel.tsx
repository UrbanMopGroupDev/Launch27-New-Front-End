// Support settings → Kustomer migration (admins). Export Kustomer's history (read-only),
// then preview which historical conversations would land on which customer's Story.
// Nothing here imports anything into the live inbox: the import isn't enabled.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type KustomerExport, type KustomerMatchKind, type KustomerTest, type KustomerScope } from './api';
import { ago } from './util';

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString('en-CA');
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const STATUS: Record<KustomerExport['status'], string> = { queued: 'Starting', running: 'Exporting', paused: 'Paused', cancelled: 'Cancelled', completed: 'Finished', failed: 'Stopped by an error' };
const MATCH: Record<KustomerMatchKind, { label: string; cls: string; help: string }> = {
  confident: { label: 'Confident', cls: 'wl-done', help: 'One Launch27 customer, by email or an identity agents already linked' },
  review: { label: 'Review', cls: 'wl-refused', help: 'Matched by phone number only: confirm before importing' },
  ambiguous: { label: 'Ambiguous', cls: 'wl-on', help: 'An address or number is on several Launch27 customers' },
  conflict: { label: 'Conflict', cls: 'wl-on', help: "The profile's addresses belong to different Launch27 customers" },
  unmatched: { label: 'Unmatched', cls: 'wl-blocked', help: 'No Launch27 customer with these addresses or numbers' },
  cleaner: { label: 'Cleaner', cls: 'wl-blocked', help: 'A Launch27 cleaner, not a customer' },
  internal: { label: 'Internal', cls: 'wl-blocked', help: 'Only our own addresses' },
};

export function KustomerMigrationPanel() {
  const qc = useQueryClient();
  const o = useQuery({ queryKey: ['inbox', 'kustomer'], queryFn: inbox.kustomer, refetchInterval: (q) => (q.state.data?.export && ['queued', 'running'].includes(q.state.data.export.status)) || q.state.data?.dry_run?.status === 'running' ? 2000 : 30_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<KustomerTest | null>(null);
  const [scope, setScope] = useState<KustomerScope | null>(null);
  const [since, setSince] = useState('');
  const [attachments, setAttachments] = useState(true);

  const act = async <T,>(fn: () => Promise<T>, after?: (v: T) => void) => {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      after?.(v);
      await qc.invalidateQueries({ queryKey: ['inbox', 'kustomer'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (o.isLoading) return <div className="muted">Loading…</div>;
  if (o.isError || !o.data) return <div className="muted">Couldn't load the Kustomer migration.</div>;
  const d = o.data;
  const job = d.export;
  const open = !!job && ['queued', 'running', 'paused'].includes(job.status);
  const run = d.dry_run;
  const r = run?.status === 'completed' ? run.results : null;

  return (
    <div className="km">
      <section className="channel-block">
        <p className="small">
          Copies Kustomer's customers, conversations, messages, internal notes and attachment details into encrypted storage here (Kustomer is only read), then previews which historical conversations would be attached to which customer's Story.{' '}
          <b>Nothing is imported into the inbox, nothing is sent, and no customer or conversation changes.</b>
          {d.source === 'synthetic' && <b> This environment reads a synthetic Kustomer made from its test data, never the real one.</b>}
        </p>
        {!d.available && <p className="error small">Not available here: {d.setup_problem}</p>}
        {error && <div className="error small">{error}</div>}
      </section>

      <section className="channel-block">
        <h3>1. Connection</h3>
        <div className="backfill-actions">
          <button type="button" className="secondary" disabled={busy || !d.available} onClick={() => act(inbox.kustomerTest, setTest)}>Test API connection</button>
          <button type="button" className="secondary" disabled={busy || !d.available} onClick={() => act(inbox.kustomerScope, setScope)}>Preview export scope</button>
        </div>
        {test && (
          <table className="table wl-table">
            <tbody>
              {test.checks.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>{c.ok ? <span className="wl-pill wl-done">OK</span> : <span className="error small">{c.error}{c.hint ? ` ${c.hint}` : ''}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {scope && <p className="small">{scope.customers_total != null ? `${n(scope.customers_total)} customers in Kustomer.` : `${n(scope.customers_on_first_page)} customers on the first page${scope.more_pages ? ', more after that' : ''}.`} {scope.note}{scope.rate_per_minute ? ` Paced at ${scope.rate_per_minute} requests a minute.` : ''}</p>}
      </section>

      <section className="channel-block">
        <h3>2. Export</h3>
        <p className="muted small">
          Stored here (encrypted): {n(d.stored.customer?.count)} customers · {n(d.stored.conversation?.count)} conversations · {n(d.stored.message?.count)} messages · {n(d.stored.note?.count)} notes · {n(d.stored.attachment?.count)} attachment records
          {d.stored.conversation?.oldest ? ` · ${day(d.stored.conversation.oldest)} to ${day(d.stored.conversation.newest)}` : ''}
        </p>
        {!open && (
          <div className="backfill-actions">
            <button type="button" disabled={busy || !d.available} onClick={() => act(() => inbox.kustomerExport({ kind: 'full', attachments }))}>Start full export</button>
            <label className="check"><input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} /> Attachment details (names, types, sizes, links; files aren't copied)</label>
            <span className="muted small">or catch up on conversations updated since</span>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Catch up since" />
            <button type="button" className="secondary" disabled={busy || !d.available || !since} onClick={() => act(() => inbox.kustomerExport({ kind: 'catchup', since, attachments }))}>Catch up</button>
          </div>
        )}
        {job && (
          <div className="backfill-job">
            <div className="backfill-job-head">
              <b>Export #{job.id}{job.kind === 'catchup' ? ` (catch-up since ${job.scope.since})` : ''}</b>
              <span className={`wl-pill ${job.status === 'completed' ? 'wl-done' : job.status === 'failed' ? 'wl-on' : 'wl-refused'}`}>{STATUS[job.status]}</span>
              <span className="muted small">{job.phase === 'customers' ? `reading the customer list (page ${job.pages + 1})` : job.phase === 'conversations' ? 'reading each customer\'s history' : 'done'} · {n(job.requests)} requests · started {ago(job.started_at || job.created_at)}</span>
              <span className="grow" />
              {['queued', 'running'].includes(job.status) && <button type="button" className="secondary" disabled={busy} onClick={() => act(() => inbox.kustomerExportAction(job.id, 'pause'))}>Pause</button>}
              {['paused', 'failed'].includes(job.status) && <button type="button" disabled={busy} onClick={() => act(() => inbox.kustomerExportAction(job.id, 'resume'))}>Resume</button>}
              {['queued', 'running', 'paused', 'failed'].includes(job.status) && <button type="button" className="secondary" disabled={busy} onClick={() => window.confirm('Cancel this export? What it already copied is kept.') && act(() => inbox.kustomerExportAction(job.id, 'cancel'))}>Cancel</button>}
            </div>
            {job.last_error && <div className="error small">{job.last_error}</div>}
            <p className="small">Customers: {n(job.customers.done)} done · {n(job.customers.pending)} to go · {n(job.customers.failed)} failed · {n(job.customers.skipped)} gone from Kustomer</p>
            {job.errors.length > 0 && (
              <details className="small">
                <summary>Problems ({job.errors.length})</summary>
                <table className="table wl-table"><tbody>{job.errors.map((e) => <tr key={e.customer_id}><td className="mono">{e.customer_id}</td><td>{e.state}</td><td className="error small">{e.error}</td></tr>)}</tbody></table>
              </details>
            )}
          </div>
        )}
      </section>

      <section className="channel-block">
        <h3>3. Dry run: where history would go</h3>
        <div className="backfill-actions">
          <button type="button" disabled={busy || !d.available || open || run?.status === 'running' || !d.stored.customer} onClick={() => act(inbox.kustomerDryRun)}>{run ? 'Run the dry run again' : 'Run the dry run'}</button>
          {r && <a className="button secondary-link" href="/api/admin/kustomer/report.csv">Download report (CSV, no names or addresses)</a>}
          <button type="button" className="secondary" disabled title="Importing Kustomer history has not been approved">Import (not enabled)</button>
        </div>
        {run?.status === 'running' && <p className="muted small">Matching… (started {ago(run.created_at)})</p>}
        {run?.status === 'failed' && <p className="error small">{run.last_error}</p>}
        {r && (
          <>
            <div className="backfill-stats">
              <Stat label="Kustomer customers" value={r.customers} sub={`${n(r.l27_customers)} Launch27 customers`} />
              <Stat label="Conversations" value={r.conversations} sub={`${n(r.new_conversations)} would be added · ${n(r.already_imported)} already imported`} />
              <Stat label="Messages" value={r.messages} sub={Object.entries(r.by_channel).map(([k, v]) => `${k} ${n(v)}`).join(' · ')} />
              <Stat label="Internal notes" value={r.notes} />
              <Stat label="Confident matches" value={r.match.confident} tone="ok" sub={`${n(r.conversations_by_match.confident)} conversations`} />
              <Stat label="Review / ambiguous / conflict" value={r.match.review + r.match.ambiguous + r.match.conflict} tone={r.match.review + r.match.ambiguous + r.match.conflict ? 'warn' : undefined} sub={`${n(r.match.review)} review · ${n(r.match.ambiguous)} ambiguous · ${n(r.match.conflict)} conflict`} />
              <Stat label="Unmatched" value={r.match.unmatched} sub={`${n(r.conversations_by_match.unmatched)} conversations kept with their Kustomer customer`} />
              <Stat label="Duplicates" value={r.duplicate_messages} sub={`messages already in the inbox · ${n(r.duplicate_identities)} Kustomer profiles for the same customer`} />
              <Stat label="Preview only" value={r.preview_only_messages} tone={r.preview_only_messages ? 'warn' : undefined} sub="Kustomer gave only the first part of the text" />
              <Stat label="Errors" value={r.errors.length} tone={r.errors.length ? 'warn' : undefined} />
            </div>
            <p className="muted small">History from {day(r.oldest)} to {day(r.newest)} · {n(r.by_direction.in)} from customers, {n(r.by_direction.out)} from us · {n(r.attachments)} attachments (details only). Cleaners {n(r.match.cleaner)} · internal {n(r.match.internal)}.</p>
            {r.errors.length > 0 && <details className="small"><summary>Import error report ({r.errors.length})</summary><ul>{r.errors.map((e) => <li key={`${e.kind}${e.kustomer_id}`}>{e.kind} {e.kustomer_id}: {e.error}</li>)}</ul></details>}
            <Matches />
          </>
        )}
      </section>

      <section className="channel-block">
        <h3>Exported data</h3>
        <p className="muted small">The copy is encrypted and visible only to admins. Delete it when the migration is finished (Kustomer itself is untouched).</p>
        <div className="backfill-actions">
          <button type="button" className="secondary" disabled={busy || open || !d.stored.customer} onClick={() => window.confirm('Delete every exported Kustomer record and dry run here? Kustomer itself is not changed.') && act(inbox.kustomerPurge)}>Delete exported data</button>
        </div>
      </section>
    </div>
  );
}

function Matches() {
  const [filter, setFilter] = useState<KustomerMatchKind | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['inbox', 'kustomer', 'matches', filter], queryFn: () => inbox.kustomerMatches(filter) });
  return (
    <>
      <div className="filters" role="tablist" aria-label="Filter matches">
        {[null, ...(Object.keys(MATCH) as KustomerMatchKind[])].map((m) => (
          <button key={m || 'all'} type="button" role="tab" aria-selected={filter === m} className={filter === m ? 'pillbtn on' : 'pillbtn'} onClick={() => setFilter(m)} title={m ? MATCH[m].help : undefined}>{m ? MATCH[m].label : 'All'}</button>
        ))}
      </div>
      <table className="table wl-table">
        <thead><tr><th>Kustomer customer</th><th>Match</th><th>Launch27 customer</th><th>Conversations</th><th>Messages</th><th>Notes</th><th /></tr></thead>
        <tbody>
          {(q.data?.rows || []).map((row) => (
            <MatchRow key={row.kustomer_customer_id} row={row} open={openId === row.kustomer_customer_id} onToggle={() => setOpenId(openId === row.kustomer_customer_id ? null : row.kustomer_customer_id)} />
          ))}
        </tbody>
      </table>
      {q.data && !q.data.rows.length && <p className="muted small">None.</p>}
      {q.data && q.data.rows.length === 100 && <p className="muted small">Showing the first 100. The downloadable report has every conversation.</p>}
    </>
  );
}

function MatchRow({ row, open, onToggle }: { row: import('./api').KustomerMatch; open: boolean; onToggle: () => void }) {
  const convs = useQuery({ queryKey: ['inbox', 'kustomer', 'conv', row.kustomer_customer_id], queryFn: () => inbox.kustomerConversations(row.kustomer_customer_id), enabled: open });
  const m = MATCH[row.match];
  return (
    <>
      <tr>
        <td>{row.name || '—'}<div className="muted small mono">{row.kustomer_customer_id}</div></td>
        <td><span className={`wl-pill ${m.cls}`} title={m.help}>{m.label}</span>{row.method ? <span className="muted small"> · {row.method.replace('_', ' ')}</span> : null}{row.reason && <div className="muted small">{row.reason}</div>}</td>
        <td>{row.l27_customer_id ? <Link to={`/customers/${row.l27_customer_id}`}>#{row.l27_customer_id}</Link> : row.candidates.length ? row.candidates.map((c) => <Link key={c} to={`/customers/${c}`} className="small">#{c} </Link>) : '—'}</td>
        <td>{n(row.conversations)}</td>
        <td>{n(row.messages)}</td>
        <td>{n(row.notes)}</td>
        <td><button type="button" className="link small" onClick={onToggle}>{open ? 'Hide' : 'Conversations'}</button></td>
      </tr>
      {open && (
        <tr className="wl-detail"><td colSpan={7}>
          {convs.isLoading ? <span className="muted small">Loading…</span> : (
            <table className="table wl-table"><thead><tr><th>Conversation</th><th>Period</th><th>Channels</th><th>Messages</th><th>Notes</th><th>Would</th></tr></thead><tbody>
              {(convs.data || []).map((c) => (
                <tr key={c.kustomer_conversation_id}>
                  <td className="mono small">{c.kustomer_conversation_id}</td>
                  <td className="small">{day(c.first_at)} – {day(c.last_at)}</td>
                  <td>{c.channels.join(', ')}</td>
                  <td>{n(c.messages)}{c.duplicate_messages ? <span className="muted small"> ({n(c.duplicate_messages)} already in the inbox)</span> : null}{c.preview_only_messages ? <span className="muted small"> · {n(c.preview_only_messages)} preview only</span> : null}</td>
                  <td>{n(c.notes)}</td>
                  <td className="small">{c.action === 'new' ? (row.l27_customer_id && row.match === 'confident' ? `be added to customer #${row.l27_customer_id}'s Story` : 'be kept with its Kustomer customer (not linked yet)') : c.action === 'already_imported' ? 'already imported' : c.reason || 'be skipped'}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </td></tr>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`backfill-stat${tone ? ` ${tone}` : ''}`}>
      <div className="backfill-stat-value">{n(value)}</div>
      <div className="small">{label}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
