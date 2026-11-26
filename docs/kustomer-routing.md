# Queues, routing and teams from Kustomer

The support inbox's queues, routing rules and teams follow Kustomer's routing configuration
(routing export of Nov 25, 2026: 14 live queues, 22 queue rules, 18 teams with a routing
profile). It uses the existing structure: queues, ordered routing rules (first match wins)
and teams that work queues, all editable in Support settings.

- New databases get it from `server/src/inbox/seed.js` (queues, rules) and
  `server/src/inbox/workforce.js` (teams).
- Databases seeded before it are moved to it once by migration
  `server/migrations/0036_kustomer_routing.sql` (generated from those two files).

## Queues

Kustomer's names and descriptions. Deleted Kustomer queues (Complaints, Outstanding
Payments, Nader Queue, Voice Test, Scheduling Queue ×3, the old Cleaner Enroute queue) are
not brought over.

| Queue | Slug | Teams that work it |
| --- | --- | --- |
| Operations Queue | `operations` | (8AM-6PM)Operations Team, (After 6PM & Weekend)Operations Team |
| Sales Queue | `sales` | Sales Team, Sales Squad, Sales Master, Customer Success & Sales Queue, (After 6PM & Weekend)Operations Team |
| Sales Overflow(Cart Abandonment) | `sales-overflow` | Sales Overflow, Sales Master, Customer Success & Sales Queue |
| Customer Success | `customer-success` | Customer Success, Customer Success & Sales Queue |
| Billing Queue | `billing` | Billing & Financial Operations, Financial Operations & Billing Team |
| Financial Operations | `financial-operations` | Billing & Financial Operations |
| Accounts Receivables | `accounts-receivables` | none (as in Kustomer) |
| Management Queue | `management` | Management Team |
| HR Queue (private) | `hr` | HR Team |
| Payroll Queue (private) | `payroll` | Payroll Team |
| Jose Queue | `jose` | Jose Queue |
| Google Reviews | `google-reviews` | none (as in Kustomer) |
| Admin | `admin` | Admin |
| Default Queue | `fallback` | (8AM-6PM)Operations Team, (After 6PM & Weekend)Operations Team |

Kustomer has a single HR Queue for hr@, careers@ and the hiring line, so the old **Hiring**
queue is merged into it (the migration moves its conversations, direct members and overflow
settings). Email Team, Voice Team and Scheduling Team have no queues in Kustomer and none
here. Kustomer's two routing-less teams (a second, empty "HR Team" and "Operations Sales")
are left out.

Team members are not in the export by email, so they are set in Support settings → Agents
or Teams. The migration moves members of the five old default teams to the team(s) working
the same queues: Customer care → (8AM-6PM)Operations Team and Customer Success; Sales →
Sales Team; Finance → Billing & Financial Operations and Payroll Team; People → HR Team;
Management → Management Team. Kustomer's capacity per team (5, 7 or 20) has no equivalent:
capacity here is per agent and channel (Agents tab, Routing policies).

## Rule order

1. **Kept from Kustomer business rules** (not in the routing export), because they close,
   redact or escalate before queue routing: system notices marked done, bank verification
   codes redacted, Stripe disputes and "Derek/Leslie for review" or management@ to
   Management Queue.
2. **Kustomer's queue rules**, in Kustomer's order and with Kustomer's names; the four that
   are off in Kustomer are off here.
3. **Kept from Kustomer business rules**, for what the queue rules leave: cleaners to
   Operations (5-minute reply target), "it was ok / it wasn't good" ratings to Customer
   Success, hiring@ to HR Queue, texts to the Ottawa number and calls to Operations.
4. Kustomer's "Operations - Chat Rule" last: it never wins, because "Sales Queue Rule" above
   it takes every chat (in Kustomer too).
5. Anything else: Default Queue.

Reply targets and priorities on the Kustomer rules (which Kustomer's queue rules don't set)
are taken from the rules they replace, e.g. quote 10 min and high priority for Sales Queue
Rule, cart 30 min for cart abandonment, hiring 12 h for HR and Payroll.

## How Kustomer's conditions read here

| Kustomer field | Here |
| --- | --- |
| message subject, message meta subject, conversation name | Subject includes |
| message preview, klass title / text | Message includes (subject or body) |
| message meta to, message meta recipient email | Sent to |
| message meta from, customer email, customer name | Sender includes |
| customer lead follow-up | Lead stage is |
| conversation channel | Channel |

- "equals" reads as "includes"; matching is not case-sensitive.
- **Conversation tags** are left out. A new conversation has no tags when it is routed here,
  so "tags include" could never match and "tags don't include" always does. This drops one
  "or" option from Sales Queue Rule and the whole of Kustomer's "Customer Success Rule"
  (off in Kustomer, tag only).
- Facebook and Instagram aren't channels here, so "Facebook or Instagram to Sales Queue"
  matches its conversation-name words ("New Facebook Lead", "Lead Reactivation for Move In
  Move Out").
- Financial Operations Rule's long Launch27 paragraph is shortened to its first sentence,
  so line breaks or spacing in the email can't stop it matching.

## Kustomer behaviour kept as is

These follow from Kustomer's order and may be worth changing in Support settings → Routing:

- **Operations Queue Rule** (any email to info@) is 10th of Kustomer's 22, so email to info@
  goes to Operations before HR Queue Rule, Google Reviews Rule, Payroll Queue Rule, the CEL and
  Cleaner Enroute rules and Route to Customer Success are checked. Those rules only catch
  messages sent elsewhere (other addresses, texts).
- **Sales Queue Rule** sends every chat, and any message containing "quote" or
  "new request", to Sales Queue.
- **Payroll Queue Rule** sends any message mentioning "payroll" (outside info@) to the private
  Payroll Queue.

## Agents added ahead of sign-in

People normally appear in Support settings after their first sign-in. Migration 0036 adds
mabutecarmelad@gmail.com, khaje91aquino@gmail.com and simon@urbanmop.ca as agents (offline,
no teams) so admins can put them on teams now; signing in later uses the same account.
They're only added to databases someone has already signed in to, so on a new database the
first person to sign in still becomes admin.

## Undoing

The migration writes the old rule list and old teams (members and queues) to the change
history (`audit_log`, actions `rules.replaced` and `teams.replaced`, `detail.before`),
visible to supervisors at `/api/audit?object_type=routing_rules` and `?object_type=teams`.
