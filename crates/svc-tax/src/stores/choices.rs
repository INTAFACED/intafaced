//! The customer's cost-basis choices (`services/svc-tax/src/choices.ts`, `createPgChoiceStore`): settings rows in schema
//! `tax`, keyed by the caller. They move no value and post nothing.

use std::sync::Arc;

use super::pool::{Pool, db_failure};
use crate::ports::{ChoiceStore, CostBasisChoices, DayChoice, EngineMethod, LotPick};
use crate::tax::Failure;

pub struct PgChoiceStore {
    pool: Arc<Pool>,
}

impl PgChoiceStore {
    pub fn new(pool: Arc<Pool>) -> PgChoiceStore {
        PgChoiceStore { pool }
    }

    fn exec(
        &self,
        sql: &str,
        params: &[&(dyn postgres::types::ToSql + Sync)],
    ) -> Result<(), Failure> {
        let mut conn = self.pool.get()?;
        conn.client()?
            .execute(sql, params)
            .map_err(|e| db_failure(&e))?;
        Ok(())
    }
}

fn method(raw: &str) -> Result<EngineMethod, Failure> {
    EngineMethod::parse(raw).ok_or_else(|| Failure::Internal(format!("unknown method {raw}")))
}

impl ChoiceStore for PgChoiceStore {
    fn read(&self, user_id: &str) -> Result<CostBasisChoices, Failure> {
        let mut conn = self.pool.get()?;
        let client = conn.client()?;
        let q = |client: &mut postgres::Client, sql: &str| {
            client.query(sql, &[&user_id]).map_err(|e| db_failure(&e))
        };
        let methods = q(
            client,
            "SELECT asset_id, method FROM tax.method_choices WHERE user_id = $1",
        )?;
        let days = q(
            client,
            "SELECT to_char(day, 'YYYY-MM-DD') AS day, asset_id, method FROM tax.method_days WHERE user_id = $1 ORDER BY day",
        )?;
        let picks = q(
            client,
            "SELECT sale_tx_id, asset_id, lot_id FROM tax.lot_picks WHERE user_id = $1",
        )?;
        let settings = q(
            client,
            "SELECT include_transfers FROM tax.pnl_settings WHERE user_id = $1",
        )?;
        let get = |e: postgres::Error| db_failure(&e);

        let mut out = CostBasisChoices::default();
        for row in &methods {
            let asset: String = row.try_get("asset_id").map_err(get)?;
            let m = method(row.try_get("method").map_err(get)?)?;
            if asset == "*" {
                out.account_method = Some(m);
            } else if let Some(slot) = out.asset_methods.iter_mut().find(|(a, _)| *a == asset) {
                slot.1 = m;
            } else {
                out.asset_methods.push((asset, m));
            }
        }
        for row in &days {
            let asset: String = row.try_get("asset_id").map_err(get)?;
            out.days.push(DayChoice {
                day: row.try_get("day").map_err(get)?,
                asset_id: (asset != "*").then_some(asset),
                method: method(row.try_get("method").map_err(get)?)?,
            });
        }
        for row in &picks {
            out.picks.push(LotPick {
                sale_tx_id: row.try_get("sale_tx_id").map_err(get)?,
                asset_id: row.try_get("asset_id").map_err(get)?,
                lot_id: row.try_get("lot_id").map_err(get)?,
            });
        }
        out.include_transfers = settings
            .first()
            .map(|r| r.try_get("include_transfers"))
            .transpose()
            .map_err(get)?;
        Ok(out)
    }

    fn set_method(
        &self,
        user_id: &str,
        asset_id: Option<&str>,
        m: Option<EngineMethod>,
    ) -> Result<(), Failure> {
        let asset = asset_id.unwrap_or("*");
        match m {
            None => self.exec(
                "DELETE FROM tax.method_choices WHERE user_id = $1 AND asset_id = $2",
                &[&user_id, &asset],
            ),
            Some(m) => self.exec(
                "INSERT INTO tax.method_choices (user_id, asset_id, method, updated_at) VALUES ($1, $2, $3, now())
                 ON CONFLICT (user_id, asset_id) DO UPDATE SET method = EXCLUDED.method, updated_at = now()",
                &[&user_id, &asset, &m.name()],
            ),
        }
    }

    fn set_day_method(
        &self,
        user_id: &str,
        day: &str,
        asset_id: Option<&str>,
        m: Option<EngineMethod>,
    ) -> Result<(), Failure> {
        let asset = asset_id.unwrap_or("*");
        match m {
            None => self.exec(
                "DELETE FROM tax.method_days WHERE user_id = $1 AND day = $2::text::date AND asset_id = $3",
                &[&user_id, &day, &asset],
            ),
            Some(m) => self.exec(
                "INSERT INTO tax.method_days (user_id, day, asset_id, method, updated_at) VALUES ($1, $2::text::date, $3, $4, now())
                 ON CONFLICT (user_id, day, asset_id) DO UPDATE SET method = EXCLUDED.method, updated_at = now()",
                &[&user_id, &day, &asset, &m.name()],
            ),
        }
    }

    fn set_pick(
        &self,
        user_id: &str,
        sale_tx_id: &str,
        asset_id: &str,
        lot_id: Option<&str>,
    ) -> Result<(), Failure> {
        match lot_id {
            None => self.exec(
                "DELETE FROM tax.lot_picks WHERE user_id = $1 AND sale_tx_id = $2 AND asset_id = $3",
                &[&user_id, &sale_tx_id, &asset_id],
            ),
            Some(lot) => self.exec(
                "INSERT INTO tax.lot_picks (user_id, sale_tx_id, asset_id, lot_id, updated_at) VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (user_id, sale_tx_id, asset_id) DO UPDATE SET lot_id = EXCLUDED.lot_id, updated_at = now()",
                &[&user_id, &sale_tx_id, &asset_id, &lot],
            ),
        }
    }

    fn set_include_transfers(&self, user_id: &str, include: Option<bool>) -> Result<(), Failure> {
        match include {
            None => self.exec("DELETE FROM tax.pnl_settings WHERE user_id = $1", &[&user_id]),
            Some(inc) => self.exec(
                "INSERT INTO tax.pnl_settings (user_id, include_transfers, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (user_id) DO UPDATE SET include_transfers = EXCLUDED.include_transfers, updated_at = now()",
                &[&user_id, &inc],
            ),
        }
    }
}
