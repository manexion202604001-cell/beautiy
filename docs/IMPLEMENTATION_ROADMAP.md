# Implementation Roadmap

## Phase 0 — Foundation
- Monorepo, env, DB, auth, tenancy, roles, audit, storage, CI/CD

## Phase 1 — Core salon operations
- Customer CRM
- Appointment ledger
- Menus/coupons
- Karte/photos/templates
- Shop/staff settings

## Phase 2 — Customer booking & LINE
- Public booking flow
- Customer identity resolution
- LINE OAuth/Messaging API
- Confirmation/reminder/cancel
- 1:1 messages and broadcasts

## Phase 3 — POS & payments
- Tickets, items, tax, discounts, points
- Stripe/Square adapters
- Refunds, close register, reports

## Phase 4 — External booking integrations
- Adapter contract
- Idempotent sync event store
- Retry/DLQ/reconciliation UI
- Provider-by-provider integration

## Phase 5 — Analytics/LTV & multi-shop
- Aggregations
- LTV/retention/visit cycle
- Staff/shop KPI
- Cross-shop data sharing and consolidated views

## Phase 6 — Reviews/Profile/EC
- Public profiles and reviews
- Google/Instagram adapters
- Storefront and order management

## Release gates
- Unit + integration + E2E coverage for booking, permissions, payments, sync
- Load test for concurrent slot booking
- Restore test for database/files
- PII access audit verification
- Provider webhook replay tests
