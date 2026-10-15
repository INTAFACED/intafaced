# Screening socket

`screenParty({name,country,registration})` and `screenWallet({address,chain})` return
`pass`, `review`, `block` or `unavailable`, together with fixed provider identity
and a visible `fixture` flag. No vendor or sanctions list ships here.

`resolveParty({merchantId,kybRef})` is a trusted provider boundary: it must return
the verified dossier party and independently verified account `identityKycTier`.
Merchant KYB approval is a separate control. An opaque dossier reference must
never be interpreted as a party name or country.

Missing providers, invalid context, exceptions, unexpected outcomes and requests
exceeding the default five-second timeout return unavailable. Callers must refuse
every outcome except pass. Inputs and provider exception text are never logged or
included in decisions. Provider adapters must follow the same privacy contract.

`createFixtureScreeningProvider` requires explicit `appEnv: 'dev' | 'test'`.
Cases contain synthetic references, parties, and wallet/network pairs with exact
outcomes; an absent case is unavailable. Its provider identity is
`fixture-test-data`, and every decision is labelled `fixture: true`.
The socket also rejects a fixture provider outside explicit dev/test environments.
