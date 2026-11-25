import { seedWorkforce } from './workforce.js';
// Starting configuration for UrbanMop: queues and routing rules as they are in Kustomer
// (routing export of Nov 25, 2026: 14 live queues, 22 queue rules, 18 teams with routing
// profiles). Databases seeded before that export are moved to it by migration 0036.
//
// Rule order: a few rules that came from Kustomer business rules (not in the routing
// export) run first, because they close, redact or escalate before queue routing; then
// Kustomer's queue rules in Kustomer's order (first match wins, disabled ones kept off);
// then the business-rule catch-alls for what the queue rules leave. Anything else goes
// to the Default Queue (slug "fallback"), as in Kustomer. See docs/kustomer-routing.md.
import { json } from '../db/index.js';

export const UM = {
  info: 'info@urbanmop.ca',
  billing: 'billing@urbanmop.ca',
  management: 'management@urbanmop.ca',
  customerSuccess: 'customersuccess@urbanmop.ca',
  noReply: 'no-reply@urbanmop.ca',
  hr: 'hr@urbanmop.ca',
  careers: 'careers@urbanmop.ca',
  hiring: 'hiring@urbanmop.ca',
  payroll: 'payroll@urbanmop.ca',
  sales: 'sales@urbanmop.ca',
  jose: 'jose@urbanmop.ca',
  smsOttawa: '+16136919880',
  smsHiring: '+16136918368',
};

// Identities agents can send from, per channel.
export const OUR_IDENTITIES = {
  email: [UM.info, UM.billing, UM.customerSuccess, UM.management, UM.hr, UM.careers, UM.hiring, UM.payroll],
  sms: [UM.smsOttawa, UM.smsHiring],
};

// Kustomer's live queues, with Kustomer's names and descriptions. "fallback" is Kustomer's
// Default Queue: everything no rule matches.
export const QUEUES = [
  { slug: 'operations', name: 'Operations Queue', description: 'Email, SMS, Chat, Phone' },
  { slug: 'sales', name: 'Sales Queue', description: 'Quotes, new inquiries, chat, Facebook and Instagram leads, lead follow-up' },
  { slug: 'sales-overflow', name: 'Sales Overflow(Cart Abandonment)', description: 'Cart abandonment emails' },
  { slug: 'customer-success', name: 'Customer Success', description: 'Queue for Customer Success' },
  { slug: 'billing', name: 'Billing Queue', description: 'This queue is for daily operations related to financial tasks such as charges not being held, any failed payments or outstanding payments from UM Portal in addition to any billing related tasks such as billing and invoices (receivables and payables).' },
  { slug: 'financial-operations', name: 'Financial Operations', description: 'This queue is strictly for daily operations related to financial tasks such as charges not being held, any failed payments or outstanding payments from UM Portal' },
  { slug: 'accounts-receivables', name: 'Accounts Receivables', description: 'It is the queue that will be used to route all receivable confirmations' },
  { slug: 'management', name: 'Management Queue', description: 'Incoming key word “Derek for review” or “Leslie for review” or emails sent to management@urbanmop.ca (an alias under info@urbanmop.ca) route to management team' },
  { slug: 'hr', name: 'HR Queue', description: 'hr@urbanmop.ca, careers@urbanmop.ca and the hiring line', restricted: true },
  { slug: 'payroll', name: 'Payroll Queue', description: 'Anything related to payroll inquiries', restricted: true },
  { slug: 'jose', name: 'Jose Queue', description: 'Email sent to jose@urbanmop.ca' },
  { slug: 'google-reviews', name: 'Google Reviews', description: 'Ratings Email IT WAS GREAT will go into this queue' },
  { slug: 'admin', name: 'Admin', description: 'This is a dead end Admin queue to route conversations out of the Management or Ops box.' },
  { slug: 'fallback', name: 'Default Queue', description: 'A Queue for all incoming conversations that don’t match any rules' },
];

export const SLA_POLICIES = [
  { slug: 'voice', name: 'Missed call callback', first_response_minutes: 15 },
  { slug: 'cleaner', name: 'Cleaner messages', first_response_minutes: 5, warn_minutes: 1 },
  { slug: 'chat', name: 'Chat', first_response_minutes: 5, warn_minutes: 1 },
  { slug: 'quote', name: 'Quote lead', first_response_minutes: 10 },
  { slug: 'cart', name: 'Cart abandonment', first_response_minutes: 30, warn_minutes: 5 },
  { slug: 'standard', name: 'Customer messages', first_response_minutes: 240, warn_minutes: 30 },
  { slug: 'hiring', name: 'Hiring and HR', first_response_minutes: 720, warn_minutes: 60 },
];

const SYSTEM_SENDERS = ['notifications@kustomerapp.com', 'notify@ringcentral.com', 'feedback@slack.com', 'team@bark.com', 'noreply@ziprecruiter.com', 'noreply@facebookmail.com', 'news@team.semrush.com', 'localservices-noreply'];

// Kustomer fields and how they read here: message subject / meta subject / conversation
// name -> subject_contains; message preview / klass titles and text -> text_contains;
// message meta to / recipient email -> to; message meta from / customer email / customer
// name -> from_contains; customer lead follow-up -> lead_stage; conversation channel ->
// channel. "equals" reads as "includes". Conversation tags are left out: a new conversation
// has none when it is routed here, so "tags include" never matches and "tags don't include"
// always does. `replaces` names the Kustomer rules (comma-separated) a rule stands for.
export const RULES = [
  // ---- From Kustomer business rules: close, redact and escalate before queue routing ----
  {
    name: 'System notices: mark done',
    conditions: { any: [{ from_contains: SYSTEM_SENDERS }, { to: [UM.noReply] }, { subject_contains: ['New booking request by'], text_excludes: ['Booking inserted into Launch 27?: N'] }] },
    action: { mark_done: true, disposition: { audience: 'system', reason: 'System notice', outcome: 'No action needed' } },
    replaces: 'Auto Close business rules, Auto Close Part 2, NoReply',
  },
  {
    name: 'Bank verification codes: keep out of shared queues',
    conditions: { text_contains: ['RBCPayEdge Authentication Code', 'verification code for RBC', 'donotreply@rbcpayedge.com'] },
    action: { queue: 'payroll', mark_done: true, redact: true, disposition: { audience: 'system', reason: 'Verification code', outcome: 'Redacted' } },
    replaces: 'RCB PayEdge Redirect, Auto assign to Payroll',
  },
  { name: 'Stripe disputes to Management', conditions: { from_contains: ['notifications@stripe.com'], text_contains: ['is being disputed'] }, action: { queue: 'management', priority: 5 }, replaces: 'Dispute from Stripe to management' },
  { name: 'Escalations to Management', conditions: { any: [{ to: [UM.management] }, { text_contains: ['Derek for review', 'Leslie for review'] }] }, action: { queue: 'management', priority: 4 }, replaces: 'Management Queue' },

  // ---- Kustomer queue rules, in Kustomer's order ----
  { name: 'Sales Overflow(Cart Abandonment) Rule', conditions: { subject_contains: ['Cart Abandonment', 'Cart Abandoned'] }, action: { queue: 'sales-overflow', sla: 'cart' }, replaces: 'Sales Overflow(Cart Abandonment) Rule' },
  {
    name: 'Keep in Sales Queue',
    conditions: { lead_stage: ['Attempt #1', 'Attempt #2', 'Attempt #3', 'Contacted Highly Interested', 'Contacted Undecided', 'Non-Region', 'Not Interested-Other', 'Not Interested-Price', 'Not Interested-Timing'] },
    action: { queue: 'sales', sla: 'standard' },
    replaces: 'Keep in Sales Queue',
  },
  {
    name: 'Sales Queue Rule',
    conditions: {
      any: [
        {
          subject_contains: [
            'submitted an inquiry',
            'New booking request by',
            'Quote Lead',
            'New Booking by Customer',
            'Boxing Week',
            'Boxing Day',
            'Payment received: Invoice #',
            'New Lead from Bark',
            'Family Day Promo',
            'Black Friday',
            'Easter Promo',
            'Prepaid booking cancellation by',
            'Canada Day Promo',
            'is interested in Carpet Cleaning services from UrbanMop',
          ],
        },
        { channel: ['chat'] },
        { text_contains: ['quote', 'new request', 'Booking inserted into Launch 27?: No', 'UrbanMop Sales'] },
        { to: [UM.sales] },
      ],
    },
    action: { queue: 'sales', sla: 'quote', priority: 4 },
    replaces: 'Sales Queue Rule',
  },
  { name: 'Facebook or Instagram to Sales Queue', conditions: { subject_contains: ['New Facebook Lead', 'Lead Reactivation for Move In Move Out'] }, action: { queue: 'sales', sla: 'quote', priority: 4 }, replaces: 'Facebook or Instagram to Sales Queue' },
  { name: '1-3 Star Google Review to Jose', enabled: false, conditions: { subject_contains: ['1-3 Star Google Review for'] }, action: { queue: 'jose' }, replaces: '1-3 Star Google Review to Jose' },
  { name: 'HR email', conditions: { to: [UM.hr] }, action: { queue: 'hr', sla: 'hiring' }, replaces: 'HR email' },
  {
    name: 'Billing & Financial Operations Queue',
    conditions: {
      any: [
        { to: [UM.billing] },
        {
          subject_contains: [
            'INTERAC e-Transfer:',
            'Biller Report For Biller Code',
            'Invoice - Reminder: Your payment to UrbanMop Inc. is due',
            'Payment Submitted And In-Progress',
            'Payment Complete - OTTAWA WEST COMMUNITY SUPPORT SERVICE',
            'RBC PayEdge',
            'RBC: Your verification code for RBCPayEdge',
          ],
        },
        { text_contains: ['You will find in the attached .pdf document the preauthorized payment transactions report that will be processed shortly.', 'RBC PayEdge', 'RBC: Your verification code for RBCPayEdge'] },
        { from_contains: ['+18449282412'] },
      ],
    },
    action: { queue: 'billing', sla: 'standard' },
    replaces: 'Billing & Financial Operations Queue',
  },
  {
    name: 'Financial Operations Rule',
    conditions: {
      any: [
        { subject_contains: ['Warning: The credit cards for', 'IMPORTANT: Credit Card validation failed for booking', 'bookings that need to be charged'] },
        { text_contains: ['These failures could be due to card expiration, insufficient funds, card number change'] },
      ],
    },
    action: { queue: 'financial-operations', sla: 'standard' },
    replaces: 'Financial Operations Rule',
  },
  { name: 'Admin Queue rule', conditions: { text_contains: ['upcoming schedule', 'changes to availability for team'], subject_contains: ['Changes to availability for team', 'upcoming schedule'] }, action: { queue: 'admin' }, replaces: 'Admin Queue rule' },
  { name: 'Operations Queue Rule', conditions: { channel: ['email'], to: [UM.info] }, action: { queue: 'operations', sla: 'standard' }, replaces: 'Operations Queue Rule' },
  { name: 'Billing Routing', enabled: false, conditions: { subject_contains: ['Biller Report For Biller Code', 'Invoice - Reminder: Your payment to UrbanMop Inc. is due'] }, action: { queue: 'billing', sla: 'standard' }, replaces: 'Billing Routing' },
  {
    name: 'HR Queue Rule',
    conditions: {
      any: [
        { from_contains: ['pandadoc'] },
        { to: [UM.hr, UM.careers, 'docs@email.pandadoc.net', UM.smsHiring, 'docs@email.pandadocs.net'] },
        { subject_contains: ['myBackCheck.com Notification', 'Final Touchpoint (15 minutes)'] },
      ],
    },
    action: { queue: 'hr', sla: 'hiring' },
    replaces: 'HR Queue Rule',
  },
  { name: 'Google Reviews Rule', conditions: { any: [{ text_contains: ['it was great'] }, { subject_contains: ['Subject: Ratings email'] }] }, action: { queue: 'google-reviews' }, replaces: 'Google Reviews Rule' },
  { name: 'Jose Queue', conditions: { to: [UM.jose] }, action: { queue: 'jose' }, replaces: 'Jose Queue' },
  { name: 'Payroll Queue Rule', conditions: { any: [{ to: [UM.payroll] }, { text_contains: ['payroll'] }] }, action: { queue: 'payroll', sla: 'hiring' }, replaces: 'Payroll Queue Rule' },
  {
    name: 'Operations Queue (Cleaner Enroute/Check In Delay) Rule',
    conditions: { text_contains: ['Cleaner has not notified of enroute or check in time through the app, 15min remain before the end of the booking arrival window'] },
    action: { queue: 'operations' },
    replaces: 'Operations Queue (Cleaner Enroute/Check In Delay) Rule',
  },
  { name: 'Action from CEL Report route to Operations', conditions: { text_contains: ['Action from CEL Visit Report'] }, action: { queue: 'operations' }, replaces: 'Action from CEL Report route to Operations' },
  // Kustomer's "Customer Success Rule" (off there) only checked a conversation tag, so it is left out.
  { name: 'Route to Customer Success', conditions: { to: [UM.customerSuccess] }, action: { queue: 'customer-success', sla: 'standard' }, replaces: 'Route to Customer Success' },
  { name: 'Accounts Receivables Rule', enabled: false, conditions: { subject_contains: ['Biller Report For Biller Code'] }, action: { queue: 'accounts-receivables', sla: 'standard' }, replaces: 'Accounts Receivables Rule' },
  { name: 'Promo ticket email to sales queue', enabled: false, conditions: { from_contains: ['accountservices@mailchimp.com'] }, action: { queue: 'sales' }, replaces: 'Promo ticket email to sales queue' },

  // ---- From Kustomer business rules: what the queue rules leave ----
  { name: 'Cleaners to Operations', conditions: { contact_role: ['cleaner'] }, action: { queue: 'operations', sla: 'cleaner', priority: 4 }, replaces: 'Cleaner business rule, Cleaner SMS SLA' },
  { name: 'Rating email (ok / not good) to Customer Success', conditions: { text_contains: ['it was ok', "it wasn't good", 'it wasnt good'] }, action: { queue: 'customer-success', sla: 'standard' }, replaces: 'Rating email (ok / not good)' },
  { name: 'Hiring email to HR', conditions: { to: [UM.hiring] }, action: { queue: 'hr', sla: 'hiring' }, replaces: 'Route SMS to Hiring Team, Route to Hiring Team' },
  { name: 'Ottawa SMS to Operations', conditions: { channel: ['sms'], to: [UM.smsOttawa] }, action: { queue: 'operations', sla: 'standard' }, replaces: 'Route SMS to Operations Team' },
  { name: 'Calls to Operations', conditions: { channel: ['voice'] }, action: { queue: 'operations' }, replaces: 'RingCentral Policy' },
  // Kustomer queue rule, last because it never wins: "Sales Queue Rule" above already takes
  // every chat (in Kustomer too). Kept so the rule is there if that changes.
  { name: 'Operations - Chat Rule', conditions: { channel: ['chat'] }, action: { queue: 'operations' }, replaces: 'Operations - Chat Rule' },
];

// Disposition lists, rebuilt from Kustomer's "Reason for Conversation" tree as three
// separate fields. Channel and direction are captured automatically, so they're gone.
export const DISPOSITIONS = {
  audience: ['Customer', 'Lead', 'Cleaner', 'Applicant', 'Vendor or system'],
  reason: [
    'Booking inquiry',
    'New booking or quote',
    'Reschedule',
    'Change of cleaner',
    'Add instructions or modify booking',
    'Cancellation',
    'Cleaner arrival or late',
    'Complaint or feedback',
    'Billing or payment',
    'Refund request',
    'Rating or Google review',
    'Retention or win-back',
    'Cleaner availability',
    'Cleaner pay',
    'Cleaner last-minute cancellation',
    'Applicant inquiry',
    'Interview or onboarding',
    'Equipment pickup',
    'Spam or wrong number',
    'Telemarketer',
    'System notice',
    'Other',
  ],
  outcome: [
    'Resolved',
    'Booking saved',
    'Quote sent',
    'Rescheduled',
    'Cancelled',
    'Cleaner reassigned',
    'Return clean offered',
    'Credit or refund given',
    'Escalated',
    'Left voicemail',
    'No answer',
    'Awaiting customer',
    'No action needed',
  ],
  cancellationReasons: ['Quality of service', 'Budget', 'Schedule change', 'Moving', 'Illness', 'Not disclosed', 'Other'],
};

export const CANNED = [
  { shortcut: 'late', title: 'Cleaner running late', body: 'Hi {{first_name}}, your cleaner is running a little behind and is now expected at {{eta}}. Sorry for the wait, and thank you for your patience!' },
  { shortcut: 'confirm', title: 'Booking confirmed', body: 'Hi {{first_name}}, you are all set for {{next_booking}}. Reply here if anything changes.' },
  { shortcut: 'resched', title: 'Rescheduled', body: 'Hi {{first_name}}, your cleaning has been moved to {{next_booking}}. Let us know if that time doesn\'t work.' },
  { shortcut: 'review', title: 'Google review ask', body: 'Thank you {{first_name}}! If you have a minute, a Google review helps our team a lot: https://g.page/r/urbanmop/review' },
  { shortcut: 'eta', title: 'Ask cleaner for ETA', body: 'Hi {{first_name}}, could you share your ETA for your next booking? The customer is asking. Thanks!', channels: ['sms'] },
  { shortcut: 'sorry', title: 'Sorry about the clean', body: 'Hi {{first_name}}, I\'m sorry the clean didn\'t meet your expectations. Could you tell me which areas were missed? We\'d like to make it right with a return visit.' },
];

// Ontario statutory holidays. Kustomer had none set.
export const HOLIDAYS = [
  ['2026-12-25', 'Christmas Day'],
  ['2026-12-26', 'Boxing Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-02-15', 'Family Day'],
  ['2027-03-26', 'Good Friday'],
  ['2027-05-24', 'Victoria Day'],
  ['2027-07-01', 'Canada Day'],
  ['2027-09-06', 'Labour Day'],
  ['2027-10-11', 'Thanksgiving'],
  ['2027-12-25', 'Christmas Day'],
  ['2027-12-27', 'Boxing Day (observed)'],
];

// Idempotent: only fills empty tables, so admin changes are never overwritten.
export async function seed(db) {
  const count = async (table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  if (!(await count('queues'))) {
    for (const [i, q] of QUEUES.entries()) {
      await db.query('INSERT INTO queues (slug, name, description, restricted, position) VALUES ($1,$2,$3,$4,$5)', [q.slug, q.name, q.description, !!q.restricted, i]);
    }
  }
  if (!(await count('sla_policies'))) {
    for (const p of SLA_POLICIES) {
      await db.query('INSERT INTO sla_policies (slug, name, first_response_minutes, warn_minutes) VALUES ($1,$2,$3,$4)', [p.slug, p.name, p.first_response_minutes, p.warn_minutes ?? 2]);
    }
  }
  if (!(await count('routing_rules'))) {
    for (const [i, r] of RULES.entries()) {
      await db.query('INSERT INTO routing_rules (position, name, enabled, conditions, action, replaces) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)', [(i + 1) * 10, r.name, r.enabled !== false, json(r.conditions), json(r.action), r.replaces || null]);
    }
  }
  if (!(await count('canned_responses'))) {
    for (const c of CANNED) {
      await db.query('INSERT INTO canned_responses (shortcut, title, body, channels) VALUES ($1,$2,$3,$4::jsonb)', [c.shortcut, c.title, c.body, json(c.channels || [])]);
    }
  }
  if (!(await count('holidays'))) {
    for (const [day, name] of HOLIDAYS) await db.query('INSERT INTO holidays (day, name) VALUES ($1,$2)', [day, name]);
  }
  await seedWorkforce(db);
}
