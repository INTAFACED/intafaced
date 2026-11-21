//! What a person's agents cost, read back from the rows svc-agents stores (`services/svc-agents/src/review/store.ts`:
//! `analyticsRange`, `analyticsSummary`, `usageSummary`). Every read is the signed person's own rows and writes nothing.
//! Spend is only ever the sum of sealed windows as stored: an open window has no amount yet and is left out.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::days_in_month;

use crate::db::{self, StoreError};
use crate::errors::{AgentError, Refusal};

fn range_refusal(code: &'static str, key: &str, message: String) -> Refusal {
    Refusal::Agent(AgentError {
        code,
        user_key: key.to_owned(),
        message,
    })
}

/// `rangeDay`: blank refuses naming the end; anything but a real `YYYY-MM-DD` UTC day is invalid.
pub fn range_day(value: Option<&str>, end: &str) -> Result<String, Refusal> {
    let text = js_trim(value.unwrap_or_default());
    if text.is_empty() {
        return Err(range_refusal(
            "agents.analytics_range_unset",
            if end == "from" {
                "agents.refused.analytics_from_unset"
            } else {
                "agents.refused.analytics_to_unset"
            },
            format!("Analytics range {end} is unset — pass it (no default window is invented)"),
        ));
    }
    let b = text.as_bytes();
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = b.get(r)?;
        s.iter()
            .all(u8::is_ascii_digit)
            .then(|| s.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let real = b.len() == 10
        && b.get(4) == Some(&b'-')
        && b.get(7) == Some(&b'-')
        && match (digits(0..4), digits(5..7), digits(8..10)) {
            (Some(y), Some(m), Some(d)) => {
                (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
            }
            _ => false,
        };
    if !real {
        return Err(range_refusal(
            "agents.analytics_range_invalid",
            "agents.refused.analytics_range_invalid",
            format!("Analytics range {end} is not a day"),
        ));
    }
    Ok(text.to_owned())
}

/// `analyticsRange`: both ends, checked; a range that ends before it starts refuses.
pub fn analytics_range(from: Option<&str>, to: Option<&str>) -> Result<(String, String), Refusal> {
    let start = range_day(from, "from")?;
    let end = range_day(to, "to")?;
    if end < start {
        return Err(range_refusal(
            "agents.analytics_range_invalid",
            "agents.refused.analytics_range_invalid",
            "Analytics range ends before it starts".to_owned(),
        ));
    }
    Ok((start, end))
}

fn store(e: impl Into<StoreError>) -> Refusal {
    Refusal::Other(e.into().to_string())
}

fn amount_of(text: &str) -> Result<Amount, Refusal> {
    parse_amount(text).map_err(Refusal::Other)
}

/// One asset's sums, in asset order.
fn amounts(map: &BTreeMap<String, Amount>) -> Json {
    Json::Array(
        map.iter()
            .map(|(asset, amount)| {
                Json::obj([
                    ("assetId", Json::str(asset.clone())),
                    ("amount", Json::str(format_amount(*amount))),
                ])
            })
            .collect(),
    )
}

#[derive(Default)]
struct Acc {
    sessions: i64,
    executed: i64,
    refused: i64,
    failed: i64,
    test_runs: i64,
    spend: BTreeMap<String, Amount>,
}

fn figures(day: Option<&str>, acc: &Acc, include_test: bool) -> Json {
    let mut fields = Vec::new();
    if let Some(d) = day {
        fields.push(("day", Json::str(d)));
    }
    fields.extend([
        ("sessions", Json::int(acc.sessions)),
        (
            "actions",
            Json::int(acc.executed + acc.refused + acc.failed),
        ),
        ("executed", Json::int(acc.executed)),
        ("refused", Json::int(acc.refused)),
        ("failed", Json::int(acc.failed)),
        (
            "testRuns",
            if include_test {
                Json::int(acc.test_runs)
            } else {
                Json::Null
            },
        ),
        ("spend", amounts(&acc.spend)),
    ]);
    obj(fields)
}

const FROM: &str = "$2::text::date::timestamp AT TIME ZONE 'UTC'";
const UNTIL: &str = "($3::text::date + 1)::timestamp AT TIME ZONE 'UTC'";

/// `analyticsSummary`: sessions by the day they opened, actions by outcome and day, spend as the sealed windows of the
/// person's sessions by the day the window opened, and test and dry runs only when asked.
pub fn analytics_summary(
    pool: &Pool,
    user_id: &str,
    from: &str,
    to: &str,
    include_test: bool,
    fee_asset_id: &str,
) -> Result<Json, Refusal> {
    let mut by_day: BTreeMap<String, Acc> = BTreeMap::new();
    db::with_client(pool, |c| {
        for r in c.query(
            &format!(
                "SELECT to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*)::int
                   FROM agents.agent_sessions
                  WHERE user_id = $1::text AND opened_at >= {FROM} AND opened_at < {UNTIL}
                  GROUP BY 1"
            ),
            &[&user_id, &from, &to],
        )? {
            by_day.entry(r.try_get(0)?).or_default().sessions += i64::from(r.try_get::<_, i32>(1)?);
        }
        for r in c.query(
            &format!(
                "SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), status::text, count(*)::int
                   FROM agents.agent_actions
                  WHERE user_id = $1::text AND occurred_at >= {FROM} AND occurred_at < {UNTIL}
                  GROUP BY 1, 2"
            ),
            &[&user_id, &from, &to],
        )? {
            let acc = by_day.entry(r.try_get(0)?).or_default();
            let n = i64::from(r.try_get::<_, i32>(2)?);
            match r.try_get::<_, String>(1)?.as_str() {
                "executed" => acc.executed += n,
                "refused" => acc.refused += n,
                _ => acc.failed += n,
            }
        }
        for r in c.query(
            "SELECT left(w.window_id, 10), coalesce(w.charged_asset, $4::text),
                    coalesce(sum(w.charged_amount), 0)::text
               FROM agents.usage_windows w
               JOIN agents.agent_sessions s ON s.id = w.session_id
              WHERE s.user_id = $1::text AND w.sealed_at IS NOT NULL
                AND left(w.window_id, 10) >= $2::text AND left(w.window_id, 10) <= $3::text
              GROUP BY 1, 2",
            &[&user_id, &from, &to, &fee_asset_id],
        )? {
            let amount: String = r.try_get(2)?;
            let amount = parse_amount(&amount).map_err(|e| StoreError::new(e, None))?;
            *by_day
                .entry(r.try_get(0)?)
                .or_default()
                .spend
                .entry(r.try_get(1)?)
                .or_default() += amount;
        }
        if include_test {
            for r in c.query(
                &format!(
                    "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*)::int
                       FROM agents.own_agent_test_runs
                      WHERE owner_id = $1::text AND created_at >= {FROM} AND created_at < {UNTIL}
                      GROUP BY 1"
                ),
                &[&user_id, &from, &to],
            )? {
                by_day.entry(r.try_get(0)?).or_default().test_runs += i64::from(r.try_get::<_, i32>(1)?);
            }
        }
        Ok(())
    })
    .map_err(store)?;

    let mut total = Acc::default();
    let mut days = Vec::new();
    for (day, acc) in &by_day {
        total.sessions += acc.sessions;
        total.executed += acc.executed;
        total.refused += acc.refused;
        total.failed += acc.failed;
        total.test_runs += acc.test_runs;
        for (asset, amount) in &acc.spend {
            *total.spend.entry(asset.clone()).or_default() += amount;
        }
        days.push(figures(Some(day), acc, include_test));
    }
    Ok(Json::obj([
        ("from", Json::str(from)),
        ("to", Json::str(to)),
        ("includesTest", Json::Bool(include_test)),
        ("totals", figures(None, &total, include_test)),
        ("days", Json::Array(days)),
    ]))
}

/// One grouping's row (`Group`), keyed by its key and asset.
struct Group {
    name: Option<String>,
    windows: i64,
    amount: Amount,
}

fn group(
    map: &mut BTreeMap<(String, String), Group>,
    key: &str,
    name: Option<&str>,
    asset: &str,
    amount: Amount,
) {
    map.entry((key.to_owned(), asset.to_owned()))
        .and_modify(|g| {
            g.windows += 1;
            g.amount += amount;
        })
        .or_insert_with(|| Group {
            name: name.map(str::to_owned),
            windows: 1,
            amount,
        });
}

fn group_rows(map: &BTreeMap<(String, String), Group>) -> Json {
    // `a.key < b.key`, then the asset: JavaScript compares strings by UTF-16 code unit.
    let mut rows: Vec<_> = map.iter().collect();
    rows.sort_by(|((ka, aa), _), ((kb, ab), _)| {
        ka.encode_utf16()
            .cmp(kb.encode_utf16())
            .then_with(|| aa.encode_utf16().cmp(ab.encode_utf16()))
    });
    Json::Array(
        rows.into_iter()
            .map(|((key, asset), g)| {
                Json::obj([
                    ("key", Json::str(key.clone())),
                    ("name", g.name.clone().map_or(Json::Null, Json::String)),
                    ("windows", Json::int(g.windows)),
                    ("assetId", Json::str(asset.clone())),
                    ("amount", Json::str(format_amount(g.amount))),
                ])
            })
            .collect(),
    )
}

/// `usageSummary`: the person's sealed windows, the newest `limit` of them, how many there are, and the totals by
/// agent, user and task, each adding up to the same total.
pub fn usage_summary(
    pool: &Pool,
    user_id: &str,
    limit: usize,
    fee_asset_id: &str,
) -> Result<Json, Refusal> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT w.session_id::text, s.user_id, s.agent_id, nullif(oa.name, '') AS agent_name, w.window_id,
                    coalesce(t.tasks, '') AS task,
                    (w.charge_tx_id IS NULL AND w.charged_amount > 0) AS unpaid,
                    coalesce(w.charged_amount, 0)::text AS amount, coalesce(w.charged_asset, $2::text) AS asset
               FROM agents.usage_windows w
               JOIN agents.agent_sessions s ON s.id = w.session_id
               LEFT JOIN agents.own_agents oa ON oa.id::text = s.agent_id AND oa.owner_id = s.user_id
               LEFT JOIN LATERAL (
                 SELECT string_agg(DISTINCT r.task, ', ' ORDER BY r.task) AS tasks
                   FROM agents.usage_records r
                  WHERE r.session_id = w.session_id AND r.window_id = w.window_id
               ) t ON true
              WHERE s.user_id = $1::text AND w.sealed_at IS NOT NULL
              ORDER BY w.window_id DESC, w.session_id DESC",
            &[&user_id, &fee_asset_id],
        )?)
    })
    .map_err(store)?;
    let mut total: BTreeMap<String, Amount> = BTreeMap::new();
    let (mut by_agent, mut by_user, mut by_task) =
        (BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
    let mut windows = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let get = |k: usize| -> Result<String, Refusal> { r.try_get(k).map_err(store) };
        let session_id = get(0)?;
        let owner = get(1)?;
        let agent_id = get(2)?;
        let agent_name: Option<String> = r.try_get(3).map_err(store)?;
        let window_id = get(4)?;
        let task = get(5)?;
        let unpaid: bool = r.try_get(6).map_err(store)?;
        let amount = amount_of(&get(7)?)?;
        let asset = get(8)?;
        *total.entry(asset.clone()).or_default() += amount;
        group(
            &mut by_agent,
            &agent_id,
            agent_name.as_deref(),
            &asset,
            amount,
        );
        group(&mut by_user, &owner, None, &asset, amount);
        group(&mut by_task, &task, None, &asset, amount);
        if i < limit {
            windows.push(Json::obj([
                ("sessionId", Json::str(session_id)),
                ("agentId", Json::str(agent_id)),
                ("agentName", agent_name.map_or(Json::Null, Json::String)),
                ("windowId", Json::str(window_id.clone())),
                ("day", Json::str(window_id.get(0..10).unwrap_or(&window_id))),
                ("task", Json::str(task)),
                (
                    "state",
                    Json::str(if unpaid { "unpaid" } else { "settled" }),
                ),
                ("amount", Json::str(format_amount(amount))),
                ("assetId", Json::str(asset)),
            ]));
        }
    }
    Ok(Json::obj([
        (
            "windowCount",
            Json::int(i64::try_from(rows.len()).unwrap_or(i64::MAX)),
        ),
        ("windows", Json::Array(windows)),
        ("total", amounts(&total)),
        ("byAgent", group_rows(&by_agent)),
        ("byUser", group_rows(&by_user)),
        ("byTask", group_rows(&by_task)),
    ]))
}

/// An object from fields built up one by one, in their order.
fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn code(r: Result<(String, String), Refusal>) -> (&'static str, String) {
        match r {
            Err(Refusal::Agent(a)) => (a.code, a.user_key),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_blank_end_refuses_by_name_and_a_day_that_is_not_real_is_invalid() {
        assert_eq!(
            code(analytics_range(None, Some("2026-11-01"))),
            (
                "agents.analytics_range_unset",
                "agents.refused.analytics_from_unset".to_owned()
            )
        );
        assert_eq!(
            code(analytics_range(Some("2026-11-01"), Some("  "))),
            (
                "agents.analytics_range_unset",
                "agents.refused.analytics_to_unset".to_owned()
            )
        );
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "26-11-01",
            "2026-11-1",
            "2026-11-01T00:00:00Z",
        ] {
            assert_eq!(
                code(analytics_range(Some(bad), Some("2026-12-01"))).0,
                "agents.analytics_range_invalid"
            );
        }
        assert_eq!(
            code(analytics_range(Some("2026-11-02"), Some("2026-11-01"))).0,
            "agents.analytics_range_invalid"
        );
        assert_eq!(
            analytics_range(Some(" 2024-02-29 "), Some("2024-02-29")).unwrap(),
            ("2024-02-29".to_owned(), "2024-02-29".to_owned())
        );
    }
}
