-- Reversal of 20261107111833_notify_market_maintenance_components.sql: the trigger refuses a market name again, as 0027
-- wrote it. Rows already written keep their components (the trigger runs only on insert and on a change of components).
CREATE OR REPLACE FUNCTION notify.notice_components_known() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW.components) > 0 AND EXISTS (
    SELECT 1 FROM unnest(NEW.components) AS named(id)
    WHERE named.id NOT IN ('api', 'webhooks', 'console')
      AND NOT EXISTS (
        SELECT 1 FROM notify.status_page p, jsonb_array_elements(p.components) AS c
        WHERE c ->> 'id' = named.id
      )
  ) THEN
    RAISE EXCEPTION 'notify.notice_component_unknown' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
