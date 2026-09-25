# Claude Code Execution Rules — MANEXION Salon OS

## Mission
Build a production-ready salon business OS with functional parity to the publicly observable capabilities described in `docs/PRODUCT_SPEC.md`. Do not copy third-party branding, source code, private APIs, screenshots, or copyrighted UI. Implement independently from the specification.

## Non-negotiable architecture
- TypeScript first.
- Next.js App Router for staff web/PWA + customer booking UI.
- PostgreSQL + Prisma as source of truth.
- Redis for booking locks, cache, queues/session support.
- S3-compatible object storage for karte photos/files.
- All records tenant-scoped by organization; shop scoped where applicable.
- PII field encryption plus authorization; never rely on UI hiding.
- All sensitive PII reads/unlocks/exports must generate audit logs.
- All payment and external booking webhooks must be idempotent.
- External provider payloads must be normalized through adapters before domain writes.

## Build order
1. Auth, tenancy, roles, shop/staff management, audit.
2. Customer CRM with encrypted PII, tags, identity linking and duplicate merge.
3. Menu/resource/business-hours models and reservation engine with conflict protection.
4. Reservation calendar and appointment CRUD.
5. Karte editor, photos, templates, counseling, consent.
6. Public no-account booking flow.
7. LINE integration abstraction + message inbox/templates/automation.
8. POS, points, payments, refunds, register close.
9. Reports, LTV, visit cycle and CSV.
10. External booking adapter framework + reconciliation.
11. Reviews/public profile/Google/Instagram adapters.
12. Storefront EC and subscriptions.
13. Multi-shop consolidated reporting and shared customer permissions.

## UX direction
Independent MANEXION design. Clean, premium, blue-base, high readability. Desktop-first salon management with responsive tablet/mobile support. Customer booking is mobile-first. Do not pixel-copy LiME.

## Definition of done for each feature
- UI states: loading, empty, populated, error.
- Server validation and authorization.
- DB migration/schema.
- Audit behavior where applicable.
- Unit tests for domain rules.
- Integration tests for API/database behavior.
- E2E happy path for user-facing workflows.
- Mobile responsiveness.
- Error recovery/retry behavior for external systems.

## Highest-risk flows
- Concurrent booking and seat capacity.
- Customer identity merge across LINE/external booking/manual records.
- PII permission and temporary unlock.
- Payment webhook replays/refunds.
- External booking sync loops and duplicate events.

## First acceptance journey
Owner creates organization/shop → invites stylist → creates menus/hours/seats → customer books from public page → LINE identity can be attached → reservation appears in staff calendar → stylist opens customer → creates karte/photos → POS checkout → payment recorded → visit/LTV/report updated → follow-up message becomes eligible.
