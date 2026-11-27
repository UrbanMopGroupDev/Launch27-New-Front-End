// The Complaint record, copied from Kustomer's Complaint object (read Nov 26, 2026 from the
// live account: 1,178 complaints and the saved searches). Picklist options are the values in
// use there, spelled as Kustomer spells them. `k` is the Kustomer custom field each one loads from.

const YES_NO = ['Yes', 'No'];

export const STATUSES = [
  'For Review',
  'Awaiting client response',
  'Damaged item for repair/reimbursement in process',
  'To schedule a reclean',
  'Reclean scheduled',
  'For refund',
  'Complaint Resolved | For Internal Investigation',
  'Closed',
];

const COMPLAINT_TYPES = [
  'Quality of Cleaning',
  'Assignment of Cleaner',
  "Complaint but Client's Fault",
  'Damage/Broken Item',
  'Lack of Equipment/Supplies',
  'Not a Complaint, but a Knowledge Gap Causing MIA',
  'Not a Complaint, but an Internal Team Error Causing MIA',
  'Behavior of the Cleaner',
  'Punctuality',
  'Scheduling',
  'Duration Conflict (Reported Time Mismatch)',
  'Unclear Policy Complaint',
  "Not following Client's Instruction",
  'Due to Health/Safety Risks',
  'Personal Hygiene',
];

export const PANELS = [
  { key: 'info', label: 'Complaint Information' },
  { key: 'resolution', label: 'Resolution Information' },
  { key: 'approval', label: 'Approval' },
  { key: 'category', label: 'Complaint Category' },
];

// type: text | long | date | number | select, or a name linked to a record:
//   cleaner (Launch27 cleaner, id in cleaner_id), customer (contact, id in contact_id),
//   user (a staff login, id in <key>_user_id). The name is kept too, as shown and as Kustomer had it.
export const FIELDS = [
  { key: 'status', label: 'Status', type: 'select', options: STATUSES, panel: 'info', k: 'statusStr' },
  { key: 'complaint_created_on', label: 'Complaint Created On', type: 'date', panel: 'info', k: 'complaintCreatedOnAt' },
  { key: 'original_service_date', label: 'Original Service Date', type: 'date', panel: 'info', k: 'originalServiceDateAt' },
  { key: 'cleaner_name', label: 'Cleaner Name', type: 'cleaner', id: 'cleaner_id', panel: 'info', k: 'cleanerNameStr' },
  { key: 'type_of_service', label: 'Type of Service', type: 'select', options: ['Regular Cleaning', 'Deep Cleaning', 'Move In/Out', 'Hourly Cleaning', 'Homemaking', 'Prepaid Package', 'Airbnb Cleaning', 'Commercial Cleaning', 'Carpet Cleaning'], panel: 'info', k: 'typeOfServiceStr' },
  { key: 'frequency', label: 'Frequency', type: 'select', options: ['One Time', 'Weekly', 'Bi-weekly', 'Monthly'], panel: 'info', k: 'frequencyStr' },
  { key: 'complaint_notes', label: 'Complaint Notes', type: 'long', panel: 'info', k: 'complaintNotesTxt' },
  { key: 'cleaner_feedback', label: 'Cleaner Feedback', type: 'long', panel: 'info', k: 'cleanerFeedbackTxt' },
  { key: 'received_photos', label: 'Received Photos', type: 'select', options: YES_NO, panel: 'info', k: 'receivedPhotosStr' },
  { key: 'customer_name', label: 'Customer Name', type: 'customer', id: 'contact_id', panel: 'info', k: 'customerNameStr' },
  { key: 'ltv_of_client', label: 'LTV of Client', type: 'number', panel: 'info', k: 'ltvOfClientStr' },
  { key: 'due_date', label: 'Due Date', type: 'date', panel: 'info', k: 'dueDateAt' },
  { key: 'location', label: 'Location', type: 'text', panel: 'info', k: 'locationStr' },
  { key: 'case_opened_by', label: 'Case Opened By', type: 'user', id: 'case_opened_by_user_id', panel: 'info', k: 'osNameStr' },
  { key: 'cs_agent', label: 'CS Agent', type: 'user', id: 'cs_agent_user_id', panel: 'info', k: 'csAgentStr' },

  { key: 'proposed_solution', label: 'Proposed Solution', type: 'long', panel: 'resolution', k: 'proposedSolutionTxt' },
  { key: 'reclean_scheduling_required', label: 'Reclean Scheduling Required', type: 'select', options: ['Yes', 'Done'], panel: 'resolution', k: 'recleanSchedulingRequiredStr' },
  { key: 'final_resolution_category', label: 'Final Resolution Category', type: 'select', options: ['Reclean', 'No Action Required', 'Complimentary Clean', 'Partial Refund', 'Full Refund', 'Partial Refund & Complimentary Clean', 'Discount on next appointment', 'Complimentary Add-ons', 'Complimentary Add-ons plus Discount', 'Reimbursement/Repair Reimbursement', 'Gift Card', 'Others'], panel: 'resolution', k: 'finalResolutionCategoryStr' },
  { key: 'final_resolution_details', label: 'Final Resolution Details', type: 'long', panel: 'resolution', k: 'finalResolutionDetailsTxt' },
  { key: 'is_client_fully_satisfied', label: 'Is the client fully satisfied?', type: 'select', options: ['Yes', 'No', 'Maybe, client is unresponsive'], panel: 'resolution', k: 'isTheClientFullySatisfiedStr' },
  { key: 'input_into_um_portal', label: 'Input into UM Portal?', type: 'select', options: YES_NO, panel: 'resolution', k: 'inputIntoUmPortalStr' },
  { key: 'case_closed_by', label: 'Case Closed By', type: 'user', id: 'case_closed_by_user_id', panel: 'resolution', k: 'caseClosedByYourNameStr' },
  { key: 'closed_date', label: 'Closed Date', type: 'date', panel: 'resolution', k: 'closedDateAt' },

  { key: 'manager_approval', label: 'Manager Approval', type: 'user', id: 'manager_approval_user_id', panel: 'approval', k: 'managerApprovalStr' },
  { key: 'manager_impact_assessment', label: 'Manager Impact Assessment', type: 'text', panel: 'approval', k: 'managerImpactAssessmentStr' },
  { key: 'at_risk_mia_amount', label: 'At Risk MIA Amt (Not Applied Yet)', type: 'number', panel: 'approval', k: 'atRiskMiaAmtNotAppliedYetNum' },
  { key: 'mia_categories', label: 'MIA Categories', type: 'select', options: ['Expenses related to recleans or poor-quality cleanings', 'Damages and reimbursements', 'Lack of Knowledge Process', 'Losses caused by internal team errors or mistakes', 'Lack of equipment and supplies'], panel: 'approval', k: 'miaCategoriesStr' },

  { key: 'complaint_type', label: 'Complaint Type', type: 'select', options: COMPLAINT_TYPES, panel: 'category', k: 'complaintTypeStr' },
  { key: 'complaint_type_2', label: 'Complaint Type 2', type: 'select', options: COMPLAINT_TYPES, panel: 'category', k: 'complaintType2Str' },
  { key: 'complaint_category', label: 'Complaint Category', type: 'select', options: ['Cleaner', 'Operational', 'False'], panel: 'category', k: 'complaintCategoryStr' },
  { key: 'complaint_sub_category', label: 'Complaint Sub Category', type: 'select', options: ['Quality', 'Damage/ Broken Item', 'Behaviour', 'Not following Client Instructions', 'Attendance', 'Lack of Equipment'], panel: 'category', k: 'complaintSubCategoryStr' },
  { key: 'complaint_sub_category_2', label: 'Complaint Sub Category 2', type: 'select', options: ['Sales- Expectation conflict', 'Assignment of cleaner', 'Internal team Error', 'Sales - Duration Conflict', 'Unclear Policy Complaint'], panel: 'category', k: 'complaintSubCategory2Str' },
  { key: 'complaint_sub_category_3', label: 'Complaint Sub Category 3', type: 'select', options: ['Client Knowledge Gap', 'Client Error'], panel: 'category', k: 'complaintSubCategory3Str' },
  { key: 'tier_level', label: 'Tier Level', type: 'select', options: ['Tier 1', 'Tier 2', 'Tier 3'], panel: 'category', k: 'tierLevelStr' },
];

export const FIELD_KEYS = FIELDS.map((f) => f.key);
// Staff names linked to a login: { key, id }.
export const USER_LINKS = FIELDS.filter((f) => f.type === 'user').map((f) => ({ key: f.key, id: f.id }));
const empty = (col) => `COALESCE(r.${col}, '') = ''`;
const statusIs = (s) => `lower(r.status) = '${s.toLowerCase()}'`;

// Kustomer's saved searches under "Complaint Tracking", in its order, with its filters.
// `where` is fixed SQL (no user input). `sort` is the view's own order when the user picks none.
export const VIEWS = [
  { slug: 'for-review', name: 'For Review', where: statusIs('For Review') },
  { slug: 'awaiting-client-response', name: 'Awaiting client response', where: statusIs('Awaiting client response') },
  { slug: 'damaged-item', name: 'Damaged Item - Pending for Repair/Reimbursement', where: statusIs('Damaged item for repair/reimbursement in process') },
  { slug: 'to-schedule-a-reclean', name: 'To Schedule a Reclean', where: statusIs('To schedule a reclean') },
  { slug: 'reclean-scheduled', name: 'Reclean scheduled', where: statusIs('Reclean scheduled') },
  { slug: 'for-refund', name: 'For Refund', where: statusIs('For refund') },
  { slug: 'monetary-impact-assessment', name: 'Monetary Impact Assessment', where: `${statusIs('Closed')} AND ${empty('manager_impact_assessment')}` },
  { slug: 'all-closed', name: 'All Closed Complaints', where: `${statusIs('Closed')} AND NOT (${empty('manager_impact_assessment')})` },
  { slug: 'overview', name: 'All Complaints Overview', where: 'r.original_service_date IS NOT NULL' },
  { slug: 'um-portal-required', name: 'Input to UM Portal Required', where: empty('input_into_um_portal'), sort: 'rating_days_left' },
  { slug: 'no-mia-categories', name: 'No MIA Categories yet', where: empty('mia_categories') },
  { slug: 'um-portal-positive', name: 'Input to UM Portal - Positive Feedback', kind: 'conversations' },
  { slug: 'resolved-internal', name: 'Complaint Resolved | For Internal Investigation', where: statusIs('Complaint Resolved | For Internal Investigation') },
];

// The list's columns, as in Kustomer's complaint searches.
export const LIST_COLUMNS = [
  { key: 'created_at', label: 'Created' },
  { key: 'customer_name', label: 'Customer Name' },
  { key: 'ltv_of_client', label: 'LTV of Client' },
  { key: 'due_date', label: 'Due Date' },
  { key: 'cleaner_name', label: 'Cleaner Name' },
  { key: 'assigned_user', label: 'Assigned User' },
  { key: 'case_opened_by', label: 'Case Opened By' },
  { key: 'original_service_date', label: 'Original Service Date' },
  { key: 'proposed_solution', label: 'Proposed Solution' },
  { key: 'complaint_notes', label: 'Complaint Notes' },
  { key: 'input_into_um_portal', label: 'Input into UM Portal?' },
  { key: 'tier_level', label: 'Tier Level' },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Checks one field's value from a request. Returns the value to store, or throws { status: 400 }. */
export function cleanValue(field, value) {
  const bad = (msg) => Object.assign(new Error(`${field.label}: ${msg}`), { status: 400 });
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 'date') {
    if (!DAY.test(String(value))) throw bad('use a date');
    return String(value);
  }
  if (field.type === 'number') {
    const n = Number(String(value).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) throw bad('use a number');
    return n;
  }
  const text = String(value);
  if (field.type === 'select' && !field.options.includes(text)) throw bad('pick one of the listed options');
  if (text.length > (field.type === 'long' ? 20_000 : 500)) throw bad('too long');
  return field.type === 'long' ? text : text.trim();
}
