//! Slice `card` (`PORT.md`): the caller's own share card (`card`) and a card read by someone else (`cardOf`), by
//! subject or through one share, as `card`, `cardFor`, `renderCard`, `visibleBlueprint`, `shareCard` and
//! `openThroughShare` in `services/svc-blueprint/src/blueprint-service.ts` answer them.
//!
//! - **The card is derived on read, never stored** (`compose`): only a real portrait render's URL is written, to
//!   `card_asset_url`, and only on the owner's own read.
//! - **The vector card always succeeds; only the raster can be absent** (`renderer`).
//! - **Denied and missing are one answer**, `blueprint.not_found`: a private card is not enumerable.
//! - **A share's open is logged with the read, or the card is not returned.** The card is rendered first, from an
//!   unlocked read, so the rasterizer's budget never holds the share's row; then one transaction locks the share,
//!   checks it again, writes the open, reads `revoked_at` once more under the lock, and only then answers.
//! - Both surfaces pass the zero-PII bar (`crate::zero_pii`) before they leave.

pub mod compose;
pub mod renderer;

use postgres::GenericClient;
use postgres::types::ToSql;
use service_kit::json::Json;
use service_kit::schema::Value;

use crate::db::{self, Store, StoreError};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::profile::{BLUEPRINT_COLUMNS, checked, first_blueprint, internal, text, user_of};
use crate::zero_pii;
use compose::{Size, Subject};
use renderer::{CardRenderer, Raster, RasterizeRequest};

/// `CARD_NOT_FOUND`: missing, revoked, other-subject and invisible all read the same.
pub const CARD_NOT_FOUND: &str =
    "No Blueprint to render a card for — run the Blueprint session first";

fn not_found() -> Refusal {
    Refusal::blueprint("blueprint.not_found", CARD_NOT_FOUND)
        .unwrap_or_else(|| internal("blueprint.not_found is not in the catalogue"))
}

fn open_log_unavailable() -> Refusal {
    Refusal::blueprint(
        "blueprint.open_log_unavailable",
        "The open could not be recorded, so the card was not returned",
    )
    .unwrap_or_else(|| internal("blueprint.open_log_unavailable is not in the catalogue"))
}

/// `mayViewCard` (`visibility.ts`): the owner always; `private` nobody else; `public` any signed-in viewer; `crew` a
/// crewmate only.
pub fn may_view_card(viewer: &str, subject: &str, visibility: &str, same_crew: bool) -> bool {
    if viewer == subject {
        return true;
    }
    match visibility {
        "private" => false,
        "public" => true,
        _ => same_crew,
    }
}

/// The slice's answers.
pub fn handle(
    store: &Store,
    renderer: &dyn CardRenderer,
    ctx: &Ctx<'_>,
) -> Result<Option<Json>, Refusal> {
    let viewer = user_of(ctx)?;
    let size = ctx
        .input
        .get("size")
        .as_str()
        .and_then(Size::parse)
        .ok_or_else(|| internal("no size in the checked input"))?;
    match ctx.call.path.as_str() {
        "card" => card(store, renderer, &viewer, size).map(Some),
        "cardOf" => {
            // The router passes on only what the input names; the viewer is always the signed caller.
            let subject = ctx.input.get("userId").as_str().filter(|s| !s.is_empty());
            let share = ctx.input.get("shareId").as_str().filter(|s| !s.is_empty());
            card_for(store, renderer, &viewer, subject, share, size).map(Some)
        }
        other => Err(internal(format!("{other} is not slice card's"))),
    }
}

fn query<C: GenericClient>(
    client: &mut C,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<postgres::Row>, Refusal> {
    Ok(client.query(sql, params).map_err(StoreError::from)?)
}

/// One connection from the pool, for reads outside a transaction.
fn with_client<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let pool = store.pool()?;
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client = conn.client().map_err(StoreError::from)?;
    f(client)
}

/// `get`: the Blueprint of `user`, checked, as its record.
fn blueprint_of<C: GenericClient>(client: &mut C, user: &str) -> Result<Option<Json>, Refusal> {
    let rows = query(
        client,
        &format!(
            "SELECT {BLUEPRINT_COLUMNS} FROM blueprint.blueprints WHERE user_id = $1::text::uuid"
        ),
        &[&user],
    )?;
    first_blueprint(&rows)
}

fn field<'a>(record: &'a Json, key: &str) -> Result<&'a str, Refusal> {
    match record.get(key) {
        Some(Json::String(s)) => Ok(s),
        _ => Err(internal(format!("the Blueprint record has no {key}"))),
    }
}

/// The crew the card names, when `user` is placed: `renderCard`'s one read.
#[derive(Debug, Clone)]
struct Crew {
    name: String,
    season: i64,
}

fn crew_of<C: GenericClient>(client: &mut C, user: &str) -> Result<Option<Crew>, Refusal> {
    let rows = query(
        client,
        "SELECT c.name, c.season \
           FROM blueprint.crew_members m \
           JOIN blueprint.crews c ON c.id = m.crew_id \
          WHERE m.user_id = $1::text::uuid",
        &[&user],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let name: String = row.try_get("name").map_err(StoreError::from)?;
    let season: i32 = row.try_get("season").map_err(StoreError::from)?;
    Ok(Some(Crew {
        name,
        season: i64::from(season),
    }))
}

/// What `renderCard` needs from the database: the Blueprint and its crew, read on one connection.
struct Drawn {
    record: Json,
    crew: Option<Crew>,
}

fn drawn<C: GenericClient>(client: &mut C, record: Json) -> Result<Drawn, Refusal> {
    let user = field(&record, "userId")?.to_owned();
    let crew = crew_of(client, &user)?;
    Ok(Drawn { record, crew })
}

/// `renderCard`, past its one read: compose the card, raster it if a renderer exists, and hold both surfaces to the
/// zero-PII bar. No connection is held while the rasterizer runs.
fn render(renderer: &dyn CardRenderer, d: &Drawn, size: Size) -> Result<(Json, Raster), Refusal> {
    let profile = d
        .record
        .get("profile")
        .ok_or_else(|| internal("the Blueprint record has no profile"))?;
    let subject_json = Json::obj([
        ("profile", profile.clone()),
        (
            "crewName",
            d.crew
                .as_ref()
                .map_or(Json::Null, |c| Json::str(c.name.clone())),
        ),
        (
            "season",
            d.crew.as_ref().map_or(Json::Null, |c| Json::int(c.season)),
        ),
    ]);
    zero_pii::assert_surface("card.subject", &subject_json)?;
    let axis = |key: &str| -> Result<String, Refusal> {
        Value::from_json(profile)
            .get(key)
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| internal(format!("the profile has no {key}")))
    };
    let subject = Subject {
        decision_style: axis("decisionStyle")?,
        risk_temperament: axis("riskTemperament")?,
        energy_rhythm: axis("energyRhythm")?,
        learning_mode: axis("learningMode")?,
        crew_role: axis("crewRole")?,
        curriculum_path: axis("curriculumPath")?,
        tone_register: axis("toneRegister")?,
        crew_name: d.crew.as_ref().map(|c| c.name.clone()),
        season: d.crew.as_ref().map(|c| c.season),
    };
    let svg = compose::compose(&subject, size).map_err(internal)?;
    let (width, height) = compose::dimensions(size);
    let raster = renderer.rasterize(&RasterizeRequest {
        svg: svg.clone(),
        size,
        width,
        height,
        blueprint_id: field(&d.record, "id")?.to_owned(),
    });
    let share_mode = if raster.rendered().is_some() {
        "png"
    } else {
        "svg"
    };
    let card = Json::obj([
        ("size", Json::str(size.name())),
        ("width", Json::Number(f64::from(width))),
        ("height", Json::Number(f64::from(height))),
        ("svg", Json::str(svg)),
        ("raster", raster.to_json()),
        ("shareMode", Json::str(share_mode)),
    ]);
    zero_pii::assert_surface("card.render", &card)?;
    Ok((card, raster))
}

/// `UPDATE ... card_asset_url`: a real portrait render's URL, the one stored fact about the card.
fn store_asset_url<C: GenericClient>(client: &mut C, user: &str, url: &str) -> Result<(), Refusal> {
    client
        .execute(
            "UPDATE blueprint.blueprints SET card_asset_url = $2, updated_at = now() \
              WHERE user_id = $1::text::uuid",
            &[&user, &url],
        )
        .map_err(StoreError::from)?;
    Ok(())
}

/// `card`: the caller's own card; a real portrait render is written to `card_asset_url`.
pub fn card(
    store: &Store,
    renderer: &dyn CardRenderer,
    user: &str,
    size: Size,
) -> Result<Json, Refusal> {
    let d = with_client(store, |c| match blueprint_of(c, user)? {
        Some(record) => drawn(c, record),
        None => Err(not_found()),
    })?;
    let (card, raster) = render(renderer, &d, size)?;
    if let (Some(url), Size::Portrait) = (raster.rendered(), size) {
        let owner = field(&d.record, "userId")?.to_owned();
        with_client(store, |c| store_asset_url(c, &owner, url))?;
    }
    Ok(card)
}

/// Whether `viewer` and `subject` share a crew.
fn same_crew<C: GenericClient>(
    client: &mut C,
    viewer: &str,
    subject: &str,
) -> Result<bool, Refusal> {
    let rows = query(
        client,
        "SELECT 1 AS ok \
           FROM blueprint.crew_members a \
           JOIN blueprint.crew_members b ON a.crew_id = b.crew_id \
          WHERE a.user_id = $1::text::uuid AND b.user_id = $2::text::uuid \
          LIMIT 1",
        &[&viewer, &subject],
    )?;
    Ok(!rows.is_empty())
}

/// `cardFor`.
pub fn card_for(
    store: &Store,
    renderer: &dyn CardRenderer,
    viewer: &str,
    subject: Option<&str>,
    share: Option<&str>,
    size: Size,
) -> Result<Json, Refusal> {
    if let Some(share) = share {
        return open_through_share(store, renderer, viewer, share, subject);
    }
    let Some(subject) = subject else {
        return Err(not_found());
    };
    if viewer == subject {
        return card(store, renderer, viewer, size);
    }
    // `visibleBlueprint`, then a render that writes nothing: a stranger's read never stamps `card_asset_url`.
    let d = with_client(store, |c| {
        let record = blueprint_of(c, subject)?.ok_or_else(not_found)?;
        let visibility = field(&record, "visibility")?.to_owned();
        let mates = visibility == "crew" && same_crew(c, viewer, subject)?;
        if !may_view_card(viewer, subject, &visibility, mates) {
            return Err(not_found());
        }
        drawn(c, record)
    })?;
    render(renderer, &d, size).map(|(card, _)| card)
}

/// A `card_shares` row, checked with `ShareRow`.
struct Share {
    id: String,
    owner: String,
    size: Size,
}

const SHARE_COLUMNS: &str = "id::text AS id, owner_user_id::text AS owner_user_id, size, \
     floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at, \
     floor(extract(epoch FROM revoked_at) * 1000)::bigint AS revoked_at";

fn share_row(row: &postgres::Row) -> Result<Value, Refusal> {
    let date = |column: &str| -> Result<Value, Refusal> {
        let ms: Option<i64> = row.try_get(column).map_err(StoreError::from)?;
        Ok(ms.map_or(Value::Null, |ms| Value::Date(Some(ms))))
    };
    Ok(Value::Object(vec![
        ("id".to_owned(), text(row, "id")?),
        ("owner_user_id".to_owned(), text(row, "owner_user_id")?),
        ("size".to_owned(), text(row, "size")?),
        ("created_at".to_owned(), date("created_at")?),
        ("revoked_at".to_owned(), date("revoked_at")?),
    ]))
}

/// `shareCard`: the share and the Blueprint behind it, or `not_found` for a missing, revoked, other-subject or
/// invisible card. `lock` holds the share's row for the rest of the transaction.
fn share_card<C: GenericClient>(
    client: &mut C,
    viewer: &str,
    share_id: &str,
    subject: Option<&str>,
    lock: bool,
) -> Result<(Share, Json), Refusal> {
    let rows = query(
        client,
        &format!(
            "SELECT {SHARE_COLUMNS} FROM blueprint.card_shares WHERE id = $1::text::uuid{}",
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&share_id],
    )?;
    let rows = rows.iter().map(share_row).collect::<Result<Vec<_>, _>>()?;
    let rows = checked("ShareRow", rows)?;
    let Some(row) = rows.first() else {
        return Err(not_found());
    };
    if !matches!(row.get("revoked_at"), Value::Null) {
        return Err(not_found());
    }
    let share = Share {
        id: row.get("id").as_str().unwrap_or_default().to_owned(),
        owner: row
            .get("owner_user_id")
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        size: row
            .get("size")
            .as_str()
            .and_then(Size::parse)
            .ok_or_else(|| internal("ShareRow: no size"))?,
    };
    if subject.is_some_and(|s| s != share.owner) {
        return Err(not_found());
    }
    let record = blueprint_of(client, &share.owner)?.ok_or_else(not_found)?;
    let visibility = field(&record, "visibility")?.to_owned();
    let mates =
        viewer != share.owner && visibility == "crew" && same_crew(client, viewer, &share.owner)?;
    if !may_view_card(viewer, &share.owner, &visibility, mates) {
        return Err(not_found());
    }
    Ok((share, record))
}

/// `openThroughShare`: render from an unlocked read, then lock the share, check it again, record the open and read
/// `revoked_at` once more, all in one transaction. A revoked share rolls the open back and returns no card; a failed
/// open write returns no card. The owner is not an opener of their own share, and only the owner's real portrait
/// render is written to `card_asset_url`.
fn open_through_share(
    store: &Store,
    renderer: &dyn CardRenderer,
    viewer: &str,
    share_id: &str,
    subject: Option<&str>,
) -> Result<Json, Refusal> {
    let (share, d) = with_client(store, |c| {
        let (share, record) = share_card(c, viewer, share_id, subject, false)?;
        Ok((share, drawn(c, record)?))
    })?;
    let (card, raster) = render(renderer, &d, share.size)?;
    db::transaction(store, |tx| {
        let (share, record) = share_card(tx, viewer, share_id, subject, true)?;
        if viewer != share.owner {
            let written = tx.query(
                "INSERT INTO blueprint.card_opens (share_id, viewer_user_id, first_opened, last_opened, open_count) \
                 VALUES ($1::text::uuid, $2::text::uuid, now(), now(), 1) \
                 ON CONFLICT (share_id, viewer_user_id) \
                 DO UPDATE SET last_opened = now(), open_count = blueprint.card_opens.open_count + 1 \
                 RETURNING share_id::text AS share_id",
                &[&share.id, &viewer],
            );
            match written {
                Ok(rows) if !rows.is_empty() => {}
                Ok(_) => return Err(open_log_unavailable()),
                Err(e) => {
                    let refusal = Refusal::from(StoreError::from(&e));
                    // A serialization failure goes back to the transaction, which runs the open again.
                    return Err(if db::is_serialization_failure(&refusal) {
                        refusal
                    } else {
                        open_log_unavailable()
                    });
                }
            }
        }
        let again = query(
            tx,
            "SELECT revoked_at IS NULL AS live FROM blueprint.card_shares WHERE id = $1::text::uuid FOR UPDATE",
            &[&share.id],
        )?;
        let live = match again.first() {
            Some(row) => row.try_get::<_, bool>("live").map_err(StoreError::from)?,
            None => false,
        };
        if !live {
            return Err(not_found());
        }
        if viewer == share.owner
            && share.size == Size::Portrait
            && let Some(url) = raster.rendered()
        {
            let owner = field(&record, "userId")?.to_owned();
            store_asset_url(tx, &owner, url)?;
        }
        Ok(card.clone())
    })
}
