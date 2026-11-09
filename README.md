# Nexora Academy — Centralized Management Portal (nexoraed.com)

A role-based web portal covering the full student journey from the SRS v1.0:

**Lead → Enquiry → Counselling → Application → Admission → Student → Course/Batch → Finance → Attendance → Assessment → Examination → Result → Certificate → Reports → Dashboard**

WhatsApp messaging runs through **Chatwoot** (`app.aiingo.com`), using your WhatsApp inbox ID and API access token.

| Part | Stack |
|---|---|
| `backend/` | TypeScript, Express 5 on **Cloudflare Workers** (Node.js compatibility), Prisma 7 on **Cloudflare D1**, zod, JWT, PDFKit |
| `frontend/` | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, Recharts |
| Hosting | One Cloudflare Worker serves the React app (static assets) and the API; files in private **R2**; jobs on **Cron Triggers**; deployed by **Workers Builds** from GitHub |

---

## What's included

### Public website (no login)
- Home page with a hero, a callback form, course cards, a "why Nexora" section and the admission steps; a floating WhatsApp button
- Course catalogue with search and category filter, plus course detail pages (curriculum, fee breakup with GST, upcoming batches with seats left)
- **Online student registration** in 5 steps: course/batch → personal → guardian & education → document upload → review. It checks inline that applicants under 18 give a guardian (STU-07) and that mandatory documents are attached.
- Application tracking (application number + mobile) and certificate verification by code
- Every enquiry or application creates a CRM lead (with duplicate detection), assigns a counselor round-robin and sends a WhatsApp acknowledgement

### Staff portal (`/staff`) — menus are filtered by RBAC
| Module | Highlights |
|---|---|
| **Dashboard** | Role-specific widgets (§16): management KPIs and trends, admin queues, sales funnel/sources/leaderboard, finance ageing and targets, academic attendance/workload, faculty "to mark", exam queues, approvals awaiting me |
| **CRM** | Leads in table or kanban view (drag to change stage). Duplicate check while typing. Auto/bulk assignment with a reason. CSV import with column mapping, skip or merge for duplicates, and an error report. CSV export. Pipeline statuses, with a reason required for lost/junk. Timeline of calls, WhatsApp, email and meetings (read-only once saved). Follow-ups with reminders. Counselling sessions. Merging duplicates. Lead → application → admission request. |
| **WhatsApp inbox** | Live Chatwoot conversations linked to leads and students. Chat panel on every lead and student. Quick replies. Approved templates for use outside the 24h window. Bulk sends to selected leads or a whole batch. Resolve/reopen. |
| **Students** | Search and filters (course, batch, status, admission date, fee status) with CSV export. Direct registration. Unified profile: personal, guardians, education, fees, attendance, results, documents (upload/verify/reject), immutable history. Status changes need a reason. Batch transfers go through approval. Photo upload. Flags for missing mandatory documents. |
| **Finance** | Fee structure per course (with GST and effective dates). Fee plan and installments generated on admission, with sequential invoices. Payments use an idempotency key, are allocated FIFO and produce **PDF receipts**. Cancellation only through approval and a reversing entry. Discounts and scholarships (self-approval up to a limit, then workflow). Refunds (approval, then pay with a reference). **Immutable ledger**. Outstanding fees with ageing buckets. Collections by day, mode, course and collector. Reconciliation. WhatsApp/email reminders. |
| **Academics** | Courses → subjects → modules, with completion tracking. Batches with capacity, status and faculty allocation. Weekly timetable with **clash detection** (batch, faculty, room) and repeat-weekly. Publishing notifies students. Attendance marking (P/A/L/E). Edits after the window go to approval. Low-attendance alerts. |
| **Examinations** | Question bank (MCQ single/multi, true/false, short, long; negative marks; CSV import; retire). Exams with eligibility rules (fees, attendance) and exceptions via approval. Student clash detection. Schedule & notify. **Online exam engine** (below). Manual evaluation. Offline marks entry. Process, lock and publish results. Result correction via approval. **Certificates** with verification code and PDF. |
| **Approvals** | Configurable multi-level workflows with conditional amount thresholds. Approve, reject or return (comment required). Self-approval blocked. Requester notified. |
| **Reports** | 12 reports: students, batch strength, admissions, leads, funnel, lost reasons, counselor performance, collections, discounts/refunds, ledger, attendance, exam results. Date filters, CSV export, print to PDF. |
| **Admin** | Users (deactivate, never delete; temporary password; bulk import), roles & permission editor, departments, master data, system settings (ID formats, security policy, CRM/finance/academic/exam rules), approval workflows, versioned notification templates, **WhatsApp (Chatwoot) settings** |
| **Audit** | Append-only audit trail with before/after values, plus login, notification-delivery and integration-call logs |

### Student portal (`/student`) — mobile-first, with bottom navigation
Home (fee balance and next due, attendance, upcoming classes, exams, results) · timetable with attendance status · fees & PDF receipts · **online exams** · results & certificate download · materials & assignment submission · profile.

**Online exam player:** shows instructions that must be acknowledged, then runs a server-authoritative timer. Answers auto-save every 5 seconds and the exam auto-submits on timeout. Questions and options are shuffled. There is a question palette with flag-for-review. Tab switches are logged, and the server enforces attempt limits. Correct answers are never sent to the browser.

---

## WhatsApp via Chatwoot (app.aiingo.com)

**How it works:**
- **Outgoing:** Nexora → Chatwoot API. The API finds or creates the contact by phone and attaches it to your WhatsApp inbox, finds or creates the conversation, then posts the message (free-form, or an approved WhatsApp template via `template_params`).
- **Incoming:** Chatwoot webhook → `POST /api/v1/webhooks/chatwoot?token=<secret>`. The message is matched to a lead or student by phone. Unknown numbers become new auto-assigned leads (source "WhatsApp"). The message is logged on the lead timeline and the owner counselor gets an in-app notification. Delivery/read updates are written to the notification log.
- **Automatic messages** (templates under Settings → Notification templates): enquiry and application received, admission confirmed (with portal login), payment receipt, fee reminders before and after the due date, exam scheduled, result published, result corrected, certificate issued, password reset.

**Setup** (Super Admin → **Settings → WhatsApp (Chatwoot)**):
1. **Chatwoot URL:** `https://app.aiingo.com`
2. **Account ID:** the number in `https://app.aiingo.com/app/accounts/<ID>/…`
3. **WhatsApp inbox ID:** Chatwoot → Settings → Inboxes → your WhatsApp inbox (the number in its URL)
4. **API access token:** Chatwoot → Profile settings → Access token. It is stored AES-256-GCM encrypted and never shown again.
5. Click **Generate secret**, then **Save**, then **Test connection**.
6. In Chatwoot → Settings → Integrations → **Webhooks**, add the URL shown on the page (`https://nexoraed.com/api/v1/webhooks/chatwoot?token=…`) and select *Message created* and *Message updated*.
7. For messages outside WhatsApp's 24-hour window, enter the **approved template name** on each notification template. `{{placeholders}}` map to `{{1}}`, `{{2}}`… in the order they appear.

You can also provide these values as environment variables (`CHATWOOT_*` in `backend/.env.example`).

---

## Running locally
Everything runs on this computer with Cloudflare's local runtime (local D1 database and R2 bucket in `.wrangler/`);
no Cloudflare account is used.
```bash
npm install && npm --prefix frontend install && npm --prefix backend install
cp .dev.vars.example .dev.vars                         # local-only settings (never real secrets)
npm run dev                                            # builds the app, applies migrations locally, http://localhost:8787
npm --prefix backend run db:seed:demo                  # optional synthetic demo data (refused in production)
npm --prefix backend run admin:bootstrap:dev -- --email you@example.com --name "Your Name" --username you
npm run dev:web                                        # optional: Vite hot reload on :5173 (proxies /api to :8787)
```

### Accounts
No account or password is ever seeded. The first Super Administrator gets a single-use 60-minute activation link
(locally: `admin:bootstrap:dev`; on Cloudflare: `POST /api/v1/auth/bootstrap` while the `BOOTSTRAP_TOKEN` secret is set,
see below). The owner sets a policy-compliant password and must then enrol an authenticator app. A second named
Super Administrator (`--second` with a management nomination) is needed because privileged role grants require
approval by another Super Administrator. Privileged roles (Super Admin, Administrator, Management, Finance) must use MFA.

Demo data (refused in production) creates synthetic users with `@example.invalid` emails:
| Username | Role |
|---|---|
| `director` | Management |
| `office` | Administrator |
| `salesmgr` | Sales Manager |
| `counselor1`, `counselor2` | Counselor |
| `finmgr` / `accounts` | Finance Manager / Finance Staff |
| `acadmgr` | Academic Manager |
| `faculty1`, `faculty2` | Faculty |
| `examofficer` | Examination Officer |

Students get their login (Student ID plus a single-use activation link) on WhatsApp/email when they are admitted.

### Tests
```bash
npm test        # 340+ tests against a real local D1 + R2 (Cloudflare's runtime), recreated on each run
```

---

## Deploying on Cloudflare
Architecture: **Workers** (site + API) · **D1** (database) · **R2** (private documents) · **Cron Triggers** ·
**Workers Secrets** · **WAF / rate limiting / Turnstile / Access** · **Workers Builds** (GitHub). Staging and
production are separate Workers with separate databases, buckets and secrets (`wrangler.jsonc`, `env.staging`).
Nobody runs Wrangler by hand: Workers Builds applies the database migrations and deploys on every push.

Workers Builds settings (Dashboard → Workers → the Worker → Settings → Build):
| | Production `nexoraedu` | Staging `nexoraedu-staging` |
|---|---|---|
| Branch | `main` (non-production branch builds **off**) | the staging branch |
| Build command | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` | `npx wrangler d1 migrations apply DB --remote --env staging && npx wrangler deploy --env staging` |

Staging: https://nexoraedu-staging.nexoraacademy.workers.dev, built from the `cloudflare-backend` branch
(D1 `nexora-erp-staging`, R2 `nexora-files-staging`). Synthetic data only.

Secrets (Worker → Settings → Variables and Secrets; different values for staging and production, 32+ random bytes):
`JWT_SECRET`, `APP_ENCRYPTION_KEY` (64 hex chars), `BOOTSTRAP_TOKEN` (only until the first Super Administrator
exists), and later `CHATWOOT_*` / `SMTP_*`. The Worker answers 503 instead of serving while a required secret is
missing or weak.

Migrations: `backend/migrations/*.sql` (generated from the Prisma schema with `npm --prefix backend run db:migrations:generate`;
later schema changes are new numbered files). Backups: D1 Time Travel (point-in-time restore) plus R2.

## Security & data integrity (SRS §18, §20, §24)
- Server-side sessions: short-lived access tokens held in memory, refresh token only in an HttpOnly/Secure/SameSite=Strict cookie with rotation and reuse detection; server-side idle timeout; users can view and end sessions. Deactivation, role and password changes apply on the next request.
- MFA (TOTP authenticator + recovery codes), mandatory for Super Admin, Administrator, Management and Finance roles.
- Password policy: ≥10 characters, 3 character classes, common/personal passwords blocked, last 5 not reusable, bcrypt cost 12. Account lock after failed logins with identical generic errors. Forced password change enforced by the API.
- RBAC on every API route, plus object-level scoping (`src/lib/policy.ts`): counselors see only their own leads and the students converted from them, faculty only their batches, students only their own records; identity documents only for administrators, the owning counselor and admission reviewers.
- Only a Super Administrator manages privileged accounts; privileged role grants need a second Super Administrator's approval; nobody changes their own roles. Approvals fail closed and nobody approves their own request.
- Rate limiting: sign-in, MFA, refresh, password reset and public forms are counted in D1 (shared by every Worker instance); a general per-instance API limit; Cloudflare WAF rules at the edge. Helmet headers. zod validation on every input. Parameterised queries (Prisma). CSV-injection guard on exports.
- **Every change is one atomic D1 batch** (`backend/src/lib/db.ts`): the business rows and their audit row commit together or not at all; concurrent changes to the same student account, approval or batch are serialised with optimistic locks and retried. Database triggers (`backend/migrations/0002_rules.sql`) make `audit_logs`, `ledger_entries`, `lead_activities`, `student_history`, `login_logs`, `approval_actions` and `integration_logs` append-only, keep enrollment and fee-adjustment history undeletable, keep every amount at 2 decimals and stop an installment from being overpaid. Corrections are reversing entries. Viewing logs and exporting data are themselves audited.
- Integration credentials are encrypted at rest (AES-256-GCM). Every Chatwoot call is logged in `integration_logs`. Webhooks are verified (token, or HMAC signature plus timestamp).
- Uploads: type, size and content-signature checks, random file names, stored in a private R2 bucket; documents and student photos served only through authenticated, scoped endpoints.

## Not yet included / next steps
- A **live payment gateway** checkout: the webhook and reconciliation are ready; the provider (Razorpay / PayU) needs to be chosen
- **SMS gateway** adapter (the notification engine supports adding channels)
- Scheduled e-mailing of reports, saved filters and dashboard widget re-ordering (should/could items)
- Future scope listed in SRS §30: mobile app, AI CRM, chatbot, biometric attendance, HR/payroll, multi-branch
