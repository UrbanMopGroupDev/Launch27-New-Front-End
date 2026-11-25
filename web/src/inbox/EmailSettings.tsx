// Email settings agents and admins change themselves: my signature (added to the end of every
// email I send) and the sender name customers see on our emails.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox } from './api';
import { SignaturePreview } from './signature';

export function MySignature() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inbox', 'signature'], queryFn: inbox.signature });
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: string) => inbox.saveSignature(body),
    onSuccess: (r) => {
      qc.setQueryData(['inbox', 'signature'], r);
      setText(null);
    },
  });
  if (!q.data) return <div className="muted">Loading…</div>;
  const value = text ?? q.data.body;
  const dirty = text !== null && text !== q.data.body;
  return (
    <section className="card">
      <h3>My email signature</h3>
      <p className="muted small">Added to the end of every email you send from the inbox. Write <b>**bold**</b> for bold and <b>[text](https://address)</b> for a link (web, mailto: or tel:).</p>
      <textarea className="full" rows={5} value={value} onChange={(e) => setText(e.target.value)} aria-label="My email signature" />
      <div className="muted small" style={{ margin: '8px 0 4px' }}>How it looks</div>
      <SignaturePreview text={value} />
      <div className="backfill-actions">
        <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate(value)}>Save signature</button>
        {q.data.custom && <button type="button" className="secondary" disabled={save.isPending} onClick={() => save.mutate('')}>Use the default</button>}
        {!q.data.custom && <span className="muted small">Using the default: your name and the business.</span>}
      </div>
      {save.isError && <div className="error small">{(save.error as Error).message}</div>}
    </section>
  );
}

export function SenderName({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const wf = useQuery({ queryKey: ['inbox', 'workforce'], queryFn: inbox.workforce });
  const current = wf.data?.settings.email_from_name ?? '';
  const [name, setName] = useState(current);
  useEffect(() => setName(current), [current]);
  const save = useMutation({ mutationFn: () => inbox.saveSettings({ email_from_name: name }), onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }) });
  return (
    <div className="policy-row">
      <div className="grow">
        <div className="strong">Sender name</div>
        <div className="muted small">What customers see as the sender of our emails, e.g. "UrbanMop Residential". Empty: the server's default.</div>
      </div>
      <input value={name} disabled={!canEdit} maxLength={60} placeholder="UrbanMop" onChange={(e) => setName(e.target.value)} aria-label="Sender name" />
      {canEdit && <button type="button" className="secondary" disabled={name === current || save.isPending} onClick={() => save.mutate()}>Save</button>}
      {save.isError && <div className="error small">{(save.error as Error).message}</div>}
    </div>
  );
}
