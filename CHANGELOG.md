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

### Changed

- `mandate.updated` is no longer a webhook type: customers approve the limits
  you ask for as they are, and can't change them afterwards.
- The README describes approval on the Nearpays web page, staging's
  predictable bill numbers, and the error codes as the API sends them
  (`idempotency_key_reused` and `request_in_progress` rather than `conflict`).

## 0.1.0

First release.
