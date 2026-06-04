# 🚚 Logistics Core Platform

A scalable, enterprise-grade backend for **logistics, warehouse management, and last-mile delivery** — engineered with the operational rigor of systems like **FedEx** and **Ozon**.

This service powers the full delivery loop: merchant order intake, warehouse barcode scanning with strict state-machine constraints, manual sorting and bulk driver dispatch, and end-to-end Cash-On-Delivery (COD) financial reconciliation with driver wallets and merchant payouts. It is built as a clean, modular monolith that is straightforward to extend into independent services as volume grows.

---

## 🧱 Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | **Node.js** |
| Web Framework | **Express** |
| Language | **TypeScript** (strict mode) |
| Authentication | **Supabase Auth** (JWT verification) |
| Database | **PostgreSQL** (via Supabase) |
| Data Security | **Row Level Security (RLS)** + role-based policies |
| Dev Tooling | `ts-node-dev`, `tsc`, `rimraf` |

---

## 📂 Project Structure

A modular architecture: configuration, feature modules, and shared cross-cutting concerns are cleanly separated.

```
livraison sys/
├── .env                       # Local secrets (gitignored)
├── .env.example               # Environment template
├── package.json
├── tsconfig.json
├── src/
│   ├── app.ts                 # Express app: middleware, route mounting, error handlers
│   ├── server.ts              # Entry point: port binding, graceful shutdown
│   ├── config/
│   │   ├── env.ts             # Validated environment loader (fail-fast)
│   │   └── supabase.ts        # Anon + service-role Supabase clients
│   ├── modules/               # Feature modules
│   │   ├── auth/              # Authenticated identity & RBAC test routes
│   │   ├── health/            # Liveness + Supabase connectivity probe
│   │   ├── shipments/         # Orders, tracking, scanning, sorting, dispatch
│   │   │   ├── shipment.controller.ts
│   │   │   ├── shipment.routes.ts
│   │   │   ├── shipment.service.ts
│   │   │   └── shipment.types.ts
│   │   └── finance/           # COD wallets, reconciliation, merchant payouts
│   │       ├── finance.controller.ts
│   │       ├── finance.routes.ts
│   │       ├── finance.service.ts
│   │       └── finance.types.ts
│   └── shared/                # Cross-cutting concerns
│       ├── errors/            # AppError hierarchy
│       ├── middlewares/       # auth, RBAC, error & 404 handlers
│       ├── types/             # Global Express augmentation, role types
│       └── utils/             # asyncHandler, tracking number generator
└── supabase/
    └── migrations/            # Ordered SQL migrations (0001 → 0008)
```

---

## 🔄 System Workflow Lifecycle

The platform models the complete logistics loop in four stages:

- **1. Order Creation & Tracking Numbers**
  - Merchants (or admins) create shipments, which start in the `DRAFT` state.
  - Each shipment is assigned a unique, human-readable tracking number in the format `FX-<YEAR>-XXXXXX` (e.g. `FX-2026-X7R9W2`).
  - The random segment is generated with a cryptographically secure source over a confusion-free alphabet (no `0/O`, `1/I`), and is verified collision-free against the database before commit.
  - An opening entry is written to the immutable `tracking_logs` audit trail.

- **2. Barcode Scanning & State Machine Constraints**
  - Warehouse agents and drivers move packages forward by scanning barcodes (single or in bulk).
  - A strict state machine governs every transition — e.g. `DRAFT → ASSIGNED_FOR_RAMASSE → RAMASSE → RECEPTION` — so packages cannot illegally skip stages.
  - Each accepted scan is applied **atomically** with its audit-log entry, and bulk scans isolate failures per item so one invalid barcode never aborts the batch.

- **3. Manual Sorting & Bulk Dispatch**
  - A dispatcher dashboard lists unassigned packages sitting in the warehouse (`RECEPTION`, no driver), filterable and grouped by **City → District** (e.g. "Casablanca → Maarif").
  - From `RECEPTION`, a shipment can branch two ways: `EN_TRANSIT` for inter-city transport, or directly to `OUT_FOR_DELIVERY` for local, same-city last-mile delivery.
  - Bulk assignment links a driver and dispatches an entire batch **atomically** (all-or-nothing): any ineligible shipment rolls back the whole operation.

- **4. Financial Reconciliation & Wallets**
  - When a shipment reaches `DELIVERED`, a financial record is **automatically** generated with status `HELD_BY_DRIVER`, capturing the collected COD amount, delivery fee, and the computed merchant share.
  - **Driver wallet:** the exact total of cash a driver is currently holding, with a per-shipment breakdown.
  - **Admin clearance:** when a driver hands in cash, an admin reconciles their held transactions to `SETTLED_WITH_COMPANY` in a single transaction.
  - **Merchant payout:** the finance team pays out settled funds, moving transactions to `PAID_TO_MERCHANT` and recording the payout method, reference, and processing admin.
  - All monetary math is performed in PostgreSQL over exact `numeric(10,2)` values and serialized as strings — **no floating-point rounding** ever touches money.

---

## ⚙️ Setup & Installation

### Prerequisites

- Node.js (LTS) and npm
- A Supabase project (URL + API keys)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the template and fill in your Supabase credentials:

```bash
cp .env.example .env
```

```dotenv
# Server
PORT=5000
NODE_ENV=development

# Supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key

# Service-role key — server-side only, bypasses RLS. NEVER expose to clients.
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

> **Note:** `SUPABASE_SERVICE_ROLE_KEY` is **required** — the server fails fast on startup if it is missing. It is the trusted backend identity that performs privileged reads/writes and must never be shipped to a browser or mobile client. Find all three values in your Supabase dashboard under **Project Settings → API**.

### 3. Run database migrations

Open the **Supabase SQL Editor** and run the migration files in `supabase/migrations/` **in numerical order**:

| Order | File | Purpose |
| --- | --- | --- |
| 1 | `0001_initial_schema.sql` | Enums, core tables, signup trigger |
| 2 | `0002_rls_policies.sql` | Row Level Security & role policies |
| 3 | `0003_scan_engine.sql` | State machine + atomic scan handler |
| 4 | `0004_bulk_dispatch.sql` | Atomic bulk driver assignment |
| 5 | `0005_reconcile_state_machine.sql` | RECEPTION → OUT_FOR_DELIVERY reconciliation |
| 6 | `0006_financial_transactions.sql` | Finance table, delivery trigger, reconcile fn |
| 7 | `0007_driver_wallet_fn.sql` | Exact driver wallet total |
| 8 | `0008_merchant_payout.sql` | Merchant balance + payout |

### 4. Run the application

```bash
# Local development (hot reload via ts-node-dev)
npm run dev

# Compile TypeScript to dist/
npm run build

# Run the compiled production build
npm start
```

The API listens on **http://localhost:5000**. Verify it is online:

```bash
curl http://localhost:5000/health
```

---

## 🛡️ Design & Architecture Highlights

- **Real-time role lookup on every request.** Authorization reads the user's role directly from the `profiles` table on each request rather than trusting a role baked into the JWT. A revoked or downgraded role takes effect **immediately**, eliminating the stale-token window where an old privilege would otherwise remain valid until expiry.

- **Hardened database security via Row Level Security.** Because Supabase tables are reachable through the public PostgREST API with the anon key, every table is protected by RLS with per-role, per-row policies (merchants see only their own data, drivers only assigned shipments, the audit trail stays insert-only). The trusted Express backend uses the service-role key, while the policies defend the direct public API channel.

- **Deterministic port allocation.** The server enforces its port policy explicitly: if the configured port (default **5000**) is already in use, it fails loudly with a clear `[FATAL]` message and a non-zero exit code (`EADDRINUSE`) instead of crashing with an opaque stack trace.

- **Live dependency health checks.** `GET /health` performs a lightweight, read-only probe against Supabase on every call. It returns **200 `ok`** when the database channel is reachable and **503 `degraded`** (with status, latency, and error detail) when it is not — giving load balancers and uptime monitors an accurate signal.

- **Atomic, audit-safe operations.** Multi-step actions (scanning, bulk dispatch, reconciliation, payouts) execute inside PostgreSQL transactions/functions so state changes and their audit-log entries commit or roll back together — no partial writes, no orphaned records.

- **Exact monetary precision.** All COD and payout arithmetic is computed server-side in `numeric(10,2)` and serialized as strings, guaranteeing zero floating-point drift across the financial lifecycle.

---

## 📜 License

MIT
