# Quickstart

From nothing to a first call in four steps.

1. Open an account: Sign up and verify your email. Keys belong to your account and do only what its permissions allow.
2. Create a key: Create an API key with only the permissions you need. Its secret is shown once: store it before you close the page.
3. Check your clock: A signed call carries a timestamp, and the server refuses one too far from its own clock. Compare your clock with the server’s before you sign. The check reads GET /api/v1/time and takes the offset at the middle of the round trip. Keep your clock on a standard network time source. Outside the window: the server refuses a timestamp more than 300 seconds from its clock. Set your clock from a time server.
4. Make your first call: Read the server time, then a public market, then your balance with your key. The reference lists every route.
