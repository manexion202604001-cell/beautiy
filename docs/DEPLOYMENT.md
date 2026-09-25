# Deployment

MANEXION Salon OS is a single Next.js app (`apps/web`) backed by PostgreSQL.
Redis is optional (booking locks use PostgreSQL advisory locks inside the booking transaction).
Object storage is optional (S3-compatible; otherwise files are stored in PostgreSQL).

## Required environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (use a pooled URL on serverless, e.g. Neon `-pooler` host with `?sslmode=require&connection_limit=5`) |
| `APP_URL` | Public base URL, e.g. `https://salon.example.com` (used in links sent to customers) |
| `PII_ENCRYPTION_KEY` | AES-256-GCM key material for customer PII (random ≥32 chars). **Never rotate without re-encryption.** |
| `PII_HASH_KEY` | Blind-index key for phone/email search (random ≥32 chars). **Never rotate without re-indexing.** |
| `CRON_SECRET` | Bearer secret for `/api/cron` (Vercel Cron sends it automatically) |
| `DEMO_MODE` | `1` shows OTP codes on screen and demo login hints. **Unset for real operation.** |

Optional: `S3_*`, `RESEND_API_KEY`/`EMAIL_FROM`, `LINE_*`, `STRIPE_*`, `SQUARE_*` (see `.env.example`).
Per-organization LINE / Stripe / Square / booking-site credentials are configured in the app under 設定 > 外部連携.

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## Option A — Vercel + Neon (recommended for a hosted web version)

1. Create a Postgres database (Vercel Marketplace → Neon, region Tokyo). Copy the pooled connection string.
2. Vercel → Add New Project → import this GitHub repository.
   - **Root Directory:** `apps/web` (Vercel installs the npm workspace from the repo root automatically).
   - Framework: Next.js. Build command comes from `apps/web/vercel.json`
     (`npm run db:deploy && npm run build` → applies Prisma migrations, then builds).
3. Environment variables: set the required ones above (Production + Preview).
4. Deploy. Then (optionally) load demo data once from your machine:
   `DATABASE_URL=<neon url> PII_ENCRYPTION_KEY=… PII_HASH_KEY=… npm run db:seed`
   (use the same PII keys as production or the encrypted demo PII will not decrypt).
5. Cron: `vercel.json` runs `/api/cron` daily (Hobby plan limit). For reminders and sync retries in
   production, call it every 5–15 minutes from Vercel Pro cron or an external scheduler:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron`
6. Webhook URLs (shown in 設定 > 外部連携): LINE `/api/webhooks/line/<key>`, Stripe `/api/webhooks/stripe?k=<key>`,
   Square `/api/webhooks/square?k=<key>`, booking sites `/api/webhooks/booking/<key>`.

## Option B — Docker (self-hosted / AWS ECS)

```bash
cp .env.example .env   # fill in secrets
docker compose --profile app up --build   # postgres + minio + web on :3000 (migrations run at start)
docker compose exec web sh -c "cd /app && echo 'seed from a dev checkout: npm run db:seed'"
```

The image (`Dockerfile`) builds a Next.js standalone server and runs `prisma migrate deploy` before start.

## Local development

```bash
cp .env.example .env                 # set PII keys, CRON_SECRET
docker compose up -d postgres        # or a local PostgreSQL 16
npm install                          # also runs prisma generate
npm run db:push && npm run db:seed   # schema + demo data
npm run dev                          # http://localhost:3000  (owner@demo.salon / demo1234)
```

Tests: `npm test` (unit + DB integration; uses `TEST_DATABASE_URL`, default `postgresql://salonos:salonos@localhost:5432/salonos_test`, reset on each run), `npm run test:e2e` (Playwright).

## Schema changes

Edit `packages/db/prisma/schema.prisma`, then create a migration:
`npx prisma migrate dev --schema packages/db/prisma/schema.prisma --name <change>` and commit it.
Production applies migrations with `prisma migrate deploy` (Vercel build / Docker start).
