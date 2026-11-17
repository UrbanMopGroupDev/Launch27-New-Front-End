// Support settings → Channels → Text messages: the RingCentral SMS connection.
// Credentials live in Railway (never on this screen); admins can check, disconnect and reconnect.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { inbox, type ChannelStatus } from './api';
import { ago, displayIdentity } from './util';

const when = (iso: string | null) => (iso ? ago(iso) : 'never');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export function SmsPanel({ sms, isAdmin }: { sms: ChannelStatus['sms']; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rc = sms.ringcentral;
  const act = async (a: 'check' | 'disconnect' | 'connect') => {
    if (a === 'disconnect' && !window.confirm('Disconnect SMS? Texts will not be sent or received until an admin reconnects. Texts that arrive meanwhile are picked up when you reconnect.')) return;
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['inbox', 'channels'], await inbox.smsAction(a));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!rc) {
    return (
      <section className="channel-block">
        <h3>Text messages</h3>
        <p className="small">
          {sms.state === 'sandbox' ? (
            <><span className="wl-pill wl-refused">Sandbox</span> This is a test environment: texts are recorded on the conversation but never sent. Use the Channel simulator for incoming texts.</>
          ) : (
            <><span className="wl-pill wl-blocked">Not connected</span> RingCentral SMS isn't set up here: replies are saved, not sent. An admin sets the RINGCENTRAL_SMS_* variables in Railway (docs/sms.md).</>
          )}
        </p>
      </section>
    );
  }

  const status = !rc.enabled ? { cls: 'wl-blocked', label: 'Disconnected' } : sms.state === 'sandbox' ? { cls: 'wl-refused', label: 'Sandbox' } : rc.health_ok ? { cls: 'wl-done', label: 'Connected' } : { cls: 'wl-on', label: 'Needs attention' };
  const h = rc.health;
  return (
    <section className="channel-block">
      <h3>Text messages <span className="muted small">· RingCentral</span></h3>
      <p className="small">
        <span className={`wl-pill ${status.cls}`}>{status.label}</span>{' '}
        {!rc.enabled
          ? 'Texts are not being sent or received. Reconnect to start again; texts that arrived meanwhile are picked up.'
          : sms.state === 'sandbox'
            ? 'Connected to the RingCentral sandbox. Replies are recorded here, never sent.'
            : rc.health_ok
              ? 'Agents can send and receive texts from the numbers below.'
              : 'RingCentral is set up but not ready to send. See the problem below.'}
      </p>
      {h && (
        <p className="muted small">
          Extension {h.extension.number || h.extension.id}{h.extension.name ? ` (${h.extension.name})` : ''}{h.account_id ? ` · account ${h.account_id}` : ''} · checked {when(rc.last_health_at)}
        </p>
      )}
      <table className="table wl-table">
        <thead><tr><th>Business number</th><th>Can send</th><th>New texts go to</th></tr></thead>
        <tbody>
          {rc.numbers.map((n) => (
            <tr key={n.number}>
              <td>{displayIdentity(n.number)}</td>
              <td>{n.can_send ? <span className="wl-pill wl-done">Yes</span> : <span className="wl-pill wl-on">No: not SMS-enabled on this extension</span>}</td>
              <td>{n.queue}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {h?.missing_scopes.length ? <p className="error small">The RingCentral app is missing permissions: {h.missing_scopes.join(', ')}. Add them in the RingCentral developer console.</p> : null}
      <table className="table wl-table backfill-kv">
        <tbody>
          <tr><th>Receiving</th><td>{rc.receiving}</td></tr>
          <tr><th>Webhook subscription</th><td>{rc.has_subscription ? `active, renews automatically (expires ${day(rc.subscription_expires_at)})` : 'none'}</td></tr>
          <tr><th>Last webhook event</th><td>{when(rc.last_webhook_at)}</td></tr>
          <tr><th>Last text received</th><td>{when(rc.last_received_at)}</td></tr>
          <tr><th>Last missed-text check</th><td>{when(rc.last_reconcile_at)}</td></tr>
          <tr><th>Incoming queue</th><td>{rc.events.pending || 0} waiting · {rc.events.failed || 0} failed · {rc.events.done || 0} processed</td></tr>
          {rc.last_error && <tr><th>Last problem</th><td className="error small">{rc.last_error} ({when(rc.last_error_at)})</td></tr>}
        </tbody>
      </table>
      {error && <div className="error small">{error}</div>}
      {isAdmin ? (
        <div className="backfill-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => act('check')}>Check connection</button>
          {rc.enabled ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => act('disconnect')}>Disconnect SMS</button>
          ) : (
            <button type="button" disabled={busy} onClick={() => act('connect')}>Reconnect SMS</button>
          )}
          <span className="muted small">Credentials are set in Railway, never here.</span>
        </div>
      ) : (
        <p className="muted small">Only admins can check, disconnect or reconnect SMS.</p>
      )}
    </section>
  );
}
