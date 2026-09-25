# Development conventions (MANEXION Salon OS)

## Layout
- `packages/core` — pure, framework-free domain logic (booking engine, pricing, analytics, identity, RBAC, messaging, CSV, provider adapters). Client-safe exports via `@salonos/core`; server-only via `@salonos/core/crypto`, `@salonos/core/integrations/*`.
- `packages/db` — Prisma schema + client (`import { prisma } from '@salonos/db'` or `@/lib/server/db`).
- `apps/web` — Next.js App Router.
  - `app/(auth)` sign-in, onboarding, invites
  - `app/(staff)` authenticated staff app (shell in `app/(staff)/layout.tsx`)
  - `app/(public)` customer-facing pages (booking, change/cancel, shared karte, counseling, store, profiles, reviews)
  - `app/api` webhooks, cron, files
  - `lib/server/*` server-only services; `lib/format.ts` client-safe formatting
  - `components/ui.tsx` server-safe primitives; `components/client.tsx` client primitives (ActionForm, SubmitButton, Modal, Drawer, ModalButton, ConfirmAction, CopyButton)

## Server rules
- Every query is scoped: `organizationId: ctx.org.id` (and `shopId` where relevant; validate foreign ids belong to the org).
- Pages: `const ctx = await requirePage('perm')`. Server actions: `requireStaff('perm')` inside `runAction(async () => {...})`, validate with zod, return `ActionResult`.
- PII: never render `*Enc` columns directly. Use `readCustomerContact` (audited) or `maskedContact`. Write with `piiColumns`.
- Audit (`audit(ctx, action, resourceType, id, meta)`) for PII reads/unlocks/exports, permission/role changes, refunds/voids, merges, integration config changes, deletes.
- Booking writes only through `lib/server/booking.ts` (locks + conflict checks + idempotency).
- Customer find-or-create from external/public input only through `resolveCustomer`. Unverified public input (web booking, store orders) passes `requireNameMatch: true`; public pages render only what the visitor typed (`Appointment.guestName`, `Order.contactName`), never the matched customer record.
- Customer messages only through `sendCustomerMessage` / `notifyAppointment` (delivery log + opt-out).
- Webhooks: verify signature → store event with unique (provider, eventId) → process idempotently.

## UI rules
- Japanese UI copy, independent MANEXION design (blue base). No third-party salon-SaaS branding/text.
- Each screen handles loading (`loading.tsx` or skeleton), empty (`<Empty>`), populated and error states.
- Desktop-first staff app, responsive to tablet/mobile; public customer pages mobile-first.
- Use the CSS primitives in `app/globals.css` (card, btn, badge, table, form-grid, field, input/select/textarea, tabs, seg, drawer, modal…).

## Tests
- Unit tests for pure rules in `packages/core/test`.
- DB integration tests in `apps/web/tests/integration` (Postgres; `makeOrg()` helper creates an isolated tenant).
- E2E (Playwright) in `apps/web/tests/e2e`.
