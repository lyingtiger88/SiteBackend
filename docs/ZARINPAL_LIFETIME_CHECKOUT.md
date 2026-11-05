# Zarinpal lifetime checkout — deployment handoff

## Scope
This change adds a server-side Zarinpal v4 adapter for the Zurvan lifetime purchase. It does not create subscriptions. It does not expose the merchant ID to Android/Windows clients.

## Flow
1. Authenticated, email-confirmed client calls `zurvan-create-zarinpal-payment` with a server-issued `price_id`.
2. The Edge Function loads the enabled Iran price from `zurvan_prices`; client-supplied amounts are ignored.
3. For `IRT`, stored toman are multiplied by 10 and sent as rial. `IRR` is sent unchanged.
4. Server creates pending order/payment and requests a Zarinpal authority.
5. Browser opens Zarinpal StartPay. Zarinpal calls `zurvan-zarinpal-callback`.
6. Callback verifies server-to-server and calls a SECURITY DEFINER RPC. That transaction marks payment/order paid, issues one lifetime license and writes an audit record.
7. Duplicate verified callbacks are idempotent.

## Required Supabase secrets
- `ZARINPAL_MERCHANT_ID`: real merchant UUID from the پذیرندگی panel; never put in a client or repository.
- `ZARINPAL_CALLBACK_URL`: deployed HTTPS URL of `zurvan-zarinpal-callback`.
- `ZARINPAL_SANDBOX=true` for sandbox; omit/false for production.
Supabase already supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Required admin configuration
Insert/enable a `zurvan_prices` row for product `zurvan`, region `IR`, provider `zarinpal`, currency `IRT` (recommended canonical display denomination: toman), and the approved amount. No amount has been invented or activated in this change.

## Deploy
Apply migration `20261105160000_zarinpal_lifetime_checkout.sql`, set secrets, deploy both functions, and configure callback URL in the Zarinpal merchant panel. Do not enable production until sandbox request, success, cancel, duplicate callback, amount mismatch, and network failure tests pass.

## Important integration gap
This adapter issues a database lifetime license record. It does not yet sign a client-verifiable license or bind it to the device key. The Android client also currently gates premium tabs using its legacy local activation code. Do not advertise paid premium access as live until signed-license issuance, one-device activation, and client entitlement refresh are integrated and tested.
