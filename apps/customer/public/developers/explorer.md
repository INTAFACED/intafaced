# API explorer

Build a request to the public API, see it as code, and send it with one of your keys. With a live key the explorer only reads. A write runs only with a sandbox key, at your sandbox address.

- Read the account balance: `GET /api/v1/account/balance`

- List your business’s payments: `GET /api/pay/v1/payments`

- Create a payment (write): `POST /api/pay/v1/payments`

Paste a key. It stays in this page and is sent only with this request. A key starting ifc_test_ is a sandbox key.
