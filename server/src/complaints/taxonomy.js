// Complaint taxonomy (DRAFT: to be re-cut from the pilot data, see docs/complaints-engine.md)
// and a rules-based first pass: category, tone, areas cited and hard routes. The rules
// always run; when Claude classification is on it refines category/tone/severity, but a
// hard route found by either is kept (we never let a model talk a case off a hard route).

export const CATEGORIES = [
  { key: 'quality_missed', label: 'Quality: missed areas', re: /\b(miss(ed|ing) (spot|area|room)|missed|forg[eo]t|didn'?t (clean|do|wipe|vacuum|mop|dust)|not (clean(ed)?|done|thorough)|dust(y)?|dirty|still (dirty|there)|skipp?ed|overlook|streak|hair|crumbs?|sticky|grime|not up to|disappoint|unsatisf|dissatisf|poor (job|clean|quality)|sub-?par)/i },
  { key: 'quality_rushed', label: 'Quality: rushed / short time', re: /\b(rush(ed)?|hurr(y|ied)|left early|only (spent|stayed|there)|short(er)? (time|visit)|less than \d|(fewer|less) hours)/i },
  { key: 'punctuality', label: 'Late / no-show', re: /\b(late|no.?show|didn'?t (show|come|arrive)|never (showed|came|arrived)|wait(ed|ing) (for|over)|stood up|delay(ed)?)\b/i },
  { key: 'cleaner_change', label: 'Cleaner change / consistency', re: /\b(usual|regular|same) (cleaner|person|team|lady)|new (cleaner|person|team)|different (cleaner|person|team)|changed? (the |my )?cleaner/i },
  { key: 'scope_booking', label: 'Scope / booking error', re: /\b(wrong (date|day|time|address|service)|extras?|oven|fridge|inside (the )?(cabinets|windows)|not (included|what i (booked|asked))|double.?book|cancel+ed (by you|on me|last minute)|reschedul)/i },
  { key: 'communication', label: 'Communication', re: /\b(no (one|body) (called|replied|responded|got back)|never (heard|responded|replied|got back)|no (response|reply|update)|unresponsive|ignored)\b/i },
  { key: 'pricing_billing', label: 'Pricing / billing', re: /\b(over.?charg|charged (twice|again|more)|double charg|price (increase|went up|change)|invoice|bill(ed|ing)?|affirm|refund (my|the) (deposit|payment)|fee)\b/i },
  { key: 'property_condition', label: 'Property condition (job not finished)', re: /\b(condition of the (property|home|house)|unable to (continue|finish|complete)|couldn'?t (continue|finish|complete)|hoard|biohazard)/i },
  { key: 'damage', label: 'Damage / breakage', re: /\b(broke(n)?|break(ing)?|damag(e|ed)|scratch(ed)?|crack(ed)?|ruin(ed)?|chipp?ed|dent(ed)?|shatter(ed)?|bleach(ed)? (my|the)|stain(ed)? (my|the))/i },
  { key: 'missing_item', label: 'Missing item / theft', re: /\b(stole|stolen|steal|theft|missing (item|ring|jewel|money|cash|watch)|can'?t find (my|the)|went missing|took (my|our))/i },
  { key: 'conduct_safety', label: 'Cleaner conduct / safety', re: /\b(rude|disrespect|yell(ed)?|inappropriate|harass|unsafe|injur|hurt|smok(ed|ing)|drunk|high|on (the|their) phone|brought (?:her |his |their )?(someone|a friend|kids?)|privacy|photo|video)/i },
];
export const CATEGORY_KEYS = [...CATEGORIES.map((c) => c.key), 'other'];
export const categoryLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || (key === 'other' ? 'Other / unclear' : key || 'Unclassified');

export const TONES = ['mild', 'frustrated', 'angry', 'threat_leave', 'threat_review'];
const TONE_RULES = [
  { key: 'threat_review', re: /\b(review|google|yelp|bbb|better business|post (about|this)|tell (everyone|my friends)|social media|facebook|reddit)\b/i },
  { key: 'threat_leave', re: /\b(cancel (my|all|the) (service|bookings?|subscription|account)|never (use|book) (you|again|urbanmop)|find (another|a different) (company|service)|done with (you|urbanmop)|won'?t be (booking|using))\b/i },
  { key: 'angry', re: /\b(unacceptable|ridiculous|disgust|furious|outrage|horrible|terrible|worst|appall|livid|scam)\b|!!|[A-Z]{6,}/ },
  { key: 'frustrated', re: /\b(disappoint|frustrat|upset|not happy|unhappy|annoy|again\b|second time|third time|keeps? happening)/i },
];

export const AREAS = ['kitchen', 'bathroom', 'floors', 'baseboards', 'dusting', 'windows', 'appliances', 'bedrooms', 'stairs'];
const AREA_RE = {
  kitchen: /\b(kitchen|counter(top)?s?|sink|stove(top)?|backsplash|cabinet)/i,
  bathroom: /\b(bath(room|tub)?|toilet|shower|washroom|mirror|vanity|grout)/i,
  floors: /\b(floor|vacuum|mop(ped|ping)?|carpet|rug)/i,
  baseboards: /\bbaseboard/i,
  dusting: /\b(dust|shel(f|ves)|blinds|ceiling fan|light fixture)/i,
  windows: /\b(window|sill|glass door)/i,
  appliances: /\b(oven|fridge|refrigerator|microwave|dishwasher)/i,
  bedrooms: /\b(bed(room)?|sheets|linen)/i,
  stairs: /\b(stair|railing|banister)/i,
};

// Never on the A/B/C/D ladder: straight to whoever holds the Office Manager role.
export const HARD_ROUTES = {
  damage_over_100: 'Damage claim over $100',
  theft_missing: 'Theft or missing item',
  safety: 'Safety incident',
  misconduct: 'Cleaner misconduct',
  legal_chargeback: 'Legal threat or chargeback',
};
const LEGAL_RE = /\b(lawyer|attorney|legal action|sue|suing|small claims|chargeback|dispute (the|this) (charge|payment)|credit card company|bank dispute)\b/i;
const SAFETY_RE = /\b(injur|hurt|unsafe|fire|flood(ed)?|gas leak|police|911|ambulance|assault)\b/i;
const MISCONDUCT_RE = /\b(harass|inappropriate|drunk|intoxicated|high on|smok(ed|ing) (in|inside)|went through (my|our)|snoop|brought (?:her |his |their )?(someone|a friend|kids?|children)|took (photos|pictures|videos?))\b/i;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;

export function amountsIn(text) {
  return [...String(text || '').matchAll(MONEY_RE)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

/** Rules-based classification of complaint text. Pure; no personal data leaves. */
export function classifyRules(text, { claimAmount = null } = {}) {
  const t = String(text || '');
  const hits = CATEGORIES.map((c) => ({ key: c.key, n: (t.match(new RegExp(c.re.source, 'gi')) || []).length })).filter((h) => h.n);
  // Damage/theft/conduct outrank quality even with fewer hits: they change who handles it.
  const priority = ['missing_item', 'conduct_safety', 'damage', 'property_condition', 'punctuality', 'pricing_billing', 'scope_booking'];
  hits.sort((a, b) => {
    const pa = priority.indexOf(a.key);
    const pb = priority.indexOf(b.key);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return b.n - a.n;
  });
  const category = hits[0]?.key || 'other';
  const tone = TONE_RULES.find((r) => r.re.test(t))?.key || 'mild';
  const areas = AREAS.filter((a) => AREA_RE[a].test(t));
  const amount = claimAmount ?? Math.max(0, ...amountsIn(t));
  const hard = hardRouteFor({ category, text: t, amount });
  const severity = hard ? 4 : tone === 'threat_review' || tone === 'threat_leave' ? 3 : tone === 'angry' || category === 'damage' ? 3 : tone === 'frustrated' ? 2 : 1;
  return { category, secondary: hits.slice(1, 3).map((h) => h.key), tone, areas, hard_route: hard, severity, confidence: hits.length ? Math.min(0.7, 0.35 + 0.1 * hits[0].n) : 0.2 };
}

export function hardRouteFor({ category, text = '', amount = 0 }) {
  if (LEGAL_RE.test(text)) return 'legal_chargeback';
  if (category === 'missing_item') return 'theft_missing';
  if (SAFETY_RE.test(text)) return 'safety';
  if (MISCONDUCT_RE.test(text)) return 'misconduct';
  if (category === 'damage' && Number(amount) > 100) return 'damage_over_100';
  return null;
}

/** Combine rules + model output. Hard routes from either side stick. */
export function mergeClassification(rules, model) {
  if (!model) return { ...rules, classified_by: 'rules' };
  const category = CATEGORY_KEYS.includes(model.category) ? model.category : rules.category;
  const hard = rules.hard_route || (model.hard_route && HARD_ROUTES[model.hard_route] ? model.hard_route : null);
  return {
    category,
    secondary: rules.secondary,
    tone: TONES.includes(model.tone) ? model.tone : rules.tone,
    areas: [...new Set([...(rules.areas || []), ...(model.areas || []).filter((a) => AREAS.includes(a))])],
    hard_route: hard,
    severity: hard ? 4 : Math.min(4, Math.max(1, Number(model.severity) || rules.severity)),
    summary: model.summary || null,
    is_complaint: model.is_complaint,
    confidence: Number(model.confidence) || 0.6,
    classified_by: 'claude',
  };
}
