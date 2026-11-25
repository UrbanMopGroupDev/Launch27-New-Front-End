import { Fragment, type ReactNode } from 'react';

// Signatures are written with **bold** and [link text](address), one line per line. The same
// rules as the server (server/src/inbox/email/signature.js): only http(s), mailto: and tel:
// addresses become links; everything else shows as typed. Rendered as React elements, so
// nothing typed is ever treated as HTML.
const TOKEN = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)|\*\*([^*\n]+)\*\*/g;

function line(text: string, key: number): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<a key={i++} href={m[2]} target="_blank" rel="noreferrer">{boldIn(m[1])}</a>);
    else out.push(<strong key={i++}>{m[3]}</strong>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment key={key}>{out}</Fragment>;
}
const boldIn = (t: string) => {
  const m = /^\*\*([^*]+)\*\*$/.exec(t);
  return m ? <strong>{m[1]}</strong> : t;
};

export function SignaturePreview({ text }: { text: string }) {
  const lines = text.split('\n');
  return <div className="sig-preview">{lines.map((l, i) => <Fragment key={i}>{line(l, i)}{i < lines.length - 1 && <br />}</Fragment>)}</div>;
}
