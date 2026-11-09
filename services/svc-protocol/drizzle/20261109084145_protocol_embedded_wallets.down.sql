-- Reverses 20261109084145_protocol_embedded_wallets.sql. A row is an address and the provider's wallet id; dropping it
-- moves nothing and loses no key (the provider keeps the wallet), and the person's next Create my wallet records it again.
DROP TABLE IF EXISTS "protocol"."embedded_wallets";
