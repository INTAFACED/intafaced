//! `SpaceService` (`spaces/space-service.ts`) and `BillsPotService` (`spaces/bills-pot.ts`): a space is a label and a
//! policy over a ledger account, never a balance. A primary space is the person's `userAvailable` account in its asset,
//! a named one its `subAccountAvailable` account; when the partner bank holds the person's money (`custody: 'off'`), the
//! partner's own figure for the same account. Every balance shown is read at request time, from the ledger or the
//! partner, and nothing here writes one.

use postgres::{GenericClient, IsolationLevel, Row, Transaction};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::ports::{Ledger, LedgerAccount};
use crate::db::{Store, StoreError};
use crate::errors::Refusal;
use crate::partner::custody::{Custody, Held};
use crate::partner::{AccountRef, Balance, balance_not_known, refuse};

/// The columns every space read selects, in [`Space::from_row`]'s order.
pub const COLS: &str = "id::text, user_id, asset_id, kind::text, name, goal_target::text, \
     floor(extract(epoch from locked_until) * 1000)::int8, \
     floor(extract(epoch from unlock_requested_at) * 1000)::int8, \
     floor(extract(epoch from unlocks_at) * 1000)::int8, \
     floor(extract(epoch from archived_at) * 1000)::int8";

/// A time parameter as Postgres reads it: `$n` milliseconds after the epoch.
pub fn at(param: &str) -> String {
    format!("(timestamptz 'epoch' + {param}::int8 * interval '1 millisecond')")
}

/// A database failure, as the guard answers any other error: an opaque failure, its words only in the log.
pub fn db(e: impl Into<StoreError>) -> Refusal {
    Refusal::Other(e.into().to_string())
}

/// `postgres::Error` into a refusal.
pub fn pg(e: &postgres::Error) -> Refusal {
    db(StoreError::from(e))
}

/// One space (`SpaceRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Space {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    /// `primary` or `named`.
    pub kind: String,
    pub name: String,
    pub goal_target: Option<Amount>,
    pub locked_until: Option<Instant>,
    pub unlock_requested_at: Option<Instant>,
    pub unlocks_at: Option<Instant>,
    pub archived_at: Option<Instant>,
}

impl Space {
    /// A row of [`COLS`].
    pub fn from_row(r: &Row) -> Result<Space, Refusal> {
        let ms = |i: usize| -> Result<Option<Instant>, Refusal> {
            Ok(r.try_get::<_, Option<i64>>(i)
                .map_err(|e| pg(&e))?
                .map(Instant))
        };
        let s =
            |i: usize| -> Result<String, Refusal> { r.try_get::<_, String>(i).map_err(|e| pg(&e)) };
        Ok(Space {
            id: s(0)?,
            user_id: s(1)?,
            asset_id: s(2)?,
            kind: s(3)?,
            name: s(4)?,
            goal_target: r
                .try_get::<_, Option<String>>(5)
                .map_err(|e| pg(&e))?
                .map(|g| parse_amount(&g))
                .transpose()
                .map_err(Refusal::Other)?,
            locked_until: ms(6)?,
            unlock_requested_at: ms(7)?,
            unlocks_at: ms(8)?,
            archived_at: ms(9)?,
        })
    }

    pub fn primary(&self) -> bool {
        self.kind == "primary"
    }

    /// `accountForSpace`: THE MAPPING.
    pub fn ledger_account(&self) -> LedgerAccount {
        if self.primary() {
            LedgerAccount::user_available(&self.user_id, &self.asset_id)
        } else {
            LedgerAccount::sub_account_available(&self.id, &self.asset_id)
        }
    }

    /// `partnerAccountFor`: a primary space is the partner's main balance.
    pub fn partner_account(&self) -> AccountRef {
        AccountRef {
            user_id: self.user_id.clone(),
            asset_id: self.asset_id.clone(),
            space_id: (!self.primary()).then(|| self.id.clone()),
        }
    }
}

/// `lockEnd`: when a pot's lock ends, or none when it is not locked at `now`.
pub fn lock_end(
    locked_until: Option<Instant>,
    unlocks_at: Option<Instant>,
    now: Instant,
) -> Option<Instant> {
    let until = locked_until?;
    if until.0 <= now.0 {
        return None;
    }
    if unlocks_at.is_some_and(|u| u.0 <= now.0) {
        return None;
    }
    Some(unlocks_at.unwrap_or(until))
}

/// `requireSpaceLimit`: a whole number 1 to 999999, else `bank.space_limit_unset`.
pub fn require_space_limit(raw: Option<&str>) -> Result<i64, Refusal> {
    let t = raw.map(service_kit::money::js_trim).unwrap_or_default();
    let ok = !t.is_empty()
        && t.len() <= 6
        && !t.starts_with('0')
        && t.bytes().all(|b| b.is_ascii_digit());
    if !ok {
        return Err(refuse(
            "bank.space_limit_unset",
            "The owner has not set how many spaces an account can hold, so no new space is made",
        ));
    }
    t.parse()
        .map_err(|_| Refusal::Other("space limit".to_owned()))
}

/// `requireUnlockWaitHours`: a whole number of hours 0 to 8760, else `bank.space_unlock_rule_unset`.
pub fn require_unlock_wait_hours(raw: Option<&str>) -> Result<i64, Refusal> {
    let t = raw.map(service_kit::money::js_trim).unwrap_or_default();
    let n = (!t.is_empty() && t.len() <= 4 && t.bytes().all(|b| b.is_ascii_digit()))
        .then(|| t.parse::<i64>().ok())
        .flatten()
        .filter(|n| *n <= 8760);
    n.ok_or_else(|| {
        refuse(
            "bank.space_unlock_rule_unset",
            "The owner has not set how long an early unlock waits, so the pot stays locked until its date",
        )
    })
}

/// `assertOwnerListLimit`: a page size, or the call's own `*_list_limit_unset` refusal; at most 200.
pub fn owner_list_limit(limit: Option<f64>, code: &str, name: &str) -> Result<i64, Refusal> {
    let unset = || {
        refuse(
            code,
            format!(
                "{name} page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit)."
            ),
        )
    };
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(unset());
    };
    let n = l.floor();
    if n < 1.0 {
        return Err(unset());
    }
    #[allow(clippy::cast_possible_truncation, reason = "at most 200 after the min")]
    Ok(n.min(200.0) as i64)
}

/// `assertSpacesListLimit`.
pub fn spaces_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(limit, "bank.spaces_list_limit_unset", "spaces.list")
}

/// `assertSharedPotsListLimit`.
pub fn shared_pots_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(
        limit,
        "bank.shared_pots_list_limit_unset",
        "sharedPots.list",
    )
}

pub fn not_found(space_id: &str) -> Refusal {
    refuse(
        "bank.space_not_found",
        format!("Space {space_id} not found"),
    )
}

pub fn archived(name: &str) -> Refusal {
    refuse(
        "bank.space_archived",
        format!("Space \"{name}\" is archived"),
    )
}

fn primary_not_archivable() -> Refusal {
    refuse(
        "bank.space_archived",
        "The primary space is the account itself and cannot be archived",
    )
}

/// One transaction at read committed: committed when `f` succeeds, rolled back with any refusal.
pub fn in_tx<T>(
    pool: &Store,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut conn = pool.pool().map_err(db)?.get().map_err(db)?;
    let client = conn.client().map_err(db)?;
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::ReadCommitted)
        .start()
        .map_err(|e| pg(&e))?;
    let out = f(&mut tx)?;
    tx.commit().map_err(|e| pg(&e))?;
    Ok(out)
}

/// One read or write outside a transaction.
pub fn with<T>(
    pool: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut conn = pool.pool().map_err(db)?.get().map_err(db)?;
    let client = conn.client().map_err(db)?;
    f(client)
}

/// `find`: a space by id, or none.
pub fn find(c: &mut impl GenericClient, space_id: &str) -> Result<Option<Space>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {COLS} FROM bank.spaces WHERE id = $1::text::uuid"),
            &[&space_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Space::from_row).transpose()
}

/// `get`: a space by id, or `bank.space_not_found`.
pub fn get(c: &mut impl GenericClient, space_id: &str) -> Result<Space, Refusal> {
    find(c, space_id)?.ok_or_else(|| not_found(space_id))
}

/// `ensurePrimary`: the person's main balance in an asset, given a name; race-safe by `spaces_one_primary_idx`.
pub fn ensure_primary(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
) -> Result<Space, Refusal> {
    let rows = c
        .query(
            &format!(
                "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, $2, 'primary', 'Main') \
                 ON CONFLICT DO NOTHING RETURNING {COLS}"
            ),
            &[&user_id, &asset_id],
        )
        .map_err(|e| pg(&e))?;
    if let Some(r) = rows.first() {
        return Space::from_row(r);
    }
    let rows = c
        .query(
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary'"
            ),
            &[&user_id, &asset_id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => Space::from_row(r),
        None => Err(refuse(
            "bank.space_not_found",
            format!("Could not resolve the primary {asset_id} space for {user_id}"),
        )),
    }
}

/// `restoreCurrency`: a removed currency shows on the account again. A label: nothing moves.
pub fn restore_currency(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
) -> Result<(), Refusal> {
    c.execute(
        "UPDATE bank.spaces SET removed_at = NULL, updated_at = now() \
         WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary' AND removed_at IS NOT NULL",
        &[&user_id, &asset_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `underSpaceLock`: one customer's space labels changed one call at a time, under `bank-spaces:<user>`.
pub fn under_space_lock<T>(
    pool: &Store,
    user_id: &str,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    in_tx(pool, |tx| {
        let key = format!("bank-spaces:{user_id}");
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&key])
            .map_err(|e| pg(&e))?;
        f(tx)
    })
}

fn assert_room(tx: &mut Transaction<'_>, user_id: &str, max: i64) -> Result<(), Refusal> {
    let n: i32 = tx
        .query_one(
            "SELECT count(*)::int FROM bank.spaces WHERE user_id = $1 AND kind = 'named' AND archived_at IS NULL",
            &[&user_id],
        )
        .map_err(|e| pg(&e))?
        .get(0);
    if i64::from(n) >= max {
        return Err(refuse(
            "bank.space_limit_reached",
            format!(
                "This account already has {max} spaces, the most it can hold. Archive one to make room."
            ),
        ));
    }
    Ok(())
}

/// What a new named space is made with.
pub struct NewSpace<'a> {
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub name: &'a str,
    pub goal_target: Option<Amount>,
    pub locked_until: Option<Instant>,
}

/// The owner values slice `spaces` reads, each as `index.ts` hands it in.
#[derive(Debug, Clone, Default)]
pub struct Rules {
    /// `BANK_SPACE_LIMIT`.
    pub space_limit: Option<String>,
    /// `BANK_SPACE_UNLOCK_WAIT_HOURS`.
    pub unlock_wait_hours: Option<String>,
}

/// `createWithinLimit`: inside the owner's limit on live named spaces, under the customer's space lock.
pub fn create_within_limit(
    pool: &Store,
    rules: &Rules,
    input: &NewSpace<'_>,
) -> Result<Space, Refusal> {
    let max = require_space_limit(rules.space_limit.as_deref())?;
    if input.locked_until.is_some() {
        require_unlock_wait_hours(rules.unlock_wait_hours.as_deref())?;
    }
    under_space_lock(pool, input.user_id, |tx| {
        assert_room(tx, input.user_id, max)?;
        ensure_primary(tx, input.user_id, input.asset_id)?;
        restore_currency(tx, input.user_id, input.asset_id)?;
        let goal = input.goal_target.map(format_amount);
        let until = input.locked_until.map(|i| i.0);
        let made = tx.query(
            &format!(
                "INSERT INTO bank.spaces (user_id, asset_id, kind, name, goal_target, locked_until) \
                 VALUES ($1, $2, 'named', $3, $4::text::numeric, {}) RETURNING {COLS}",
                at("$5")
            ),
            &[&input.user_id, &input.asset_id, &input.name, &goal, &until],
        );
        match made {
            Ok(rows) => rows
                .first()
                .map_or_else(|| Err(Refusal::Other("no row".to_owned())), Space::from_row),
            Err(e)
                if e.as_db_error().is_some_and(|d| {
                    d.code().code() == "23505"
                        && d.constraint() == Some("spaces_user_asset_name_idx")
                }) =>
            {
                Err(refuse(
                    "bank.space_name_taken",
                    format!(
                        "A space named \"{}\" already exists for {}, perhaps archived: pick another name",
                        input.name, input.asset_id
                    ),
                ))
            }
            Err(e) => Err(pg(&e)),
        }
    })
}

/// `unarchiveWithinLimit`: an archived named space comes back inside the same limit; a live one is a no-op.
pub fn unarchive_within_limit(pool: &Store, rules: &Rules, space_id: &str) -> Result<(), Refusal> {
    let space = with(pool, |c| get(c, space_id))?;
    if !space.primary() && space.archived_at.is_some() {
        let max = require_space_limit(rules.space_limit.as_deref())?;
        return under_space_lock(pool, &space.user_id, |tx| {
            assert_room(tx, &space.user_id, max)?;
            restore_currency(tx, &space.user_id, &space.asset_id)?;
            tx.execute(
                "UPDATE bank.spaces SET archived_at = NULL, updated_at = now() \
                 WHERE id = $1::text::uuid AND archived_at IS NOT NULL",
                &[&space_id],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        });
    }
    // `unarchive`.
    let space = with(pool, |c| get(c, space_id))?;
    if space.primary() {
        return Err(primary_not_archivable());
    }
    if space.archived_at.is_none() {
        return Ok(());
    }
    with(pool, |c| {
        c.execute(
            "UPDATE bank.spaces SET archived_at = NULL, updated_at = now() WHERE id = $1::text::uuid AND archived_at IS NOT NULL",
            &[&space_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `archive`: a labelling decision; the money stays in its ledger account. The bills pot role and a linked card end
/// with it, under the row lock.
pub fn archive(pool: &Store, space_id: &str) -> Result<(), Refusal> {
    let space = with(pool, |c| get(c, space_id))?;
    if space.primary() {
        return Err(primary_not_archivable());
    }
    in_tx(pool, |tx| {
        tx.execute(
            "UPDATE bank.spaces SET archived_at = now(), updated_at = now() WHERE id = $1::text::uuid",
            &[&space_id],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "DELETE FROM bank.bills_pots WHERE space_id = $1::text::uuid",
            &[&space_id],
        )
        .map_err(|e| pg(&e))?;
        let unlinked = tx
            .query(
                "DELETE FROM bank.shared_pot_cards WHERE space_id = $1::text::uuid RETURNING card_id::text",
                &[&space_id],
            )
            .map_err(|e| pg(&e))?;
        for r in unlinked {
            let card: String = r.get(0);
            tx.execute(
                "INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, kind, card_id) \
                 VALUES ($1::text::uuid, $2, 'card_unlinked', $3::text::uuid)",
                &[&space_id, &space.user_id, &card],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })
}

/// `ownPotForUpdate`: one named, live pot of this owner under a row lock; another owner's is not found.
pub fn own_pot_for_update(
    tx: &mut Transaction<'_>,
    space_id: &str,
    user_id: &str,
) -> Result<Space, Refusal> {
    let rows = tx
        .query(
            &format!("SELECT {COLS} FROM bank.spaces WHERE id = $1::text::uuid FOR UPDATE"),
            &[&space_id],
        )
        .map_err(|e| pg(&e))?;
    let space = match rows.first() {
        Some(r) => Space::from_row(r)?,
        None => return Err(not_found(space_id)),
    };
    if space.user_id != user_id {
        return Err(not_found(space_id));
    }
    if space.primary() {
        return Err(refuse(
            "bank.space_change_invalid",
            "The primary space is the account itself; goals and locks belong to pots",
        ));
    }
    if space.archived_at.is_some() {
        return Err(archived(&space.name));
    }
    Ok(space)
}

fn updated(
    tx: &mut Transaction<'_>,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Space, Refusal> {
    let rows = tx.query(sql, params).map_err(|e| pg(&e))?;
    rows.first()
        .map_or_else(|| Err(Refusal::Other("no row".to_owned())), Space::from_row)
}

/// `setGoal`: a target, never a holding; nothing moves.
pub fn set_goal(
    pool: &Store,
    space_id: &str,
    user_id: &str,
    goal: Option<Amount>,
) -> Result<Space, Refusal> {
    if goal.is_some_and(|g| g <= Amount::ZERO) {
        return Err(refuse(
            "bank.space_change_invalid",
            "A goal is an amount above zero; clear it to have none",
        ));
    }
    in_tx(pool, |tx| {
        own_pot_for_update(tx, space_id, user_id)?;
        let goal = goal.map(format_amount);
        updated(
            tx,
            &format!(
                "UPDATE bank.spaces SET goal_target = $2::text::numeric, updated_at = now() \
                 WHERE id = $1::text::uuid RETURNING {COLS}"
            ),
            &[&space_id, &goal],
        )
    })
}

/// `setLock`: lock a pot until a later date, never shorter; a new date replaces an early unlock still waiting.
pub fn set_lock(
    pool: &Store,
    rules: &Rules,
    space_id: &str,
    user_id: &str,
    until: Instant,
    now: Instant,
) -> Result<Space, Refusal> {
    if until.0 <= now.0 {
        return Err(refuse(
            "bank.space_change_invalid",
            "A lock date must be in the future",
        ));
    }
    require_unlock_wait_hours(rules.unlock_wait_hours.as_deref())?;
    in_tx(pool, |tx| {
        let space = own_pot_for_update(tx, space_id, user_id)?;
        let current = lock_end(space.locked_until, space.unlocks_at, now);
        if let (Some(_), Some(locked)) = (current, space.locked_until)
            && until.0 < locked.0
        {
            return Err(refuse(
                "bank.space_change_invalid",
                format!(
                    "Space \"{}\" is locked until {}; to end the lock sooner, ask for an early unlock",
                    space.name,
                    locked.iso()
                ),
            ));
        }
        if space.locked_until == Some(until) && space.unlocks_at.is_none() {
            return Ok(space);
        }
        updated(
            tx,
            &format!(
                "UPDATE bank.spaces SET locked_until = {}, unlock_requested_at = NULL, unlocks_at = NULL, updated_at = now() \
                 WHERE id = $1::text::uuid RETURNING {COLS}",
                at("$2")
            ),
            &[&space_id, &until.0],
        )
    })
}

/// `requestUnlock`: the pot opens after the owner's wait, or at its own date if sooner; asking again returns the same.
pub fn request_unlock(
    pool: &Store,
    rules: &Rules,
    space_id: &str,
    user_id: &str,
    now: Instant,
) -> Result<Space, Refusal> {
    in_tx(pool, |tx| {
        let space = own_pot_for_update(tx, space_id, user_id)?;
        if lock_end(space.locked_until, space.unlocks_at, now).is_none() {
            return Err(refuse(
                "bank.space_not_locked",
                format!("Space \"{}\" is not locked", space.name),
            ));
        }
        if space.unlocks_at.is_some() {
            return Ok(space);
        }
        let hours = require_unlock_wait_hours(rules.unlock_wait_hours.as_deref())?;
        let waited = now.0 + hours * 3_600_000;
        let opens = match space.locked_until {
            Some(l) if l.0 < waited => l.0,
            _ => waited,
        };
        updated(
            tx,
            &format!(
                "UPDATE bank.spaces SET unlock_requested_at = {}, unlocks_at = {}, updated_at = now() \
                 WHERE id = $1::text::uuid RETURNING {COLS}",
                at("$2"),
                at("$3")
            ),
            &[&space_id, &now.0, &opens],
        )
    })
}

/// `cancelUnlock`: withdraw an early unlock still waiting; none waiting changes nothing.
pub fn cancel_unlock(
    pool: &Store,
    space_id: &str,
    user_id: &str,
    now: Instant,
) -> Result<Space, Refusal> {
    in_tx(pool, |tx| {
        let space = own_pot_for_update(tx, space_id, user_id)?;
        if space.unlocks_at.is_none()
            || lock_end(space.locked_until, space.unlocks_at, now).is_none()
        {
            return Ok(space);
        }
        updated(
            tx,
            &format!(
                "UPDATE bank.spaces SET unlock_requested_at = NULL, unlocks_at = NULL, updated_at = now() \
                 WHERE id = $1::text::uuid RETURNING {COLS}"
            ),
            &[&space_id],
        )
    })
}

/// One bills pot (`BillsPot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BillsPot {
    pub space_id: String,
    pub asset_id: String,
    pub fallback: bool,
}

/// `BillsPotService.set`: one of the person's own live pots pays their bills for its asset; another gives the role up.
pub fn set_bills_pot(
    pool: &Store,
    user_id: &str,
    space_id: &str,
    fallback: bool,
) -> Result<BillsPot, Refusal> {
    in_tx(pool, |tx| {
        let space = own_pot_for_update(tx, space_id, user_id)?;
        let r = tx
            .query_one(
                "INSERT INTO bank.bills_pots (user_id, asset_id, space_id, fallback) VALUES ($1, $2, $3::text::uuid, $4) \
                 ON CONFLICT (user_id, asset_id) DO UPDATE SET space_id = EXCLUDED.space_id, fallback = EXCLUDED.fallback, set_at = now() \
                 RETURNING space_id::text, asset_id, fallback",
                &[&user_id, &space.asset_id, &space_id, &fallback],
            )
            .map_err(|e| pg(&e))?;
        Ok(BillsPot {
            space_id: r.get(0),
            asset_id: r.get(1),
            fallback: r.get(2),
        })
    })
}

/// `BillsPotService.clear`: the pot stops paying bills; its money stays where it is.
pub fn clear_bills_pot(pool: &Store, user_id: &str, space_id: &str) -> Result<(), Refusal> {
    with(pool, |c| {
        let space = get(c, space_id)?;
        if space.user_id != user_id {
            return Err(not_found(space_id));
        }
        c.execute(
            "DELETE FROM bank.bills_pots WHERE user_id = $1 AND space_id = $2::text::uuid",
            &[&user_id, &space_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `BillsPotService.list`: the person's bills pots on live spaces, one per asset at most.
pub fn bills_pots(pool: &Store, user_id: &str) -> Result<Vec<BillsPot>, Refusal> {
    with(pool, |c| {
        let rows = c
            .query(
                "SELECT b.space_id::text, b.asset_id, b.fallback FROM bank.bills_pots b JOIN bank.spaces s ON s.id = b.space_id \
                 WHERE b.user_id = $1 AND s.archived_at IS NULL ORDER BY b.asset_id",
                &[&user_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(rows
            .iter()
            .map(|r| BillsPot {
                space_id: r.get(0),
                asset_id: r.get(1),
                fallback: r.get(2),
            })
            .collect())
    })
}

/// Where a person's money is read: the ledger, or the partner when it holds it.
pub struct Money<'a> {
    pub ledger: &'a dyn Ledger,
    pub custody: &'a Custody<'a>,
    pub now: Instant,
}

/// `reportedAmount`: the partner's figure, or `bank.partner_balance_not_known`; never 0.
pub fn reported(b: &Balance) -> Result<Amount, Refusal> {
    match (b.amount, b.as_of) {
        (Some(a), Some(_)) => Ok(a),
        _ => Err(balance_not_known(b.label)),
    }
}

/// One space's figure as the partner holding the person's money reports it (`partnerFigure` in `overview`): its label,
/// the amount, its as-of time and whether it is older than `STALE_AFTER_MS`. The partner's list for the person is read
/// once by the caller (`reports`); an account it did not list is asked for by itself. A figure the partner has not
/// reported, or one dated ahead of now by more than the stale window, refuses by name: never shown, never 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldFigure {
    pub label: &'static str,
    pub amount: Amount,
    pub as_of: Instant,
    pub stale: bool,
}

pub fn held_figure(
    partner: &Held<'_>,
    reports: &[Balance],
    space: &Space,
    now: Instant,
) -> Result<HeldFigure, Refusal> {
    let account = space.partner_account();
    let reported = reports
        .iter()
        .find(|b| b.account.asset_id == account.asset_id && b.account.space_id == account.space_id)
        .cloned()
        .unwrap_or_else(|| partner.balance(&account, now));
    let (Some(amount), Some(as_of)) = (reported.amount, reported.as_of) else {
        return Err(balance_not_known(reported.label));
    };
    let age = now.0 - as_of.0;
    if age < -crate::partner::STALE_AFTER_MS {
        return Err(balance_not_known(reported.label));
    }
    Ok(HeldFigure {
        label: reported.label,
        amount,
        as_of,
        stale: age > crate::partner::STALE_AFTER_MS,
    })
}

impl Money<'_> {
    pub fn held(&self, user_id: &str) -> Option<Held<'_>> {
        self.custody.bank_for(user_id)
    }

    /// `balanceOf`: one read, the partner's or the ledger's.
    pub fn balance_of(&self, space: &Space) -> Result<Amount, Refusal> {
        if let Some(p) = self.held(&space.user_id) {
            return reported(&p.balance(&space.partner_account(), self.now));
        }
        self.ledger
            .balance(&space.ledger_account())
            .map_err(Refusal::Other)
    }

    /// `heldMain`: what the person holds in their main balance above zero, optionally in one asset.
    pub fn held_main(
        &self,
        user_id: &str,
        asset: Option<&str>,
    ) -> Result<Vec<(String, Amount)>, Refusal> {
        let mut out = Vec::new();
        if let Some(p) = self.held(user_id) {
            for b in p.balances(user_id, self.now) {
                if b.account.space_id.is_some() || asset.is_some_and(|a| a != b.account.asset_id) {
                    continue;
                }
                let amount = reported(&b)?;
                if amount > Amount::ZERO {
                    out.push((b.account.asset_id.clone(), amount));
                }
            }
            return Ok(out);
        }
        for b in self
            .ledger
            .balances("user", user_id)
            .map_err(Refusal::Other)?
        {
            if b.kind == "available"
                && b.amount > Amount::ZERO
                && asset.is_none_or(|a| a == b.asset_id)
            {
                out.push((b.asset_id, b.amount));
            }
        }
        Ok(out)
    }
}

/// `ensureHeldPrimaries`: every asset the person holds in their main account gets its primary row, and a removed one
/// comes back. A failed write never fails the read.
pub fn ensure_held_primaries(pool: &Store, money: &Money<'_>, user_id: &str, asset: Option<&str>) {
    let run = || -> Result<(), Refusal> {
        let held = money.held_main(user_id, asset)?;
        if held.is_empty() {
            return Ok(());
        }
        with(pool, |c| {
            let rows = c
                .query(
                    "SELECT asset_id, removed_at IS NOT NULL FROM bank.spaces WHERE user_id = $1 AND kind = 'primary'",
                    &[&user_id],
                )
                .map_err(|e| pg(&e))?;
            for (asset_id, _) in &held {
                match rows.iter().find(|r| r.get::<_, String>(0) == *asset_id) {
                    None => {
                        ensure_primary(c, user_id, asset_id)?;
                    }
                    Some(r) if r.get::<_, bool>(1) => restore_currency(c, user_id, asset_id)?,
                    Some(_) => {}
                }
            }
            Ok(())
        })
    };
    if let Err(e) = run() {
        let detail = match e {
            Refusal::Bank(b) => b.message,
            Refusal::Trpc(t) => t.message,
            Refusal::Other(m) => m,
        };
        eprintln!(
            "{}",
            service_kit::json::Json::obj([
                ("level", service_kit::json::Json::str("error")),
                ("service", service_kit::json::Json::str("svc-bank")),
                (
                    "event",
                    service_kit::json::Json::str("bank.held_primary_open_failed")
                ),
                ("userId", service_kit::json::Json::str(user_id)),
                ("detail", service_kit::json::Json::str(detail)),
            ])
            .compact()
        );
    }
}

/// Same order as the list SQL: asset (when grouped), then primary before named, then name, then id.
fn order(spaces: &mut [Space], by_asset: bool) {
    spaces.sort_by(|a, b| {
        if by_asset && a.asset_id != b.asset_id {
            return a.asset_id.cmp(&b.asset_id);
        }
        if a.kind != b.kind {
            return if a.primary() {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        utf16_cmp(&a.name, &b.name).then_with(|| a.id.cmp(&b.id))
    });
}

/// JavaScript's string order: UTF-16 code units.
pub fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn rows_of(
    c: &mut impl GenericClient,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<Space>, Refusal> {
    c.query(sql, params)
        .map_err(|e| pg(&e))?
        .iter()
        .map(Space::from_row)
        .collect()
}

/// `fundedArchived`: archived named spaces whose balance is still above zero.
pub fn funded_archived(
    pool: &Store,
    money: &Money<'_>,
    user_id: &str,
    asset: Option<&str>,
) -> Result<Vec<Space>, Refusal> {
    let rows = with(pool, |c| match asset {
        Some(a) => rows_of(
            c,
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'named' AND archived_at IS NOT NULL ORDER BY name ASC"
            ),
            &[&user_id, &a],
        ),
        None => rows_of(
            c,
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND kind = 'named' AND archived_at IS NOT NULL ORDER BY asset_id ASC, name ASC"
            ),
            &[&user_id],
        ),
    })?;
    let mut out = Vec::new();
    for s in rows {
        if money.balance_of(&s)? > Amount::ZERO {
            out.push(s);
        }
    }
    Ok(out)
}

/// `namedSpaces`: every live space, and archived ones while funded.
pub fn named_spaces(pool: &Store, money: &Money<'_>, user_id: &str) -> Result<Vec<Space>, Refusal> {
    let mut rows = with(pool, |c| {
        rows_of(
            c,
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND archived_at IS NULL ORDER BY asset_id ASC, kind DESC, name ASC"
            ),
            &[&user_id],
        )
    })?;
    rows.extend(funded_archived(pool, money, user_id, None)?);
    order(&mut rows, true);
    Ok(rows)
}

/// `allNamedSpaces`: every named space the person ever owned, archived or not.
pub fn all_named_spaces(pool: &Store, user_id: &str) -> Result<Vec<Space>, Refusal> {
    with(pool, |c| {
        rows_of(
            c,
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND kind = 'named' ORDER BY asset_id ASC, name ASC, id ASC"
            ),
            &[&user_id],
        )
    })
}

/// `list`: one page of live, shown spaces, then the funded archived ones.
pub fn list(
    pool: &Store,
    money: &Money<'_>,
    user_id: &str,
    asset: Option<&str>,
    page: i64,
) -> Result<Vec<Space>, Refusal> {
    let mut rows = with(pool, |c| match asset {
        Some(a) => rows_of(
            c,
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND archived_at IS NULL AND removed_at IS NULL \
                 ORDER BY kind DESC, name ASC LIMIT $3"
            ),
            &[&user_id, &a, &page],
        ),
        None => rows_of(
            c,
            &format!(
                "SELECT {COLS} FROM bank.spaces WHERE user_id = $1 AND archived_at IS NULL AND removed_at IS NULL \
                 ORDER BY asset_id ASC, kind DESC, name ASC LIMIT $2"
            ),
            &[&user_id, &page],
        ),
    })?;
    rows.extend(funded_archived(pool, money, user_id, asset)?);
    order(&mut rows, asset.is_none());
    Ok(rows)
}

/// `unnamedAssets`: assets held in the main account with no space yet, from the ledger (or the partner).
pub fn unnamed_assets(
    pool: &Store,
    money: &Money<'_>,
    user_id: &str,
) -> Result<Vec<(String, Amount)>, Refusal> {
    let held = money.held_main(user_id, None)?;
    let named: Vec<String> = named_spaces(pool, money, user_id)?
        .into_iter()
        .map(|s| s.asset_id)
        .collect();
    Ok(held
        .into_iter()
        .filter(|(a, _)| !named.contains(a))
        .collect())
}
