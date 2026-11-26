// Complaint Resolution Engine, Phase 1: mine the history into complaint cases.
// A run (admin-started, in-process, read-only on every source):
//   1. Launch27 visits from the nightly 12-month snapshot (Residential locations only)
//   2. Kustomer complaint objects + their conversations       (KUSTOMER_API_KEY)
//   3. Unhappy Launch27 ratings with a comment                 (snapshot)
//   4. info@ emails that read as complaints                    (Gmail service account)
//   5. Refund / reimbursement posts in the finance channels    (SLACK_BOT_TOKEN)
//   then per case: classify (rules + Claude on redacted text), link the booking, add
//   refunds / recleans / credits as costs, the client's journey, and outcomes at 30/60/90.
// Sources that aren't configured are skipped and reported, never faked.
import { many, one, json } from '../db/index.js';
import { indexVisits } from '../reports/compute.js';
import { frequencyKind } from '../schedule/rules.js';
import { normalizeEmail, normalizePhone } from '../inbox/normalize.js';
import { parseGmailMessage } from '../inbox/email/mime.js';
import { classifyRules, mergeClassification, amountsIn } from './taxonomy.js';
import { redact } from './redact.js';
import { journeyAt, outcomeAt, oneTimeOutcomeAt, cleanerStatsIndex, recleanCost, unitEconomics } from './journey.js';
import { normalizeSettings, rungForRefund } from './settings.js';
import { parseRefundPost } from './slackRefunds.js';
import { createKustomerClient, discover, listComplaints, toCase as kustomerToCase, customer as kustomerCustomer, conversationsAround } from './sources/kustomer.js';
import { createSlackClient, DEFAULT_CHANNELS } from './sources/slack.js';
import { buildPlaybook, buildClients } from './playbook.js';

const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const nameKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const SOURCE_RANK = { kustomer: 0, ops_inbox: 1, gmail: 2, launch27_rating: 3, slack: 4, manual: 5 };
const RECLEAN_RE = /\b(re-?clean|return (clean|visit)|come back|send (someone|a cleaner|the team) back|redo)\b/i;
const CREDIT_RE = /\$\s?(\d{1,3})(?:\.\d{2})?\s*(?:off|credit|discount)\b|\bcredit(?:ed)?\s*(?:of\s*)?\$\s?(\d{1,3})/i;

const CLASSIFY_CONCURRENCY = 6;
// Run fn over items with at most n in flight.
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const suggestBrand = (name) => {
  const n = String(name || '').toLowerCase();
  if (/commercial|cornwall/.test(n)) return 'commercial';
  if (/ottawa|kitchener|waterloo|carpet/.test(n)) return 'residential';
  return null;
};

export function createComplaints({ db, config, reports, fetchImpl = fetch, gmail = null, classifier = null, l27 = null, syncBearer = null, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  let running = null;

  async function getSettings() {
    const row = await one(db, 'SELECT data FROM complaint_settings WHERE id = 1');
    return normalizeSettings(row?.data || {});
  }
  async function saveSettings(data, userId) {
    const s = normalizeSettings(data);
    await db.query('INSERT INTO complaint_settings (id, data, updated_by, updated_at) VALUES (1, $1::jsonb, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()', [json(s), userId || null]);
    return s;
  }

  const sources = () => ({
    kustomer: config.kustomerApiKey ? 'connected' : 'not set up (KUSTOMER_API_KEY)',
    slack: config.slackBotToken ? 'connected' : 'not set up (SLACK_BOT_TOKEN)',
    gmail: gmail ? `connected (${gmail.accounts.join(', ')})` : 'not connected in this environment',
    launch27: config.l27Mode === 'mock' ? 'synthetic data' : config.l27SyncEmail ? 'connected (nightly 12-month sync)' : 'connected (uses your Launch27 login when you run it)',
    claude: classifier ? 'on (redacted text only)' : 'off (ANTHROPIC_API_KEY not set): rules only',
  });

  async function kustomerDiscover() {
    if (!config.kustomerApiKey) throw Object.assign(new Error('KUSTOMER_API_KEY is not set'), { status: 409 });
    const client = createKustomerClient({ apiKey: config.kustomerApiKey, fetchImpl });
    return discover(client, { klass: config.kustomerComplaintKlass });
  }

  // ---------- the run ----------
  // bearer: the Launch27 login of the admin who started the run. Used when there's no
  // L27_SYNC_EMAIL service login (production today), the same way "Refresh now" works.
  async function run({ from, to, userId = null, bearer = null, label = null, refreshFrom = null }) {
    const runRow = await one(db, 'INSERT INTO complaint_runs (started_by, window_from, window_to) VALUES ($1,$2,$3) RETURNING id', [userId, from, to]);
    const runLog = [];
    const note = (level, msg, extra = {}) => {
      runLog.push({ at: new Date(now()).toISOString(), level, msg, ...extra });
      // Saved as it goes, so the page can show progress while a run is going.
      db.query('UPDATE complaint_runs SET log = $2::jsonb WHERE id = $1', [runRow.id, json(runLog)]).catch(() => {});
      log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`complaints: ${msg}`, extra);
    };
    try {
      if (label) note('info', label);
      const settings = await getSettings();
      const ctx = await loadContext(note, bearer);
      const staffNames = (await many(db, 'SELECT name FROM users WHERE name IS NOT NULL')).map((r) => r.name);
      const guarded = async (label, fn) => {
        try {
          return await fn();
        } catch (err) {
          note('error', `${label} skipped: ${err.message}`);
          return [];
        }
      };
      // Each source is classified and saved as soon as it's read, so a run that's cut off
      // (a release restarts the app) keeps every source it finished.
      let saved = 0;
      const save = async (label, cases) => {
        // info@ is mostly not complaints: the free keyword rules screen it first, and only
        // emails that read as a complaint go to Claude.
        // Already read on an earlier run? Reuse what Claude (or a person) decided then, and skip
        // emails already judged not to be complaints. Daily updates re-read the last two weeks,
        // so this is what keeps them quick and cheap.
        const ids = cases.map((c) => c.source_id);
        const src = cases[0]?.source;
        const known = new Map(!ids.length ? [] : (await many(db, "SELECT source_id, category, tone, severity, areas_cited, hard_route, summary, classified_by, classifier_confidence FROM complaint_cases WHERE source = $1 AND source_id = ANY($2::text[]) AND classified_by IN ('claude', 'human')", [src, ids])).map((r) => [r.source_id, r]));
        const notComplaints = new Set(!ids.length ? [] : (await many(db, "SELECT source_id FROM complaint_source_items WHERE source = $1 AND source_id = ANY($2::text[]) AND kind = 'not_complaint'", [src, ids])).map((r) => r.source_id));
        const fresh = cases.filter((c) => !notComplaints.has(c.source_id));
        const work = fresh
          .map((c) => ({ c, rules: classifyRules(c.text, { claimAmount: c.claim_amount }) }))
          .filter(({ c, rules }) => known.has(c.source_id) || c.source !== 'gmail' || rules.category !== 'other' || rules.tone !== 'mild');
        const screened = cases.length - work.length;
        let reused = 0;
        // Classify several at a time (Claude calls are the slow part), then save in order.
        await pool(work, CLASSIFY_CONCURRENCY, async (w) => {
          const k = known.get(w.c.source_id);
          if (k) {
            reused++;
            w.c.cls = { category: k.category, tone: k.tone, severity: k.severity, areas: k.areas_cited || [], hard_route: k.hard_route || w.rules.hard_route, summary: k.summary, classified_by: k.classified_by, confidence: k.classifier_confidence };
            return;
          }
          const model = classifier && w.c.text ? await classifier(redact(w.c.text, { names: [w.c.customer_name, ...(w.c.cleaner_names || []), ...staffNames] })) : null;
          w.c.cls = mergeClassification(w.rules, model);
          w.skip = w.c.source === 'gmail' && ((model && model.is_complaint === false) || (!model && (w.c.cls.category === 'other' || w.c.cls.tone === 'mild')));
          // Remember emails Claude read and found not to be complaints, so they aren't sent again.
          if (w.skip && model) await db.query("INSERT INTO complaint_source_items (source, source_id, occurred_at, kind) VALUES ($1, $2, $3, 'not_complaint') ON CONFLICT (source, source_id) DO NOTHING", [w.c.source, w.c.source_id, w.c.opened_at]).catch(() => {});
        });
        let kept = 0;
        for (const w of work) {
          if (w.skip) continue;
          w.c.id = await upsertCase(w.c);
          kept++;
        }
        saved += kept;
        note('info', `${label}: ${kept} complaint case${kept === 1 ? '' : 's'} saved${screened ? ` (${screened} screened out as not complaints)` : ''}${reused ? `, ${reused} already classified` : ''}`);
      };

      if (config.kustomerApiKey) await save('Kustomer', await guarded('Kustomer', () => fromKustomer(from, to, ctx, note)));
      else note('warn', 'Kustomer skipped: KUSTOMER_API_KEY is not set');
      const ratings = fromRatings(from, to, ctx);
      note('info', `Launch27 unhappy ratings: ${ratings.length}`);
      await save('Launch27 ratings', ratings);
      if (gmail) await save('info@ email', await guarded('info@ email', () => fromGmail(from, to, ctx, note)));
      else note('warn', 'info@ email skipped: Gmail is not connected in this environment');
      await markDuplicates();

      if (config.slackBotToken) await guarded('Slack', () => fromSlack(from, to, ctx, note));
      else note('warn', 'Slack refund history skipped: SLACK_BOT_TOKEN is not set');

      await enrich(refreshFrom && refreshFrom < from ? refreshFrom : from, to, ctx, settings, note);
      // 'partial': it finished, but a source failed (shown on the page with the reason).
      const status = runLog.some((l) => l.level === 'error') ? 'partial' : 'done';
      await db.query('UPDATE complaint_runs SET finished_at = now(), status = $3, log = $2::jsonb WHERE id = $1', [runRow.id, json(runLog), status]);
      return { run_id: Number(runRow.id), cases: saved };
    } catch (err) {
      note('error', `run failed: ${err.message}`);
      await db.query("UPDATE complaint_runs SET finished_at = now(), status = 'failed', log = $2::jsonb WHERE id = $1", [runRow.id, json(runLog)]);
      throw err;
    }
  }

  async function loadContext(note, userBearer = null) {
    let snap;
    try {
      snap = await reports.visitsSnapshot();
    } catch (err) {
      // No Launch27 history yet (no nightly sync login): build it now with the runner's login.
      if (!userBearer || err.status !== 409) throw err;
      note('info', 'Launch27 history not built yet: building it now with your Launch27 login (a few minutes)');
      await reports.sync({ bearer: userBearer });
      snap = await reports.visitsSnapshot();
    }
    const overrides = new Map((await many(db, 'SELECT location_id, brand FROM brand_locations')).map((r) => [Number(r.location_id), r.brand]));
    const brandOf = (v) => (overrides.has(Number(v.location_id)) ? overrides.get(Number(v.location_id)) : suggestBrand(v.location_name));
    const visits = snap.visits.filter((v) => brandOf(v) === 'residential' && !v.partner_kind);
    note('info', `Launch27 snapshot: ${visits.length} Residential visits, ${snap.from} to ${snap.to}`);
    const byCustomer = indexVisits(visits);
    const byName = new Map();
    for (const [id, list] of byCustomer) {
      const k = nameKey(list[list.length - 1].customer);
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(id);
    }
    const bearer = (syncBearer ? await syncBearer().catch(() => null) : null) || userBearer;
    if (!bearer) note('warn', 'No Launch27 login for lookups: clients are matched by name only and Launch27 refund amounts are skipped');
    return { snap, visits, byCustomer, byName, bearer, cleanerStatsAt: cleanerStatsIndex(visits), econ: unitEconomics(visits, now() - 90 * DAY) };
  }

  const customerByName = (ctx, name) => {
    const ids = ctx.byName.get(nameKey(name));
    return ids && ids.size === 1 ? [...ids][0] : null; // ambiguous names are left unlinked
  };
  async function customerByEmail(ctx, emails = [], phones = []) {
    if (!l27 || !ctx.bearer) return null;
    for (const [kind, v] of [...emails.map((e) => ['email', e]), ...phones.map((p) => ['phone', p])]) {
      const found = await l27.identify(ctx.bearer, kind, v);
      if (found?.l27_customer_id) return Number(found.l27_customer_id);
    }
    return null;
  }

  // ---------- sources ----------
  async function fromKustomer(from, to, ctx, note) {
    const client = createKustomerClient({ apiKey: config.kustomerApiKey, fetchImpl });
    const found = await discover(client, { klass: config.kustomerComplaintKlass });
    if (!found.complaint_klass) {
      note('error', `Kustomer: no complaint object type found. Types: ${found.klasses.map((k) => k.name).join(', ')}. Set KUSTOMER_COMPLAINT_KLASS.`);
      return [];
    }
    if (!found.listing) {
      note('error', `Kustomer: couldn't list "${found.complaint_klass}" records. ${found.attempts.map((a) => `${a.label}: ${a.error}`).join(' | ')}`);
      return [];
    }
    const out = [];
    const custCache = new Map();
    for await (const ko of listComplaints(client, found.listing, { from, to })) {
      const c = kustomerToCase(ko);
      if (c.kustomer_customer_id && !custCache.has(c.kustomer_customer_id)) custCache.set(c.kustomer_customer_id, await kustomerCustomer(client, c.kustomer_customer_id).catch(() => null));
      const cust = custCache.get(c.kustomer_customer_id) || null;
      const convs = c.kustomer_customer_id ? await conversationsAround(client, c.kustomer_customer_id, c.opened_at, { ids: c.kustomer_conversation_ids }).catch(() => []) : [];
      const msgs = convs.flatMap((v) => v.messages.map((m) => ({ ...m, conv: v.id, conv_channel: v.channel })));
      const inbound = msgs.filter((m) => m.direction === 'in');
      const firstIn = inbound[0]?.at || c.opened_at;
      const firstOut = msgs.find((m) => m.direction === 'out' && m.at >= firstIn)?.at || null;
      let exchanges = 0;
      for (let i = 1; i < msgs.length; i++) if (msgs[i].direction !== msgs[i - 1].direction) exchanges++;
      out.push({
        ...c,
        customer_name: cust?.name || null,
        customer_email: normalizeEmail(cust?.emails?.[0]),
        customer_phone: normalizePhone(cust?.phones?.[0]),
        emails: cust?.emails || [],
        phones: cust?.phones || [],
        channel: convs[0]?.channel || null,
        first_response_at: firstOut,
        exchanges,
        // Customer side first (the complaint), then our replies (what we offered).
        text: [c.text, inbound.map((m) => m.text).join('\n'), '--- our replies ---', msgs.filter((m) => m.direction === 'out').map((m) => m.text).join('\n')].filter(Boolean).join('\n'),
        our_replies: msgs.filter((m) => m.direction === 'out').map((m) => m.text).join('\n'),
      });
    }
    note('info', `Kustomer: ${out.length} complaint objects (${found.complaint_klass}, ${found.listing.label})`);
    for (const c of out) c.l27_customer_id = c.l27_customer_id || (await customerByEmail(ctx, c.emails, c.phones)) || customerByName(ctx, c.customer_name);
    return out;
  }

  function fromRatings(from, to, ctx) {
    const out = [];
    for (const v of ctx.visits) {
      if (!v.rating || v.rating.r !== 0 || !v.rating.comment || v.date < from || v.date > to) continue;
      out.push({
        source: 'launch27_rating',
        source_id: String(v.id),
        opened_at: v.rating.at || new Date(v.at + 6 * 3_600_000).toISOString(),
        channel: 'review',
        status: 'open',
        customer_name: v.customer,
        l27_customer_id: v.customer_id,
        l27_booking_id: v.id,
        l27_team_ids: v.teams.map((t) => t.id),
        cleaner_names: v.teams.map((t) => t.name),
        service_date: v.date,
        text: v.rating.comment,
        raw: { rating: v.rating.r },
      });
    }
    return out;
  }

  // info@ in month-long windows: one Gmail search over six months timed out on production.
  // A slow search is retried once, a slow or unreadable message is skipped and counted, and
  // one bad month doesn't lose the others.
  async function fromGmail(from, to, ctx, note) {
    const terms = '-from:urbanmop.ca -from:launch27.com -from:kustomerapp.com -category:promotions (refund OR complaint OR disappointed OR unhappy OR "not happy" OR missed OR "not clean" OR dirty OR reclean OR "re-clean" OR damaged OR broken OR late OR "no show" OR unacceptable)';
    const gday = (ms) => isoDay(ms).replace(/-/g, '/');
    const windows = [];
    for (let a = Date.parse(from); a <= Date.parse(to); a += 31 * DAY) windows.push([a, Math.min(a + 31 * DAY, Date.parse(to) + DAY)]);
    const retry = async (fn) => {
      try {
        return await fn();
      } catch {
        return fn();
      }
    };
    const out = [];
    let skipped = 0;
    let failedWindows = 0;
    for (const account of gmail.accounts.filter((a) => /^info@/.test(a))) {
      const seenThreads = new Set();
      for (const [a, b] of windows) {
        const q = `after:${gday(a)} before:${gday(b)} ${terms}`;
        try {
          let pageToken = null;
          let n = 0;
          do {
            const page = await retry(() => gmail.client.search(account, q, { max: 100, pageToken }));
            for (const id of page.ids) {
              let m;
              try {
                m = parseGmailMessage(await retry(() => gmail.client.message(account, id)));
              } catch {
                skipped++;
                continue;
              }
              if (m.autoSubmitted || !m.from || seenThreads.has(m.threadId)) continue;
              seenThreads.add(m.threadId);
              out.push({
                source: 'gmail',
                source_id: `${account}:${m.threadId}`,
                opened_at: (m.date || new Date()).toISOString(),
                channel: 'email',
                status: 'resolved',
                customer_name: m.fromName,
                customer_email: m.from,
                emails: [m.from],
                text: [m.subject, m.body].filter(Boolean).join('\n'),
                raw: { subject: m.subject },
              });
              n++;
            }
            pageToken = page.next;
          } while (pageToken && n < 1000);
        } catch (err) {
          failedWindows++;
          note('warn', `info@ email: ${gday(a)}–${gday(b)} skipped (${err.message})`);
        }
      }
    }
    note('info', `info@ email: ${out.length} candidate threads (Claude/rules keep only complaints)${skipped ? `, ${skipped} messages unreadable` : ''}${failedWindows ? `, ${failedWindows} month(s) skipped` : ''}`);
    const byEmail = new Map();
    for (const c of out) {
      if (!byEmail.has(c.customer_email)) byEmail.set(c.customer_email, await customerByEmail(ctx, c.emails, []).catch(() => null));
      c.l27_customer_id = byEmail.get(c.customer_email);
    }
    return out;
  }

  async function fromSlack(from, to, ctx, note) {
    const slack = createSlackClient({ token: config.slackBotToken, fetchImpl });
    const oldest = Date.parse(from) / 1000 - 3 * 86400;
    const latest = Date.parse(to) / 1000 + 75 * 86400; // refunds get posted weeks after the clean
    let parsed = 0;
    let linked = 0;
    for (const [channel, label] of Object.entries(config.slackChannels || DEFAULT_CHANNELS)) {
      try {
        for await (const m of slack.history(channel, { oldest, latest: Math.min(latest, now() / 1000) })) {
          if (m.subtype && m.subtype !== 'thread_broadcast') continue;
          const p = parseRefundPost({ text: m.text, ts: m.ts, user_name: await slack.userName(m.user) });
          if (!p) continue;
          parsed++;
          const sourceId = slack.permalink(channel, m.ts);
          const caseId = ['complaint', 'damage', 'unknown'].includes(p.kind) ? await linkRefund(p, sourceId, ctx) : null;
          if (caseId) linked++;
          const { client_name: _omit, ...data } = p; // keep the name out of the raw-items table
          await db.query('INSERT INTO complaint_source_items (source, source_id, occurred_at, kind, case_id, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (source, source_id) DO UPDATE SET kind = EXCLUDED.kind, case_id = EXCLUDED.case_id, data = EXCLUDED.data', ['slack', sourceId, p.posted_at, p.kind, caseId, json({ ...data, channel: label })]);
        }
      } catch (err) {
        note('warn', `Slack #${label}: ${err.message} (is the bot invited to the channel?)`);
      }
    }
    note('info', `Slack: ${parsed} refund posts parsed, ${linked} linked to a complaint`);
  }

  // A refund post → the matching case (same client, complaint 45 days before to 7 after the
  // post), or a new Slack-only case when no other source saw the complaint.
  async function linkRefund(p, sourceId, ctx) {
    const custId = p.other_profile ? null : customerByName(ctx, p.client_name);
    const postedMs = Date.parse(p.posted_at);
    let caseRow = null;
    if (custId) {
      caseRow = await one(db, `SELECT id, l27_booking_id FROM complaint_cases WHERE l27_customer_id = $1 AND merged_into IS NULL AND opened_at BETWEEN $2 AND $3 ORDER BY abs(extract(epoch FROM opened_at - $4::timestamptz)) LIMIT 1`, [custId, new Date(postedMs - 45 * DAY).toISOString(), new Date(postedMs + 7 * DAY).toISOString(), p.service_date || p.posted_at]);
    }
    if (!caseRow) {
      const visit = custId && p.service_date ? (ctx.byCustomer.get(custId) || []).find((v) => v.date === p.service_date) : null;
      const rules = classifyRules(p.reason || '', { claimAmount: p.amount });
      const id = await upsertCase({
        source: 'slack',
        source_id: sourceId,
        opened_at: p.service_date ? new Date(Date.parse(p.service_date) + DAY).toISOString() : p.posted_at,
        channel: 'slack',
        status: 'resolved',
        customer_name: p.client_name,
        l27_customer_id: custId,
        l27_booking_id: visit?.id || null,
        l27_team_ids: visit ? visit.teams.map((t) => t.id) : [],
        service_date: p.service_date,
        text: p.reason || '',
        cls: { ...rules, category: p.kind === 'damage' ? 'damage' : rules.category, hard_route: p.kind === 'damage' && p.amount > 100 ? 'damage_over_100' : rules.hard_route, classified_by: 'rules', confidence: 0.3 },
        handled_by: p.decided_by,
        raw: { from_refund_post: true },
      });
      caseRow = { id };
    }
    await db.query(
      `INSERT INTO complaint_resolutions (case_id, step, rung, action, pct, amount, offered_at, accepted, decided_by, approved_by, approval_ref, source, source_id)
       VALUES ($1, 9, $2, $3, $4, $5, $6, 'yes', $7, $8, $9, 'slack', $9)
       ON CONFLICT (source, source_id) DO UPDATE SET case_id = EXCLUDED.case_id, rung = EXCLUDED.rung, pct = EXCLUDED.pct, amount = EXCLUDED.amount`,
      [caseRow.id, p.kind === 'damage' ? null : rungForRefund(p.pct), p.kind === 'damage' ? 'damage_reimbursement' : 'refund', p.pct, p.amount, p.posted_at, p.decided_by, p.approved_by, sourceId],
    );
    if (p.amount) await addCost(caseRow.id, p.kind === 'damage' ? 'damage' : 'refund', p.amount, 'slack', sourceId);
    if (p.cleaner_recovery) await addCost(caseRow.id, 'cleaner_recovery', -p.cleaner_recovery, 'slack', sourceId);
    return caseRow.id;
  }

  // ---------- storage ----------
  async function upsertCase(c) {
    const cls = c.cls || {};
    const row = await one(
      db,
      `INSERT INTO complaint_cases (brand, source, source_id, customer_email, customer_phone, customer_name, l27_customer_id, l27_booking_id, l27_team_ids, service_date,
         opened_at, first_response_at, resolved_at, channel, status, source_status, category, severity, tone, areas_cited, hard_route, summary, handled_by,
         exchanges, classified_by, classifier_confidence, raw)
       VALUES ('residential',$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26::jsonb)
       ON CONFLICT (source, source_id) DO UPDATE SET
         customer_email = EXCLUDED.customer_email, customer_phone = EXCLUDED.customer_phone, customer_name = EXCLUDED.customer_name,
         l27_customer_id = COALESCE(EXCLUDED.l27_customer_id, complaint_cases.l27_customer_id), l27_booking_id = COALESCE(EXCLUDED.l27_booking_id, complaint_cases.l27_booking_id),
         l27_team_ids = EXCLUDED.l27_team_ids, service_date = COALESCE(EXCLUDED.service_date, complaint_cases.service_date), first_response_at = EXCLUDED.first_response_at,
         resolved_at = EXCLUDED.resolved_at, channel = EXCLUDED.channel, status = EXCLUDED.status, source_status = EXCLUDED.source_status,
         category = CASE WHEN complaint_cases.classified_by = 'human' THEN complaint_cases.category ELSE EXCLUDED.category END,
         severity = EXCLUDED.severity, tone = EXCLUDED.tone, areas_cited = EXCLUDED.areas_cited,
         hard_route = COALESCE(EXCLUDED.hard_route, complaint_cases.hard_route), summary = COALESCE(EXCLUDED.summary, complaint_cases.summary),
         exchanges = EXCLUDED.exchanges, classified_by = CASE WHEN complaint_cases.classified_by = 'human' THEN 'human' ELSE EXCLUDED.classified_by END,
         classifier_confidence = EXCLUDED.classifier_confidence, raw = EXCLUDED.raw, updated_at = now()
       RETURNING id`,
      [
        c.source, c.source_id, normalizeEmail(c.customer_email) || null, normalizePhone(c.customer_phone) || null, c.customer_name || null, c.l27_customer_id || null, c.l27_booking_id || null,
        json(c.l27_team_ids || []), c.service_date || null, c.opened_at, c.first_response_at || null, c.resolved_at || null, c.channel || null, c.status || 'open', c.source_status || null,
        cls.category || 'other', cls.severity || null, cls.tone || null, json(cls.areas || []), cls.hard_route || null, cls.summary || null, c.handled_by || null,
        c.exchanges ?? null, cls.classified_by || 'rules', cls.confidence ?? null, json({ ...(c.raw || {}), resolution_text: c.resolution_text || null, our_replies_excerpt: (c.our_replies || '').slice(0, 2000) || null }),
      ],
    );
    return Number(row.id);
  }

  // The same complaint seen in two sources (e.g. an unhappy rating and the Kustomer object):
  // same client, opened within 10 days. The richer source stays; the other points at it.
  async function markDuplicates() {
    const rows = await many(db, "SELECT id, source, l27_customer_id, opened_at FROM complaint_cases WHERE l27_customer_id IS NOT NULL ORDER BY l27_customer_id, opened_at");
    const updates = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length && rows[j].l27_customer_id === rows[i].l27_customer_id; j++) {
        if (Math.abs(new Date(rows[j].opened_at) - new Date(rows[i].opened_at)) > 10 * DAY) continue;
        const [keep, drop] = (SOURCE_RANK[rows[i].source] ?? 9) <= (SOURCE_RANK[rows[j].source] ?? 9) ? [rows[i], rows[j]] : [rows[j], rows[i]];
        if (keep.source !== drop.source || keep.source === 'launch27_rating') updates.push([drop.id, keep.id]);
      }
    }
    for (const [drop, keep] of updates) await db.query('UPDATE complaint_cases SET merged_into = $2 WHERE id = $1 AND id <> $2 AND merged_into IS NULL', [drop, keep]);
  }

  async function addCost(caseId, kind, amount, source, ref, estimated = false) {
    await db.query('INSERT INTO complaint_costs (case_id, kind, amount, source, source_ref, estimated) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (case_id, kind, source, source_ref) DO UPDATE SET amount = EXCLUDED.amount, estimated = EXCLUDED.estimated', [caseId, kind, amount, source, ref, estimated]);
  }

  // ---------- per-case enrichment ----------
  async function enrich(from, to, ctx, settings, note) {
    const rows = await many(db, `SELECT * FROM complaint_cases WHERE merged_into IS NULL AND opened_at >= $1 AND opened_at < $2::date + 1 ORDER BY opened_at`, [from, to]);
    const allCases = await many(db, 'SELECT id, l27_customer_id, opened_at FROM complaint_cases WHERE merged_into IS NULL');
    const todayMs = now();
    let refundsFound = 0;
    let recleans = 0;
    for (const c of rows) {
      const at = new Date(c.opened_at).getTime();
      const list = c.l27_customer_id ? ctx.byCustomer.get(Number(c.l27_customer_id)) || [] : [];
      // The booking complained about: given, or the client's last visit before the complaint.
      let visit = c.l27_booking_id ? list.find((v) => v.id === Number(c.l27_booking_id)) : null;
      if (!visit) visit = list.filter((v) => v.at < at && v.at > at - 21 * DAY).slice(-1)[0] || null;
      if (visit && !c.l27_booking_id) await db.query('UPDATE complaint_cases SET l27_booking_id = $2, service_date = COALESCE(service_date, $3), l27_team_ids = $4::jsonb WHERE id = $1', [c.id, visit.id, visit.date, json(visit.teams.map((t) => t.id))]);

      // Refunds recorded on the booking in Launch27 (the source of truth for money moved).
      if (visit && l27 && ctx.bearer && config.l27Mode !== 'mock') {
        const b = await l27Get(ctx.bearer, `/v1/staff/bookings/${visit.id}`).catch(() => null);
        const refunded = (b?.charges?.refunded || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
        if (refunded > 0) {
          refundsFound++;
          // Slack and Launch27 describe the same refund: keep the Launch27 amount.
          await db.query("DELETE FROM complaint_costs WHERE case_id = $1 AND kind = 'refund' AND source = 'slack'", [c.id]);
          await addCost(c.id, 'refund', Math.round(refunded * 100) / 100, 'launch27', `booking:${visit.id}`);
          const pct = visit.revenue ? Math.round((refunded / (visit.revenue + refunded)) * 100) : null;
          await db.query(
            `INSERT INTO complaint_resolutions (case_id, step, rung, action, pct, amount, accepted, source, source_id) VALUES ($1, 8, $2, 'refund', $3, $4, 'yes', 'launch27', $5)
             ON CONFLICT (source, source_id) DO UPDATE SET rung = EXCLUDED.rung, pct = EXCLUDED.pct, amount = EXCLUDED.amount`,
            [c.id, rungForRefund(pct), pct, refunded, `booking:${visit.id}`],
          );
        }
      }

      // Reclean: a $0 visit for the same client within 14 days after the complaint, or the
      // Kustomer status / our reply says so.
      const free = list.find((v) => v.at > at && v.at < at + 14 * DAY && (v.reclean || (v.revenue || 0) === 0));
      const mentioned = c.source_status && /reclean/i.test(c.source_status) || RECLEAN_RE.test(c.raw?.resolution_text || '') || RECLEAN_RE.test(c.raw?.our_replies_excerpt || '');
      if (free || mentioned) {
        recleans++;
        const t = free?.teams?.[0];
        const cost = recleanCost({ hours: free ? free.teams.reduce((s, x) => s + (x.hours || 0), 0) : null, cleanerHourly: t?.earned && t?.hours ? t.earned / t.hours : ctx.econ.cleanerHourly, marginPerHour: ctx.econ.marginPerHour }, settings.costs);
        const ref = free ? `booking:${free.id}` : `case:${c.id}`;
        await db.query(
          `INSERT INTO complaint_resolutions (case_id, step, rung, action, accepted, offered_at, source, source_id) VALUES ($1, 5, 'L3', $2, $3, $4, $5, $6)
           ON CONFLICT (source, source_id) DO NOTHING`,
          [c.id, free ? 'reclean_full' : 'reclean_spot', free ? 'yes' : 'unknown', free ? new Date(free.at).toISOString() : null, free ? 'launch27' : c.source, `reclean:${ref}`],
        );
        await addCost(c.id, 'reclean_labour', free && t?.earned != null ? free.teams.reduce((s, x) => s + (x.earned || 0), 0) : cost.labour, 'model', ref, !(free && t?.earned != null));
        await addCost(c.id, 'reclean_travel', cost.travel, 'model', ref, true);
        await addCost(c.id, 'reclean_lost_slot', cost.lost_slot, 'model', ref, true);
      }

      // Small credits written into our replies ("$10 off your next clean").
      const credit = String(c.raw?.our_replies_excerpt || '').match(CREDIT_RE);
      if (credit) {
        const amt = Number(credit[1] || credit[2]);
        if (amt > 0 && amt <= 100) {
          await db.query(
            `INSERT INTO complaint_resolutions (case_id, step, rung, action, amount, accepted, source, source_id) VALUES ($1, 3, $2, 'credit', $3, 'unknown', $4, $5) ON CONFLICT (source, source_id) DO NOTHING`,
            [c.id, amt <= 5 ? 'L1' : 'L2', amt, c.source, `credit:case:${c.id}`],
          );
          await addCost(c.id, 'credit', amt, c.source, `case:${c.id}`, true);
        }
      }

      // Damage claim amount from the complaint (when no refund post recorded one).
      if (c.category === 'damage' && c.hard_route === 'damage_over_100') {
        const has = await one(db, "SELECT 1 FROM complaint_costs WHERE case_id = $1 AND kind = 'damage'", [c.id]);
        const amt = Math.max(0, ...amountsIn(c.raw?.resolution_text || ''));
        if (!has && amt) await addCost(c.id, 'damage', amt, c.source, `case:${c.id}`, true);
      }

      // Journey and outcomes.
      const prior = allCases.filter((x) => Number(x.l27_customer_id) === Number(c.l27_customer_id) && x.id !== c.id).map((x) => ({ opened_at: new Date(x.opened_at).getTime() }));
      if (list.length) {
        const j = journeyAt(list, at, { priorCases: prior, cleanerStatsAt: ctx.cleanerStatsAt, dataFrom: ctx.snap.from, complainedVisitId: visit?.id ?? null });
        await db.query(
          `INSERT INTO complaint_journeys (case_id, tenure_days, frequency, cleans_total, spend_12m, price_change_pct, distinct_cleaners_90d, cleaner_changed_last_visit, prior_complaints, prior_unhappy_ratings,
             days_since_last_clean, cleaner_id, cleaner_name, cleaner_visits_before, cleaner_unhappy_rate_90d, data_from, computed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
           ON CONFLICT (case_id) DO UPDATE SET tenure_days = EXCLUDED.tenure_days, frequency = EXCLUDED.frequency, cleans_total = EXCLUDED.cleans_total, spend_12m = EXCLUDED.spend_12m,
             price_change_pct = EXCLUDED.price_change_pct, distinct_cleaners_90d = EXCLUDED.distinct_cleaners_90d, cleaner_changed_last_visit = EXCLUDED.cleaner_changed_last_visit,
             prior_complaints = EXCLUDED.prior_complaints, prior_unhappy_ratings = EXCLUDED.prior_unhappy_ratings, days_since_last_clean = EXCLUDED.days_since_last_clean,
             cleaner_id = EXCLUDED.cleaner_id, cleaner_name = EXCLUDED.cleaner_name, cleaner_visits_before = EXCLUDED.cleaner_visits_before,
             cleaner_unhappy_rate_90d = EXCLUDED.cleaner_unhappy_rate_90d, data_from = EXCLUDED.data_from, computed_at = now()`,
          [c.id, j.tenure_days, j.frequency, j.cleans_total, j.spend_12m, j.price_change_pct, j.distinct_cleaners_90d, j.cleaner_changed_last_visit, j.prior_complaints, j.prior_unhappy_ratings, j.days_since_last_clean, j.cleaner_id, j.cleaner_name, j.cleaner_visits_before, j.cleaner_unhappy_rate_90d, j.data_from],
        );
        const repeat = allCases.find((x) => Number(x.l27_customer_id) === Number(c.l27_customer_id) && x.id !== c.id && new Date(x.opened_at) > new Date(c.opened_at) && new Date(x.opened_at) - new Date(c.opened_at) <= 90 * DAY);
        // Recurring clients: still booking at 30/60/90 days. One-time clients: did they book
        // again within 90/120 days. Recleans and free visits don't count as coming back.
        const paid = list.filter((v) => !v.reclean && (v.revenue || 0) > 0);
        const kindVisit = visit || list.filter((v) => v.at < at).slice(-1)[0] || null;
        const oneTime = kindVisit ? kindVisit.kind === 'one' : false;
        const days = oneTime ? [90, 120] : [30, 60, 90];
        await db.query('DELETE FROM complaint_outcomes WHERE case_id = $1 AND NOT (day = ANY($2::int[]))', [c.id, days]);
        for (const day of days) {
          const o = oneTime ? oneTimeOutcomeAt(paid, at, day, { today: todayMs, repeatCaseId: repeat?.id || null }) : outcomeAt(paid, at, day, { today: todayMs, repeatCaseId: repeat?.id || null });
          await db.query(
            `INSERT INTO complaint_outcomes (case_id, day, still_booking, next_booking_on, last_booking_on, public_review_stars, public_review_platform, repeat_case_id, outcome, checked_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
             ON CONFLICT (case_id, day) DO UPDATE SET still_booking = EXCLUDED.still_booking, next_booking_on = EXCLUDED.next_booking_on, last_booking_on = EXCLUDED.last_booking_on,
               public_review_stars = EXCLUDED.public_review_stars, public_review_platform = EXCLUDED.public_review_platform, repeat_case_id = EXCLUDED.repeat_case_id, outcome = EXCLUDED.outcome, checked_at = now()`,
            [c.id, day, o.still_booking, o.next_booking_on, o.last_booking_on, o.public_review_stars, o.public_review_platform, o.repeat_case_id, o.outcome],
          );
        }
      }
    }
    note('info', `enriched ${rows.length} cases: ${refundsFound} with a Launch27 refund, ${recleans} recleans`);
  }

  async function l27Get(bearer, path) {
    const res = await fetchImpl(`${config.l27BaseUrl}${path}`, { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Launch27 ${path} returned ${res.status}`);
    return res.json();
  }

  // ---------- reads for the UI ----------
  function start({ from, to, userId, bearer = null }) {
    if (running) throw Object.assign(new Error('A run is already going'), { status: 409 });
    running = run({ from, to, userId, bearer }).catch((err) => ({ error: err.message })).finally(() => {
      running = null;
      chain(bearer);
    });
    return { started: true };
  }

  // ---------- automatic updates ----------
  // Nobody should have to click. Every day the engine re-reads the last two weeks (new
  // complaints, late refunds) and refreshes outcomes; until the history target is reached it
  // also reads one older month after another. State lives in the database (finished runs =
  // what's been read), so a release that restarts the app just means the next trigger picks
  // up where it stopped. It needs a Launch27 login: the L27_SYNC_EMAIL service login when
  // set (then the worker runs it overnight), otherwise the login of a supervisor or admin
  // who opens the Complaint playbook (then it runs the first time someone opens it each day).
  let heldBearer = null;
  let lastAutoAttempt = 0;
  const torontoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date(ms));
  async function nextAuto() {
    const settings = await getSettings();
    if (!settings.auto.enabled) return null;
    const today = torontoDay(now());
    const mined = await many(db, "SELECT window_from::text AS f, window_to::text AS t FROM complaint_runs WHERE status IN ('done', 'partial')");
    const recent = await one(db, "SELECT cursor FROM complaint_sync_state WHERE source = 'auto_recent'");
    return planAuto({ mined: mined.map((m) => ({ from: m.f.slice(0, 10), to: m.t.slice(0, 10) })), today, historyDays: Math.round(settings.auto.history_months * 30.44), recentDone: recent?.cursor || null });
  }
  async function maybeRun({ bearer = null } = {}) {
    if (running) return false;
    if (now() - lastAutoAttempt < 60_000) return false;
    const login = bearer || heldBearer || (syncBearer ? await syncBearer().catch(() => null) : null);
    if (!login) return false;
    const job = await nextAuto();
    if (!job) return false;
    // A job that keeps failing (not interrupted: failed) waits half an hour between tries.
    const lastFail = await one(db, "SELECT finished_at FROM complaint_runs WHERE status = 'failed' ORDER BY id DESC LIMIT 1");
    if (lastFail?.finished_at && now() - new Date(lastFail.finished_at).getTime() < 30 * 60_000) return false;
    if (running) return false;
    lastAutoAttempt = now();
    heldBearer = login;
    running = run({ from: job.from, to: job.to, bearer: login, label: job.label, refreshFrom: job.refreshFrom })
      .then(async (r) => {
        if (job.kind === 'recent') await db.query("INSERT INTO complaint_sync_state (source, cursor, last_run_at, last_ok_at) VALUES ('auto_recent', $1, now(), now()) ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, last_run_at = now(), last_ok_at = now()", [torontoDay(now())]);
        return r;
      })
      .catch((err) => ({ error: err.message }))
      .finally(() => {
        running = null;
        chain(login);
      });
    return true;
  }
  // After any run, look for the next piece of work a few seconds later (older history, or today's update).
  function chain(bearer) {
    if (bearer) heldBearer = bearer;
    const t = setTimeout(() => {
      lastAutoAttempt = 0;
      maybeRun().catch(() => {});
    }, 5_000);
    t.unref?.();
  }

  // A run lives in this process: a restart (every release) ends it. Called at startup, so a
  // run that was cut off shows as interrupted instead of running forever. Everything it saved stays.
  async function markInterrupted() {
    const r = await db.query("UPDATE complaint_runs SET status = 'interrupted', finished_at = now(), log = log || $1::jsonb WHERE status = 'running' RETURNING id", [json([{ at: new Date(now()).toISOString(), level: 'warn', msg: 'Interrupted: the app restarted (a release) before the run finished. Cases saved before then are kept; run again for the rest.' }])]);
    return r.rows.length;
  }

  async function status() {
    const last = await one(db, 'SELECT id, started_at, finished_at, status, window_from, window_to, log FROM complaint_runs ORDER BY id DESC LIMIT 1');
    // Which periods have been mined (finished runs), so the page can say what a date range covers.
    const mined = await many(db, "SELECT window_from, window_to, finished_at, status FROM complaint_runs WHERE status IN ('done', 'partial') ORDER BY window_from");
    const settings = await getSettings();
    const next = await nextAuto().catch(() => null);
    const recent = await one(db, "SELECT cursor, last_ok_at FROM complaint_sync_state WHERE source = 'auto_recent'");
    const hasSyncLogin = config.l27Mode === 'mock' || !!(config.l27SyncEmail && config.l27SyncPassword);
    const auto = { enabled: settings.auto.enabled, history_months: settings.auto.history_months, next, last_daily_update: recent?.last_ok_at || null, overnight: hasSyncLogin };
    return { running: !!running, sources: sources(), last_run: last, mined, auto };
  }

  async function listCases({ from, to, category, limit = 5000 }) {
    const params = [from || '2000-01-01', to || '2999-12-31'];
    let where = 'c.merged_into IS NULL AND c.excluded_at IS NULL AND c.opened_at >= $1 AND c.opened_at < $2::date + 1';
    if (category) {
      params.push(category);
      where += ` AND c.category = $${params.length}`;
    }
    params.push(Math.min(5000, Number(limit) || 5000));
    const rows = await many(
      db,
      `SELECT c.id, c.source, c.source_id, c.opened_at, c.service_date, c.customer_name, c.l27_customer_id, c.l27_booking_id, c.category, c.tone, c.severity, c.hard_route, c.summary, c.status, c.source_status, c.classified_by,
              (SELECT coalesce(sum(amount), 0) FROM complaint_costs k WHERE k.case_id = c.id) AS total_cost,
              (SELECT string_agg(DISTINCT coalesce(r.rung, r.action), ', ') FROM complaint_resolutions r WHERE r.case_id = c.id) AS rungs,
              (SELECT outcome FROM complaint_outcomes o WHERE o.case_id = c.id AND o.day = 60) AS outcome_60,
              (SELECT outcome FROM complaint_outcomes o WHERE o.case_id = c.id AND o.day = 120) AS outcome_120,
              j.tenure_days, j.cleaner_name, j.frequency
         FROM complaint_cases c LEFT JOIN complaint_journeys j ON j.case_id = c.id
        WHERE ${where} ORDER BY c.opened_at DESC LIMIT $${params.length}`,
      params,
    );
    const byId = await visitIndex();
    return rows.map(({ source_id, ...r }) => ({ ...r, original_url: gmailUrl(r.source, source_id), ...visitInfo(byId.get(Number(r.l27_booking_id)), r.frequency) }));
  }

  // Service type and client type of the visit complained about, from the Launch27 snapshot.
  let visitCache = null;
  async function visitIndex() {
    try {
      const snap = await reports.visitsSnapshot();
      if (!visitCache || visitCache.taken_at !== snap.taken_at) visitCache = { taken_at: snap.taken_at, byId: new Map(snap.visits.map((v) => [Number(v.id), v])) };
      return visitCache.byId;
    } catch {
      return new Map();
    }
  }
  function visitInfo(v, frequency = null) {
    const kind = v?.kind || (frequency ? frequencyKind(frequency) : null);
    return {
      client_type: kind == null ? null : kind === 'one' ? 'one_time' : 'recurring',
      service: v?.svc ? [v.svc, v.deep && 'Deep cleaning', v.move && 'Move in/out', v.reclean && 'Reclean'].filter(Boolean).join(' · ') : null,
    };
  }

  async function getCase(id) {
    const c = await one(db, 'SELECT * FROM complaint_cases WHERE id = $1', [id]);
    if (!c) return null;
    const [journey, resolutions, costs, outcomes, dupes] = await Promise.all([
      one(db, 'SELECT * FROM complaint_journeys WHERE case_id = $1', [id]),
      many(db, 'SELECT * FROM complaint_resolutions WHERE case_id = $1 ORDER BY step, offered_at', [id]),
      many(db, 'SELECT kind, amount, source, estimated FROM complaint_costs WHERE case_id = $1 ORDER BY kind', [id]),
      many(db, 'SELECT * FROM complaint_outcomes WHERE case_id = $1 ORDER BY day', [id]),
      many(db, 'SELECT id, source, opened_at FROM complaint_cases WHERE merged_into = $1', [id]),
    ]);
    const byId = await visitIndex();
    return { ...c, ...visitInfo(byId.get(Number(c.l27_booking_id)), journey?.frequency), journey, resolutions, costs, outcomes, also_seen_in: dupes };
  }

  async function setCategory(id, { category, hard_route }, userId) {
    await db.query("UPDATE complaint_cases SET category = COALESCE($2, category), hard_route = $3, classified_by = 'human', updated_at = now() WHERE id = $1", [id, category || null, hard_route || null]);
    await db.query("INSERT INTO audit_log (actor_id, action, object_type, object_id, detail) VALUES ($1, 'complaint.reclassified', 'complaint_case', $2, $3::jsonb)", [userId, String(id), json({ category, hard_route })]);
  }

  async function playbook({ from, to }) {
    const settings = await getSettings();
    const cases = await many(db, `SELECT j.*, c.id, c.source, c.opened_at, c.category, c.tone, c.severity, c.hard_route, c.first_response_at, c.exchanges, c.handled_by, c.l27_customer_id, c.l27_booking_id, c.classified_by
      FROM complaint_cases c LEFT JOIN complaint_journeys j ON j.case_id = c.id
      WHERE c.merged_into IS NULL AND c.excluded_at IS NULL AND c.opened_at >= $1 AND c.opened_at < $2::date + 1`, [from, to]);
    const ids = cases.map((c) => c.id);
    const [resolutions, costs, outcomes] = ids.length
      ? await Promise.all([
          many(db, 'SELECT case_id, rung, action, pct, amount, decided_by, approved_by FROM complaint_resolutions WHERE case_id = ANY($1::bigint[])', [ids]),
          many(db, 'SELECT case_id, kind, amount, estimated FROM complaint_costs WHERE case_id = ANY($1::bigint[])', [ids]),
          many(db, 'SELECT case_id, day, outcome FROM complaint_outcomes WHERE case_id = ANY($1::bigint[])', [ids]),
        ])
      : [[], [], []];
    let visits = [];
    try {
      const ctx = await loadContext(() => {});
      visits = ctx.visits;
    } catch {
      // Reports not built yet: the playbook still renders, without per-visit rates.
    }
    const byId = await visitIndex();
    for (const c of cases) c.one_time = visitInfo(byId.get(Number(c.l27_booking_id)), c.frequency).client_type === 'one_time';
    return buildPlaybook({ cases, resolutions, costs, outcomes, visits, from, to, settings, today: isoDay(now()) });
  }

  // Clients view: who complains repeatedly, and who looks at risk of leaving right now.
  async function clients() {
    const since = new Date(now() - 365 * DAY).toISOString();
    const rows = await many(db, `SELECT c.id, c.l27_customer_id, c.customer_name, c.opened_at, c.category, c.tone, c.severity, c.hard_route,
        (SELECT coalesce(sum(amount), 0) FROM complaint_costs k WHERE k.case_id = c.id) AS cost,
        (SELECT json_agg(json_build_object('day', o.day, 'outcome', o.outcome, 'next', o.next_booking_on)) FROM complaint_outcomes o WHERE o.case_id = c.id) AS outcomes,
        j.cleans_total, j.cleaner_changed_last_visit, j.price_change_pct, j.frequency, j.tenure_days
      FROM complaint_cases c LEFT JOIN complaint_journeys j ON j.case_id = c.id
      WHERE c.merged_into IS NULL AND c.excluded_at IS NULL AND c.l27_customer_id IS NOT NULL AND c.opened_at >= $1 ORDER BY c.opened_at`, [since]);
    return buildClients(rows, now());
  }


  // ---- Checking the taxonomy by hand ----
  // A random sample per category of cases nobody has checked yet. Message bodies aren't
  // stored, so the reviewer sees the one-line summary, the subject or title, the source's own
  // status and what we did, plus a link to the original where there is one.
  async function reviewQueue({ per = 20, category = null, source = null } = {}) {
    const rows = await many(
      db,
      `SELECT * FROM (
         SELECT c.id, c.source, c.source_id, c.l27_booking_id, c.opened_at, c.service_date, c.customer_name, c.category, c.tone, c.severity, c.hard_route, c.summary,
                c.source_status, c.classified_by, c.classifier_confidence, c.areas_cited, c.raw,
                (SELECT string_agg(DISTINCT coalesce(r.rung, r.action), ', ') FROM complaint_resolutions r WHERE r.case_id = c.id) AS rungs,
                row_number() OVER (PARTITION BY c.category ORDER BY random()) AS pick
           FROM complaint_cases c
          WHERE c.merged_into IS NULL AND c.excluded_at IS NULL AND c.classified_by <> 'human'
            AND NOT EXISTS (SELECT 1 FROM complaint_reviews v WHERE v.case_id = c.id)
            AND ($2::text IS NULL OR c.category = $2) AND ($3::text IS NULL OR c.source = $3)
       ) q WHERE pick <= $1 ORDER BY category, pick`,
      [Math.max(1, Math.min(100, Number(per) || 20)), category, source],
    );
    const byId = await visitIndex();
    return rows.map(({ raw, source_id, l27_booking_id, pick: _pick, ...c }) => ({
      ...c,
      // The client's own words where we already hold them: the Launch27 rating comment, or the
      // longest text field on the Kustomer complaint. Emails are opened from the link instead.
      text: (c.source === 'launch27_rating' ? byId.get(Number(l27_booking_id))?.rating?.comment : c.source === 'kustomer' ? longestText(raw?.custom) : null) || null,
      title: raw?.subject || raw?.title || null,
      resolution_text: raw?.resolution_text || null,
      rating: raw?.rating ?? null,
      original_url: gmailUrl(c.source, source_id),
    }));
  }

  async function reviewCase(id, { verdict, category = null, note = null }, userId) {
    const c = await one(db, 'SELECT id, category, classified_by FROM complaint_cases WHERE id = $1', [id]);
    if (!c) throw Object.assign(new Error('Not found'), { status: 404 });
    if (verdict === 'wrong_category' && category === c.category) verdict = 'correct';
    // Keep what the engine said the first time; a second look only changes the verdict.
    await db.query(
      `INSERT INTO complaint_reviews (case_id, reviewer_id, verdict, was_category, was_classified_by, now_category, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (case_id) DO UPDATE SET reviewer_id = EXCLUDED.reviewer_id, verdict = EXCLUDED.verdict, now_category = EXCLUDED.now_category, note = EXCLUDED.note, reviewed_at = now()`,
      [id, userId, verdict, c.category, c.classified_by, verdict === 'wrong_category' ? category : null, note ? String(note).slice(0, 500) : null],
    );
    if (verdict === 'wrong_category') await db.query("UPDATE complaint_cases SET category = $2, classified_by = 'human', excluded_at = NULL, updated_at = now() WHERE id = $1", [id, category]);
    else if (verdict === 'not_complaint') await db.query("UPDATE complaint_cases SET excluded_at = now(), classified_by = 'human', updated_at = now() WHERE id = $1", [id]);
    else await db.query("UPDATE complaint_cases SET classified_by = 'human', excluded_at = NULL, updated_at = now() WHERE id = $1", [id]);
    await db.query("INSERT INTO audit_log (actor_id, action, object_type, object_id, detail) VALUES ($1, 'complaint.reviewed', 'complaint_case', $2, $3::jsonb)", [userId, String(id), json({ verdict, category })]);
  }

  async function reviewStats() {
    const rows = await many(db, `SELECT v.verdict, v.was_category, v.was_classified_by, v.now_category, c.source
      FROM complaint_reviews v JOIN complaint_cases c ON c.id = v.case_id`);
    const waiting = await many(db, `SELECT category, count(*)::int AS n FROM complaint_cases c
      WHERE c.merged_into IS NULL AND c.excluded_at IS NULL AND c.classified_by <> 'human' AND NOT EXISTS (SELECT 1 FROM complaint_reviews v WHERE v.case_id = c.id) GROUP BY category`);
    return buildReviewStats(rows, waiting);
  }

  return { getSettings, saveSettings, kustomerDiscover, start, run, status, markInterrupted, maybeRun, listCases, getCase, setCategory, playbook, clients, sources, reviewQueue, reviewCase, reviewStats };
}

// Measured accuracy from hand checks: of the cases the engine put in a category, how many a
// person agreed with. Under REVIEW_MIN checks a number is shown as thin, not as a result.
function gmailUrl(source, sourceId) {
  const [account, thread] = String(sourceId).split(':');
  if (source !== 'gmail' || !/^[0-9a-f]{8,}$/i.test(thread || '')) return null;
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${thread}`;
}

function longestText(custom) {
  const texts = Object.values(custom || {}).filter((v) => typeof v === 'string' && v.trim().length > 20);
  return texts.sort((a, b) => b.length - a.length)[0]?.slice(0, 1500) || null;
}

export const REVIEW_MIN = 20;
export function buildReviewStats(rows, waiting = []) {
  const tally = (list) => {
    const n = list.length;
    const correct = list.filter((r) => r.verdict === 'correct').length;
    return { checked: n, correct, wrong_category: list.filter((r) => r.verdict === 'wrong_category').length, not_complaint: list.filter((r) => r.verdict === 'not_complaint').length, accuracy: n ? correct / n : null, enough: n >= REVIEW_MIN };
  };
  const group = (key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key] || 'unknown', [...(m.get(r[key] || 'unknown') || []), r]);
    return [...m].map(([k, list]) => ({ key: k, ...tally(list) })).sort((a, b) => b.checked - a.checked);
  };
  const left = new Map(waiting.map((w) => [w.category || 'unknown', Number(w.n)]));
  const by_category = group('was_category').map((g) => ({ ...g, waiting: left.get(g.key) || 0 }));
  for (const [k, n] of left) if (!by_category.some((g) => g.key === k)) by_category.push({ key: k, ...tally([]), waiting: n });
  const moves = new Map();
  for (const r of rows) if (r.verdict === 'wrong_category') moves.set(`${r.was_category}>${r.now_category}`, (moves.get(`${r.was_category}>${r.now_category}`) || 0) + 1);
  return {
    total: tally(rows),
    by_category,
    by_source: group('source'),
    by_classifier: group('was_classified_by'),
    confusions: [...moves].map(([k, n]) => ({ from: k.split('>')[0], to: k.split('>')[1], n })).sort((a, b) => b.n - a.n).slice(0, 15),
    min_checks: REVIEW_MIN,
    waiting: [...left.values()].reduce((a, b) => a + b, 0),
  };
}


/**
 * What should an automatic update read next? Pure.
 *   mined: finished runs' windows [{from, to}] (YYYY-MM-DD); today: local date;
 *   historyDays: how far back to keep history; recentDone: the day the daily update last ran.
 * 1. The newest stretch of days (up to a month) that hasn't been read, back to the history target.
 * 2. Otherwise, once a day: the last two weeks again, refreshing outcomes for ~4 months.
 */
export function planAuto({ mined, today, historyDays, recentDone }) {
  const add = (d, n) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const yesterday = add(today, -1);
  const target = add(today, -historyDays);
  // Walk back from yesterday through everything already read.
  let p = yesterday;
  for (let moved = true; moved && p >= target; ) {
    moved = false;
    for (const m of mined) {
      if (m.from <= p && m.to >= p) {
        p = add(m.from, -1);
        moved = true;
      }
    }
  }
  if (p >= target) {
    // Unread days end at p. Start a month earlier, but not before anything already read or the target.
    const readBelow = mined.filter((m) => m.to < p).map((m) => m.to).sort().pop();
    let from = add(p, -30);
    if (readBelow && add(readBelow, 1) > from) from = add(readBelow, 1);
    if (from < target) from = target;
    const catchUp = p === yesterday;
    return { kind: 'history', from, to: p, refreshFrom: null, label: catchUp ? 'Automatic update: reading the days since the last update' : 'Automatic update: reading older history' };
  }
  if (recentDone !== today) return { kind: 'recent', from: add(today, -14), to: yesterday, refreshFrom: add(today, -130), label: 'Automatic daily update: the last two weeks, and outcomes for the last four months' };
  return null;
}
