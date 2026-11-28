// Google review drill-down (src/kpi/review-details.js and the reviews drill in calc.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { indexDataset, scorecard, drill } from '../src/kpi/calc.js';
import { KPI_BRANDS } from '../src/kpi/config.js';
import { peopleOf, clientOf, cleanersIn, reviewRows, starCounts } from '../src/kpi/review-details.js';

const brand = KPI_BRANDS[0];
const NOW = Date.parse('2026-11-28T15:00:00Z');
let id = 1;
const visit = (cid, customer, cleaner, date = '2026-11-10') => ({ id: id++, customer_id: cid, customer, date, start: `${date}T09:00`, created_at: '2026-01-05T10:00', frequency: 'Biweekly', completed: true, cleaner, checkin_at: `${date}T09:05`, rating: null, rated_at: null, cancellation: null });
// Made-up clients and cleaners.
const bookings = [
  visit(1, 'Ada Example', 'Maria G.'),
  visit(2, 'Ben Sample', 'Maria P., Lee T.'),
  visit(3, 'Ben Sampleton', 'Lee T.'),
  visit(4, 'Cora Test', 'Team 3'),
];

describe('Google review details', () => {
  test('client by name: the same full name, or first name and last initial when only one client fits', () => {
    const people = peopleOf(bookings);
    assert.deepEqual(clientOf('Ada Example', people), { id: 1, name: 'Ada Example', match: 'same name' });
    assert.deepEqual(clientOf('ada E.', people), { id: 1, name: 'Ada Example', match: 'likely' });
    assert.equal(clientOf('Ben S.', people), null); // two clients fit
    assert.equal(clientOf('Ada Different', people), null);
    assert.equal(clientOf('Ada', people), null);
  });

  test('cleaners by first name: the client’s own cleaner first, otherwise only when the name is unique', () => {
    const people = peopleOf(bookings);
    assert.deepEqual(cleanersIn('Maria was amazing!', people, 1).map((c) => c.name), ['Maria G.']);
    assert.deepEqual(cleanersIn('Maria was amazing!', people, null).map((c) => c.name), ['Maria (2 cleaners with that name)']);
    assert.deepEqual(cleanersIn('Thanks LEE, great job by the team', people, null).map((c) => c.name), ['Lee T.']);
    assert.deepEqual(cleanersIn('Marianne was here', people, null), []); // whole words only
  });

  test('drill: newest first, low stars, cleaners, stars; replies only when known; tile details open their tab', () => {
    const reviews = [
      { id: 'a', date: '2026-11-03', rating: 5, reviewer: 'Ada E.', comment: 'Maria was wonderful', link: 'https://maps.google.com/r/a' },
      { id: 'b', date: '2026-11-20', rating: 2, reviewer: 'Zed Nobody', comment: 'Late and rushed', link: null },
      { id: 'c', date: '2026-11-25', rating: null, reviewer: '', comment: '' },
      { id: 'd', date: '2026-10-25', rating: 4, reviewer: 'Old One', comment: 'Fine' },
    ];
    const ds = { sources: { launch27: { refreshed_at: new Date(NOW - 3_600_000).toISOString() }, google: { refreshed_at: new Date(NOW - 3_600_000).toISOString() } }, bookings, complaints: [], reviews, reviewBaseline: { count: 0, avg: null }, ocr: { qbo: [], syft: [] }, manualReviews: {} };
    const ix = indexDataset(ds);
    const d = drill(ix, { kpi: 'reviews', month: '2026-11', today: '2026-11-28' });
    const tab = (k) => d.tabs.find((t) => t.key === k);
    assert.deepEqual(d.tabs.map((t) => t.key), ['reviews_all', 'reviews_low', 'reviews_cleaners', 'reviews_stars']); // no replies known: no "Not replied to"
    assert.deepEqual(tab('reviews_all').rows.map((r) => r.date), ['2026-11-25', '2026-11-20', '2026-11-03']);
    const a = tab('reviews_all').rows[2];
    assert.deepEqual([a.stars, a.client, a.client_href, a.cleaners, a.link_href], ['★★★★★', 'Ada Example (likely)', '/customers/1', 'Maria G.', 'https://maps.google.com/r/a']);
    assert.equal(tab('reviews_all').rows[0].stars, 'Not shown by Google');
    assert.deepEqual(tab('reviews_low').rows.map((r) => r.reviewer), ['Zed Nobody']);
    assert.deepEqual(tab('reviews_stars').rows.map((r) => [r.stars, r.count]), [['★★★★★', 1], ['★★★★☆', 0], ['★★★☆☆', 0], ['★★☆☆☆', 1], ['★☆☆☆☆', 0], ['Stars not shown by Google', 1]]);
    // A tile detail opens its own tab first.
    assert.equal(drill(ix, { kpi: 'reviews_low', month: '2026-11', today: '2026-11-28' }).tabs[0].key, 'reviews_low');
    const tile = scorecard(ix, { brand, month: '2026-11', now: NOW, today: '2026-11-28' }).tiles.find((t) => t.kpi === 'reviews');
    const detail = (l) => tile.details.find((x) => x.label === l);
    assert.deepEqual([detail('Stars').value, detail('Stars').drill], ['5★ 1 · 4★ 0 · 3★ 0 · 2★ 1 · 1★ 0', 'reviews_stars']);
    assert.deepEqual([detail('Low-star reviews (1–3★)').value, detail('Reviews naming a cleaner').value], ['1', '1']);
    assert.equal(detail('Not replied to'), undefined);
  });

  test('with replies known (Business Profile API): the "Not replied to" tab, oldest first', () => {
    const rows = reviewRows([{ date: '2026-11-02', rating: 5, replied: false }, { date: '2026-11-01', rating: 1, replied: false }, { date: '2026-11-03', rating: 4, replied: true, reply: 'Thanks!' }], bookings);
    assert.deepEqual(rows.map((r) => [r.replied, r.unanswered]), [['No', true], ['No', true], ['Yes', false]]);
    assert.deepEqual(starCounts([{ rating: 5 }, { rating: 1 }, { rating: null }]), { 5: 1, 4: 0, 3: 0, 2: 0, 1: 1 });
  });
});
