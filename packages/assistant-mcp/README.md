# @intafaced/assistant-mcp

The MCP server a person's own outside assistant runs to trade on its agent account (DV-tools-02; J-agents-21 #7). It speaks MCP over stdio and turns each tool call into one signed call to our API through Edge, with the person's agent key. It holds no state and moves no money: what the key may do is decided by our services.

```sh
INTAFACED_API_URL=<Edge base URL> \
INTAFACED_AGENT_KEY=<agent key> \
INTAFACED_AGENT_SIGNING_SECRET=<the key's signing secret> \
  node packages/assistant-mcp/src/server.ts
```

Node runs the source as it is (type stripping, Node 22.18 or later); `pnpm --filter @intafaced/assistant-mcp build` writes the compiled copy to `dist/`.

## Tools

- `place_order`: a spot or perpetual order on the agent account the key is connected to (`POST /api/v1/venue/agent/orders`). Amounts are decimal strings. The same `clientOrderId` is the same order. A refusal (the person's caps, the venue's own refusal, a revoked or expired key) comes back as the tool's error with our typed code.

The key reaches that route and no other: a move, withdrawal, bank, card or other-account call refuses `auth.scope_denied` at our API.

## Not decided here

Where the server is hosted and whether the package is published are the owner's (spec `developer-tools.md` DV-tools-02, decision note). Until then it runs from this repository.
