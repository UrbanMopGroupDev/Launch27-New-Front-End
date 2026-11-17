// Commercial workforce plan: the Commercial team, the weekly plan of moves, open slots and the
// partner availability files (docs/commercial-workforce.md). Reads the scheduling planner's
// snapshot (hours, days off and every booking, live from Launch27); stores only the team's
// choices (migration 0017). Never writes to Launch27.
import { readFileSync } from 'node:fs';
import { addDays, mondayOf, km } from '../schedule/rules.js';
import { DEFAULT_SETTINGS, commercialTest, computeSlots, partnerSnapshot, planWeek, suggestSlots, teamStats, withDetails } from './workforce-core.js';

// Centre of each "K" postal area (© GeoNames, CC BY 4.0), to place a new client from a postal code.
const FSA = JSON.parse(readFileSync(new URL('./data/postal-area-centres.json', import.meta.url), 'utf8'));
const PARTNER_FILE = readFileSync(new URL('./data/partner-file.html', import.meta.url), 'utf8');
const TRAVEL = { on: true, roadFactor: 1.3, kmh: 35, sameAreaKm: 2, minGap: 10 };
const STATUSES = ['proposed', 'approved', 'done', 'hold'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PET = ['ok', 'no'];
/** A Canadian postal code, tidied ("k1c2b3" -> "K1C 2B3"); the first three characters alone are accepted. */
export function tidyPostal(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s)) return `${s.slice(0, 3)} ${s.slice(3)}`;
  if (/^[A-Z]\d[A-Z]$/.test(s)) return s;
  return null;
}

export const fsaOfPostal = (pc) => {
  const s = String(pc || '').toUpperCase().replace(/\s/g, '').slice(0, 3);
  return /^[A-Z]\d[A-Z]$/.test(s) && FSA[s] ? s : '';
};
/** The postal area whose centre is nearest to a place (within 25 km), so exact places never leave the app. */
export function nearestFsa(p) {
  if (!p || p.lat == null || p.lng == null) return '';
  let best = '';
  let bestKm = 25;
  for (const [code, [lat, lng]] of Object.entries(FSA)) {
    const d = km(p, { lat, lng });
    if (d != null && d < bestKm) [best, bestKm] = [code, d];
  }
  return best;
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createWorkforce({ db, schedule }) {
  async function settings() {
    const row = (await db.query('SELECT data FROM commercial_settings WHERE id = 1')).rows[0];
    const d = row ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : {};
    return { ...DEFAULT_SETTINGS, ...d, partner: { ...DEFAULT_SETTINGS.partner, ...(d.partner || {}) } };
  }

  /** Everything the plan needs, from the planner's snapshot and the team's saved choices. */
  async function context(locations) {
    const s = await schedule._load();
    if (!s) throw bad('The scheduling planner has not loaded Launch27 yet. Open Scheduling planner and click "Refresh now".', 409);
    if (!locations?.length) throw bad('No Commercial locations: set them under Support settings → Brands.');
    const set = await settings();
    const rows = (await db.query("SELECT cleaner_id, commercial, to_char(last_day, 'YYYY-MM-DD') AS last_day, gender, home_postal, pets_dogs, pets_cats, pets_other, pets_note FROM commercial_cleaners")).rows;
    const ticks = new Map(rows.filter((r) => r.commercial !== null).map((r) => [Number(r.cleaner_id), r.commercial]));
    const lastDay = new Map(rows.filter((r) => r.last_day).map((r) => [Number(r.cleaner_id), r.last_day]));
    const details = new Map(rows.map((r) => [Number(r.cleaner_id), r]));
    const cleaners = withDetails(s.cleaners, details); // the lead's gender entries win over Launch27's codes
    const moves = (await db.query("SELECT series_key, status, assignee_id, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM commercial_moves")).rows;
    const state = new Map(moves.map((m) => [m.series_key, { status: m.status, assignee_id: m.assignee_id == null ? null : Number(m.assignee_id), ends_on: m.ends_on }]));
    const isCom = commercialTest(locations);
    const team = teamStats({ visits: s.visits, cleaners, today: s.today, isCom, ticks, lastDay, threshold: set.threshold });
    return {
      today: s.today, taken_at: s.taken_at, visits: s.visits, cleaners, windowFor: schedule._window, isCom, team, state, settings: set, details,
      prefsFor: (id) => s.customers.get(id)?.prefs || null,
    };
  }
  const weekOf = (ctx, week) => {
    if (week && !DATE.test(week)) throw bad('week must be a date (YYYY-MM-DD).');
    const w = mondayOf(week || ctx.today);
    const first = mondayOf(addDays(ctx.today, -7));
    const last = mondayOf(addDays(ctx.today, 49));
    return w < first ? first : w > last ? last : w; // the planner holds about 8 weeks ahead
  };

  async function team({ locations }) {
    const ctx = await context(locations);
    // Details stay inside the portal: they are never put into a partner file.
    const cleaners = ctx.team.map((t) => {
      const d = ctx.details.get(t.id) || {};
      const fsa = fsaOfPostal(d.home_postal);
      return {
        ...t,
        home_postal: d.home_postal || null, home_fsa: fsa || null, home_place: fsa ? FSA[fsa][2] : null,
        pets: { dogs: d.pets_dogs || null, cats: d.pets_cats || null, other: d.pets_other || null, note: d.pets_note || '' },
      };
    });
    return { today: ctx.today, taken_at: ctx.taken_at, threshold: ctx.settings.threshold, cleaners };
  }

  async function plan({ week, locations }) {
    const ctx = await context(locations);
    const { _busy, _series, ...out } = planWeek(ctx, weekOf(ctx, week));
    return { today: ctx.today, taken_at: ctx.taken_at, transition_rule: ctx.settings.transitionRule, ...out };
  }

  const areaFn = (areas) => (locationId) => (areas?.cornwall?.includes(Number(locationId)) ? 'C' : 'O');
  async function slotData(ctx, areas) {
    const p = ctx.settings.partner;
    return computeSlots(ctx, { startWeek: mondayOf(addDays(ctx.today, 7)), weeks: p.weeks, days: p.days, slots: p.slots, areaOf: areaFn(areas) });
  }

  /** Open slots (internal view, with names), and suggestions for a new client's postal code. */
  async function slots({ locations, areas = null, postal = null, freq = 1, day = null }) {
    const ctx = await context(locations);
    const data = await slotData(ctx, areas);
    let suggestions = null;
    let placed = null;
    if (postal) {
      const fsa = fsaOfPostal(postal);
      if (!/^[A-Za-z]\d[A-Za-z]/.test(String(postal).replace(/\s/g, ''))) throw bad('Enter a postal code like K1C 2B3 (the first three characters are enough).');
      const place = fsa ? { lat: FSA[fsa][0], lng: FSA[fsa][1] } : null;
      placed = fsa ? { fsa, name: FSA[fsa][2], area: FSA[fsa][1] >= -75.05 ? 'C' : 'O' } : null;
      suggestions = suggestSlots(data, { place, area: placed?.area || null, freq: [0, 1, 2].includes(freq) ? freq : 1, day });
    }
    const W = data.weeks.length;
    const grid = data.slots.map((sl, si) => data.days.map((d) => {
      const here = data.options.filter((o) => o.day === d && o.slot === si);
      return { every_week: here.filter((o) => o.weeks.every((w) => w.free)).map((o) => o.cleaner), some_weeks: here.filter((o) => o.weeks.some((w) => w.free) && !o.weeks.every((w) => w.free)).map((o) => ({ cleaner: o.cleaner, free: o.weeks.filter((w) => w.free).length, of: W })) };
    }));
    return { today: ctx.today, taken_at: ctx.taken_at, weeks: data.weeks, days: data.days, slots: data.slots, grid, cleaners: [...new Set(data.options.map((o) => o.cleaner))].length, placed, suggestions, partner: ctx.settings.partner };
  }

  /** The standalone availability page for one partner (Carefor, OWCS): only what that partner may see. */
  async function partnerFile({ partner, locations, areas = null }) {
    const ctx = await context(locations);
    const p = ctx.settings.partner;
    if (!p.accounts[partner]) throw bad('No such partner.', 404);
    const snap = partnerSnapshot(await slotData(ctx, areas), partner, { ...p, generated: ctx.today, fsaOf: nearestFsa });
    const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
    const html = PARTNER_FILE.replace('/*SNAPSHOT*/', () => json(snap)).replace('/*FSA*/', () => json(FSA)).replace('/*TRAVEL*/', () => json(TRAVEL));
    return { filename: `urbanmop-availability-${partner.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${ctx.today}.html`, html, open: snap.options.length };
  }

  // ---------- the team's choices ----------
  /** The lead's choices for one cleaner. Each field is optional; null clears it. */
  async function setCleaner(id, { commercial, last_day, gender, home_postal, pets_dogs, pets_cats, pets_other, pets_note } = {}, userId = null) {
    const cid = Number(id);
    if (!Number.isInteger(cid) || cid <= 0) throw bad('No such cleaner.', 404);
    if (commercial !== undefined && commercial !== null && typeof commercial !== 'boolean') throw bad('commercial must be true, false or null.');
    if (last_day !== undefined && last_day !== null && !DATE.test(String(last_day))) throw bad('last_day must be a date (YYYY-MM-DD).');
    if (gender !== undefined && gender !== null && !['F', 'M'].includes(gender)) throw bad('gender must be F, M or null.');
    let postal = home_postal;
    if (postal !== undefined && postal !== null && postal !== '') {
      postal = tidyPostal(postal);
      if (!postal) throw bad('Enter a home postal code like K1C 2B3 (the first three characters are enough).');
    } else if (postal === '') postal = null;
    const pets = { pets_dogs, pets_cats, pets_other };
    for (const [k, v] of Object.entries(pets)) if (v !== undefined && v !== null && !PET.includes(v)) throw bad(`${k} must be ok, no or null.`);
    // Column names below come from this fixed list, never from the request.
    const changes = [['commercial', commercial], ['last_day', last_day], ['gender', gender], ['home_postal', postal], ...Object.entries(pets),
      ['pets_note', pets_note === undefined ? undefined : String(pets_note || '').trim().slice(0, 200) || null]].filter(([, v]) => v !== undefined);
    await db.query('INSERT INTO commercial_cleaners (cleaner_id, set_by) VALUES ($1, $2) ON CONFLICT (cleaner_id) DO NOTHING', [cid, userId]);
    for (const [col, v] of changes) await db.query(`UPDATE commercial_cleaners SET ${col} = $2, set_by = $3, set_at = now() WHERE cleaner_id = $1`, [cid, v, userId]);
    // Dispatch and the scheduling planner use the entered gender too.
    if (gender !== undefined) await schedule.gendersChanged?.();
  }

  async function setMove(key, { status, assignee_id, ends_on }, userId = null) {
    const k = String(key || '');
    if (!/^-?\d+\|[0-6]\|\d{1,4}\|\d{1,4}\|[a-z]+$/.test(k)) throw bad('No such visit series.', 404);
    if (status !== undefined && !STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}.`);
    if (assignee_id !== undefined && assignee_id !== null && !(Number.isInteger(Number(assignee_id)) && Number(assignee_id) > 0)) throw bad('assignee_id must be a cleaner.');
    if (ends_on !== undefined && ends_on !== null && !DATE.test(String(ends_on))) throw bad('ends_on must be a date (YYYY-MM-DD).');
    await db.query('INSERT INTO commercial_moves (series_key, set_by) VALUES ($1, $2) ON CONFLICT (series_key) DO NOTHING', [k, userId]);
    if (status !== undefined) await db.query('UPDATE commercial_moves SET status = $2, set_by = $3, set_at = now() WHERE series_key = $1', [k, status, userId]);
    if (assignee_id !== undefined) await db.query('UPDATE commercial_moves SET assignee_id = $2, set_by = $3, set_at = now() WHERE series_key = $1', [k, assignee_id == null ? null : Number(assignee_id), userId]);
    if (ends_on !== undefined) await db.query('UPDATE commercial_moves SET ends_on = $2, set_by = $3, set_at = now() WHERE series_key = $1', [k, ends_on, userId]);
  }

  async function setSettings(patch, userId = null) {
    const cur = await settings();
    const next = { threshold: cur.threshold, transitionRule: cur.transitionRule, partner: { ...cur.partner } };
    if (patch.transitionRule !== undefined) next.transitionRule = !!patch.transitionRule;
    if (patch.threshold !== undefined) {
      const t = Number(patch.threshold);
      if (!(t > 0 && t <= 1)) throw bad('threshold must be between 0 and 1.');
      next.threshold = t;
    }
    const p = patch.partner || {};
    for (const k of ['showNames', 'showOwnAddresses', 'showOtherPartners']) if (p[k] !== undefined) next.partner[k] = !!p[k];
    if (p.weeks !== undefined) {
      const w = Number(p.weeks);
      if (!Number.isInteger(w) || w < 1 || w > 7) throw bad('weeks must be 1 to 7.');
      next.partner.weeks = w;
    }
    if (p.contact !== undefined) next.partner.contact = String(p.contact).slice(0, 200);
    await db.query('INSERT INTO commercial_settings (id, data, set_by) VALUES (1, $1::jsonb, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, set_by = EXCLUDED.set_by, set_at = now()', [JSON.stringify(next), userId]);
    return settings();
  }

  return { team, plan, slots, partnerFile, setCleaner, setMove, setSettings, settings };
}
