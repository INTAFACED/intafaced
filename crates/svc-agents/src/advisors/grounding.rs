//! The Coach's grounding (`coach/grounded-session.ts`, `coach/policy.ts`, `coach/academy-curriculum-source.ts`): the
//! curriculum it may cite, the honesty board, and `coach.session`'s ruling. Titles come only from svc-academy's
//! answer; a failed read is the empty catalog (a chatbot, refused), never invention.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;

use super::text::position_ask;

/// `COACH_REFUSE_COPY`.
pub const REFUSE_COPY: &str = "agents.error.capability_unavailable";

/// `COACH_REFUSE_REASONS`.
pub const REFUSE_REASONS: [&str; 5] = [
    "curriculum_empty",
    "library_import_pending",
    "invented_library",
    "positions_not_decided",
    "advice_forbidden",
];

/// `CoachCatalogItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lesson {
    pub slug: String,
    pub title: String,
}

impl Lesson {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("slug", Json::str(self.slug.clone())),
            ("title", Json::str(self.title.clone())),
        ])
    }

    /// A stored `{ slug, title }`.
    pub fn from_json(j: &Json) -> Option<Lesson> {
        match (j.get("slug"), j.get("title")) {
            (Some(Json::String(slug)), Some(Json::String(title))) => Some(Lesson {
                slug: slug.clone(),
                title: title.clone(),
            }),
            _ => None,
        }
    }
}

/// `CoachGrounding`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Grounding {
    pub items: Vec<Lesson>,
    /// The licensed library import: false until it exists, never invented.
    pub licensed_library_imported: bool,
}

/// Where the Coach reads its curriculum (`loadCoachGrounding`). `Err` is a read that threw.
pub trait Curriculum: Send + Sync {
    fn load(&self) -> Result<Grounding, String>;
}

/// `envCoachGrounding()`: no academy wired, the empty catalog.
pub struct NoCurriculum;

impl Curriculum for NoCurriculum {
    fn load(&self) -> Result<Grounding, String> {
        Ok(Grounding::default())
    }
}

/// A fixed spine (`FixedAcademyCurriculumSource`): tests. The licensed library stays false.
pub struct FixedCurriculum(pub Vec<Lesson>);

impl Curriculum for FixedCurriculum {
    fn load(&self) -> Result<Grounding, String> {
        Ok(Grounding {
            items: self.0.clone(),
            licensed_library_imported: false,
        })
    }
}

/// `ACADEMY_INTERNAL_CURRICULUM`'s path.
pub const ACADEMY_CURRICULUM_PATH: &str = "/internal/curriculum";

/// `createAcademyCurriculumSource`: svc-academy's record, a GET signed as svc-agents over the empty body. A refusal,
/// a transport failure or a reply the record refuses reads as the empty catalog.
pub struct AcademyCurriculum {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl AcademyCurriculum {
    fn read(&self) -> Result<Vec<Lesson>, String> {
        let mut headers = Vec::new();
        headers.extend(self.signer.sign("", "GET", ACADEMY_CURRICULUM_PATH, "")?);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!(
                    "{}{ACADEMY_CURRICULUM_PATH}",
                    self.base_url.trim_end_matches('/')
                ),
                headers,
                body: None,
                timeout_ms: None,
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if !res.ok() {
            return Err(format!("{ACADEMY_CURRICULUM_PATH}: {}", res.status));
        }
        let body = json::parse(&res.body).map_err(|e| e.message)?;
        // The record's output: `{ items: [{ slug, title }], licensedLibraryImported: false, source: 'platform-spine' }`.
        let shaped = body.get("licensedLibraryImported") == Some(&Json::Bool(false))
            && body.get("source") == Some(&Json::str("platform-spine"));
        let Some(Json::Array(items)) = body.get("items") else {
            return Err("the curriculum reply has no items".to_owned());
        };
        if !shaped {
            return Err("the curriculum reply is not the record's".to_owned());
        }
        items
            .iter()
            .map(|i| {
                Lesson::from_json(i).ok_or_else(|| "a lesson is not { slug, title }".to_owned())
            })
            .collect()
    }
}

impl Curriculum for AcademyCurriculum {
    fn load(&self) -> Result<Grounding, String> {
        Ok(Grounding {
            items: self.read().unwrap_or_default(),
            licensed_library_imported: false,
        })
    }
}

/// `describeCoachPolicy()`: the public honesty board.
pub fn policy() -> Json {
    Json::obj([
        ("notAdvice", Json::Bool(true)),
        ("positionsReferencedForbidden", Json::Bool(true)),
        ("licensedLibraryNeverInvented", Json::Bool(true)),
        ("emptyCatalogRefuses", Json::Bool(true)),
        (
            "refuseReasons",
            Json::Array(REFUSE_REASONS.iter().map(|r| Json::str(*r)).collect()),
        ),
        ("userMessageKey", Json::str(REFUSE_COPY)),
        ("allowedTasks", Json::Array(Vec::new())),
        ("inventsLibraryTitles", Json::Bool(false)),
        ("inventsLessonBodies", Json::Bool(false)),
        ("inventsPositions", Json::Bool(false)),
        ("inventsTradeRecommendations", Json::Bool(false)),
    ])
}

/// `CoachSessionInput`.
#[derive(Debug, Clone, Default)]
pub struct SessionAsk<'a> {
    pub ask: Option<&'a str>,
    pub requested_slug: Option<&'a str>,
    pub include_positions: bool,
    pub as_advice: bool,
}

/// `runCoachSession`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ruling {
    Refuse {
        reason: &'static str,
        licensed_library_imported: bool,
    },
    Grounded {
        licensed_library_imported: bool,
        citations: Vec<Lesson>,
    },
}

/// `runCoachSession`: ground an ask, or refuse when the catalog or the owner's line cannot support one.
pub fn rule(grounding: &Grounding, input: &SessionAsk<'_>) -> Ruling {
    let licensed = grounding.licensed_library_imported;
    let refuse = |reason| Ruling::Refuse {
        reason,
        licensed_library_imported: licensed,
    };
    let ask = service_kit::schema::js_trim(input.ask.unwrap_or_default());
    let requested = service_kit::schema::js_trim(input.requested_slug.unwrap_or_default());
    if input.as_advice {
        return refuse("advice_forbidden");
    }
    if input.include_positions || position_ask(ask) {
        return refuse("positions_not_decided");
    }
    if grounding.items.is_empty() {
        return refuse("curriculum_empty");
    }
    if !requested.is_empty() {
        return match grounding.items.iter().find(|i| i.slug == requested) {
            None => refuse("invented_library"),
            Some(hit) => Ruling::Grounded {
                licensed_library_imported: licensed,
                citations: vec![hit.clone()],
            },
        };
    }
    if !licensed {
        return refuse("library_import_pending");
    }
    Ruling::Grounded {
        licensed_library_imported: true,
        citations: grounding.items.iter().take(3).cloned().collect(),
    }
}

/// `coach.session`'s answer, in its output schema's order.
pub fn session_output(ruling: &Ruling) -> Json {
    match ruling {
        Ruling::Refuse {
            reason,
            licensed_library_imported,
        } => Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(*reason)),
            ("kind", Json::str("not_advice")),
            ("isAdvice", Json::Bool(false)),
            ("positionsReferenced", Json::Bool(false)),
            (
                "licensedLibraryImported",
                Json::Bool(*licensed_library_imported),
            ),
            ("inventedLibrary", Json::Bool(false)),
            ("citedCount", Json::int(0)),
            ("userMessageKey", Json::str(REFUSE_COPY)),
        ]),
        Ruling::Grounded {
            licensed_library_imported,
            citations,
        } => Json::obj([
            ("status", Json::str("grounded")),
            ("kind", Json::str("citation")),
            ("isAdvice", Json::Bool(false)),
            ("positionsReferenced", Json::Bool(false)),
            (
                "licensedLibraryImported",
                Json::Bool(*licensed_library_imported),
            ),
            ("inventedLibrary", Json::Bool(false)),
            (
                "citedCount",
                Json::int(i64::try_from(citations.len()).unwrap_or(i64::MAX)),
            ),
            (
                "citations",
                Json::Array(citations.iter().map(Lesson::to_json).collect()),
            ),
            ("userMessageKey", Json::str(REFUSE_COPY)),
        ]),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn spine(licensed: bool) -> Grounding {
        Grounding {
            items: ["a", "b", "c", "d"]
                .iter()
                .map(|s| Lesson {
                    slug: format!("slug-{s}"),
                    title: format!("Title {s}"),
                })
                .collect(),
            licensed_library_imported: licensed,
        }
    }

    fn reason(r: &Ruling) -> &'static str {
        match r {
            Ruling::Refuse { reason, .. } => reason,
            Ruling::Grounded { .. } => "grounded",
        }
    }

    /// `grounded-session.test.ts`: the order of the refusals and what a grounded answer cites.
    #[test]
    fn the_ruling_refuses_in_order_and_cites_only_the_catalog() {
        let empty = Grounding::default();
        let ask = |a: SessionAsk<'_>, g: &Grounding| reason(&rule(g, &a)).to_owned();
        assert_eq!(ask(SessionAsk::default(), &empty), "curriculum_empty");
        assert_eq!(
            ask(
                SessionAsk {
                    as_advice: true,
                    include_positions: true,
                    ..SessionAsk::default()
                },
                &spine(true)
            ),
            "advice_forbidden"
        );
        assert_eq!(
            ask(
                SessionAsk {
                    ask: Some("What about my positions?"),
                    ..SessionAsk::default()
                },
                &empty
            ),
            "positions_not_decided"
        );
        assert_eq!(
            ask(
                SessionAsk {
                    requested_slug: Some(" slug-x "),
                    ..SessionAsk::default()
                },
                &spine(false)
            ),
            "invented_library"
        );
        assert_eq!(
            ask(SessionAsk::default(), &spine(false)),
            "library_import_pending"
        );
        assert_eq!(
            rule(
                &spine(false),
                &SessionAsk {
                    requested_slug: Some("slug-b"),
                    ..SessionAsk::default()
                }
            ),
            Ruling::Grounded {
                licensed_library_imported: false,
                citations: vec![spine(false).items[1].clone()],
            }
        );
        let Ruling::Grounded { citations, .. } = rule(&spine(true), &SessionAsk::default()) else {
            panic!("grounded");
        };
        assert_eq!(citations, spine(true).items[..3].to_vec());
    }
}
