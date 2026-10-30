-- J-more-catalogue-14 #8: suspending an issuer closes its open launches in the same transaction. Each close is an
-- ordinary move row with the suspension's actor and approver, and `cause` names why it moved; an operator's own move
-- leaves it null.
ALTER TABLE "token"."launch_event_moves" ADD COLUMN IF NOT EXISTS "cause" text;
