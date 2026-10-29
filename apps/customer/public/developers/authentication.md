# Authentication

How a key proves that each request is yours.

## Send your key

Send the key in the Authorization header: Bearer, a space, then the key. The key is shown once, when you create it.

## Sign each request

A key you create under Developers that may place orders (trade:write) signs every request, so that key copied alone cannot trade. Its signing secret is shown once, beside the key, when you create it. Join these lines with a newline, sign the text with HMAC-SHA256 and the secret, and send the signature in hex.

1. The scheme’s name, INTAFACED-REQ-V1
2. The method, in capitals
3. The path with its query string, exactly as sent
4. The time you sign, in Unix seconds
5. A nonce: a new value for every request
6. The SHA-256 of the body you send, in hex (of empty text when there is no body)

## Timestamp window

An altered request, a stale or future timestamp and a reused nonce are each refused with their own code. The window and the test vector are read live from GET /api/identity/trpc/requestSigningPolicy.

- Authentication and permission errors: /developers/errors/auth
