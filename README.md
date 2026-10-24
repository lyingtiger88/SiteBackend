# SiteBackend — Zurvan License Server v2

Central source repository for the Zurvan website, permanent-license service and payment integration.

> **Status: architecture and database scaffold only. No production payment gateway, deployed API or live license service exists yet.**

## Agreed product rules
- **Lifetime purchase only**; no subscriptions.
- Exactly **one active device binding per license/account** at the server.
- On first launch, the app generates a non-exportable device key pair and registers a provisional account; the user sets a username and password before purchasing or transferring.
- Following verified payment, issue a permanent license to the account and bind it to that device.
- Iran: prices in **toman** (convert explicitly to gateway minor units); other eligible regions: USD/EUR using a separately approved provider. Never treat a return URL as payment confirmation.
- Check license status every **72 hours** when online. Previously activated clients may continue offline after a network failure; online verified revocation or transfer takes precedence.
- Account recovery/transfer: sign in on the new device, step-up authentication, declare reason (broken/sold/lost/upgrade), revoke prior device binding atomically, advance license generation, bind new device.
- Because offline access is unbounded, an indefinitely offline old device **cannot be forcibly revoked**. The one-device guarantee applies at the server and to online clients.
- Legacy special codes must be migrated securely without hard-coding credentials in distributed clients.

## Proposed structure
```
docs/ARCHITECTURE.md       architecture, flows, business rules and API contract
database/001_initial.sql   PostgreSQL baseline schema and constraints
api/openapi.yaml           v2 HTTP interface (contract-first)
web/README.md             public site and admin console route map
```

## Proposed deployment
PostgreSQL plus a server-side HTTPS API (Supabase + Edge Functions are candidate technologies, not yet provisioned). GitHub is the **source code repository, not the running server**. Never commit payment credentials, private signing keys, service-role tokens or user data. This public repository requires careful secrets management and backend-only authorization.

## Delivery milestones
1. Schema review + migrations + RLS/backend authorization.
2. Identity and device challenge/proof-of-possession.
3. License signature issuance, validation and transfer transaction.
4. Payment gateway adapters with sandbox verification and webhook idempotency.
5. Web storefront and administrative UI.
6. Android client integration, legacy migration and automated security/integration tests.
