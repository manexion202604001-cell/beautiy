# Architecture

## 1. Boundary
- Staff Web/PWA: Next.js
- Customer Booking: same Next.js app, public route group
- API: start as Next.js Route Handlers or standalone service; split when scale requires
- PostgreSQL: system of record
- Redis: booking locks, cache, sessions, queues
- Object Storage: karte photos, consent PDFs, exports
- Workers: notifications, external booking sync, analytics aggregation, reminders

## 2. Domain modules
1. Identity & Access
2. Organization / Shop / Staff
3. Customer CRM
4. Booking
5. Karte
6. POS / Payment
7. Messaging
8. Review / Profile
9. Analytics / LTV
10. External Integrations
11. Commerce
12. Audit / Security

## 3. Critical rules
- Every business record is scoped by organization_id and where relevant shop_id.
- Customer PII is field-encrypted; application authorization is separate from DB tenancy.
- Appointment create/update must use an idempotency key.
- Availability checks staff + seat/resource capacity inside one transaction or distributed lock.
- External provider webhooks are stored first in SyncEvent, then processed asynchronously.
- Provider payload is normalized before touching Appointment.
- Payment provider webhooks are idempotent and never trust client-side payment state.
- Every PII unlock/read/export is written to AuditLog.

## 4. Suggested deployment
- Web: Vercel or AWS ECS/CloudFront
- API/Workers: AWS ECS/Fargate
- DB: RDS PostgreSQL Multi-AZ
- Redis: ElastiCache
- Files: S3 + CloudFront signed URLs
- Secrets: AWS Secrets Manager
- Observability: OpenTelemetry + CloudWatch/Sentry
