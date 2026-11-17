// Support settings → Channels → Text messages: each SMS provider (RingCentral, Twilio).
// Credentials live in Railway (never on this screen); admins can check, disconnect and reconnect.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { inbox, type ChannelStatus, type SmsProviderStatus } from './api';
import { ago, displayIdentity } from './util';

const LABEL = { ringcentral: 'RingCentral', twilio: 'Twilio' } as const;
const when = (iso: string | null | undefined) => (iso ? ago(iso) : 'never');
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export function SmsPanel({ sms, isAdmin }: { sms: ChannelStatus['sms']; isAdmin: boolean }) {
  if (!sms.providers?.length) {
    return (
      <section className="channel-block">
        <h3>Text messages</h3>
        <p className="small">
          {sms.state === 'sandbox' ? (
            <><span className="wl-pill wl-refused">Sandbox</span> This is a test environment: texts are recorded on the conversation but never sent. Use the Channel simulator for incoming texts.</>
          ) : (
            <><span className="wl-pill wl-blocked">Not connected</span> SMS isn't set up here: replies are saved, not sent. An admin sets the RingCentral or Twilio variables in Railway (docs/sms.md).</>
          )}
        </p>
      </section>
    );
  }
  return (
    <>
      {sms.providers.length > 1 && <p className="muted small">Each business number belongs to one provider; replies go out through the provider that owns the conversation's number.</p>}
      {sms.providers.map((p) => (
        <ProviderPanel key={p.provider} p={p} sandbox={sms.state === 'sandbox'} isAdmin={isAdmin} />
      ))}
    </>
  );
}

function ProviderPanel({ p, sandbox, isAdmin }: { p: SmsProviderStatus; sandbox: boolean; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = LABEL[p.provider];
  const act = async (a: 'check' | 'disconnect' | 'connect') => {
    if (a === 'disconnect' && !window.confirm(`Disconnect ${name} SMS? Its numbers will not send or receive texts until an admin reconnects. Texts that arrive meanwhile are picked up when you reconnect.`)) return;
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['inbox', 'channels'], await inbox.smsAction(p.provider, a));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = !p.enabled ? { cls: 'wl-blocked', label: 'Disconnected' } : sandbox ? { cls: 'wl-refused', label: 'Sandbox' } : p.health_ok ? { cls: 'wl-done', label: 'Connected' } : { cls: 'wl-on', label: 'Needs attention' };
  const h = p.health;
  return (
    <section className="channel-block">
      <h3>Text messages <span className="muted small">· {name}</span></h3>
      <p className="small">
        <span className={`wl-pill ${status.cls}`}>{status.label}</span>{' '}
        {!p.enabled
          ? 'These numbers are not sending or receiving texts. Reconnect to start again; texts that arrived meanwhile are picked up.'
          : sandbox
            ? 'Replies are recorded here, never sent.'
            : p.health_ok
              ? 'Agents can send and receive texts from the numbers below.'
              : `${name} is set up but not ready to send. See the problem below.`}
      </p>
      {h?.extension && (
        <p className="muted small">Extension {h.extension.number || h.extension.id}{h.extension.name ? ` (${h.extension.name})` : ''}{h.account_id ? ` · account ${h.account_id}` : ''} · checked {when(p.last_health_at)}</p>
      )}
      {h?.account && (
        <p className="muted small">Account {h.account.name || ''} ({h.account.sid}) · {h.account.status}{h.account.type ? ` · ${h.account.type}` : ''} · checked {when(p.last_health_at)}</p>
      )}
      <table className="table wl-table">
        <thead><tr><th>Business number</th><th>Can send</th><th>New texts go to</th></tr></thead>
        <tbody>
          {p.numbers.map((n) => (
            <tr key={n.number}>
              <td>{displayIdentity(n.number)}{h?.webhook_elsewhere?.includes(n.number) && <div className="error small">Its incoming texts are still sent somewhere else in Twilio.</div>}</td>
              <td>{n.can_send ? <span className="wl-pill wl-done">Yes</span> : <span className="wl-pill wl-on">No: not SMS-enabled</span>}</td>
              <td>{n.queue}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {h?.missing_scopes?.length ? <p className="error small">The RingCentral app is missing permissions: {h.missing_scopes.join(', ')}. Add them in the RingCentral developer console.</p> : null}
      <table className="table wl-table backfill-kv">
        <tbody>
          <tr><th>Receiving</th><td>{p.receiving}</td></tr>
          {p.provider === 'ringcentral' && <tr><th>Webhook subscription</th><td>{p.has_subscription ? `active, renews automatically (expires ${day(p.subscription_expires_at)})` : 'none'}</td></tr>}
          {p.provider === 'twilio' && p.webhook_url && <tr><th>Incoming texts URL (set in Twilio)</th><td className="mono small">{p.webhook_url}</td></tr>}
          <tr><th>Last webhook event</th><td>{when(p.last_webhook_at)}</td></tr>
          <tr><th>Last text received</th><td>{when(p.last_received_at)}</td></tr>
          <tr><th>Last missed-text check</th><td>{when(p.last_reconcile_at)}</td></tr>
          <tr><th>Incoming queue</th><td>{p.events.pending || 0} waiting · {p.events.failed || 0} failed · {p.events.done || 0} processed</td></tr>
          {p.last_error && <tr><th>Last problem</th><td className="error small">{p.last_error} ({when(p.last_error_at)})</td></tr>}
        </tbody>
      </table>
      {error && <div className="error small">{error}</div>}
      {isAdmin ? (
        <div className="backfill-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => act('check')}>Check connection</button>
          {p.enabled ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => act('disconnect')}>Disconnect {name}</button>
          ) : (
            <button type="button" disabled={busy} onClick={() => act('connect')}>Reconnect {name}</button>
          )}
          <span className="muted small">Credentials are set in Railway, never here.</span>
        </div>
      ) : (
        <p className="muted small">Only admins can check, disconnect or reconnect SMS.</p>
      )}
    </section>
  );
}
