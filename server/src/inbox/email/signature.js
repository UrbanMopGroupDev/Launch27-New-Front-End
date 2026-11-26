// Email signatures are written in a small, safe format: **bold** and [link text](address),
// one line per line. The address may be a web page (http/https), an email (mailto:) or a
// phone number (tel:); anything else stays plain text. Everything else is escaped, so a
// signature can never inject HTML into an email.

const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML for an email body (escaped), with line breaks kept. */
export function textToHtml(text) {
  return esc(text).replace(/\r?\n/g, '<br>');
}

/** The signature as HTML: bold, links, line breaks. */
export function signatureHtml(md) {
  const parts = [];
  let last = 0;
  for (const m of String(md || '').matchAll(LINK)) {
    parts.push(bold(esc(md.slice(last, m.index))));
    parts.push(`<a href="${esc(m[2])}" target="_blank">${bold(esc(m[1]))}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(bold(esc(String(md || '').slice(last))));
  return parts.join('').replace(/\r?\n/g, '<br>');
}
const bold = (html) => html.replace(BOLD, '<strong>$1</strong>');

/** The signature as plain text: "text (address)" for a link unless the text already says it. */
export function signatureText(md) {
  return String(md || '')
    .replace(LINK, (_, text, href) => {
      const bare = href.replace(/^(https?:\/\/|mailto:|tel:)/, '').replace(/\/$/, '');
      return bare.toLowerCase() === text.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase() ? text : `${text} (${href})`;
    })
    .replace(BOLD, '$1');
}
