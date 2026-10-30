# Developers

Connect to Intafaced from your own code. Pick the audience that fits you, then the section you need.

## Who gets access

Access follows the account and the permissions on its key. No access tiers are published in this build, so none are listed here.

## Exchange API

Public market data needs no key. Your own orders, balances and positions need a key from your signed-in account, and a key does only what its permissions allow. Withdrawals are never reachable with a key.

- Permissions: /developers/permissions
- Authentication: /developers/authentication
- REST conventions: /developers/rest
- API reference: /developers/reference
- WebSocket streams: Waits for DV-websocket-01
- Rate limits: Waits for DV-limits-01
- Errors: Waits for DV-errors-01
- Idempotency: Waits for DV-auth-03
- Versioning: Waits for DV-versioning-01
- Changelog: /developers/changelog
- Market data terms: /developers/data-terms

## Institutional

FIX sessions are not opened from this portal: FIX access waits for its onboarding and session policy (DV-fix-01). The connectivity options say what is available today.

- Connectivity: /developers/connectivity
- FIX: Waits for DV-fix-01
- Choosing a protocol: Waits for DV-websocket-01

## Embedded

For merchant accounts: payment keys and webhooks are made inside the merchant portal, and sandboxes in the developer sandbox.

- Webhooks: /pay/developer/webhooks
- Sandbox: /developers/sandbox

## Broker

A registered app acts for a person only after that person consents to the permissions it asks for.

- Registered apps: /developers/apps

## Best practice

Open to everyone: reading these pages needs no account.

- Quickstart: /developers/quickstart
- Libraries: Waits for DV-tools-01
- Command line: Waits for DV-tools-02
- Assistant tools: Waits for DV-tools-02
- API explorer: Waits for DV-console-01
- Machine-readable specs: /developers/openapi
- Developer support: Waits for DV-portal-03
- Service status: /developers/status
