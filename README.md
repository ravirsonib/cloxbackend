# CLOX Pre-Launch API

NestJS API for the CLOX pre-launch site. It accepts public leads (sender/carrier registry, admin partner EOI, and investor pre-qualification), signs Super Admins in with email OTP, and supports lead review.

Stack: **NestJS 10** · **TypeScript** · **PostgreSQL** · **Prisma** · **JWT** · **Zod**.

## Requirements

- Node.js 22
- PostgreSQL
- npm

## Setup

From the `api` directory:

```bash
cd api
npm ci
```

Create `api/.env` (this file is gitignored). Required values:

```env
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/clox
JWT_ACCESS_SECRET=replace-with-at-least-32-characters
JWT_REFRESH_SECRET=replace-with-a-different-32-characters
```

Then generate the client, apply migrations, and seed the Super Admin:

```bash
npx prisma generate
npx prisma migrate dev
npm run prisma:seed
```

The seed upserts one Super Admin. Override the address with `SEED_SUPER_ADMIN_EMAIL` (default `abc@example.com`).

## Run

```bash
npm run dev
```

The API listens on `http://localhost:3000/v1`. In development, OpenAPI is at `http://localhost:3000/v1/docs`.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled app |
| `npm run lint` | Typecheck (`tsc --noEmit`) |
| `npm test` | Unit tests (Jest) |
| `npm run prisma:studio` | Open Prisma Studio |
| `npm run prisma:deploy` | Apply migrations (non-interactive) |

## API

Global prefix: `/v1`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | Public | Liveness and database readiness |
| `POST` | `/v1/leads/registry` | Public | Sender or carrier registry lead. Optional `Idempotency-Key` header (or body `idempotencyKey`) prevents duplicate rows on client retries. |
| `POST` | `/v1/leads/eoi` | Public | Admin partner expression of interest. Same idempotency support. |
| `POST` | `/v1/leads/investor` | Public | Investor pre-qualification. Same idempotency support. |
| `POST` | `/v1/auth/otp/request` | Public | Email a Super Admin OTP |
| `POST` | `/v1/auth/otp/verify` | Public | Exchange OTP for JWT access and refresh tokens |
| `POST` | `/v1/auth/refresh` | Public | Refresh the access token |
| `GET` | `/v1/admin/dashboard/stats` | Bearer | Dashboard counts and recent activity |
| `GET` | `/v1/admin/leads` | Bearer | Paginated, filterable lead list |
| `GET` | `/v1/admin/leads/export` | Bearer | CSV export |
| `GET` | `/v1/admin/leads/:id` | Bearer | Lead detail, notes, and events |
| `PATCH` | `/v1/admin/leads/:id` | Bearer | Update status, priority, or assignee |
| `POST` | `/v1/admin/leads/:id/notes` | Bearer | Add an internal note |
| `GET` | `/v1/admin/audit` | Bearer | Activity log |

Public lead and OTP routes are rate-limited. Admin routes require `Authorization: Bearer <accessToken>`.

## Environment

Validated at startup in `api/src/config/env.validation.ts`. The process exits if required values are missing or invalid.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` | `3000` | HTTP port |
| `API_PREFIX` | `v1` | Global route prefix |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5174` | Comma-separated origins |
| `DATABASE_URL` | — | Required PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | — | Required, at least 32 characters |
| `JWT_REFRESH_SECRET` | — | Required, at least 32 characters |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `JWT_REFRESH_TTL` | `7d` | Refresh token lifetime |
| `OTP_TTL_MINUTES` | `10` | OTP expiry |
| `OTP_LENGTH` | `6` | Digits, 4–8 |
| `SMTP_HOST` | `smtp.gmail.com` | Outbound mail |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` / `1` / `yes` |
| `SMTP_USER` | — | Optional |
| `SMTP_PASS` | — | Optional |
| `MAIL_FROM` | — | Optional sender address |
| `NOTIFY_EMAIL` | — | Optional lead notification address |
| `INVEST_NOTIFY_EMAIL` | — | Optional investor notification address |
| `ENABLE_OPENAPI` | `false` | OpenAPI is still on when `NODE_ENV` is not `production` |
| `EXPOSE_OTP_IN_RESPONSE` | `true` | Testing only. Set `false` before real use so OTPs are email-only |
| `SEED_SUPER_ADMIN_EMAIL` | `abc@example.com` | Seeded admin email |
| `SEED_SUPER_ADMIN_NAME` | `CLOX Super Admin` | Seeded admin name |
| `THROTTLE_TTL_MS` | `60000` | Default rate-limit window |
| `THROTTLE_LIMIT` | `10` | Default requests per window |

## Layout

```text
api/
  prisma/          schema, migrations, seed
  src/
    config/        env validation
    common/        guards, filters, pipes
    modules/
      auth/        OTP and JWT
      leads/       public lead intake
      admin/       review, notes, audit, export
      health/
    prisma/        Prisma module
```

## CI

`.github/workflows/ci.yml` installs dependencies, generates the Prisma client, typechecks, runs unit tests, and builds the API on Node 22.
