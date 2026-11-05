# Zarinpal annual subscription checkout — deployment handoff

## Product model
Zurvan is sold as a **prepaid one-year subscription**, not a lifetime license. Each verified payment grants 12 months. A renewal extends the existing account/product entitlement by 12 months from the later of the current expiry or payment verification time. Premium access is enabled only while the server-side entitlement is unexpired.

## Flow
1. Authenticated, email-confirmed client calls `zurvan-create-zarinpal-payment` with a server-issued `price_id`.
2. The Edge Function loads the enabled Iran price from `zurvan_prices`; client-supplied amounts are ignored.
3. For `IRT`, stored toman are multiplied by 10 and sent as rial. `IRR` is sent unchanged.
4. Server creates pending order/payment and requests a Zarinpal authority.
5. Browser opens Zarinpal StartPay. Zarinpal calls `zurvan-zarinpal-callback`.
6. Callback verifies server-to-server and calls a SECURITY DEFINER RPC. That transaction marks payment/order paid, issues or renews the annual entitlement, sets expiry, and writes an audit record.
7. Duplicate verified callbacks are idempotent.

## Required Supabase secrets
- `ZARINPAL_MERCHANT_ID`: real merchant UUID from the پذیرندگی panel; never put in a client or repository.
- `ZARINPAL_CALLBACK_URL`: deployed HTTPS URL of `zurvan-zarinpal-callback`.
- `ZARINPAL_SANDBOX=true` for sandbox; omit/false for production.
Supabase already supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Required admin configuration
Insert/enable a `zurvan_prices` row for product `zurvan`, region `IR`, provider `zarinpal`, currency `IRT` (canonical display denomination: toman), and the approved annual amount. No price has been invented or activated.

## Deploy
Apply migrations `20261105160000_zarinpal_lifetime_checkout.sql` and `20261105161000_convert_zurvan_to_annual_subscription.sql`, set secrets, deploy both functions, and configure callback URL in the Zarinpal merchant panel. Do not enable production until sandbox request, success, cancel, duplicate callback, amount mismatch, renewal, expiry, and network failure tests pass.

## Important integration gap
This adapter writes an annual entitlement record. Signed client-verifiable entitlement issuance, device binding and Android/Windows premium entitlement refresh are not yet connected. Do not advertise paid premium access as live until those are implemented and tested.
