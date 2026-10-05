# Changelog

## 0.2.0

### Fixed

- `bills.validate()` and `bills.buy()` no longer send `amount` to validation,
  which Nearpays rejects ("property amount should not exist"). The amount goes
  with the purchase. `ValidateBillRequest.amount` and the `validate_bill`
  agent tool's `amount` are gone.

### Added

- `RedisStore` (ioredis or node-redis) and `PostgresStore` (pg), both with a
  lock that works across instances.
- `encryptStore(store, key)`: AES-256-GCM for everything the SDK stores, with
  key rotation through `previousKeys`.
- `nearpays.sendTestWebhook(customer, type)`: asks Nearpays for a signed sample
  event.
- A `timeout` error code, and a `timeoutSeconds` option (60 by default, up
  from openid-client's 30). A timed-out payment may still go through; retry
  with the same reference to get its result.

### Changed

- `mandate.updated` is no longer a webhook type: customers approve the limits
  you ask for as they are, and can't change them afterwards.
- Phone numbers for airtime and data are documented in `+234` form, which
  Nearpays requires.
- The README describes approval on the Nearpays web page, staging's
  predictable bill numbers, and the error codes as the API sends them
  (`idempotency_key_reused` and `request_in_progress` rather than `conflict`).

## 0.1.0

First release.
