//! Limit increase requests (`transfers/limit-requests.ts`, BK-acct-04): a person asks for a higher per-transfer or daily
//! limit with a reason; compliance decides it with a second look (`ops.limitRequests`, `ops.decideLimitRequest`, slice
//! `ops-desk`, which calls [`queue`] and [`decide`] here). An approved grant replaces the published limit of its kind for
//! that person alone ([`granted_limits`], read by every quote and send). Nothing is defaulted: an approval names its
//! grant, and a page size is never 50 unless asked for.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

/// The partial unique index that keeps one open request per person, asset and kind.
const OPEN_UNIQUE_INDEX: &str = "limit_increase_requests_open_uq";

/// `COLUMNS`, in [`LimitRequest::from_row`]'s order.
const COLUMNS: &str = "id::text, user_id::text, asset_id, kind, requested::text, reason, status, granted::text, \
     decided_by, decision_note, floor(extract(epoch from created_at) * 1000)::int8, \
     floor(extract(epoch from decided_at) * 1000)::int8";

/// One request (`Row`, shown as `LimitRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitRequest {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    /// `per_transfer` or `daily`.
    pub kind: String,
    pub requested: Amount,
    pub reason: String,
    /// `open`, `approved` or `declined`.
    pub status: String,
    pub granted: Option<Amount>,
    pub decided_by: Option<String>,
    pub decision_note: Option<String>,
    pub created_at: Instant,
    pub decided_at: Option<Instant>,
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

impl LimitRequest {
    fn from_row(r: &postgres::Row) -> Result<LimitRequest, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        Ok(LimitRequest {
            id: s(0)?,
            user_id: s(1)?,
            asset_id: s(2)?,
            kind: s(3)?,
            requested: amount(&s(4)?)?,
            reason: s(5)?,
            status: s(6)?,
            granted: o(7)?.map(|g| amount(&g)).transpose()?,
            decided_by: o(8)?,
            decision_note: o(9)?,
            created_at: Instant(r.try_get::<_, i64>(10).map_err(|e| pg(&e))?),
            decided_at: r
                .try_get::<_, Option<i64>>(11)
                .map_err(|e| pg(&e))?
                .map(Instant),
        })
    }

    /// `requestOut`, in its schema's key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        let opt = |v: Option<&String>| v.map_or(Json::Null, |s| Json::str(s.clone()));
        vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("kind".to_owned(), Json::str(self.kind.clone())),
            (
                "requested".to_owned(),
                Json::str(format_amount(self.requested)),
            ),
            ("reason".to_owned(), Json::str(self.reason.clone())),
            ("status".to_owned(), Json::str(self.status.clone())),
            (
                "granted".to_owned(),
                self.granted
                    .map_or(Json::Null, |g| Json::str(format_amount(g))),
            ),
            ("decidedBy".to_owned(), opt(self.decided_by.as_ref())),
            ("decisionNote".to_owned(), opt(self.decision_note.as_ref())),
            ("createdAt".to_owned(), Json::str(self.created_at.iso())),
            (
                "decidedAt".to_owned(),
                self.decided_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ]
    }

    /// `requestOut.extend({ replayed })`.
    pub fn json_replayed(&self, replayed: bool) -> Json {
        let mut f = self.fields();
        f.push(("replayed".to_owned(), Json::Bool(replayed)));
        Json::Object(f)
    }

    /// `requestOut.extend({ userId })`: the desk's queue line.
    pub fn json_with_user(&self) -> Json {
        let mut f = self.fields();
        f.push(("userId".to_owned(), Json::str(self.user_id.clone())));
        Json::Object(f)
    }
}

/// `grantedLimits`: the person's latest approved grant of each kind in the asset, `(perTransfer, daily)`.
pub fn granted_limits(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
) -> Result<(Option<Amount>, Option<Amount>), Refusal> {
    let rows = c
        .query(
            "SELECT DISTINCT ON (kind) kind, granted::text
               FROM bank.limit_increase_requests
              WHERE user_id = $1::text::uuid AND asset_id = $2 AND status = 'approved'
              ORDER BY kind, decided_at DESC",
            &[&user_id, &asset_id],
        )
        .map_err(|e| pg(&e))?;
    let (mut per, mut daily) = (None, None);
    for r in &rows {
        let kind: String = r.try_get(0).map_err(|e| pg(&e))?;
        let granted: String = r.try_get(1).map_err(|e| pg(&e))?;
        match kind.as_str() {
            "per_transfer" => per = Some(amount(&granted)?),
            "daily" => daily = Some(amount(&granted)?),
            _ => {}
        }
    }
    Ok((per, daily))
}

/// What a person asks for.
pub struct Ask<'a> {
    pub request_id: &'a str,
    pub asset_id: &'a str,
    pub kind: &'a str,
    pub requested: Amount,
    pub reason: &'a str,
}

fn by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<LimitRequest>, Refusal> {
    c.query(
        &format!("SELECT {COLUMNS} FROM bank.limit_increase_requests WHERE id = $1::text::uuid"),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(LimitRequest::from_row)
    .transpose()
}

/// `LimitRequestService.request`: the request and whether it is a replay of one already made under its id.
pub fn request(
    c: &mut impl GenericClient,
    user_id: &str,
    ask: &Ask<'_>,
) -> Result<(LimitRequest, bool), Refusal> {
    let reason = ask.reason.trim();
    if reason.encode_utf16().count() < 10 {
        return Err(refuse(
            "bank.limit_request_reason_too_short",
            "A limit increase request needs a reason of at least 10 characters",
        ));
    }
    if ask.requested <= Amount::ZERO {
        return Err(refuse(
            "bank.validation_failed",
            "The requested limit must be positive",
        ));
    }
    let terms = c
        .query(
            "SELECT 1 FROM bank.personal_transfer_terms WHERE asset_id = $1",
            &[&ask.asset_id],
        )
        .map_err(|e| pg(&e))?;
    if terms.is_empty() {
        return Err(refuse(
            "bank.personal_transfer_terms_unset",
            format!(
                "No limits are published for {}, so there is nothing to raise (bank.personal_transfer_terms_unset)",
                ask.asset_id
            ),
        ));
    }
    let requested = format_amount(ask.requested);
    let inserted = c.query(
        &format!(
            "INSERT INTO bank.limit_increase_requests (id, user_id, asset_id, kind, requested, reason)
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5::text::numeric, $6)
             ON CONFLICT (id) DO NOTHING
             RETURNING {COLUMNS}"
        ),
        &[
            &ask.request_id,
            &user_id,
            &ask.asset_id,
            &ask.kind,
            &requested,
            &reason,
        ],
    );
    let inserted = match inserted {
        Ok(rows) => rows,
        Err(e) => {
            let open_slot = e.as_db_error().is_some_and(|d| {
                d.code().code() == "23505" && d.constraint() == Some(OPEN_UNIQUE_INDEX)
            });
            if !open_slot {
                return Err(pg(&e));
            }
            // ON CONFLICT (id) absorbs only the id key. A retry racing its own first call loses on the open key
            // instead: a row under this id means replay, none means another id holds the slot.
            if by_id(c, ask.request_id)?.is_none() {
                return Err(refuse(
                    "bank.limit_request_open",
                    format!(
                        "A {} limit request for {} is already open",
                        ask.kind, ask.asset_id
                    ),
                ));
            }
            Vec::new()
        }
    };
    if let Some(r) = inserted.first() {
        return Ok((LimitRequest::from_row(r)?, false));
    }
    match by_id(c, ask.request_id)? {
        Some(prior)
            if prior.user_id == user_id
                && prior.asset_id == ask.asset_id
                && prior.kind == ask.kind
                && prior.requested == ask.requested
                && prior.reason == reason =>
        {
            Ok((prior, true))
        }
        _ => Err(refuse(
            "bank.limit_request_conflict",
            "That request id was already used for a different request",
        )),
    }
}

pub fn list_limit_unset() -> Refusal {
    refuse(
        "bank.limit_request_list_limit_unset",
        "Limit request page size is required; blank is not 50",
    )
}

/// `LimitRequestService.mine`: the person's own requests, newest first.
pub fn mine(
    c: &mut impl GenericClient,
    user_id: &str,
    limit: Option<i64>,
) -> Result<Vec<LimitRequest>, Refusal> {
    let limit = limit.ok_or_else(list_limit_unset)?;
    c.query(
        &format!(
            "SELECT {COLUMNS} FROM bank.limit_increase_requests WHERE user_id = $1::text::uuid
              ORDER BY created_at DESC, id DESC LIMIT $2"
        ),
        &[&user_id, &limit],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(LimitRequest::from_row)
    .collect()
}

/// `LimitRequestService.queue`: the open requests, oldest first (the desk's queue).
pub fn queue(c: &mut impl GenericClient, limit: Option<i64>) -> Result<Vec<LimitRequest>, Refusal> {
    let limit = limit.ok_or_else(list_limit_unset)?;
    c.query(
        &format!(
            "SELECT {COLUMNS} FROM bank.limit_increase_requests WHERE status = 'open'
              ORDER BY created_at ASC, id ASC LIMIT $1"
        ),
        &[&limit],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(LimitRequest::from_row)
    .collect()
}

/// A compliance decision.
pub struct Decision<'a> {
    pub request_id: &'a str,
    /// `true` approves, `false` declines.
    pub approve: bool,
    pub granted: Option<Amount>,
    pub note: &'a str,
    pub decider_id: &'a str,
}

/// `decide`'s checks of the decision itself, made before any read: a short note, an approval with no grant, a decline
/// with one.
pub fn check_decision(d: &Decision<'_>) -> Result<(), Refusal> {
    let note = d.note.trim();
    if note.encode_utf16().count() < 10 {
        return Err(refuse(
            "bank.ops_reason_too_short",
            "A limit decision needs a note of at least 10 characters (bank.ops_reason_too_short)",
        ));
    }
    if d.approve && d.granted.is_none_or(|g| g <= Amount::ZERO) {
        return Err(refuse(
            "bank.limit_grant_unset",
            "An approval names the granted limit; it is never defaulted to the requested one",
        ));
    }
    if !d.approve && d.granted.is_some() {
        return Err(refuse("bank.validation_failed", "A decline grants nothing"));
    }
    Ok(())
}

/// `LimitRequestService.decide`: the decided request and whether it repeats a decision already made.
pub fn decide(
    c: &mut impl GenericClient,
    d: &Decision<'_>,
) -> Result<(LimitRequest, bool), Refusal> {
    check_decision(d)?;
    let note = d.note.trim();
    let status = if d.approve { "approved" } else { "declined" };
    let granted = d.granted.map(format_amount);
    let Some(row) = by_id(c, d.request_id)? else {
        return Err(refuse(
            "bank.limit_request_not_found",
            "No such limit request",
        ));
    };
    if row.user_id == d.decider_id {
        return Err(refuse(
            "bank.limit_request_self_decision",
            "A customer cannot decide their own limit request",
        ));
    }
    if row.status != "open" {
        let same = row.status == status
            && row.granted == d.granted
            && row.decision_note.as_deref() == Some(note);
        if same {
            return Ok((row, true));
        }
        return Err(refuse(
            "bank.limit_request_decided",
            "This limit request was already decided differently",
        ));
    }
    let updated = c
        .query(
            &format!(
                "UPDATE bank.limit_increase_requests
                    SET status = $2, granted = $3::text::numeric, decided_by = $4,
                        decision_note = $5, decided_at = now()
                  WHERE id = $1::text::uuid AND status = 'open'
                  RETURNING {COLUMNS}"
            ),
            &[&d.request_id, &status, &granted, &d.decider_id, &note],
        )
        .map_err(|e| pg(&e))?;
    match updated.first() {
        Some(r) => Ok((LimitRequest::from_row(r)?, false)),
        None => Err(refuse(
            "bank.limit_request_decided",
            "This limit request was decided by someone else first",
        )),
    }
}

fn text<'v>(v: &'v service_kit::schema::Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

/// The page size the schema let through (an integer from 1 to 200), or none.
fn limit_of(v: &service_kit::schema::Value) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation, reason = "an integer from 1 to 200")]
    v.get("limit").as_number().map(|n| n as i64)
}

/// The answer of `limits.requestIncrease` or `limits.myRequests`; `None` for any other path.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    match ctx.call.path {
        "limits.requestIncrease" => Some((|| {
            let requested = amount(text(input, "requested"))?;
            let ask = Ask {
                request_id: text(input, "requestId"),
                asset_id: text(input, "assetId"),
                kind: text(input, "kind"),
                requested,
                reason: text(input, "reason"),
            };
            let (r, replayed) = with(d.store, |c| request(c, user, &ask))?;
            Ok(r.json_replayed(replayed))
        })()),
        "limits.myRequests" => Some((|| {
            let limit = limit_of(input);
            // The page size refuses before any read, as `mine` does.
            limit.ok_or_else(list_limit_unset)?;
            let rows = with(d.store, |c| mine(c, user, limit))?;
            Ok(Json::Array(
                rows.iter().map(|r| Json::Object(r.fields())).collect(),
            ))
        })()),
        _ => None,
    }
}
