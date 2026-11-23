//! The desk (`programme-ops.ts`): settings and the checklist, the authorisation rules, staff and the audit log, the
//! decision log and one authorisation, the report and its signed export, and the desk's first paint.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::{Deps, LIST, assert_may_change, audit, is_uuid, js_len, jsonb, safe_parse};
use crate::cards::moves::decide::RuleParams;
use crate::cards::ms;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `SETTING_KEYS`.
pub const SETTING_KEYS: [&str; 5] = ["programme", "product", "bin", "fees", "threeds"];

/// `SHADOW_SAMPLE`: the last 100 authorisations on simulated (TEST) cards, what a shadow rule is run over.
pub const SHADOW_SAMPLE: i64 = 100;

/// `EXPORT_INFO`.
const EXPORT_INFO: &str = "svc-bank card programme report v1";

/// The recorded schema of one setting (`SETTING_SCHEMAS[key]`).
pub fn setting_schema(key: &str) -> String {
    format!("ops.cardProgrammeConfigure#{key}")
}

/// The recorded rule params schema (`ruleParamsSchema`).
pub const RULE_PARAMS: &str = "ops.cardProgrammeRuleCreate#params";

fn at(t: i64) -> Json {
    Json::str(Instant(t).iso())
}

fn opt_at(t: Option<i64>) -> Json {
    t.map_or(Json::Null, at)
}

fn opt_str(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::str)
}

fn num(n: i64) -> Json {
    Json::int(n)
}

/// `settings`: each key's value as last saved and parsed, or null (a stored value that does not parse is left out).
pub fn settings(c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT key, value::text, version::int8, updated_by, {} FROM bank.card_programme_settings",
                ms("updated_at")
            ),
            &[],
        )
        .map_err(|e| pg(&e))?;
    let mut out: Vec<(String, Json)> = SETTING_KEYS
        .iter()
        .map(|k| ((*k).to_owned(), Json::Null))
        .collect();
    for r in &rows {
        let key: String = r.get(0);
        let Some(slot) = out.iter_mut().find(|(k, _)| *k == key) else {
            return Err(Refusal::Other(format!("no setting schema for {key}")));
        };
        if let Ok(value) = safe_parse(&setting_schema(&key), &jsonb(&r.get::<_, String>(1))?)? {
            slot.1 = Json::obj([
                ("value", value),
                ("version", num(r.get(2))),
                ("updatedBy", Json::str(r.get::<_, String>(3))),
                ("updatedAt", at(r.get(4))),
            ]);
        }
    }
    Ok(Json::Object(out))
}

fn path_word(p: &Json) -> String {
    match p {
        Json::String(s) => s.clone(),
        other => other.compact(),
    }
}

/// `configure`: the value in shape, then the viewer check, then the row and its audit in one transaction.
pub fn configure(d: &Deps<'_>, actor: &str, key: &str, value: &Json) -> Result<Json, Refusal> {
    let parsed = match safe_parse(&setting_schema(key), value)? {
        Ok(v) => v,
        Err(issues) => {
            let words: Vec<String> = issues
                .iter()
                .map(|i| {
                    let path: Vec<String> = i.path().iter().map(path_word).collect();
                    let path = path.join(".");
                    format!(
                        "{}: {}",
                        if path.is_empty() { key } else { &path },
                        i.message()
                    )
                })
                .collect();
            return Err(refuse(
                "bank.card_programme_invalid",
                format!(
                    "That {key} setting is not in shape: {} (bank.card_programme_invalid)",
                    words.join("; ")
                ),
            ));
        }
    };
    with(d.store(), |c| assert_may_change(c, actor))?;
    in_tx(d.store(), |tx| {
        let before = tx
            .query(
                "SELECT value::text, version::int8 FROM bank.card_programme_settings WHERE key = $1 FOR UPDATE",
                &[&key],
            )
            .map_err(|e| pg(&e))?;
        let (before_value, version) = match before.first() {
            Some(r) => (Some(jsonb(&r.get::<_, String>(0))?), r.get::<_, i64>(1)),
            None => (None, 0),
        };
        let text = parsed.compact();
        tx.execute(
            "INSERT INTO bank.card_programme_settings (key, value, version, updated_by) \
             VALUES ($1, $2::text::jsonb, $3::int8::int4, $4) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version, \
               updated_by = EXCLUDED.updated_by, updated_at = now()",
            &[&key, &text, &(version + 1), &actor],
        )
        .map_err(|e| pg(&e))?;
        audit(
            tx,
            actor,
            &format!("setting.{key}"),
            key,
            before_value.as_ref(),
            Some(&parsed),
        )
    })?;
    with(d.store(), settings)
}

/// `clearThreeDs`: online payments are asked no challenge by this app again.
pub fn clear_three_ds(d: &Deps<'_>, actor: &str) -> Result<Json, Refusal> {
    with(d.store(), |c| assert_may_change(c, actor))?;
    in_tx(d.store(), |tx| {
        let rows = tx
            .query(
                "DELETE FROM bank.card_programme_settings WHERE key = 'threeds' RETURNING value::text",
                &[],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = rows.first() {
            let before = jsonb(&r.get::<_, String>(0))?;
            audit(
                tx,
                actor,
                "setting.threeds.clear",
                "threeds",
                Some(&before),
                None,
            )?;
        }
        Ok(())
    })?;
    with(d.store(), settings)
}

/// `checklist`: derived from what is stored. There is no "go live" control: a live issuer is not a setting.
pub fn checklist(d: &Deps<'_>, c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let s = settings(c)?;
    let programme = d.cards.issuer().programme();
    let counts = c
        .query(
            "SELECT (SELECT count(*)::int8 FROM bank.card_programme_rules WHERE state = 'active'), \
                    (SELECT count(*)::int8 FROM bank.card_programme_staff)",
            &[],
        )
        .map_err(|e| pg(&e))?;
    let (rules, staff): (i64, i64) = counts.first().map_or((0, 0), |r| (r.get(0), r.get(1)));
    let set = |k: &str| !matches!(s.get(k), None | Some(Json::Null));
    let item = |id: &str, label: &str, done: bool, blocker: &str| {
        Json::obj([
            ("id", Json::str(id)),
            ("label", Json::str(label)),
            ("done", Json::Bool(done)),
            (
                "blocker",
                if done { Json::Null } else { Json::str(blocker) },
            ),
        ])
    };
    Ok(Json::Array(vec![
        item(
            "programme",
            "Programme: consumer or commercial, currencies, fulfilment",
            set("programme"),
            "Not configured yet.",
        ),
        item(
            "product",
            "Card product",
            set("product"),
            "Not configured yet.",
        ),
        item("bin", "BIN and network", set("bin"), "Not configured yet."),
        item(
            "issuer",
            "Card issuer",
            !programme.simulated,
            &format!(
                "rail.card: the card issuer is {}, a simulation (TEST). A live issuer is not connected, so no real card exists.",
                programme.display_name
            ),
        ),
        item(
            "rules",
            "Authorisation rules",
            rules > 0,
            "No rule is promoted.",
        ),
        item(
            "fees",
            "Cardholder fees",
            set("fees"),
            "Not set: no fee line shows and none is charged.",
        ),
        item(
            "threeds",
            "3DS policy and SCA exemptions",
            set("threeds"),
            "Not set: this app asks online payments no challenge.",
        ),
        item("staff", "Staff roles", staff > 0, "No staff role is given."),
    ]))
}

fn rule_cols() -> String {
    format!(
        "id::text, rule_key, version::int8, name, params::text, state, shadow_evaluated::int8, \
         shadow_would_decline::int8, {}, created_by, {}, {}, {}",
        ms("shadow_at"),
        ms("created_at"),
        ms("promoted_at"),
        ms("retired_at")
    )
}

/// Params the rule schema accepted, as the authorise path reads them (`cards::moves::decide`, slice `card-ops`).
fn rule_of(params: &Json) -> Result<RuleParams, Refusal> {
    RuleParams::parse(params).ok_or_else(|| {
        Refusal::Other(format!(
            "rule params the schema accepted do not parse: {}",
            params.compact()
        ))
    })
}

/// One rule as the desk shows it, or `None` when its stored params do not parse.
fn rule_json(r: &Row) -> Result<Option<Json>, Refusal> {
    let Ok(params) = safe_parse(RULE_PARAMS, &jsonb(&r.get::<_, String>(4))?)? else {
        return Ok(None);
    };
    let words = rule_of(&params)?.words();
    Ok(Some(Json::obj([
        ("id", Json::str(r.get::<_, String>(0))),
        ("ruleKey", Json::str(r.get::<_, String>(1))),
        ("version", num(r.get(2))),
        ("name", Json::str(r.get::<_, String>(3))),
        ("params", params),
        ("words", Json::str(words)),
        ("state", Json::str(r.get::<_, String>(5))),
        (
            "shadow",
            Json::obj([
                ("evaluated", num(r.get(6))),
                ("wouldDecline", num(r.get(7))),
                ("at", at(r.get(8))),
            ]),
        ),
        ("createdBy", Json::str(r.get::<_, String>(9))),
        ("createdAt", at(r.get(10))),
        ("promotedAt", opt_at(r.get(11))),
        ("retiredAt", opt_at(r.get(12))),
    ])))
}

/// `rules`: the newest 50 versions; one whose stored params do not parse is left out.
pub fn rules(c: &mut impl GenericClient) -> Result<Vec<Json>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.card_programme_rules ORDER BY created_at DESC, version DESC LIMIT $1",
                rule_cols()
            ),
            &[&LIST],
        )
        .map_err(|e| pg(&e))?;
    let mut out = Vec::new();
    for r in &rows {
        out.extend(rule_json(r)?);
    }
    Ok(out)
}

fn rule_key_ok(key: &str) -> bool {
    let b = key.as_bytes();
    let first = b
        .first()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    first
        && (2..=64).contains(&b.len())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `createRule`: a new rule, or a new version of one, in shadow: it decides nothing, and is run over the last 100 TEST
/// authorisations.
pub fn create_rule(
    d: &Deps<'_>,
    actor: &str,
    rule_key: &str,
    name: &str,
    params: &Json,
) -> Result<Json, Refusal> {
    let parsed = safe_parse(RULE_PARAMS, params)?;
    let key = service_kit::money::js_trim(rule_key);
    let name = service_kit::money::js_trim(name);
    let parsed = match parsed {
        Ok(p) if rule_key_ok(key) && !name.is_empty() && js_len(name) <= 80 => p,
        _ => {
            return Err(refuse(
                "bank.card_programme_invalid",
                "A rule needs a key (lower-case letters, digits and dashes), a name and a kind with its value (bank.card_programme_invalid)",
            ));
        }
    };
    with(d.store(), |c| assert_may_change(c, actor))?;
    let sample = with(d.store(), |c| {
        c.query(
            "SELECT k.asset_id, a.amount::text, a.channel, a.merchant_category \
               FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id \
              WHERE k.simulated \
              ORDER BY a.decided_at DESC, a.id DESC \
              LIMIT $1",
            &[&SHADOW_SAMPLE],
        )
        .map_err(|e| pg(&e))
    })?;
    let rule = rule_of(&parsed)?;
    let mut would_decline: i64 = 0;
    for a in &sample {
        let asset: String = a.get(0);
        let amount = parse_amount(&a.get::<_, String>(1)).map_err(Refusal::Other)?;
        let channel: String = a.get(2);
        let mc: Option<String> = a.get(3);
        if rule.declines(&asset, amount, &channel, mc.as_deref()) {
            would_decline += 1;
        }
    }
    let evaluated = i64::try_from(sample.len()).unwrap_or(i64::MAX);
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    let kind = match parsed.get("kind") {
        Some(Json::String(k)) => k.clone(),
        _ => String::new(),
    };
    let now = d.cards.now().0;
    in_tx(d.store(), |tx| {
        let lock = format!("card-rule:{key}");
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&lock])
            .map_err(|e| pg(&e))?;
        let last: Option<i64> = tx
            .query(
                "SELECT max(version)::int8 FROM bank.card_programme_rules WHERE rule_key = $1",
                &[&key],
            )
            .map_err(|e| pg(&e))?
            .first()
            .and_then(|r| r.get(0));
        let version = last.unwrap_or(0) + 1;
        let params_text = parsed.compact();
        tx.execute(
            "INSERT INTO bank.card_programme_rules (id, rule_key, version, name, kind, params, state, shadow_evaluated, \
               shadow_would_decline, shadow_at, created_by) \
             VALUES ($1::text::uuid, $2, $3::int8::int4, $4, $5, $6::text::jsonb, 'shadow', $7::int8::int4, $8::int8::int4, \
               to_timestamp($9::int8 / 1000.0), $10)",
            &[
                &id,
                &key,
                &version,
                &name,
                &kind,
                &params_text,
                &evaluated,
                &would_decline,
                &now,
                &actor,
            ],
        )
        .map_err(|e| pg(&e))?;
        audit(
            tx,
            actor,
            "rule.shadow",
            &format!("{key} v{version}"),
            None,
            Some(&Json::obj([
                ("name", Json::str(name)),
                ("params", parsed.clone()),
                ("evaluated", num(evaluated)),
                ("wouldDecline", num(would_decline)),
            ])),
        )
    })?;
    with(d.store(), rules)?
        .into_iter()
        .find(|r| matches!(r.get("id"), Some(Json::String(s)) if *s == id))
        .ok_or_else(|| Refusal::Other("the new rule is not among the newest".to_owned()))
}

fn rule_state() -> Refusal {
    refuse(
        "bank.card_rule_state",
        "Only a rule in shadow can be promoted (bank.card_rule_state)",
    )
}

/// `promoteRule`: the shadow version decides new authorisations from now; the version it replaces retires. Past
/// decisions stay as they were.
pub fn promote_rule(d: &Deps<'_>, actor: &str, rule_id: &str) -> Result<Json, Refusal> {
    with(d.store(), |c| assert_may_change(c, actor))?;
    in_tx(d.store(), |tx| {
        let rows = tx
            .query(
                "SELECT rule_key, version::int8, state FROM bank.card_programme_rules WHERE id = $1::text::uuid FOR UPDATE",
                &[&rule_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(rule) = rows.first() else {
            return Err(refuse(
                "bank.card_rule_not_found",
                "No such card programme rule (bank.card_rule_not_found)",
            ));
        };
        let (key, version, state): (String, i64, String) = (rule.get(0), rule.get(1), rule.get(2));
        if state != "shadow" {
            return Err(rule_state());
        }
        let lock = format!("card-rule:{key}");
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&lock])
            .map_err(|e| pg(&e))?;
        let retired: Option<i64> = tx
            .query(
                "UPDATE bank.card_programme_rules SET state = 'retired', retired_at = now() \
                  WHERE rule_key = $1 AND state = 'active' RETURNING version::int8",
                &[&key],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| r.get(0));
        tx.execute(
            "UPDATE bank.card_programme_rules SET state = 'active', promoted_at = now(), retired_at = NULL \
              WHERE id = $1::text::uuid",
            &[&rule_id],
        )
        .map_err(|e| pg(&e))?;
        audit(
            tx,
            actor,
            "rule.promote",
            &format!("{key} v{version}"),
            retired.map(|v| Json::obj([("active", num(v))])).as_ref(),
            Some(&Json::obj([("active", num(version))])),
        )
    })?;
    Ok(Json::Array(with(d.store(), rules)?))
}

/// `rollbackRule`: the promoted version retires and the version promoted before it decides again, or none does.
pub fn rollback_rule(d: &Deps<'_>, actor: &str, rule_key: &str) -> Result<Json, Refusal> {
    with(d.store(), |c| assert_may_change(c, actor))?;
    in_tx(d.store(), |tx| {
        let lock = format!("card-rule:{rule_key}");
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&lock])
            .map_err(|e| pg(&e))?;
        let rows = tx
            .query(
                "SELECT id::text, version::int8 FROM bank.card_programme_rules \
                  WHERE rule_key = $1 AND state = 'active' FOR UPDATE",
                &[&rule_key],
            )
            .map_err(|e| pg(&e))?;
        let Some(active) = rows.first() else {
            return Err(refuse(
                "bank.card_rule_state",
                "This rule has no promoted version to roll back (bank.card_rule_state)",
            ));
        };
        let (active_id, active_version): (String, i64) = (active.get(0), active.get(1));
        tx.execute(
            "UPDATE bank.card_programme_rules SET state = 'retired', retired_at = now() WHERE id = $1::text::uuid",
            &[&active_id],
        )
        .map_err(|e| pg(&e))?;
        let previous: Option<(String, i64)> = tx
            .query(
                "SELECT id::text, version::int8 FROM bank.card_programme_rules \
                  WHERE rule_key = $1 AND version < $2::int8 AND promoted_at IS NOT NULL \
                  ORDER BY version DESC LIMIT 1",
                &[&rule_key, &active_version],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| (r.get(0), r.get(1)));
        if let Some((id, _)) = &previous {
            tx.execute(
                "UPDATE bank.card_programme_rules SET state = 'active', promoted_at = now(), retired_at = NULL \
                  WHERE id = $1::text::uuid",
                &[id],
            )
            .map_err(|e| pg(&e))?;
        }
        audit(
            tx,
            actor,
            "rule.rollback",
            rule_key,
            Some(&Json::obj([("active", num(active_version))])),
            Some(&Json::obj([(
                "active",
                previous.map_or(Json::Null, |(_, v)| num(v)),
            )])),
        )
    })?;
    Ok(Json::Array(with(d.store(), rules)?))
}

/// `staff`: the newest 50 roles.
pub fn staff(c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT user_id, email, role, assigned_by, {} FROM bank.card_programme_staff \
                 ORDER BY assigned_at DESC, user_id LIMIT $1",
                ms("assigned_at")
            ),
            &[&LIST],
        )
        .map_err(|e| pg(&e))?;
    Ok(Json::Array(
        rows.iter()
            .map(|r| {
                Json::obj([
                    ("userId", Json::str(r.get::<_, String>(0))),
                    ("email", Json::str(r.get::<_, String>(1))),
                    ("role", Json::str(r.get::<_, String>(2))),
                    ("assignedBy", Json::str(r.get::<_, String>(3))),
                    ("assignedAt", at(r.get(4))),
                ])
            })
            .collect(),
    ))
}

/// `assignStaff`: a role for an active account found by email, never one's own.
pub fn assign_staff(d: &Deps<'_>, actor: &str, email: &str, role: &str) -> Result<Json, Refusal> {
    with(d.store(), |c| assert_may_change(c, actor))?;
    let Some(user_id) = super::holders::find_account(d, email)? else {
        return Err(refuse(
            "bank.card_programme_invalid",
            "No active account has that email, so no role was given (bank.card_programme_invalid)",
        ));
    };
    if user_id == actor {
        return Err(refuse(
            "bank.card_programme_staff_self",
            "You cannot change your own card programme role (bank.card_programme_staff_self)",
        ));
    }
    let email = service_kit::money::js_trim(email).to_lowercase();
    in_tx(d.store(), |tx| {
        let before: Option<String> = tx
            .query(
                "SELECT role FROM bank.card_programme_staff WHERE user_id = $1 FOR UPDATE",
                &[&user_id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| r.get(0));
        tx.execute(
            "INSERT INTO bank.card_programme_staff (user_id, email, role, assigned_by) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email, \
               assigned_by = EXCLUDED.assigned_by, assigned_at = now()",
            &[&user_id, &email, &role, &actor],
        )
        .map_err(|e| pg(&e))?;
        audit(
            tx,
            actor,
            "staff.assign",
            &email,
            before.map(|r| Json::obj([("role", Json::str(r))])).as_ref(),
            Some(&Json::obj([("role", Json::str(role))])),
        )
    })?;
    with(d.store(), staff)
}

/// `auditLog`: the newest 50 staff actions. TEST simulator events are kept in the log but listed in the decision log,
/// so they never crowd staff actions out.
pub fn audit_log(c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT id::text, actor, action, target, before::text, after::text, {} \
                   FROM bank.card_programme_audit WHERE action NOT LIKE 'simulator.%' \
                  ORDER BY id DESC LIMIT $1",
                ms("at")
            ),
            &[&LIST],
        )
        .map_err(|e| pg(&e))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let side = |i: usize| -> Result<Json, Refusal> {
            match r.get::<_, Option<String>>(i) {
                None => Ok(Json::Null),
                Some(t) => Ok(Json::str(jsonb(&t)?.compact())),
            }
        };
        out.push(Json::obj([
            ("id", Json::str(r.get::<_, String>(0))),
            ("actor", Json::str(r.get::<_, String>(1))),
            ("action", Json::str(r.get::<_, String>(2))),
            ("target", Json::str(r.get::<_, String>(3))),
            ("before", side(4)?),
            ("after", side(5)?),
            ("at", at(r.get(6))),
        ]));
    }
    Ok(Json::Array(out))
}

fn amount_text(s: &str) -> Result<String, Refusal> {
    Ok(format_amount(parse_amount(s).map_err(Refusal::Other)?))
}

/// `decisionLog`: the newest 50 authorisations, each decided by the card path.
pub fn decision_log(c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT a.id::text, a.card_id::text, k.pan_tail, k.asset_id, a.amount::text, a.channel, a.merchant_category, \
                        a.decision::text, a.decline_code, a.status::text, {}, k.simulated \
                   FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id \
                  ORDER BY a.decided_at DESC, a.id DESC LIMIT $1",
                ms("a.decided_at")
            ),
            &[&LIST],
        )
        .map_err(|e| pg(&e))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(Json::obj([
            ("id", Json::str(r.get::<_, String>(0))),
            ("cardId", Json::str(r.get::<_, String>(1))),
            ("panTail", Json::str(r.get::<_, String>(2))),
            ("assetId", Json::str(r.get::<_, String>(3))),
            ("amount", Json::str(amount_text(&r.get::<_, String>(4))?)),
            ("channel", Json::str(r.get::<_, String>(5))),
            ("merchantCategory", opt_str(r.get(6))),
            ("decision", Json::str(r.get::<_, String>(7))),
            ("declineCode", opt_str(r.get(8))),
            ("status", Json::str(r.get::<_, String>(9))),
            ("decidedAt", at(r.get(10))),
            ("test", Json::Bool(r.get(11))),
        ]));
    }
    Ok(Json::Array(out))
}

/// One step of a stored trace, in `traceStep`'s key order.
fn trace_step(s: &Json) -> Json {
    let f = |k: &str| s.get(k).cloned().unwrap_or(Json::Null);
    Json::obj([
        ("check", f("check")),
        ("result", f("result")),
        ("detail", f("detail")),
    ])
}

fn authorization_not_found() -> Refusal {
    refuse(
        "bank.ops_authorization_not_found",
        "No such card authorisation (bank.ops_authorization_not_found)",
    )
}

/// `authorization`: one authorisation, its lifecycle, capture variance and the trace of why it was decided. An id that is
/// no uuid is not asked of the database.
pub fn authorization(d: &Deps<'_>, id: &str) -> Result<Json, Refusal> {
    if !is_uuid(id) {
        return Err(authorization_not_found());
    }
    with(d.store(), |c| authorization_of(c, id))
}

fn authorization_of(c: &mut impl GenericClient, id: &str) -> Result<Json, Refusal> {
    let not_found = authorization_not_found;
    let rows = c
        .query(
            &format!(
                "SELECT a.id::text, a.card_id::text, a.authorization_ref, k.pan_tail, k.asset_id, a.amount::text, a.channel, \
                        a.merchant_category, a.decision::text, a.decline_code, a.status::text, a.money_book, a.partner_hold_ref, \
                        {}, k.simulated \
                   FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id WHERE a.id = $1::text::uuid",
                ms("a.decided_at")
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    let a = rows.first().ok_or_else(not_found)?;
    let auth_id: String = a.get(0);
    let settlements = c
        .query(
            &format!(
                "SELECT kind::text, amount::text, status::text, partner_ref, money_book, {}, {} \
                   FROM bank.card_settlements WHERE authorization_id = $1::text::uuid ORDER BY sequence",
                ms("settled_at"),
                ms("created_at")
            ),
            &[&auth_id],
        )
        .map_err(|e| pg(&e))?;
    let trace: Option<String> = c
        .query(
            "SELECT steps::text FROM bank.card_authorization_traces WHERE authorization_id = $1::text::uuid",
            &[&auth_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| r.get(0));
    let authorised = parse_amount(&a.get::<_, String>(5)).map_err(Refusal::Other)?;
    let decision: String = a.get(8);
    let status: String = a.get(10);
    let mut captured: Amount = 0;
    let mut returned: Amount = 0;
    let mut lifecycle = vec![Json::obj([
        (
            "event",
            Json::str(if decision == "approved" {
                "authorised"
            } else {
                "declined"
            }),
        ),
        ("amount", Json::str(format_amount(authorised))),
        ("at", at(a.get(13))),
        ("detail", opt_str(a.get(9))),
    ])];
    for s in &settlements {
        let kind: String = s.get(0);
        let amount = parse_amount(&s.get::<_, String>(1)).map_err(Refusal::Other)?;
        let st: String = s.get(2);
        let partner_ref: Option<String> = s.get(3);
        if st == "settled" {
            if kind == "capture" {
                captured += amount;
            } else if kind == "reversal" {
                returned += amount;
            }
        }
        let event = if kind == "capture" {
            "captured"
        } else if partner_ref
            .as_deref()
            .is_some_and(|r| r.ends_with(":expired"))
        {
            "expired: given back by the partner when its hold time ran out"
        } else {
            "given back"
        };
        let detail = if st == "settled" {
            opt_str(partner_ref)
        } else {
            match partner_ref.filter(|r| !r.is_empty()) {
                Some(r) => Json::str(format!("{st}, {r}")),
                None => Json::str(st.clone()),
            }
        };
        let when: i64 = s.get::<_, Option<i64>>(5).unwrap_or_else(|| s.get(6));
        lifecycle.push(Json::obj([
            ("event", Json::str(event)),
            ("amount", Json::str(format_amount(amount))),
            ("at", at(when)),
            ("detail", detail),
        ]));
    }
    let open = if decision == "approved" && status == "settled" {
        authorised - captured - returned
    } else {
        0
    };
    let variance = if decision == "approved" {
        Json::obj([
            ("authorised", Json::str(format_amount(authorised))),
            ("captured", Json::str(format_amount(captured))),
            ("returned", Json::str(format_amount(returned))),
            ("stillHeld", Json::str(format_amount(open))),
            (
                "captureVariance",
                Json::str(format_amount(captured - authorised)),
            ),
        ])
    } else {
        Json::Null
    };
    let trace = match trace {
        None => Json::Null,
        Some(t) => match jsonb(&t)? {
            Json::Array(steps) => Json::Array(steps.iter().map(trace_step).collect()),
            other => other,
        },
    };
    Ok(Json::obj([
        ("id", Json::str(auth_id.clone())),
        ("cardId", Json::str(a.get::<_, String>(1))),
        ("authorizationRef", Json::str(a.get::<_, String>(2))),
        ("panTail", Json::str(a.get::<_, String>(3))),
        ("assetId", Json::str(a.get::<_, String>(4))),
        ("amount", Json::str(format_amount(authorised))),
        ("channel", Json::str(a.get::<_, String>(6))),
        ("merchantCategory", opt_str(a.get(7))),
        ("decision", Json::str(decision.clone())),
        ("declineCode", opt_str(a.get(9))),
        ("heldBy", Json::str(a.get::<_, String>(11))),
        ("partnerHoldRef", opt_str(a.get(12))),
        ("test", Json::Bool(a.get(14))),
        ("lifecycle", Json::Array(lifecycle)),
        ("variance", variance),
        ("trace", trace),
    ]))
}

/// The day's figures (`report`): authorisations decided today (UTC) per asset.
pub struct Report {
    pub day: String,
    pub as_of: String,
    pub test: bool,
    /// `(assetId, approved, approvedVolume, declined)`.
    pub assets: Vec<(String, i64, String, i64)>,
}

impl Report {
    fn totals(&self) -> (i64, i64) {
        self.assets
            .iter()
            .fold((0, 0), |(a, d), r| (a + r.1, d + r.3))
    }

    pub fn json(&self) -> Json {
        let (approved, declined) = self.totals();
        Json::obj([
            ("day", Json::str(self.day.clone())),
            ("asOf", Json::str(self.as_of.clone())),
            ("test", Json::Bool(self.test)),
            (
                "assets",
                Json::Array(
                    self.assets
                        .iter()
                        .map(|(asset, a, v, dcl)| {
                            Json::obj([
                                ("assetId", Json::str(asset.clone())),
                                ("approved", num(*a)),
                                ("approvedVolume", Json::str(v.clone())),
                                ("declined", num(*dcl)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "totals",
                Json::obj([("approved", num(approved)), ("declined", num(declined))]),
            ),
        ])
    }
}

/// `report`: authorisations decided today (UTC) per asset: what the screen shows and what the export signs.
pub fn report(d: &Deps<'_>, c: &mut impl GenericClient) -> Result<Report, Refusal> {
    let now = d.cards.now();
    let as_of = now.iso();
    let day = as_of.get(..10).unwrap_or_default().to_owned();
    let start = now.0 - now.0.rem_euclid(86_400_000);
    let rows = c
        .query(
            "SELECT k.asset_id, \
                    (count(*) FILTER (WHERE a.decision = 'approved'))::int8, \
                    COALESCE(SUM(a.amount) FILTER (WHERE a.decision = 'approved'), 0)::text, \
                    (count(*) FILTER (WHERE a.decision = 'declined'))::int8 \
               FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id \
              WHERE a.decided_at >= to_timestamp($1::int8 / 1000.0) \
              GROUP BY k.asset_id ORDER BY k.asset_id",
            &[&start],
        )
        .map_err(|e| pg(&e))?;
    let mut assets = Vec::with_capacity(rows.len());
    for r in &rows {
        assets.push((
            r.get::<_, String>(0),
            r.get::<_, i64>(1),
            amount_text(&r.get::<_, String>(2))?,
            r.get::<_, i64>(3),
        ));
    }
    Ok(Report {
        day,
        as_of,
        test: d.test(),
        assets,
    })
}

/// `exportReport`: the report as a signed file: its text, its freshness time, the SHA-256 of the text and its signature.
pub fn export_report(d: &Deps<'_>, actor: &str) -> Result<Json, Refusal> {
    let Some(secret) = d.w.export_secret.as_deref().filter(|s| !s.is_empty()) else {
        return Err(refuse(
            "bank.card_report_signing_unset",
            "svc-bank has no signing secret, so no export can be signed (bank.card_report_signing_unset)",
        ));
    };
    let r = with(d.store(), |c| report(d, c))?;
    let (approved, declined) = r.totals();
    let mut lines = vec![
        format!(
            "INTAFACED card programme report{}",
            if r.test {
                " (TEST: simulated card programme)"
            } else {
                ""
            }
        ),
        format!("Authorisations decided on {} (UTC)", r.day),
        format!("As of (UTC): {}", r.as_of),
        "asset,approved,approved_volume,declined".to_owned(),
    ];
    for (asset, a, v, dcl) in &r.assets {
        lines.push(format!(
            "{},{a},{v},{dcl}",
            crate::global::one_line(Some(asset))
        ));
    }
    lines.push(format!("total,{approved},,{declined}"));
    lines.push(String::new());
    let text = lines.join("\n");
    with(d.store(), |c| {
        audit(
            c,
            actor,
            "report.export",
            &format!("authorisations {}", r.day),
            None,
            Some(&Json::obj([
                ("asOf", Json::str(r.as_of.clone())),
                (
                    "totals",
                    Json::obj([("approved", num(approved)), ("declined", num(declined))]),
                ),
            ])),
        )
    })?;
    let (sha256, signature) = crate::global::send::sign_receipt(&text, secret, EXPORT_INFO);
    Ok(Json::obj([
        (
            "fileName",
            Json::str(format!("card-programme-{}.csv", r.day)),
        ),
        ("asOf", Json::str(r.as_of.clone())),
        ("text", Json::str(text)),
        ("sha256", Json::str(sha256)),
        ("signature", Json::str(signature)),
    ]))
}

/// `exemptionCount`: how many authorisations the SCA low-value exemption let through without a challenge.
pub fn exemption_count(c: &mut impl GenericClient) -> Result<i64, Refusal> {
    Ok(c
        .query(
            "SELECT count(*)::int8 FROM bank.card_authorization_traces t \
              WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.steps) s WHERE s->>'detail' LIKE 'SCA low-value exemption:%')",
            &[],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map_or(0, |r| r.get(0)))
}

/// `desk`: everything the card programme desk shows on its first paint.
pub fn desk(d: &Deps<'_>) -> Result<Json, Refusal> {
    let programme = d.cards.issuer().programme();
    with(d.store(), |c| {
        let settings = settings(c)?;
        let checklist = checklist(d, c)?;
        let rules = rules(c)?;
        let staff = staff(c)?;
        let audit = audit_log(c)?;
        let review = super::holders::review_queue(c)?;
        let holders = super::holders::cardholders(c, None)?;
        let log = decision_log(c)?;
        let report = report(d, c)?;
        let exemptions = exemption_count(c)?;
        Ok(Json::obj([
            ("test", Json::Bool(programme.simulated)),
            (
                "programme",
                Json::obj([
                    ("id", Json::str(programme.id)),
                    ("displayName", Json::str(programme.display_name)),
                    ("simulated", Json::Bool(programme.simulated)),
                ]),
            ),
            ("settings", settings),
            ("checklist", checklist),
            ("rules", Json::Array(rules)),
            ("staff", staff),
            ("audit", audit),
            ("reviewQueue", review),
            ("cardholders", holders),
            ("decisionLog", log),
            ("report", report.json()),
            ("exemptions", num(exemptions)),
            (
                "simulator",
                Json::Bool(d.w.simulator_allowed && programme.simulated),
            ),
            (
                "screeningListSet",
                Json::Bool(super::holders::read_sanctions(d.w.sanctions.as_deref()).is_some()),
            ),
        ]))
    })
}
