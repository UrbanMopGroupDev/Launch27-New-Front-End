// Slack source connector (read-only): refund and reimbursement decisions posted in the
// finance channels. Needs SLACK_BOT_TOKEN for a Slack app with channels:history,
// groups:history and users:read, invited to each channel (they're private). Only reads.

export const DEFAULT_CHANNELS = {
  C04469ZQMC1: 'finance-refunds',
  C06JZHD9G83: 'finance-operations-collaboration',
  C049WH1FRSL: 'finance-charges',
};

export function createSlackClient({ token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function get(method, params) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 && attempt < 5) {
        await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(`Slack ${method} failed: ${body.error || res.status}`);
      return body;
    }
  }
  const names = new Map();
  return {
    async *history(channel, { oldest, latest }) {
      let cursor;
      do {
        const body = await get('conversations.history', { channel, oldest: String(oldest), latest: String(latest), limit: '200', ...(cursor ? { cursor } : {}) });
        for (const m of body.messages || []) yield m;
        cursor = body.response_metadata?.next_cursor || null;
      } while (cursor);
    },
    async userName(id) {
      if (!id) return null;
      if (!names.has(id)) {
        const u = await get('users.info', { user: id }).catch(() => null);
        names.set(id, u?.user?.real_name || u?.user?.profile?.real_name || u?.user?.name || null);
      }
      return names.get(id);
    },
    permalink: (channel, ts) => `slack:${channel}:${ts}`,
  };
}
