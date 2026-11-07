-- svc-notify · a maintenance notice may name one market (`market-btc-usdc`, J-cex-spot-14 #5) without the status page
-- defining it; svc-trade shows the window on that market's lifecycle read. The board already allows it; the database
-- trigger from 0027 still refused it, so it is widened the same way: a maintenance row may name `market-<base>-<quote>`
-- (contracts MARKET_COMPONENT_PATTERN). An incident, or any other name, is checked against the page exactly as before.
-- Reversal: the matching .down.sql
CREATE OR REPLACE FUNCTION notify.notice_components_known() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW.components) > 0 AND EXISTS (
    SELECT 1 FROM unnest(NEW.components) AS named(id)
    WHERE named.id NOT IN ('api', 'webhooks', 'console')
      AND NOT (NEW.kind = 'maintenance' AND named.id ~ '^market-[a-z0-9]{1,15}-[a-z0-9]{1,15}$')
      AND NOT EXISTS (
        SELECT 1 FROM notify.status_page p, jsonb_array_elements(p.components) AS c
        WHERE c ->> 'id' = named.id
      )
  ) THEN
    RAISE EXCEPTION 'notify.notice_component_unknown' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
