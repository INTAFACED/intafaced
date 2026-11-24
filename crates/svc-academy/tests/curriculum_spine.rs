//! The curriculum spine and what is derived from it, without a database: the ports of `curriculum/catalog.test.ts`,
//! `item-type.test.ts`, `title-complete.test.ts`, `coach-spine.test.ts`, `deep-links.test.ts`, `i18n-strategy.test.ts`,
//! `related.test.ts` (with `reserved-slugs.ts`), `lesson-substance.test.ts`, `import-pipeline.test.ts` and the pure
//! part of `public-catalogue.test.ts`. Each section names its TypeScript file; each test keeps its assertions' meaning.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeSet;

use service_kit::json::Json;
use svc_academy::curriculum::links::{self, DeepLink, Sort};
use svc_academy::curriculum::spine::{
    self, Item, KINDS, MIN_BODY_CHARS, PATHS, RESERVED_TAB_SLUGS,
};
use svc_academy::curriculum::substance::{self, Issue};
use svc_academy::errors::Refusal;

/// The refusal's code, as the TypeScript tests read `err.code`.
fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> Option<String> {
    match r {
        Ok(_) => None,
        Err(Refusal::Academy(e)) => Some(e.code.clone()),
        Err(other) => Some(format!("not-academy: {other:?}")),
    }
}

fn message<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.message.clone(),
        other => panic!("{other:?}"),
    }
}

fn all() -> Vec<&'static Item> {
    spine::list(None, None)
}

fn first() -> &'static Item {
    all()[0]
}

/// JavaScript's `.length`.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn trim(s: &str) -> &str {
    service_kit::schema::js_trim(s)
}

fn strings(v: &[String]) -> Json {
    Json::Array(v.iter().map(|s| Json::str(s.clone())).collect())
}

/// An import record as the TypeScript tests spread one.
fn record(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn item_record(item: &Item, slug: &str, path: &str, order: i64) -> Vec<(&'static str, Json)> {
    vec![
        ("slug", Json::str(slug)),
        ("title", Json::str(item.title.clone())),
        ("kind", Json::str(item.kind.clone())),
        ("path", Json::str(path)),
        ("order", Json::int(order)),
        ("summary", Json::str(item.summary.clone())),
        ("body", Json::str(item.body.clone())),
        ("objectives", strings(&item.objectives)),
    ]
}

fn with(mut fields: Vec<(&'static str, Json)>, key: &'static str, value: Json) -> Json {
    fields.retain(|(k, _)| *k != key);
    fields.push((key, value));
    record(&fields)
}

fn codes(issues: &[Issue]) -> Vec<&str> {
    issues.iter().map(|i| i.code.as_str()).collect()
}

// ── catalog.test.ts ─────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn catalog_lists_a_non_empty_spine_of_metadata_only() {
    let items = all();
    assert!(items.len() >= 4);
    for item in &items {
        assert!(
            item.slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        );
        assert!(!item.title.is_empty());
        assert!(!item.summary.is_empty());
        assert!(PATHS.contains(&item.path.as_str()));
        // A list row never carries the body.
        let Json::Object(fields) = item.summary_json() else {
            panic!()
        };
        assert!(fields.iter().all(|(k, _)| k != "body"), "{}", item.slug);
    }
}

#[test]
fn catalog_filters_by_path_and_kind_and_orders_by_order() {
    let foundations = spine::list(Some("foundations"), None);
    assert!(!foundations.is_empty());
    assert!(foundations.iter().all(|i| i.path == "foundations"));
    assert!(
        spine::list(Some("sovereign"), None)
            .iter()
            .all(|i| i.path == "sovereign")
    );
    let playbooks = spine::list(None, Some("playbook"));
    assert!(!playbooks.is_empty());
    assert!(playbooks.iter().all(|i| i.kind == "playbook"));
    let orders: Vec<i64> = foundations.iter().map(|i| i.order).collect();
    let mut sorted = orders.clone();
    sorted.sort_unstable();
    assert_eq!(orders, sorted);
}

#[test]
fn catalog_returns_the_body_for_a_known_slug_and_none_for_an_unknown_one() {
    let item = spine::get("foundations-risk-first").unwrap();
    assert!(item.body.contains("# Risk first"));
    assert_eq!(item.kind, "playbook");
    assert_eq!(item.path, "foundations");
    assert!(spine::get("does-not-exist").is_none());
}

#[test]
fn catalog_covers_every_path_and_inventories_the_spine_only() {
    let paths: BTreeSet<&str> = all().iter().map(|i| i.path.as_str()).collect();
    for p in PATHS {
        assert!(paths.contains(p), "{p}");
    }
    let (total, by_path, by_kind) = spine::inventory();
    assert_eq!(total, all().len());
    assert!(total > 0);
    assert_eq!(by_path.iter().sum::<usize>(), total);
    assert_eq!(by_kind.iter().sum::<usize>(), total);
    for (i, p) in PATHS.iter().enumerate() {
        assert_eq!(spine::list(Some(p), None).len(), by_path[i]);
    }
    for (i, k) in KINDS.iter().enumerate() {
        assert_eq!(spine::list(None, Some(k)).len(), by_kind[i]);
    }
    assert!(spine::has("foundations-risk-first"));
    assert!(!spine::has("not-a-real-deriv-desk-title"));
    let slugs = spine::slugs();
    assert_eq!(slugs.len(), total);
    let mut sorted = slugs.clone();
    sorted.sort_unstable();
    assert_eq!(slugs, sorted);
    assert!(slugs.contains(&"foundations-risk-first"));
}

#[test]
fn catalog_bodies_are_real_content_in_platform_vocabulary() {
    for item in all() {
        assert!(js_len(trim(&item.body)) > 40);
        assert!(item.body.starts_with('#'));
    }
    assert!(
        spine::get("foundations-risk-first")
            .unwrap()
            .body
            .contains("Identity Blueprint")
    );
}

#[test]
fn library_gives_every_item_the_full_field_set() {
    for item in all() {
        let s = &item.slug;
        assert!(
            !s.is_empty() && !s.starts_with('-') && !s.ends_with('-') && !s.contains("--"),
            "{s}"
        );
        assert!(!trim(&item.title).is_empty());
        assert!(js_len(trim(&item.summary)) >= 12);
        assert!(KINDS.contains(&item.kind.as_str()));
        assert!(PATHS.contains(&item.path.as_str()));
        assert!(item.estimated_minutes > 0);
    }
}

#[test]
fn library_keeps_slugs_unique_and_order_unique_within_a_path() {
    let slugs: BTreeSet<&str> = all().iter().map(|i| i.slug.as_str()).collect();
    assert_eq!(slugs.len(), all().len());
    for p in PATHS {
        let orders: Vec<i64> = spine::list(Some(p), None).iter().map(|i| i.order).collect();
        assert_eq!(
            orders.iter().collect::<BTreeSet<_>>().len(),
            orders.len(),
            "{p}"
        );
    }
}

#[test]
fn library_carries_a_real_body_on_every_item() {
    for item in all() {
        assert!(
            item.body
                .trim_start_matches(spine::js_space)
                .starts_with("# ")
        );
        assert!(item.body_chars() >= MIN_BODY_CHARS, "{}", item.slug);
        let prose = item
            .body
            .split('\n')
            .filter(|l| {
                !trim(l).is_empty() && !l.trim_start_matches(spine::js_space).starts_with('#')
            })
            .count();
        assert!(prose > 10, "{}", item.slug);
    }
}

#[test]
fn library_carries_objectives_key_terms_and_self_check_on_every_item() {
    for item in all() {
        assert!(item.objectives.len() >= 2);
        assert!(item.key_terms.len() >= 2);
        assert!(item.self_check.len() >= 2);
        for o in &item.objectives {
            assert!(js_len(trim(o)) > 20);
        }
        for t in &item.key_terms {
            assert!(!trim(&t.term).is_empty());
            assert!(js_len(trim(&t.definition)) > 20);
        }
        for q in &item.self_check {
            assert!(js_len(trim(q)) > 20);
        }
    }
}

#[test]
fn library_derives_the_reading_estimate_from_the_body() {
    for item in all() {
        assert_eq!(item.estimated_minutes, spine::reading_minutes(&item.body));
    }
    assert_eq!(spine::reading_minutes(""), 1);
    assert_eq!(spine::reading_minutes(&"w ".repeat(200)), 1);
    assert_eq!(spine::reading_minutes(&"w ".repeat(201)), 2);
}

#[test]
fn library_passes_its_own_import_validator() {
    for item in all() {
        let v = substance::validate_record(&record(&item_record(
            item, &item.slug, &item.path, item.order,
        )));
        assert_eq!(v.issues, Vec::new(), "{}", item.slug);
        assert!(v.ok);
    }
}

#[test]
fn library_reports_depth_honestly_and_nothing_is_thin() {
    let d = spine::depth();
    assert_eq!(d.total, all().len());
    assert_eq!(d.deep + d.thin, d.total);
    assert!(d.thin_slugs.is_empty());
    assert_eq!(d.json().get("allDeep"), Some(&Json::Bool(true)));
    assert!(d.shortest_body_chars >= MIN_BODY_CHARS);
    assert_eq!(
        d.total_body_chars,
        all().iter().map(|i| js_len(&i.body)).sum::<usize>()
    );
    assert!(d.line().contains(&format!("thin={}", d.thin)));
    // The figures the wire answers, in JavaScript string lengths.
    assert_eq!((d.total_body_chars, d.shortest_body_chars), (69_230, 2_345));
}

#[test]
fn library_builds_a_study_guide_for_every_item_and_none_for_an_unknown_slug() {
    assert!(spine::study_guide("no-such-slug").is_none());
    assert_eq!(spine::study_guides(None).len(), all().len());
    for item in all() {
        let guide = spine::study_guide(&item.slug).unwrap().study_guide_json();
        assert_eq!(
            guide.get("bodyChars"),
            Some(&Json::int(i64::try_from(js_len(&item.body)).unwrap()))
        );
        assert_eq!(guide.get("objectives"), Some(&strings(&item.objectives)));
        assert!(guide.get("body").is_none());
    }
    let sovereign = spine::study_guides(Some("sovereign"));
    assert_eq!(sovereign.len(), spine::list(Some("sovereign"), None).len());
    assert!(sovereign.iter().all(|g| g.path == "sovereign"));
}

// ── item-type.test.ts ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn item_type_a_quiz_wins_a_workbook_is_an_assignment_else_a_lesson() {
    assert_eq!(spine::item_type("playbook", false), "lesson");
    assert_eq!(spine::item_type("lesson", false), "lesson");
    assert_eq!(spine::item_type("workbook", false), "assignment");
    assert_eq!(spine::item_type("playbook", true), "quiz");
    assert_eq!(spine::item_type("workbook", true), "quiz");
    let types = |p: &str| {
        spine::list(Some(p), None)
            .iter()
            .map(|r| spine::item_type(&r.kind, false))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    };
    for p in ["foundations", "markets", "builder"] {
        assert_eq!(types(p), ["assignment", "lesson"], "{p}");
    }
    assert_eq!(types("sovereign"), ["lesson"]);
}

// ── title-complete.test.ts ──────────────────────────────────────────────────────────────────────────────────────────

const DANGLING_LAST_WORD: [&str; 20] = [
    "a", "an", "the", "and", "or", "but", "of", "to", "for", "with", "without", "in", "on", "at",
    "by", "from", "into", "over", "than", "as",
];

/// `titleEndsMidWord`.
fn title_ends_mid_word(title: &str) -> bool {
    let trimmed = trim(title);
    if trimmed.is_empty() || trimmed.ends_with(['-', '–', '—', '/', ',', ';', ':', '…']) {
        return true;
    }
    let last = trimmed
        .split(spine::js_space)
        .next_back()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_alphabetic());
    if last.len() < 2 || !last.chars().any(|c| "aeiouyAEIOUY".contains(c)) {
        return true;
    }
    DANGLING_LAST_WORD.contains(&last.to_lowercase().as_str())
}

#[test]
fn titles_are_complete_words_and_match_their_heading() {
    let item = spine::get("foundations-position-sizing").unwrap();
    assert_eq!(item.title, "Position sizing without inventing numbers");
    assert_eq!(
        item.body
            .trim_start_matches(spine::js_space)
            .split('\n')
            .next(),
        Some("# Position sizing without inventing numbers")
    );
    for item in all() {
        assert!(!title_ends_mid_word(&item.title), "{}", item.title);
        let heading = item
            .body
            .trim_start_matches(spine::js_space)
            .split('\n')
            .next()
            .unwrap();
        let heading = heading
            .strip_prefix('#')
            .map_or(heading, |h| h.trim_start_matches(spine::js_space));
        assert_eq!(trim(heading), item.title, "{}", item.slug);
    }
    assert!(title_ends_mid_word("Sizing without"));
    assert!(title_ends_mid_word("Risk sz"));
    assert!(title_ends_mid_word("Risk —"));
}

// ── coach-spine.test.ts ─────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn coach_spine_lists_slug_and_title_for_every_row_and_never_a_body() {
    let payload = links::coach_spine_json();
    assert_eq!(
        payload.get("licensedLibraryImported"),
        Some(&Json::Bool(false))
    );
    assert_eq!(payload.get("source"), Some(&Json::str("platform-spine")));
    let Some(Json::Array(items)) = payload.get("items") else {
        panic!()
    };
    assert_eq!(items.len(), all().len());
    assert!(!items.is_empty());
    let mut slugs = Vec::new();
    for row in items {
        let Json::Object(fields) = row else { panic!() };
        assert_eq!(
            fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            ["slug", "title"]
        );
        let (Some(Json::String(slug)), Some(Json::String(title))) =
            (row.get("slug"), row.get("title"))
        else {
            panic!()
        };
        assert!(spine::has(slug));
        assert!(!title.is_empty());
        assert_eq!(&spine::get(slug).unwrap().title, title);
        slugs.push(slug.as_str());
    }
    slugs.sort_unstable();
    assert_eq!(slugs, spine::slugs());
    assert!(!slugs.contains(&"not-a-real-deriv-desk-title"));
    assert!(!payload.compact().contains("\"body\""));
}

#[test]
fn coach_spine_pins_licensed_library_imported_false() {
    assert_eq!(
        Json::Bool(links::LICENSED_LIBRARY_IMPORTED),
        Json::Bool(false)
    );
    assert_eq!(
        links::coach_spine_json().get("licensedLibraryImported"),
        Some(&Json::Bool(links::LICENSED_LIBRARY_IMPORTED))
    );
    for flag in [None, Some(false), Some(true)] {
        assert!(!links::resolve_licensed_library_imported(flag));
    }
}

// ── deep-links.test.ts ──────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn deep_links_build_a_path_index_for_every_path() {
    for p in PATHS {
        assert_eq!(
            links::resolve_deep_link(p, None),
            DeepLink::Ok {
                path: p.to_owned(),
                slug: None,
                href: format!("{}/{p}", links::DEEP_LINK_PREFIX)
            }
        );
    }
}

#[test]
fn deep_links_refuse_an_unknown_path_an_unknown_slug_and_a_mismatch() {
    assert!(matches!(
        links::resolve_deep_link("moon", None),
        DeepLink::Refused {
            reason: "unknown_path",
            ..
        }
    ));
    assert!(matches!(
        links::resolve_deep_link("foundations", Some("no-such-item")),
        DeepLink::Refused {
            reason: "unknown_slug",
            ..
        }
    ));
    assert!(matches!(
        links::resolve_deep_link("markets", Some("foundations-risk-first")),
        DeepLink::Refused {
            reason: "path_mismatch",
            ..
        }
    ));
    assert_eq!(
        links::resolve_deep_link("foundations", Some("foundations-risk-first")),
        DeepLink::Ok {
            path: "foundations".to_owned(),
            slug: Some("foundations-risk-first".to_owned()),
            href: format!(
                "{}/foundations/foundations-risk-first",
                links::DEEP_LINK_PREFIX
            )
        }
    );
}

#[test]
fn deep_links_list_paths_with_content_and_resolve_a_slug() {
    let rows = links::path_deep_links();
    assert_eq!(rows.len(), PATHS.len());
    assert!(
        rows.iter()
            .all(|(_, href, n)| *n > 0 && href.starts_with(links::DEEP_LINK_PREFIX))
    );
    assert!(links::deep_links_verified());
    assert_eq!(links::deep_link_for_slug("nope"), None);
    assert_eq!(
        links::deep_link_for_slug("foundations-paper-workbook"),
        Some(format!(
            "{}/foundations/foundations-paper-workbook",
            links::DEEP_LINK_PREFIX
        ))
    );
}

// ── i18n-strategy.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn i18n_defaults_an_empty_or_unknown_locale_to_en_with_fell_back() {
    let r = |l| links::resolve_locale(l);
    assert_eq!(
        r(None),
        links::LocaleResolution {
            requested: None,
            locale: links::DEFAULT_LOCALE,
            fell_back: true
        }
    );
    assert_eq!(
        r(Some("fr")),
        links::LocaleResolution {
            requested: Some("fr".to_owned()),
            locale: "en",
            fell_back: true
        }
    );
    let bad = r(Some("!!"));
    assert!(bad.fell_back && bad.locale == "en");
    assert_eq!(
        r(Some("en")),
        links::LocaleResolution {
            requested: Some("en".to_owned()),
            locale: "en",
            fell_back: false
        }
    );
}

#[test]
fn i18n_never_invents_a_translated_body_and_says_so() {
    // `curriculumBodyForLocale` returns the body unchanged for every locale: the localized read serves the same item
    // fields whatever locale resolves (the golden's `curriculumItemLocalized` answers hold it over the wire).
    assert!(links::i18n_strategy_line().contains("neverInvent=1"));
    assert!(links::i18n_strategy_honest());
}

// ── related.test.ts and reserved-slugs.ts ───────────────────────────────────────────────────────────────────────────

#[test]
fn reserved_tab_slugs_refuse_in_any_case_or_spacing() {
    for slug in RESERVED_TAB_SLUGS {
        assert_eq!(
            code(spine::assert_slug_not_reserved(slug)).as_deref(),
            Some("academy.slug_reserved")
        );
    }
    assert_eq!(
        code(spine::assert_slug_not_reserved("Rooms")).as_deref(),
        Some("academy.slug_reserved")
    );
    assert_eq!(
        code(spine::assert_slug_not_reserved(" videos ")).as_deref(),
        Some("academy.slug_reserved")
    );
    assert_eq!(code(spine::assert_slug_not_reserved("rooms-101")), None);
    assert!(message(spine::assert_no_reserved_slugs(["ok", "rooms"])).contains("rooms"));
    assert_eq!(
        code(spine::assert_no_reserved_slugs(["ok", "rooms"])).as_deref(),
        Some("academy.slug_reserved")
    );
    assert!(
        !all()
            .iter()
            .any(|i| RESERVED_TAB_SLUGS.contains(&i.slug.as_str()))
    );
    assert_eq!(spine::check(), Ok(()));
}

#[test]
fn related_returns_same_path_items_without_the_item_capped_by_the_limit() {
    let f = first();
    let out = spine::related(&f.slug, 50).unwrap();
    assert_eq!(out.len(), spine::list(Some(&f.path), None).len() - 1);
    assert!(out.iter().all(|i| i.path == f.path && i.slug != f.slug));
    assert!(spine::related(&f.slug, 1).unwrap().len() <= 1);
    assert_eq!(
        code(spine::related("no-such-slug", 5)).as_deref(),
        Some("academy.curriculum_not_found")
    );
}

#[test]
fn page_limit_refuses_a_blank_or_sub_one_size_and_caps_at_200() {
    let unset = Some("academy.curriculum_list_limit_unset");
    assert_eq!(code(spine::page_limit(None)).as_deref(), unset);
    assert_eq!(code(spine::page_limit(Some(0.5))).as_deref(), unset);
    assert_eq!(code(spine::page_limit(Some(-1.0))).as_deref(), unset);
    assert_eq!(spine::page_limit(Some(1.7)).unwrap(), 1);
    assert_eq!(spine::page_limit(Some(1e9)).unwrap(), 200);
}

// ── lesson-substance.test.ts ────────────────────────────────────────────────────────────────────────────────────────

const OBJECTIVES: [&str; 2] = [
    "State the maximum you are willing to lose on an idea before you look at the entry.",
    "Derive position size from an invalidation level rather than from conviction.",
];

fn objectives() -> Json {
    Json::Array(OBJECTIVES.iter().map(|o| Json::str(*o)).collect())
}

/// `uniqueProse(seed)`.
fn unique_prose(seed: &str) -> String {
    let clauses = [
        "Risk is chosen before the market decides whether the idea was right.",
        "Size is the arithmetic that keeps an accepted loss from becoming a larger one.",
        "Invalidation is a level that proves the idea wrong, not a feeling after entry.",
        "Leverage changes margin required to hold; it does not change loss over distance.",
        "A daily loss prompt is a brake set before the day it binds.",
        "Empty books stay empty; invented depth is a lie dressed as pedagogy.",
        "Paper practice belongs on the paper market path, never relabelled as live.",
        "Certification and XP belong to the certs surface, not this import bar.",
        "A quote is a moment rather than a promise of a fill at that size.",
        "Guardrails are defaults you may raise, never ignore quietly under pressure.",
    ];
    (0..12)
        .map(|i| format!("{} ({seed} {}).", clauses[i % clauses.len()], i + 1))
        .collect::<Vec<_>>()
        .join(" ")
}

fn summary_record(
    slug: &str,
    title: &str,
    kind: &str,
    order: i64,
    body: &str,
    objectives: Option<Json>,
) -> Json {
    let mut fields = vec![
        ("slug", Json::str(slug)),
        ("title", Json::str(title)),
        ("kind", Json::str(kind)),
        ("path", Json::str("foundations")),
        ("order", Json::int(order)),
        (
            "summary",
            Json::str("Summary long enough to pass the twelve character floor."),
        ),
        ("body", Json::str(body)),
    ];
    if let Some(o) = objectives {
        fields.push(("objectives", o));
    }
    record(&fields)
}

#[test]
fn substance_refuses_empty_and_whitespace_by_name() {
    assert_eq!(codes(&substance::checklist("", None)), [substance::EMPTY]);
    assert_eq!(
        codes(&substance::checklist(" \n\t  ", None)),
        [substance::WHITESPACE]
    );
}

#[test]
fn substance_refuses_length_padded_junk_even_over_the_char_floor() {
    let pad = "Depth floor requires real teaching prose, not a three-bullet stub. ".repeat(20);
    let body = format!("# Pad\n\n{pad}\n## Section two\n\n{pad}\n## Section three\n\n{pad}");
    assert!(js_len(trim(&body)) >= MIN_BODY_CHARS);
    assert!(
        codes(&substance::checklist(&body, Some(&objectives()))).contains(&substance::PADDED_JUNK)
    );
    assert!(
        !substance::validate_record(&summary_record(
            "pad-junk",
            "Pad junk",
            "playbook",
            1,
            &body,
            Some(objectives())
        ))
        .ok
    );
}

#[test]
fn substance_refuses_a_unique_wall_without_sections() {
    let body = format!(
        "# Only a title\n\n{}\n\n{}",
        unique_prose("wall"),
        unique_prose("more")
    );
    assert_eq!(substance::count_sections(&body), 0);
    assert!(js_len(trim(&body)) >= MIN_BODY_CHARS);
    assert!(
        codes(&substance::checklist(&body, Some(&objectives())))
            .contains(&substance::MISSING_SECTIONS)
    );
}

#[test]
fn substance_refuses_sectioned_prose_without_steps() {
    let body = format!(
        "# Title\n\n{}\n\n## Mechanism\n\n{}\n\n## Mistakes\n\n{}",
        unique_prose("a"),
        unique_prose("b"),
        unique_prose("c")
    );
    assert!(substance::count_sections(&body) >= 2);
    assert_eq!(substance::count_steps(&body), 0);
    assert!(
        codes(&substance::checklist(&body, Some(&objectives())))
            .contains(&substance::MISSING_STEPS)
    );
}

#[test]
fn substance_refuses_a_structured_body_without_objectives() {
    let body = format!(
        "# Title\n\n{}\n\n## Mechanism\n\n- Size from invalidation, not from conviction on the day.\n- Write the risk fraction before you look at the entry.\n\n## Mistakes\n\n{}",
        unique_prose("obj"),
        unique_prose("obj2")
    );
    assert!(codes(&substance::checklist(&body, None)).contains(&substance::MISSING_OBJECTIVES));
    assert!(
        !substance::validate_record(&summary_record(
            "no-objectives",
            "No objectives",
            "lesson",
            2,
            &body,
            None
        ))
        .ok
    );
}

#[test]
fn substance_accepts_sections_steps_and_objectives_from_the_field_or_a_heading() {
    let item = first();
    assert_eq!(
        substance::checklist(&item.body, Some(&strings(&item.objectives))),
        Vec::new()
    );
    let with_heading = format!(
        "# Drill\n\n{}\n\n## Objectives\n\n- State the maximum you are willing to lose on an idea first.\n- Derive position size from an invalidation level, not hope.\n\n## Mechanism\n\n- Write the risk fraction before you look at the book.\n- Stop when the daily loss prompt fires, not after.\n\n## Mistakes\n\n{}",
        unique_prose("ok"),
        unique_prose("ok2")
    );
    assert_eq!(substance::checklist(&with_heading, None), Vec::new());
}

// ── import-pipeline.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

fn good() -> Vec<(&'static str, Json)> {
    let pb = spine::get(&spine::list(None, Some("playbook"))[0].slug).unwrap();
    item_record(pb, "foundations-sample-drill", "foundations", 40)
}

fn good_workbook() -> Vec<(&'static str, Json)> {
    let wb = spine::get(&spine::list(None, Some("workbook"))[0].slug).unwrap();
    item_record(wb, "foundations-outline-workbook", "foundations", 50)
}

#[test]
fn import_inventory_reports_the_title_promise_honestly() {
    assert_eq!(substance::CONTENT_SOURCE, "platform-native-expansion");
    let inv = substance::inventory();
    let json = inv.json();
    assert_eq!(
        json.get("titleTarget"),
        Some(&Json::obj([
            (
                "playbooks",
                Json::int(i64::try_from(substance::TITLE_PLAYBOOKS).unwrap())
            ),
            (
                "workbooks",
                Json::int(i64::try_from(substance::TITLE_WORKBOOKS).unwrap())
            ),
        ]))
    );
    assert!(inv.total > 0);
    assert_eq!(inv.playbooks, substance::TITLE_PLAYBOOKS);
    assert_eq!(inv.workbooks, substance::TITLE_WORKBOOKS);
    assert_eq!((inv.residual_playbooks, inv.residual_workbooks), (0, 0));
    assert!(inv.title_promise_met());
}

#[test]
fn import_accepts_a_clean_record_and_refuses_a_bad_path_a_stub_or_a_url() {
    assert!(substance::validate_record(&record(&good())).ok);
    assert!(!substance::validate_record(&with(good(), "path", Json::str("moon"))).ok);
    assert!(!substance::validate_record(&with(good(), "body", Json::str("short"))).ok);
    assert!(
        !substance::validate_record(&with(
            good(),
            "body",
            Json::str("# T\n\nSee https://example.com for more.")
        ))
        .ok
    );
}

#[test]
fn import_accepts_honest_workbooks_and_refuses_painted_live_quotes() {
    assert!(substance::validate_record(&record(&good_workbook())).ok);
    assert!(
        !substance::validate_record(&with(
            good_workbook(),
            "body",
            Json::str("# Bad\n\nLive quote bid: 1.2345 ask: 1.2347 — paint as market.")
        ))
        .ok
    );
    assert!(
        !substance::workbook_live_quote(
            "workbook",
            "x",
            "enough summary text here",
            "# X\n\ncurrent price: 99.5 on the tape"
        )
        .is_empty()
    );
    let pb = spine::get(&spine::list(None, Some("playbook"))[0].slug).unwrap();
    assert!(
        substance::workbook_live_quote("playbook", &pb.title, &pb.summary, &pb.body).is_empty()
    );
}

#[test]
fn import_refuses_empty_whitespace_and_padded_junk_by_name() {
    let has = |v: &substance::Validation, c: &str| v.issues.iter().any(|i| i.code == c);
    assert!(has(
        &substance::validate_record(&with(good(), "body", Json::str(""))),
        substance::EMPTY
    ));
    assert!(has(
        &substance::validate_record(&with(good(), "body", Json::str("   \n\t  "))),
        substance::WHITESPACE
    ));
    let pad = "Depth floor requires real teaching prose, not a three-bullet stub. ".repeat(20);
    let pad = trim(&pad);
    let theater = format!("# Theater pad\n{pad}\n## Worked idea\n{pad}\n## Mistakes\n{pad}\n");
    assert!(js_len(trim(&theater)) >= 900);
    let objectives = good()
        .into_iter()
        .find(|(k, _)| *k == "objectives")
        .unwrap()
        .1;
    assert!(
        codes(&substance::checklist(&theater, Some(&objectives))).contains(&substance::PADDED_JUNK)
    );
    let v = substance::validate_record(&record(&[
        ("slug", Json::str("foundations-theater-pad")),
        ("title", Json::str("Theater pad")),
        ("kind", Json::str("playbook")),
        ("path", Json::str("foundations")),
        ("order", Json::int(99)),
        (
            "summary",
            Json::str("A summary that is long enough to pass the summary floor."),
        ),
        ("body", Json::str(theater)),
        ("objectives", objectives),
    ]));
    assert!(!v.ok);
    assert!(has(&v, substance::PADDED_JUNK));
}

#[test]
fn import_accepts_every_spine_item_with_its_objectives_and_finds_no_theater() {
    for item in all() {
        assert_eq!(
            substance::checklist(&item.body, Some(&strings(&item.objectives))),
            Vec::new(),
            "{}",
            item.slug
        );
    }
    assert!(substance::theater_slugs().is_empty());
}

#[test]
fn import_batch_requires_an_array_and_counts_what_it_accepts() {
    assert!(!substance::validate_batch(&Json::Null).0);
    let batch = substance::validate_batch(&Json::Array(vec![
        record(&good()),
        with(good(), "slug", Json::str("BAD SLUG")),
    ]));
    assert_eq!(batch.1, 1);
    assert!(!batch.0);
    assert_eq!(substance::summarize_batch(&batch), (2, 1, 1, false));
    assert_eq!(
        substance::summarize_batch(&substance::validate_batch(&Json::Array(vec![]))),
        (0, 0, 0, true)
    );
}

#[test]
fn import_stage_status_reports_every_stage_honestly() {
    let s = substance::import_stage_status();
    assert_eq!(s.get("stage1Pipeline"), Some(&Json::Bool(true)));
    assert_eq!(s.get("stage2CatalogExpanded"), Some(&Json::Bool(true)));
    assert_eq!(s.get("titlePromiseMet"), Some(&Json::Bool(true)));
    let polish = s.get("stage3Polish").unwrap();
    for k in ["deepLinksVerified", "i18nStrategyHonest", "ready"] {
        assert_eq!(polish.get(k), Some(&Json::Bool(true)), "{k}");
    }
    assert_eq!(s.get("substanceBarMet"), Some(&Json::Bool(true)));
    assert_eq!(s.get("theaterSlugs"), Some(&Json::Array(vec![])));
}

#[test]
fn import_body_floor_is_the_depth_floor() {
    let body = "# Thin\n\nOnly a few lines of body that stay under the depth floor on purpose.";
    assert!(js_len(trim(body)) < MIN_BODY_CHARS && js_len(trim(body)) >= 40);
    let v = substance::validate_record(&record(&[
        ("slug", Json::str("stub-thin-playbook")),
        ("title", Json::str("Thin stub")),
        ("kind", Json::str("playbook")),
        ("path", Json::str("foundations")),
        ("order", Json::int(10)),
        (
            "summary",
            Json::str("A summary that is long enough to pass."),
        ),
        ("body", Json::str(body)),
    ]));
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.field == "body" && i.message.contains(&MIN_BODY_CHARS.to_string()))
    );
    let item = first();
    assert!(item.body_chars() >= MIN_BODY_CHARS);
    assert!(
        substance::validate_record(&record(&item_record(
            item, &item.slug, &item.path, item.order
        )))
        .ok
    );
}

// ── public-catalogue.test.ts (the pure part; the signed-out release check is in curriculum_release.rs) ─────────────

#[test]
fn public_search_keeps_only_items_whose_title_or_summary_holds_the_query() {
    let word = first().title.split(' ').find(|w| w.len() > 3).unwrap();
    let rows = links::search_public(Some(&word.to_uppercase()), None, None, None, 200);
    assert!(!rows.is_empty());
    for r in &rows {
        assert!(
            format!("{} {}", r.title, r.summary)
                .to_lowercase()
                .contains(&word.to_lowercase())
        );
    }
    assert!(links::search_public(Some("zz-no-such-phrase-zz"), None, None, None, 200).is_empty());
}

#[test]
fn public_search_sorts_by_shipped_order_or_by_title_and_honours_the_page_size() {
    let slugs = |rows: Vec<&Item>| rows.into_iter().map(|r| r.slug.clone()).collect::<Vec<_>>();
    assert_eq!(
        slugs(links::search_public(None, None, None, None, 200)),
        slugs(all())
    );
    let asc: Vec<String> = links::search_public(None, None, None, Some(Sort::NameAsc), 200)
        .iter()
        .map(|r| r.title.clone())
        .collect();
    // `localeCompare(.., 'en')` on these titles agrees with a case-folded comparison.
    let mut sorted = asc.clone();
    sorted.sort_by_key(|t| t.to_lowercase());
    assert_eq!(asc, sorted);
    let desc: Vec<String> = links::search_public(None, None, None, Some(Sort::NameDesc), 200)
        .iter()
        .map(|r| r.title.clone())
        .collect();
    assert_eq!(desc, asc.iter().rev().cloned().collect::<Vec<_>>());
    assert_eq!(links::search_public(None, None, None, None, 2).len(), 2);
    assert!(
        links::search_public(None, Some("markets"), None, None, 200)
            .iter()
            .all(|r| r.path == "markets")
    );
}

fn open(_: &str) -> Result<bool, Refusal> {
    Ok(true)
}

#[test]
fn public_course_lists_a_card_per_course_and_opens_its_syllabus_and_outcomes() {
    let cards = links::public_courses();
    let paths: BTreeSet<&str> = all().iter().map(|r| r.path.as_str()).collect();
    assert_eq!(cards.iter().map(|c| c.0).collect::<BTreeSet<_>>(), paths);
    for (slug, items, _) in &cards {
        assert_eq!(*items, spine::list(Some(slug), None).len());
    }
    let course = links::public_course("foundations", |_| None, open, &BTreeSet::new()).unwrap();
    let Some(Json::Array(syllabus)) = course.get("syllabus") else {
        panic!()
    };
    assert_eq!(
        syllabus
            .iter()
            .map(|r| r.get("slug").cloned().unwrap())
            .collect::<Vec<_>>(),
        spine::list(Some("foundations"), None)
            .iter()
            .map(|r| Json::str(r.slug.clone()))
            .collect::<Vec<_>>()
    );
    assert_eq!(course.get("summary"), Some(&Json::Null));
    assert_eq!(course.get("instructor"), Some(&Json::Null));
    let Some(Json::Array(outcomes)) = course.get("outcomes") else {
        panic!()
    };
    assert!(!outcomes.is_empty());
    assert_eq!(
        outcomes
            .iter()
            .map(Json::compact)
            .collect::<BTreeSet<_>>()
            .len(),
        outcomes.len()
    );
}

#[test]
fn public_course_gives_the_same_not_found_for_an_unknown_course_and_a_lesson_slug() {
    for slug in ["no-such-course", first().slug.as_str()] {
        assert_eq!(
            code(links::public_course(slug, |_| None, open, &BTreeSet::new())).as_deref(),
            Some("academy.course_not_found"),
            "{slug}"
        );
    }
}

#[test]
fn public_course_names_the_certificate_only_when_one_is_published_for_the_path() {
    let named = |p: &str| (p == "foundations").then(|| "Foundations".to_owned());
    let course = links::public_course("foundations", named, open, &BTreeSet::new()).unwrap();
    assert_eq!(course.get("certificate"), Some(&Json::str("Foundations")));
    let other = links::public_courses()
        .into_iter()
        .find(|c| c.0 != "foundations")
        .unwrap();
    let course = links::public_course(other.0, |_| None, open, &BTreeSet::new()).unwrap();
    assert_eq!(course.get("certificate"), Some(&Json::Null));
}

#[test]
fn public_course_keeps_a_gated_lessons_objectives_out_of_the_outcomes_but_the_lesson_in_the_syllabus()
 {
    let gated = spine::list(Some("foundations"), None)[1];
    let course = links::public_course(
        "foundations",
        |_| None,
        |s| Ok(s != gated.slug),
        &BTreeSet::new(),
    )
    .unwrap();
    let Some(Json::Array(syllabus)) = course.get("syllabus") else {
        panic!()
    };
    assert!(
        syllabus
            .iter()
            .any(|r| r.get("slug") == Some(&Json::str(gated.slug.clone())))
    );
    let others: BTreeSet<&str> = spine::list(Some("foundations"), None)
        .into_iter()
        .filter(|r| r.slug != gated.slug)
        .flat_map(|r| r.objectives.iter().map(String::as_str))
        .collect();
    let Some(Json::Array(outcomes)) = course.get("outcomes") else {
        panic!()
    };
    for o in &gated.objectives {
        if !others.contains(o.as_str()) {
            assert!(!outcomes.contains(&Json::str(o.clone())), "{o}");
        }
    }
    // A published quiz makes its row a quiz in the syllabus.
    let quiz: BTreeSet<String> = [gated.slug.clone()].into();
    let course = links::public_course("foundations", |_| None, open, &quiz).unwrap();
    let Some(Json::Array(syllabus)) = course.get("syllabus") else {
        panic!()
    };
    assert!(
        syllabus
            .iter()
            .any(|r| r.get("type") == Some(&Json::str("quiz")))
    );
}
