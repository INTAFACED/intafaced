-- intafaced:destructive — reversal of 0005_miner_credentials.sql
-- Every issued miner secret is lost; rigs need a newly issued one after 0005 is applied again.
DROP TABLE IF EXISTS "mining_pool"."miner_credentials";
