-- trade.algo · chase kind: one limit child that follows the best price on its own side, up to a maximum distance
-- Reversal: 20261029230000_algo_chase_kind.down.sql
--
-- ADD VALUE must commit before the label is used in a CHECK, so the columns are in 20261029230100.

ALTER TYPE "trade"."algo_kind" ADD VALUE IF NOT EXISTS 'chase';
