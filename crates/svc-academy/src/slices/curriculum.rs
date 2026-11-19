//! The curriculum slice: the calls the door table gives `Slice::Curriculum`, answered as `router.ts` answers them.
//!
//! Most are pure reads of the embedded spine and never reach the service: they answer the same whatever the database
//! does. The item reads (`curriculumItem`, `curriculumItemLocalized`, `publicCurriculumItem`) and `publicHub` call the
//! service, so they first meet a refusing service ([`enter`]); then each checks what the TypeScript checks before its
//! first query (the slug is on the spine) and only then reads the release rows, the access record and the featured
//! slot.

use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};

use crate::curriculum::links::{self, Sort};
use crate::curriculum::{gates, spine, substance};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::slices::{Answer, not_ported};

/// A call into `AcademyService`: a service that refuses every method refuses here, before anything else runs.
fn enter(ctx: &Ctx<'_>) -> Result<(), Refusal> {
    match ctx.store {
        Store::Refuses(r) => Err(r.clone()),
        _ => Ok(()),
    }
}

/// A string field, when present.
fn text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

/// A field the TypeScript reads as `input?.<key> ? ... : {}`: present only when truthy.
fn truthy<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    text(input, key).filter(|s| !s.is_empty())
}

fn summaries(items: &[&spine::Item]) -> Json {
    Json::Array(items.iter().map(|i| i.summary_json()).collect())
}

fn guides(items: &[&spine::Item]) -> Json {
    Json::Array(items.iter().map(|i| i.study_guide_json()).collect())
}

/// `academy.readCurriculumItem({ userId, slug })`: the release decision and the access record first, then the body.
fn read_item(ctx: &Ctx<'_>, slug: &str) -> Result<&'static spine::Item, Refusal> {
    enter(ctx)?;
    gates::require_slug(slug)?;
    gates::assert_may_read(ctx.service()?, ctx.user_id(), slug, ctx.now.0)?;
    spine::item_view(slug)
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let input = &ctx.input;
    let limit = || spine::page_limit(input.get("limit").as_number());
    let out = match ctx.call.path {
        "curriculum" => {
            let all = spine::list(truthy(input, "path"), truthy(input, "kind"));
            let n = limit()?;
            summaries(&all.into_iter().take(n).collect::<Vec<_>>())
        }
        "curriculumRelated" => {
            let slug = text(input, "slug").unwrap_or("");
            let n = limit()?;
            summaries(&spine::related(slug, n)?)
        }
        "curriculumItem" => {
            Json::Object(read_item(ctx, text(input, "slug").unwrap_or(""))?.item_fields())
        }
        "curriculumItemLocalized" => {
            let item = read_item(ctx, text(input, "slug").unwrap_or(""))?;
            let locale = links::resolve_locale(text(input, "locale"));
            let mut fields = item.item_fields();
            fields.extend([
                ("locale".to_owned(), Json::str(locale.locale)),
                ("fellBack".to_owned(), Json::Bool(locale.fell_back)),
                (
                    "i18nStrategy".to_owned(),
                    Json::str(links::i18n_strategy_line()),
                ),
            ]);
            Json::Object(fields)
        }
        "curriculumStudyGuide" => {
            let slug = text(input, "slug").unwrap_or("");
            spine::study_guide(slug)
                .ok_or_else(|| spine::not_in_spine(slug))?
                .study_guide_json()
        }
        "curriculumStudyGuides" => {
            let all = spine::study_guides(truthy(input, "path"));
            let n = limit()?;
            guides(&all.into_iter().take(n).collect::<Vec<_>>())
        }
        "curriculumDepth" => spine::depth().json(),
        "curriculumInventory" => substance::inventory().json(),
        "curriculumImportStatus" => substance::import_stage_status(),
        "curriculumPathDeepLinks" => links::path_deep_links_json(),
        "curriculumDeepLink" => {
            links::resolve_deep_link(text(input, "path").unwrap_or(""), text(input, "slug")).json()
        }
        "publicCurriculum" => {
            let n = limit()?;
            summaries(&links::search_public(
                text(input, "q"),
                truthy(input, "path"),
                truthy(input, "kind"),
                truthy(input, "sort").and_then(Sort::parse),
                n,
            ))
        }
        "publicCurriculumItem" => {
            enter(ctx)?;
            let slug = text(input, "slug").unwrap_or("");
            gates::require_slug(slug)?;
            gates::assert_may_read_signed_out(ctx.service()?, slug, ctx.now.0)?;
            Json::Object(spine::item_view(slug)?.item_fields())
        }
        "publicCurriculumRelated" => {
            let slug = js_trim(text(input, "slug").unwrap_or(""));
            let n = limit()?;
            summaries(&spine::related(slug, n)?)
        }
        "publicHub" => {
            enter(ctx)?;
            let pool = ctx.service()?;
            let featured = gates::featured_item(pool, ctx.now.0)?;
            let lesson = gates::featured_lesson(pool)?;
            Json::obj([
                (
                    "featured",
                    featured.map_or(Json::Null, spine::Item::summary_json),
                ),
                ("lesson", lesson),
            ])
        }
        _ => return not_ported(ctx),
    };
    Ok(Some(out))
}
