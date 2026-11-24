//! Words on a line the ledger does not store (`activity-records.ts`): a transfer message both parties see, the
//! person's own private note and report description, an open dispute (nothing here refunds or decides), and the
//! crypto address of the person's own off-ramp. With the feed's other reads of svc-bank's own tables: the person's
//! named spaces (`allNamedSpaces`) and a personal send's words (`personal-pay.ts` `factsFor`).
//!
//! Each query is the TypeScript's SQL; a user id goes in as text and is cast where the column is a uuid, so a value
//! that is not one fails in Postgres as it does for the TypeScript.

use std::collections::BTreeMap;

use postgres::IsolationLevel;

use super::service::{
    Annotation, Dispute, Fact, FeedError, Fees, Records, SpaceRef, Spaces, TransferFacts, bank,
};
use crate::db::{Store, StoreError, transaction, with_client};

/// `floor(extract(epoch from <col>) * 1000)::int8`: a `Date`'s milliseconds.
pub fn ms_col(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn iso(ms: i64) -> String {
    service_kit::time::Instant(ms).iso()
}

fn pg(e: postgres::Error) -> FeedError {
    FeedError::Other(StoreError::from(e))
}

/// svc-bank's own tables, read for the feed.
pub struct StoreFeed<'a>(pub &'a Store);

impl StoreFeed<'_> {
    fn client<T>(
        &self,
        f: impl FnOnce(&mut postgres::Client) -> Result<T, StoreError>,
    ) -> Result<T, FeedError> {
        let pool = self.0.pool()?;
        Ok(with_client(pool, f)?)
    }
}

impl Spaces for StoreFeed<'_> {
    fn all_named(&self, user_id: &str, asset_id: Option<&str>) -> Result<Vec<SpaceRef>, FeedError> {
        self.client(|c| {
            let cols = "id::text, user_id, kind::text, name";
            let rows = match asset_id {
                Some(a) => c.query(
                    &format!(
                        "SELECT {cols} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'named' \
                         ORDER BY asset_id ASC, name ASC, id ASC"
                    ),
                    &[&user_id, &a],
                )?,
                None => c.query(
                    &format!(
                        "SELECT {cols} FROM bank.spaces WHERE user_id = $1 AND kind = 'named' \
                         ORDER BY asset_id ASC, name ASC, id ASC"
                    ),
                    &[&user_id],
                )?,
            };
            rows.iter()
                .map(|r| {
                    Ok(SpaceRef {
                        id: r.try_get(0)?,
                        user_id: r.try_get(1)?,
                        kind: r.try_get(2)?,
                        name: r.try_get(3)?,
                    })
                })
                .collect::<Result<Vec<_>, postgres::Error>>()
                .map_err(StoreError::from)
        })
    }
}

impl Records for StoreFeed<'_> {
    fn for_items(
        &self,
        user_id: &str,
        refs: &[(String, String)],
    ) -> Result<BTreeMap<String, Annotation>, FeedError> {
        let mut out = BTreeMap::new();
        if refs.is_empty() {
            return Ok(out);
        }
        let mut tx_ids: Vec<String> = Vec::new();
        for (_, t) in refs {
            if !tx_ids.contains(t) {
                tx_ids.push(t.clone());
            }
        }
        let ids: Vec<String> = refs.iter().map(|(i, _)| i.clone()).collect();
        type Words = (Option<String>, Option<String>);
        let (messages, notes, disputes) = self.client(|c| {
            let mut messages: BTreeMap<String, Words> = BTreeMap::new();
            for r in c.query(
                "SELECT ledger_tx_id, note, reference FROM bank.transfer_messages \
                  WHERE ledger_tx_id = ANY($1::text[]) \
                    AND (from_user_id = $2::text::uuid OR to_user_id = $2::text::uuid)",
                &[&tx_ids, &user_id],
            )? {
                if let Some(tx) = r.try_get::<_, Option<String>>(0)? {
                    messages.insert(tx, (r.try_get(1)?, r.try_get(2)?));
                }
            }
            let mut notes: BTreeMap<String, Words> = BTreeMap::new();
            for r in c.query(
                "SELECT activity_id, text, report_description FROM bank.activity_notes \
                  WHERE user_id = $1::text::uuid AND activity_id = ANY($2::text[])",
                &[&user_id, &ids],
            )? {
                notes.insert(r.try_get(0)?, (r.try_get(1)?, r.try_get(2)?));
            }
            let mut disputes: BTreeMap<String, Dispute> = BTreeMap::new();
            for r in c.query(
                "SELECT id::text, activity_id, reason FROM bank.activity_disputes \
                  WHERE user_id = $1::text::uuid AND activity_id = ANY($2::text[])",
                &[&user_id, &ids],
            )? {
                disputes.insert(
                    r.try_get(1)?,
                    Dispute {
                        id: r.try_get(0)?,
                        reason: r.try_get(2)?,
                    },
                );
            }
            Ok((messages, notes, disputes))
        })?;
        for (id, tx) in refs {
            let message = messages.get(tx);
            let written = notes.get(id);
            let private_note = written.and_then(|w| w.0.clone());
            let report_description = written.and_then(|w| w.1.clone());
            let dispute = disputes.get(id).cloned();
            if message.is_none()
                && private_note.is_none()
                && report_description.is_none()
                && dispute.is_none()
            {
                continue;
            }
            out.insert(
                id.clone(),
                Annotation {
                    note: message.and_then(|m| m.0.clone()),
                    reference: message.and_then(|m| m.1.clone()),
                    private_note,
                    report_description,
                    dispute,
                },
            );
        }
        Ok(out)
    }

    fn looks_up_addresses(&self) -> bool {
        true
    }

    fn addresses_for(
        &self,
        user_id: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, String>, FeedError> {
        let mut out = BTreeMap::new();
        if tx_ids.is_empty() {
            return Ok(out);
        }
        let mut wanted: Vec<String> = Vec::new();
        for t in tx_ids {
            if !wanted.contains(t) {
                wanted.push(t.clone());
            }
        }
        let rows = self.client(|c| {
            Ok(c.query(
                "SELECT destination_ref, hold_ledger_tx_id, settle_ledger_tx_id, release_ledger_tx_id \
                   FROM bank.ramp_offramps \
                  WHERE user_id = $1 AND kind = 'crypto' \
                    AND (hold_ledger_tx_id = ANY($2::text[]) OR settle_ledger_tx_id = ANY($2::text[]) \
                      OR release_ledger_tx_id = ANY($2::text[]))",
                &[&user_id, &wanted],
            )?)
        })?;
        for r in rows {
            let dest: String = r.try_get(0).map_err(pg)?;
            for i in 1..=3 {
                if let Some(tx) = r.try_get::<_, Option<String>>(i).map_err(pg)? {
                    out.insert(tx, dest.clone());
                }
            }
        }
        Ok(out)
    }
}

/// A recorded numeric fee as the wire writes an amount: no trailing zeros ("0", "0.5").
fn figure(v: &str) -> String {
    match v.split_once('.') {
        Some((whole, frac)) => match frac.trim_end_matches('0') {
            "" => whole.to_owned(),
            frac => format!("{whole}.{frac}"),
        },
        None => v.to_owned(),
    }
}

impl TransferFacts for StoreFeed<'_> {
    /// `factsFor`: posted sends, by ledger tx id or the partner's move id.
    fn for_transfers(
        &self,
        user_id: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, Fact>, FeedError> {
        let mut out = BTreeMap::new();
        if tx_ids.is_empty() {
            return Ok(out);
        }
        let rows = self.client(|c| {
            Ok(c.query(
                "SELECT ledger_tx_id, partner_move_id, from_user_id, note, reference, from_handle, to_handle, \
                        fee::text, network_fee::text \
                   FROM bank.personal_transfers \
                  WHERE status = 'posted' AND (ledger_tx_id = ANY($1::text[]) OR partner_move_id = ANY($1::text[])) \
                    AND (from_user_id = $2 OR to_user_id = $2)",
                &[&tx_ids, &user_id],
            )?)
        })?;
        for r in rows {
            let get = |i: usize| r.try_get::<_, Option<String>>(i).map_err(pg);
            let Some(id) = get(0)?.or(get(1)?) else {
                continue;
            };
            let handle = if get(2)?.as_deref() == Some(user_id) {
                get(6)?
            } else {
                get(5)?
            };
            out.insert(
                id,
                Fact {
                    note: get(3)?,
                    reference: get(4)?,
                    counterparty_handle: handle,
                    fees: Fees {
                        fee: get(7)?.map(|v: String| figure(&v)),
                        network_fee: get(8)?.map(|v: String| figure(&v)),
                    },
                },
            );
        }
        Ok(out)
    }
}

/// `setNote`'s and `openDispute`'s answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteSet {
    pub activity_id: String,
    pub text: Option<String>,
    pub report_description: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisputeOpened {
    pub dispute_id: String,
    pub activity_id: String,
    pub reason: String,
    pub created_at: String,
}

fn is_unique(e: &StoreError) -> bool {
    e.code.as_deref() == Some("23505")
}

/// `isSerializationFailure`.
fn is_serialization(e: &StoreError) -> bool {
    matches!(e.code.as_deref(), Some("40001" | "40P01"))
}

/// `transaction(sql, fn)`: serializable, up to five attempts on a serialization failure.
fn serializable<T>(
    store: &Store,
    mut f: impl FnMut(&mut postgres::Transaction<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let pool = store.pool()?;
    let mut attempt = 1;
    loop {
        match transaction(pool, IsolationLevel::Serializable, &mut f) {
            Err(e) if is_serialization(&e) && attempt < 5 => {
                std::thread::sleep(std::time::Duration::from_millis(
                    (2u64.pow(attempt) * 5).min(80) / 2,
                ));
                attempt += 1;
            }
            out => return out,
        }
    }
}

/// `setNote`: write the person's private note and/or report description on one line. A field left out keeps what it
/// had; the command id makes a repeat of the same press one write, and the same id with other words refuses.
pub fn set_note(
    store: &Store,
    user_id: &str,
    activity_id: &str,
    text: Option<&str>,
    description: Option<&str>,
    command_id: &str,
) -> Result<NoteSet, FeedError> {
    if text.is_none() && description.is_none() {
        return Err(bank(
            "bank.activity_note_empty",
            "Write a note, a report description, or both",
        ));
    }
    let pool = store.pool()?;
    type Stored = (String, String, Option<String>, Option<String>, i64);
    let prior_rows = || -> Result<Option<Stored>, StoreError> {
        with_client(pool, |c| {
            let rows = c.query(
                &format!(
                    "SELECT user_id::text, activity_id, text, report_description, {} \
                       FROM bank.activity_note_commands WHERE command_id = $1",
                    ms_col("updated_at")
                ),
                &[&command_id],
            )?;
            rows.first()
                .map(|r| {
                    Ok((
                        r.try_get(0)?,
                        r.try_get(1)?,
                        r.try_get(2)?,
                        r.try_get(3)?,
                        r.try_get(4)?,
                    ))
                })
                .transpose()
                .map_err(|e: postgres::Error| StoreError::from(e))
        })
    };
    let same = |row: &Stored| {
        row.0 == user_id
            && row.1 == activity_id
            && row.2.as_deref() == text
            && row.3.as_deref() == description
    };
    let current = || -> Result<(Option<String>, Option<String>), StoreError> {
        with_client(pool, |c| {
            let rows = c.query(
                "SELECT text, report_description FROM bank.activity_notes \
                  WHERE user_id = $1::text::uuid AND activity_id = $2",
                &[&user_id, &activity_id],
            )?;
            match rows.first() {
                None => Ok((None, None)),
                Some(r) => Ok((r.try_get(0)?, r.try_get(1)?)),
            }
        })
    };
    let conflict = || {
        bank(
            "bank.activity_note_conflict",
            "That command id was already used for a different note",
        )
    };
    let replay = |at: i64| -> Result<NoteSet, FeedError> {
        let (t, d) = current()?;
        Ok(NoteSet {
            activity_id: activity_id.to_owned(),
            text: t,
            report_description: d,
            updated_at: iso(at),
        })
    };
    if let Some(prior) = prior_rows()? {
        if !same(&prior) {
            return Err(conflict());
        }
        return replay(prior.4);
    }
    let written = serializable(store, |tx| {
        let row = tx.query_one(
            &format!(
                "INSERT INTO bank.activity_notes (user_id, activity_id, text, report_description) \
                 VALUES ($1::text::uuid, $2, $3, $4) \
                 ON CONFLICT (user_id, activity_id) \
                 DO UPDATE SET text = COALESCE(EXCLUDED.text, bank.activity_notes.text), \
                               report_description = COALESCE(EXCLUDED.report_description, bank.activity_notes.report_description), \
                               updated_at = now() \
                 RETURNING {}, text, report_description",
                ms_col("updated_at")
            ),
            &[&user_id, &activity_id, &text, &description],
        )?;
        let at: i64 = row.try_get(0)?;
        // The TypeScript writes back the `Date` it read: the moment to the millisecond.
        tx.execute(
            &format!(
                "INSERT INTO bank.activity_note_commands (command_id, user_id, activity_id, text, report_description, updated_at) \
                 VALUES ($1, $2::text::uuid, $3, $4, $5, {})",
                crate::spaces::space::at("$6")
            ),
            &[&command_id, &user_id, &activity_id, &text, &description, &at],
        )?;
        Ok((
            at,
            row.try_get::<_, Option<String>>(1)?,
            row.try_get::<_, Option<String>>(2)?,
        ))
    });
    match written {
        Ok((at, t, d)) => Ok(NoteSet {
            activity_id: activity_id.to_owned(),
            text: t,
            report_description: d,
            updated_at: iso(at),
        }),
        Err(e) if is_unique(&e) => match prior_rows()? {
            Some(again) if same(&again) => replay(again.4),
            _ => Err(conflict()),
        },
        Err(e) => Err(e.into()),
    }
}

/// `openDispute`: one open dispute per line; the dispute id makes a repeat one write.
pub fn open_dispute(
    store: &Store,
    user_id: &str,
    activity_id: &str,
    reason: &str,
    dispute_id: &str,
) -> Result<DisputeOpened, FeedError> {
    let pool = store.pool()?;
    type Row = (String, String, String, String, i64);
    let by_id = || -> Result<Option<Row>, StoreError> {
        with_client(pool, |c| {
            let rows = c.query(
                &format!(
                    "SELECT id::text, user_id::text, activity_id, reason, {} \
                       FROM bank.activity_disputes WHERE id = $1::text::uuid",
                    ms_col("created_at")
                ),
                &[&dispute_id],
            )?;
            rows.first()
                .map(|r| {
                    Ok((
                        r.try_get(0)?,
                        r.try_get(1)?,
                        r.try_get(2)?,
                        r.try_get(3)?,
                        r.try_get(4)?,
                    ))
                })
                .transpose()
                .map_err(|e: postgres::Error| StoreError::from(e))
        })
    };
    let opened = |r: Row| DisputeOpened {
        dispute_id: r.0,
        activity_id: r.2,
        reason: r.3,
        created_at: iso(r.4),
    };
    let same = |r: &Row| r.1 == user_id && r.2 == activity_id && r.3 == reason;
    let exists = || {
        bank(
            "bank.activity_dispute_exists",
            "This transaction already has an open dispute",
        )
    };
    if let Some(prior) = by_id()? {
        if !same(&prior) {
            return Err(bank(
                "bank.activity_dispute_conflict",
                "That dispute id was already used for a different case",
            ));
        }
        return Ok(opened(prior));
    }
    let open = with_client(pool, |c| {
        Ok(c.query(
            "SELECT id FROM bank.activity_disputes WHERE user_id = $1::text::uuid AND activity_id = $2",
            &[&user_id, &activity_id],
        )?)
    })?;
    if !open.is_empty() {
        return Err(exists());
    }
    let inserted = with_client(pool, |c| {
        let r = c.query_one(
            &format!(
                "INSERT INTO bank.activity_disputes (id, user_id, activity_id, reason) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4) RETURNING id::text, {}",
                ms_col("created_at")
            ),
            &[&dispute_id, &user_id, &activity_id, &reason],
        )?;
        Ok((r.try_get::<_, String>(0)?, r.try_get::<_, i64>(1)?))
    });
    match inserted {
        Ok((id, at)) => Ok(DisputeOpened {
            dispute_id: id,
            activity_id: activity_id.to_owned(),
            reason: reason.to_owned(),
            created_at: iso(at),
        }),
        Err(e) if is_unique(&e) => match by_id()? {
            Some(again) if same(&again) => Ok(opened(again)),
            _ => Err(exists()),
        },
        Err(e) => Err(e.into()),
    }
}
