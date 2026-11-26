// KPI scorecard configuration: brands, rule lists and thresholds. Everything a definition
// depends on lives here so a rule change is one edit, covered by server/test/kpi.test.js.

// Brands shown on the scorecard. To add a brand: add an entry here, give its connectors data
// (connectors.js) and list which KPIs apply. No UI change is needed.
export const KPI_BRANDS = [
  { key: 'urbanmop', name: 'UrbanMop', detail: 'Ottawa Residential', locations: /^ottawa$/i, complaintBrand: 'residential', googleExport: 'google-reviews-urbanmop.json', syftReport: /(urban ?mop|um canada).*(management|monthly|syft) report/i, syftNotReport: /luxo|clean ?bee|\b(urban ?mop|um) us\b/i, syftEntity: /urban ?mop|um canada/i, syftQuery: 'from:indep.so has:attachment filename:pdf ("Management Report" OR "Management Reports" OR "Monthly Report") newer_than:1100d', syftScope: 'Whole company (UM Canada: Residential and Commercial)', kpis: ['ocr', 'churn', 'fulfilment', 'complaints', 'reviews', 'billing'] },
  // { key: 'cleanbee', name: 'Clean Bee', detail: 'Spokane', kpis: ['ocr', 'churn', 'complaints', 'reviews', 'billing'] },
];

export const KPI_LABELS = {
  ocr: 'Operational Cost Ratio',
  churn: 'Recurring client churn',
  fulfilment: 'Service fulfilment',
  complaints: 'Complaint rate',
  reviews: 'Google reviews',
  billing: 'Billing cash conversion',
};

export const KPI_RULES = {
  // First month the dashboard covers.
  firstMonth: '2024-01',

  // ----- Churn -----
  // Recurring = the frequency name contains one of these, and is not a one-time.
  recurringWords: ['weekly', 'biweekly', 'triweekly', 'monthly', 'prepaid'],
  // Institutional / B2B2C clients: out of numerator and denominator.
  institutional: ['carefor', 'owcs', 'bruyere', 'homemaking', 'mft', 'metis', 'digirealty', 'spark lifecare', 'corretto'],
  // Test entries: these names, plus any name or reason containing the word "test".
  testNames: ['leslie t', 'leslie tam', 'leslietest', 'simon test', 'les tee'],
  // Cancellation reason -> category (first match wins). Out of the numerator.
  reasonCategories: [
    { key: 'luxo_transfer', label: 'Transfer to LuxoClean', pattern: /luxo|kitchener|waterloo|\bk-?w\b/i },
    { key: 'temporary', label: 'Temporary (travel, hold, renovation, Airbnb, postpartum)', pattern: /travel|vacation|out of (town|the country)|snowbird|on hold|\bhold\b|pause|renovat|air\s?bnb|post\s?partum/i },
    { key: 'admin_error', label: 'Admin error', pattern: /admin(istrative|istration)? error|duplicate|by mistake|in error/i },
  ],
  // "Came back": a later active recurring booking. null = any time after the cancellation;
  // a number limits it to that many days.
  returnWindowDays: null,
  // Temporary cancellations: back within this many days = not churn; no return by then = churn.
  temporaryReturnDays: 90,
  returnBuckets: [30, 60, 90],
  churnBands: [
    { max: 7, label: 'Excellent', tone: 'good' },
    { max: 10, label: 'Healthy', tone: 'good' },
    { max: 12, label: 'Elevated', tone: 'warning' },
    { max: Infinity, label: 'High', tone: 'critical' },
  ],
  churnTarget: 6.8, // %; the tile also shows the last 12 months beside it
  // Admin over-cancellation: a staff cancellation whose reason contains one of these.
  overCancelWords: ['vacation', 'travel', 'away', 'reschedule', 'on hold', 'pause', 'no show', 'cleaner cancel', 'preferred cleaner', 'last minute'],

  // ----- Fulfilment -----
  fulfilmentTarget: 98.5, // %, the threshold in the GM governance sheet
  lateMinutes: 30, // late arrival = check-in this many minutes after the scheduled start
  snapshotHours: 48, // "on the books" snapshot taken this long before the visit
  // Cancellation reason -> who caused it. Company patterns are checked first.
  companyCauses: [
    { label: 'We rescheduled', pattern: /we rescheduled|rescheduled by (us|the office|office|urbanmop)|office rescheduled/i },
    { label: 'Cleaner no-show', pattern: /cleaner no[\s-]?show|cleaner did ?n.t (show|arrive)/i },
    { label: 'Cleaner cancelled', pattern: /cleaner (cancel|called (in|out)|sick|quit|unavailable|emergency)/i },
    { label: 'Unable to staff', pattern: /unable to staff|no cleaner|short[\s-]?staffed|staffing|no availability/i },
  ],
  // A staff-entered cancellation is still client-caused when the reason says so.
  clientCausePattern: /client|customer|lock(ed)? ?out|no access|travel|vacation|moving|moved|sold|price|budget|sick/i,

  // ----- Complaints -----
  dedupeDays: 7, // a rating and a complaint from one client this close together are one complaint
  savedDays: 60, // "saved" = still booking this many days after the complaint

  // ----- OCR -----
  // QBO account categories that count as operational delivery cost.
  ocrIncluded: {
    cleaner_wages: 'Cleaner wages (contractor + employee)',
    cleaner_payroll_taxes: "Payroll taxes, EI, CPP, workers' comp on cleaners",
    supplies: 'Supplies',
    field_vehicle: 'Field vehicle costs (gas, vehicle insurance)',
    ops_staff: 'Ops / office staff (scheduling and delivery)',
    ops_software: 'Ops software',
    recruitment_ads: 'Recruitment ads',
  },
  ocrExcluded: { office_rent: 'Office rent', general_insurance: 'General business insurance' },
  ocrTarget: [63, 68], // target range, %; lower is better
  ragTolerance: 0.05, // within 5% of missing the target = Warning; beyond = Off track
  ocrFlagPp: 1.0, // flag when QBO and Syft differ by more than this many percentage points
  closeDay: 10, // a month is Provisional until this day of the following month

  // ----- Freshness -----
  staleHours: 48,
};

export const KPI_SOURCES = {
  launch27: { label: 'Launch27', daily: true },
  kustomer: { label: 'Kustomer', daily: true },
  google: { label: 'Google Business Profile', daily: true },
  qbo: { label: 'QuickBooks Online', daily: false },
  syft: { label: 'Syft report (Gmail)', daily: false },
};
