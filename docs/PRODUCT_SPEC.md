# MANEXION Salon OS — Full Feature Parity Specification

## Product goal
美容サロン向けの顧客・予約・施術・会計・再来店を1つの顧客IDでつなぐ業務OSを構築する。既存サービスの公開機能を参考にするが、ブランド、UI、文章、素材、コードは独自に設計する。

## Functional modules

### A. Authentication / Organization
- Email/password, magic link or passkey
- OTP for sensitive operations
- Organization / multi-shop tenancy
- Owner, director, manager, stylist, assistant, receptionist roles
- Shop switcher
- Staff invite/deactivate
- Fine-grained customer PII permission
- Temporary PII unlock
- Audit log

### B. Customer CRM
- Customer create/edit/search
- Encrypted phone/email/address
- Favorites
- Tags/segments
- Assigned stylist
- Visit timeline
- Booking history
- Sales history
- LTV
- Average spend
- Average visit interval
- No-show/cancel history
- LINE identity / external identities
- Duplicate candidate detection + merge workflow
- CSV import/export

### C. Electronic Karte
- One karte per visit/appointment
- Treatment notes
- Chemical/formula notes
- Templates
- Speech-to-text hook
- Copy from previous visit
- Assistant notes
- Photos before/after
- Drawing/sketch JSON canvas
- Counseling form builder
- E-sign consent form
- Customer self-entry link
- Customer-facing photo/care memo share

### D. Reservation ledger
- Day/week calendar
- Multi-staff view
- Drag/drop create/move/resize
- Statuses: requested/confirmed/arrived/in-service/completed/cancelled/no-show
- Staff availability
- Business hours / holidays
- Seat/resource capacity
- Capacity overrun warning
- Private appointments
- Consultation appointments
- Menu duration and price
- Coupon support
- Hold/temporary slot lock
- Waitlist
- Booking source attribution

### E. Customer online booking
- Public booking URL per shop/staff
- No mandatory account creation
- Menu/coupon selection
- Staff selection/no preference
- Availability calendar
- Customer details
- Booking request/instant confirmation mode
- Consultation booking
- Confirmation page
- Change/cancel URL
- LINE linkage

### F. LINE CRM
- LINE Official Account OAuth/linking
- Rich menu booking entry
- Customer LINE identity linking
- Reservation confirmation
- Reminder
- Change/cancel notice
- One-to-one message thread
- Templates
- Segment broadcast
- Automated visit-cycle message
- Review request
- Karte/photo share notification
- Delivery/error logs
- Consent / opt-out controls

### G. POS / Register
- Open ticket from appointment/customer
- Service items
- Retail items
- Discount/coupon
- Staff attribution: nominated/free
- Tax handling
- Cash/card/e-money/custom method
- Stripe integration adapter
- Square integration adapter
- Split payment
- Points earn/redeem
- Receipt
- Draft transaction
- Refund/void
- Register open/close
- Cash expected/actual difference
- Daily closing report

### H. Sales / Analytics / LTV
- Daily/monthly sales
- Shop total
- Staff total
- Service vs retail sales
- Booking source performance
- Nominated/free split
- Customer count
- New/repeat ratio
- Repeat rate
- Average ticket
- Visit interval
- LTV per customer
- LTV per segment
- Dormancy candidates
- Staff KPI comparison
- CSV export

### I. Reviews / Profile / Discovery
- Stylist public profile
- Shop public profile
- Bio, images, videos, social links
- Menu and price
- Business hours
- Hygiene/salon info
- Customer review submission
- Review reply
- Social share image generation hook
- Google Business Profile synchronization adapter
- Instagram booking entry adapter

### J. External booking sync
- Provider adapter interface
- Hot Pepper adapter placeholder
- minimo adapter placeholder
- Rakuten Beauty adapter placeholder
- Other provider adapter
- Inbound webhook/poll normalization
- Outbound availability/booking propagation
- Idempotent event processing
- Conflict detection
- Retry/backoff/dead-letter
- Manual reconciliation screen
- Sync health dashboard

### K. Storefront EC
- Product catalog
- Customer product recommendation link
- Cart/checkout
- Order history
- Subscription purchase support
- Product attribution to shop/staff/customer
- Fulfillment provider abstraction

### L. Multi-shop
- Organization dashboard
- Shared customer record
- Shared karte with permissions
- Shop-specific booking hours/resources
- Cross-shop customer timeline
- Shop-specific and consolidated sales
- Staff shop assignment
- Inter-shop transfer/history

## Required screens
1. Sign in
2. Organization onboarding
3. Dashboard
4. Daily reservation ledger
5. Weekly reservation ledger
6. Appointment drawer
7. Customer list
8. Customer detail
9. Customer merge
10. Karte editor
11. Karte history
12. Counseling form
13. Consent form
14. POS checkout
15. Register closing
16. Transaction history
17. Messages inbox
18. Broadcast builder
19. Automation rules
20. Sales report
21. LTV report
22. Staff report
23. Reviews
24. Public stylist profile editor
25. Menu/coupon management
26. Staff management
27. Shop management
28. Permissions/PII lock
29. Integrations
30. External sync errors
31. Audit logs
32. Customer online booking
33. Customer change/cancel
34. Customer shared karte page
35. EC catalog/order screens

## Definition of parity
A module is not considered complete until CRUD, permissions, validation, mobile view, error handling, audit behavior, exports where relevant, and integration retry paths are implemented and tested.

## Non-copy constraints
- Do not use LiME name/logo/assets/screenshots.
- Do not pixel-copy screen layouts or text.
- Do not scrape private/authenticated interfaces or reverse engineer proprietary APIs.
- Build equivalent workflows from public behavior and independent product requirements.
