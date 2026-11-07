# Nexora Academy — Centralized Management Portal (nexoraed.com)

A role-based web portal covering the full student journey from the SRS v1.0:

**Lead → Enquiry → Counselling → Application → Admission → Student → Course/Batch → Finance → Attendance → Assessment → Examination → Result → Certificate → Reports → Dashboard**

WhatsApp messaging runs through **Chatwoot** (`app.aiingo.com`), using your WhatsApp inbox ID and API access token.

| Part | Stack |
|---|---|
| `backend/` | Node 22, Express, TypeScript, Prisma, PostgreSQL 16, zod, JWT, PDFKit |
| `frontend/` | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, Recharts |
| Deploy | Docker Compose (Postgres, API, nginx serving the SPA and proxying `/api`) |

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

Requirements: Node 22+ and PostgreSQL 16.

```bash
# 1. Database
createuser -P nexora && createdb -O nexora nexora      # password: nexora

# 2. API
cd backend
cp .env.example .env                                   # adjust DATABASE_URL etc.
npm install
npx prisma migrate deploy                              # schema + immutability triggers
npm run db:seed:reference                              # roles, masters, templates, workflows (no users)
APP_ENV=development npm run db:seed:demo               # optional synthetic demo data; prints one-time passwords
npm run admin:bootstrap:dev -- --email you@example.org --name "Your Name" --username you   # first Super Admin (activation link)
npm run dev                                            # http://localhost:4000  (Swagger: /api/docs, development only)

# 3. Web
cd ../frontend
npm install
npm run dev                                            # http://localhost:5173  (proxies /api to :4000)
```

### Accounts
No account or password is ever seeded. The first Super Administrator is created with `npm run admin:bootstrap`
(single-use 60-minute activation link; the owner sets a policy-compliant password and must then enrol an
authenticator app). A second named Super Administrator is created with `--second` (needed because privileged
role grants require approval by another Super Administrator). Privileged roles (Super Admin, Administrator,
Management, Finance) must use MFA.

Demo data (`db:seed:demo`, refused in production) creates these synthetic users with random one-time passwords
and `@example.invalid` emails:
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

Students get their login (Student ID, e.g. `nxa-2026-00001`, plus a temporary password) on WhatsApp/email when they are admitted. They must change the password at first sign-in (enforced by the API).

Existing installations created with the old seed: run `npm run accounts:legacy` (dry run) to find the old
default `admin / Admin@12345` and demo accounts, then `-- --apply` (after approval) to deactivate them.
Staging/production refuse to start while such accounts are active.

### Tests
```bash
cd backend && npm test      # TEST_DATABASE_URL (default: local postgres nexora_test, owner must have CREATEROLE); resets it each run
                            # tests connect as a restricted role created from prisma/sql/app-role.sql
```
The end-to-end suite covers: auth and RBAC, duplicate detection, lost-reason enforcement, online application with a document upload (and the under-18 guardian rule), the admission approval chain (including no self-approval), fee plan maths, idempotent payments, overpayment blocking, ledger immutability, payment cancellation with reversal, the online exam (answers hidden, auto-grading, attempt limit, unpublished results hidden), role-specific dashboards, the append-only audit log, and the inbound Chatwoot webhook creating a lead.

---

## Deploying on Cloudflare (nexoraed.com)

```
Browser ──▶ Cloudflare Worker "nexoraedu"  (static site + portals, wrangler.jsonc)
               └─ /api/*, /health ──▶ Cloudflare Tunnel (api.nexoraed.com)
                                        └─ server: docker compose → API + PostgreSQL + nightly backup
Chatwoot (app.aiingo.com) webhooks ──▶ https://nexoraed.com/api/v1/webhooks/chatwoot
```

**1. Worker (Cloudflare dashboard → Workers & Pages → Create → Import a repository → `hussainhabeebi/nexoraedu`)**

| Setting | Value |
|---|---|
| Project name | `nexoraedu` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Production branch | `main` |
| Root directory | `/` (leave empty) |
| Build variable | `NODE_VERSION` = `22` |

After the first deploy go to Worker → Settings:
- **Variables and Secrets:** check that `API_ORIGIN` = `https://api.nexoraed.com` (it comes from `wrangler.jsonc`). Add the secret **`PROXY_SECRET`** with the same value as in `deploy/.env`.
- **Domains & Routes:** add the custom domains `nexoraed.com` and `www.nexoraed.com`.

**2. Backend server + Cloudflare Tunnel**
1. Zero Trust → Networks → **Tunnels → Create tunnel** (Cloudflared, Docker) → copy the token. Add a public hostname `api.nexoraed.com` → service `http://api:4000`.
2. On any Linux server with Docker:
   ```bash
   git clone https://github.com/hussainhabeebi/nexoraedu && cd nexoraedu
   cp deploy/.env.cloudflare.example deploy/.env   # secrets, tunnel token, PROXY_SECRET, Chatwoot
   docker compose -f deploy/docker-compose.cloudflare.yml --env-file deploy/.env up -d --build
   ```
   Then run the release step and create the first Super Administrator (the API no longer migrates or seeds on start):
   `docker compose -f deploy/docker-compose.cloudflare.yml --env-file deploy/.env run --rm api npm run release` and
   `… run --rm api npm run admin:bootstrap -- --email … --name … --username …`.
   Recommended: run the API as the restricted DB role from `backend/prisma/sql/app-role.sql`.
   To update: `git pull && docker compose -f deploy/docker-compose.cloudflare.yml --env-file deploy/.env up -d --build`.

**3. Go-live checklist**
- Open the activation link from `admin:bootstrap`, set a password and enrol MFA.
- Settings → General: academy phone, WhatsApp number and address.
- Settings → WhatsApp: Account ID, inbox ID, token → Test connection. Then add the webhook in Chatwoot.
- Create staff users. Review courses, fees and batches.

GitHub Actions (`.github/workflows/deploy.yml`) runs the backend tests and the frontend build on every push and pull request.

## Deploying on your own server (alternative)

```bash
cp backend/.env.example .env
# set: JWT_SECRET, APP_ENCRYPTION_KEY (openssl rand -hex 32), POSTGRES_PASSWORD,
#      PUBLIC_APP_URL=https://nexoraed.com, API_BASE_URL=https://nexoraed.com,
#      CORS_ORIGINS=https://nexoraed.com, CHATWOOT_* (optional), SMTP_* (optional), APP_ENV=production,
#      PROXY_SECRET (or REQUIRE_PROXY_SECRET=false when nginx in this compose file is the only entry point)
docker compose up -d --build        # web on :8080 → put behind TLS (Caddy / nginx / Cloudflare)
```
- Run `docker compose run --rm api npm run release` (migrations + reference data) before starting the API; it never seeds users.
- Back up the `pgdata` and `uploads` volumes. The SRS targets daily full backups plus PITR (BKP-01); use your managed Postgres or `pg_dump` with WAL archiving.
- Website / landing-page forms can push leads to `POST /api/v1/webhooks/website-leads` with the header `X-API-Key: $WEBSITE_LEADS_API_KEY`.
- Payment gateways can confirm payments at `POST /api/v1/webhooks/payment`, signed with `HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, "<timestamp>.<raw body>")` in `X-Signature` and the timestamp in `X-Timestamp`.

---

## Security & data integrity (SRS §18, §20, §24)
- Server-side sessions: short-lived access tokens held in memory, refresh token only in an HttpOnly/Secure/SameSite=Strict cookie with rotation and reuse detection; server-side idle timeout; users can view and end sessions. Deactivation, role and password changes apply on the next request.
- MFA (TOTP authenticator + recovery codes), mandatory for Super Admin, Administrator, Management and Finance roles.
- Password policy: ≥10 characters, 3 character classes, common/personal passwords blocked, last 5 not reusable, bcrypt cost 12. Account lock after failed logins with identical generic errors. Forced password change enforced by the API.
- RBAC on every API route, plus object-level scoping (`src/lib/policy.ts`): counselors see only their own leads and the students converted from them, faculty only their batches, students only their own records; identity documents only for administrators, the owning counselor and admission reviewers.
- Only a Super Administrator manages privileged accounts; privileged role grants need a second Super Administrator's approval; nobody changes their own roles. Approvals fail closed and nobody approves their own request.
- Rate limiting (global, auth and public forms). Helmet headers. zod validation on every input. Parameterised queries (Prisma). CSV-injection guard on exports.
- **Audit rows are written in the same transaction as the change.** PostgreSQL triggers plus a restricted runtime role (`prisma/sql/app-role.sql`) make `audit_logs`, `ledger_entries`, `lead_activities`, `student_history`, `login_logs`, `approval_actions` and `integration_logs` append-only. Corrections are reversing entries. Viewing logs and exporting data are themselves audited.
- Integration credentials are encrypted at rest (AES-256-GCM). Every Chatwoot call is logged in `integration_logs`. Webhooks are verified (token, or HMAC signature plus timestamp).
- Uploads: type, size and content-signature checks, random file names; documents and student photos served only through authenticated, scoped endpoints.

## Not yet included / next steps
- A **live payment gateway** checkout: the webhook and reconciliation are ready; the provider (Razorpay / PayU) needs to be chosen
- **SMS gateway** adapter (the notification engine supports adding channels)
- Scheduled e-mailing of reports, saved filters and dashboard widget re-ordering (should/could items)
- Future scope listed in SRS §30: mobile app, AI CRM, chatbot, biometric attendance, HR/payroll, multi-branch
