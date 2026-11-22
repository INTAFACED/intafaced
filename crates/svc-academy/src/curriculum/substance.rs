//! The import bar (`curriculum/lesson-substance.ts` and `import-pipeline.ts`): named refusals for an empty, blank or
//! length-padded body, a body without sections, steps or objectives, a workbook that paints a live quote; the record
//! validator a curriculum import clears; and the inventory and stage status the curriculum calls report over the spine.
//!
//! The TypeScript's regular expressions are matched by hand here, each as JavaScript matches it: `\s` is JavaScript's
//! whitespace, `\b` and `\w` are ASCII, `/i` folds ASCII only, `/m` lines end at `\n`, `\r`, U+2028 and U+2029, and a
//! length is UTF-16 code units.

use std::collections::{BTreeMap, BTreeSet};

use service_kit::json::Json;
use service_kit::s2s::js_length;
use service_kit::schema::js_trim;

use super::spine::{self, MIN_BODY_CHARS, PATHS, js_space};

/// `CURRICULUM_IMPORT_REFUSE`.
pub const EMPTY: &str = "academy.curriculum_empty";
pub const WHITESPACE: &str = "academy.curriculum_whitespace";
pub const PADDED_JUNK: &str = "academy.curriculum_padded_junk";
pub const MISSING_SECTIONS: &str = "academy.curriculum_missing_sections";
pub const MISSING_STEPS: &str = "academy.curriculum_missing_steps";
pub const MISSING_OBJECTIVES: &str = "academy.curriculum_missing_objectives";

const MIN_SECTIONS: usize = 2;
const MIN_STEPS: usize = 2;
const MIN_OBJECTIVES: usize = 2;
const MIN_OBJECTIVE_CHARS: usize = 20;
const MIN_UNIQUE_WORDS: usize = 90;
/// `MIN_UNIQUE_RATIO` = 0.28, compared as 28 / 100.
const MIN_UNIQUE_RATIO: (usize, usize) = (28, 100);
const PAD_LINE_REPEATS: usize = 4;

/// `CURRICULUM_TITLE_PLAYBOOKS`, `CURRICULUM_TITLE_WORKBOOKS`.
pub const TITLE_PLAYBOOKS: usize = 20;
pub const TITLE_WORKBOOKS: usize = 3;
/// `CURRICULUM_CONTENT_SOURCE`.
pub const CONTENT_SOURCE: &str = "platform-native-expansion";

/// One issue: `LessonSubstanceIssue` and `ImportValidationIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub field: String,
    pub code: String,
    pub message: String,
}

fn issue(field: &str, code: &str, message: impl Into<String>) -> Issue {
    Issue {
        field: field.to_owned(),
        code: code.to_owned(),
        message: message.into(),
    }
}

/// `/m`'s line terminators.
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `\w`.
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `classifyEmptyBody`: length 0 is empty, only whitespace is whitespace.
pub fn classify_empty(body: &str) -> Option<&'static str> {
    if body.is_empty() {
        Some(EMPTY)
    } else if js_trim(body).is_empty() {
        Some(WHITESPACE)
    } else {
        None
    }
}

/// `countMarkdownSections`: `/^## .+$/gm`.
pub fn count_sections(body: &str) -> usize {
    body.split(line_terminator)
        .filter(|line| line.starts_with("## ") && line.len() > 3)
        .count()
}

/// `^\s*(?:\d+\.|[-*])\s+\S` on one line.
fn list_line(line: &str) -> bool {
    let rest = line.trim_start_matches(js_space);
    let after_marker = if let Some(r) = rest.strip_prefix(['-', '*']) {
        r
    } else {
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        match rest.get(digits..).and_then(|r| r.strip_prefix('.')) {
            Some(r) if digits > 0 => r,
            _ => return false,
        }
    };
    let spaced = after_marker.trim_start_matches(js_space);
    spaced.len() < after_marker.len() && spaced.chars().next().is_some_and(|c| !js_space(c))
}

/// `^\*\*[^*]{3,}\*\*` on a trimmed line.
fn bold_lead(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("**") else {
        return false;
    };
    let run = rest.find('*').unwrap_or(rest.len());
    let (inner, after) = rest.split_at(run);
    js_length(inner) >= 3 && after.starts_with("**")
}

/// `^## (?:Drill|Step|Checklist)\b` with `/gim`, on one line.
fn named_head(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("## ") else {
        return false;
    };
    ["drill", "step", "checklist"].iter().any(|w| {
        rest.get(..w.len())
            .is_some_and(|h| h.eq_ignore_ascii_case(w))
            && !rest
                .get(w.len()..)
                .and_then(|r| r.chars().next())
                .is_some_and(word)
    })
}

/// `countInstructionalSteps`: list items, bold lead-ins and `## Drill|Step|Checklist` headings.
pub fn count_steps(body: &str) -> usize {
    let list = body.split('\n').filter(|l| list_line(l)).count();
    let bold = body.split('\n').filter(|l| bold_lead(js_trim(l))).count();
    let heads = body
        .split(line_terminator)
        .filter(|l| named_head(l))
        .count();
    list + bold + heads
}

/// `normalizeObjectives`: the strings of a list, trimmed, at least 20 characters.
pub fn normalize_objectives(raw: Option<&Json>) -> Vec<String> {
    let Some(Json::Array(items)) = raw else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| match v {
            Json::String(s) => Some(js_trim(s)),
            _ => None,
        })
        .filter(|t| js_length(t) >= MIN_OBJECTIVE_CHARS)
        .map(str::to_owned)
        .collect()
}

/// How many `#` open a heading of `#{2,3}\s+`, and what follows the whitespace.
fn heading(line: &str) -> Option<&str> {
    let hashes = line.len() - line.trim_start_matches('#').len();
    if !(2..=3).contains(&hashes) {
        return None;
    }
    let after = line.get(hashes..)?;
    let rest = after.trim_start_matches(js_space);
    (rest.len() < after.len()).then_some(rest)
}

/// `/^#{2,3}\s+(learning\s+)?objectives\b/i`.
fn objectives_heading(line: &str) -> bool {
    let Some(rest) = heading(line) else {
        return false;
    };
    let objectives = |r: &str| {
        r.get(..10)
            .is_some_and(|h| h.eq_ignore_ascii_case("objectives"))
            && !r.get(10..).and_then(|r| r.chars().next()).is_some_and(word)
    };
    if objectives(rest) {
        return true;
    }
    match rest.get(..8) {
        Some(h) if h.eq_ignore_ascii_case("learning") => {
            let after = rest.get(8..).unwrap_or("");
            let r = after.trim_start_matches(js_space);
            r.len() < after.len() && objectives(r)
        }
        _ => false,
    }
}

/// `parseObjectivesFromBody`: the bullets under `## Objectives` or `## Learning objectives`, up to the next heading.
pub fn objectives_from_body(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in body.split('\n') {
        let trimmed = js_trim(line);
        if objectives_heading(trimmed) {
            in_block = true;
            continue;
        }
        if in_block
            && heading(trimmed).is_some_and(|r| r.chars().next().is_some_and(|c| !js_space(c)))
        {
            break;
        }
        if !in_block {
            continue;
        }
        // `/^(?:[-*]|\d+\.)\s+(.+\S)/`, then trimmed.
        let after_marker = if let Some(r) = trimmed.strip_prefix(['-', '*']) {
            r
        } else {
            let digits = trimmed.len()
                - trimmed
                    .trim_start_matches(|c: char| c.is_ascii_digit())
                    .len();
            match trimmed.get(digits..).and_then(|r| r.strip_prefix('.')) {
                Some(r) if digits > 0 => r,
                _ => continue,
            }
        };
        let spaced = after_marker.trim_start_matches(js_space);
        if spaced.len() == after_marker.len() {
            continue;
        }
        let segment = spaced.split(line_terminator).next().unwrap_or("");
        let value = js_trim(segment);
        if js_length(value) >= MIN_OBJECTIVE_CHARS {
            out.push(value.to_owned());
        }
    }
    out
}

/// `isLengthPaddedJunk`.
fn padded_junk(body: &str) -> bool {
    let trimmed = js_trim(body);
    let lower = trimmed.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '\''))
        .filter(|w| !w.is_empty())
        .collect();
    let unique: BTreeSet<&str> = words.iter().copied().collect();
    if unique.len() < MIN_UNIQUE_WORDS {
        return true;
    }
    // `unique.size / words.length < 0.28`, in whole numbers.
    if unique.len().saturating_mul(MIN_UNIQUE_RATIO.1)
        < words.len().saturating_mul(MIN_UNIQUE_RATIO.0)
    {
        return true;
    }
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut max_rep = 0;
    for line in trimmed.split('\n') {
        let line = js_trim(line).to_lowercase();
        if js_length(&line) < 48 || line.starts_with('#') {
            continue;
        }
        let n = counts.entry(line).or_default();
        *n += 1;
        max_rep = max_rep.max(*n);
    }
    max_rep >= PAD_LINE_REPEATS
}

/// `lessonSubstanceChecklist(body, { objectives })`.
pub fn checklist(body: &str, objectives: Option<&Json>) -> Vec<Issue> {
    match classify_empty(body) {
        Some(EMPTY) => {
            return vec![issue(
                "body",
                EMPTY,
                "Import body is empty — refuse academy.curriculum_empty",
            )];
        }
        Some(_) => {
            return vec![issue(
                "body",
                WHITESPACE,
                "Import body is whitespace-only — refuse academy.curriculum_whitespace",
            )];
        }
        None => {}
    }
    let mut issues = Vec::new();
    let trimmed = js_trim(body);
    if padded_junk(trimmed) {
        issues.push(issue(
            "body",
            PADDED_JUNK,
            "Import body is length-padded junk — refuse academy.curriculum_padded_junk (char-count theater)",
        ));
    }
    if count_sections(trimmed) < MIN_SECTIONS {
        issues.push(issue(
            "body",
            MISSING_SECTIONS,
            format!("Body needs ≥{MIN_SECTIONS} ## sections — refuse academy.curriculum_missing_sections"),
        ));
    }
    if count_steps(trimmed) < MIN_STEPS {
        issues.push(issue(
            "body",
            MISSING_STEPS,
            format!(
                "Body needs ≥{MIN_STEPS} instructional steps (list items) — refuse academy.curriculum_missing_steps"
            ),
        ));
    }
    let from_field = normalize_objectives(objectives);
    let objectives = if from_field.len() >= MIN_OBJECTIVES {
        from_field
    } else {
        objectives_from_body(trimmed)
    };
    if objectives.len() < MIN_OBJECTIVES {
        issues.push(issue(
            "objectives",
            MISSING_OBJECTIVES,
            format!(
                "Import needs ≥{MIN_OBJECTIVES} checkable objectives — refuse academy.curriculum_missing_objectives"
            ),
        ));
    }
    issues
}

/// One step of a hand-matched pattern.
enum Tok<'a> {
    /// `\b`.
    Boundary,
    /// A literal, folded as `/i` folds it.
    Lit(&'a str),
    /// One of several literals.
    Either(&'a [&'a str]),
    /// `\s*` (0) or `\s+` (1).
    Spaces(usize),
    /// ` *`: literal spaces.
    Blanks,
    /// One of these characters.
    OneOf(&'a [char]),
    /// An optional character.
    Opt(char),
    /// `\d+`.
    Digits,
}

/// Whether `pattern` matches `text` anywhere (`RegExp.prototype.test` with `/i`). Each step is greedy and the steps
/// meet on disjoint characters, so no backtracking is needed.
fn search(text: &str, pattern: &[Tok<'_>]) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let boundary = |i: usize| {
        let before = i.checked_sub(1).and_then(at).is_some_and(word);
        let after = at(i).is_some_and(word);
        before != after
    };
    let lit = |i: usize, w: &str| {
        let n = w.chars().count();
        let ok = w
            .chars()
            .enumerate()
            .all(|(k, c)| at(i + k).is_some_and(|t| t.eq_ignore_ascii_case(&c)));
        ok.then_some(i + n)
    };
    (0..=chars.len()).any(|start| {
        let mut i = start;
        for tok in pattern {
            match tok {
                Tok::Boundary => {
                    if !boundary(i) {
                        return false;
                    }
                }
                Tok::Lit(w) => match lit(i, w) {
                    Some(j) => i = j,
                    None => return false,
                },
                Tok::Either(ws) => match ws.iter().find_map(|w| lit(i, w)) {
                    Some(j) => i = j,
                    None => return false,
                },
                Tok::Spaces(min) => {
                    let from = i;
                    while at(i).is_some_and(js_space) {
                        i += 1;
                    }
                    if i - from < *min {
                        return false;
                    }
                }
                Tok::Blanks => {
                    while at(i) == Some(' ') {
                        i += 1;
                    }
                }
                Tok::OneOf(set) => {
                    if at(i).is_some_and(|c| set.contains(&c)) {
                        i += 1;
                    } else {
                        return false;
                    }
                }
                Tok::Opt(c) => {
                    if at(i) == Some(*c) {
                        i += 1;
                    }
                }
                Tok::Digits => {
                    let from = i;
                    while at(i).is_some_and(|c| c.is_ascii_digit()) {
                        i += 1;
                    }
                    if i == from {
                        return false;
                    }
                }
            }
        }
        true
    })
}

/// `workbookLiveQuoteChecklist`: a workbook never paints a live quote.
pub fn workbook_live_quote(kind: &str, title: &str, summary: &str, body: &str) -> Vec<Issue> {
    use Tok::{Boundary, Digits, Either, Lit, OneOf, Opt, Spaces};
    if kind != "workbook" {
        return Vec::new();
    }
    let blob = format!("{title}\n{summary}\n{body}");
    let mut issues = Vec::new();
    if search(
        &blob,
        &[Boundary, Lit("live"), Spaces(1), Lit("quote"), Boundary],
    ) || search(
        &blob,
        &[Boundary, Lit("live"), Spaces(1), Lit("ticker"), Boundary],
    ) {
        issues.push(issue(
            "body",
            "invalid",
            "Workbook must not claim a live quote/ticker — paper drills use trade paper flags, never painted live quotes",
        ));
    }
    let price = |words: &[&str], gap: usize| {
        let mut p = vec![Boundary, Either(words)];
        if gap > 0 {
            p.extend([Spaces(1), Lit("price")]);
        }
        p.extend([Spaces(0), OneOf(&[':', '=']), Spaces(0), Opt('$'), Digits]);
        search(&blob, &p)
    };
    if price(&["bid", "ask", "last", "mid"], 0) {
        issues.push(issue(
            "body",
            "invalid",
            "Workbook must not embed bid/ask/last/mid prices as live quotes",
        ));
    }
    if price(&["current"], 1) || price(&["spot"], 1) {
        issues.push(issue(
            "body",
            "invalid",
            "Workbook must not paint a current/spot price as a live market quote",
        ));
    }
    issues
}

/// `brandChecklist`: no outbound link, no placeholder residue, a real summary, a markdown body over the depth floor
/// with real substance, and for a workbook no painted quote.
pub fn brand_checklist(
    kind: Option<&str>,
    title: &str,
    summary: &str,
    body: &str,
    objectives: Option<&Json>,
) -> Vec<Issue> {
    use Tok::{Blanks, Boundary, Lit};
    let mut issues = Vec::new();
    let blob = format!("{title}\n{summary}\n{body}");
    if blob.contains("http://") || blob.contains("https://") {
        issues.push(issue(
            "body",
            "brand",
            "Import bodies must not embed outbound URLs — link policy is platform-owned",
        ));
    }
    if search(
        &blob,
        &[Boundary, Lit("TODO:"), Blanks, Lit("translate"), Boundary],
    ) || search(
        &blob,
        &[Boundary, Lit("FIXME:"), Blanks, Lit("brand"), Boundary],
    ) {
        issues.push(issue(
            "body",
            "brand",
            "Import still carries brand/translate placeholders — rewrite before merge",
        ));
    }
    if js_trim(title).is_empty() || js_length(js_trim(summary)) < 12 {
        issues.push(issue(
            "summary",
            "invalid",
            "Title required; summary min 12 characters (no empty stubs painted complete)",
        ));
    }
    match classify_empty(body) {
        Some(EMPTY) => issues.push(issue("body", EMPTY, "Import body is empty — refuse academy.curriculum_empty")),
        Some(_) => issues.push(issue(
            "body",
            WHITESPACE,
            "Import body is whitespace-only — refuse academy.curriculum_whitespace",
        )),
        None if !body.trim_start_matches(js_space).starts_with('#') => {
            issues.push(issue("body", "invalid", "Body must be real markdown (starts with # heading)"));
        }
        None if js_length(js_trim(body)) < MIN_BODY_CHARS => issues.push(issue(
            "body",
            "invalid",
            format!(
                "Body must clear depth floor (≥{MIN_BODY_CHARS} chars) — the old 40-char import bar let stubs re-enter"
            ),
        )),
        None => issues.extend(checklist(body, objectives)),
    }
    if kind == Some("workbook") {
        issues.extend(workbook_live_quote("workbook", title, summary, body));
    }
    issues
}

/// `SLUG_RE`: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
fn slug_shape(slug: &str) -> bool {
    !slug.is_empty()
        && slug.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `ImportValidationResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Validation {
    pub ok: bool,
    pub issues: Vec<Issue>,
}

/// `validateImportRecord(raw)`.
pub fn validate_record(raw: &Json) -> Validation {
    let fields: &[(String, Json)] = match raw {
        Json::Object(f) => f,
        Json::Array(_) => &[],
        _ => {
            return Validation {
                ok: false,
                issues: vec![issue("_", "invalid", "Import record must be an object")],
            };
        }
    };
    let get = |k: &str| {
        fields
            .iter()
            .rev()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v)
    };
    let string = |k: &str| match get(k) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    };
    let mut issues = Vec::new();
    let slug = string("slug").unwrap_or("");
    if !slug_shape(slug) || js_length(slug) > 120 {
        issues.push(issue(
            "slug",
            "invalid",
            "slug: lowercase alphanumeric + hyphen, max 120",
        ));
    }
    let kind = string("kind").filter(|k| spine::KINDS.contains(k));
    if kind.is_none() {
        issues.push(issue(
            "kind",
            "invalid",
            "kind must be playbook|workbook|lesson",
        ));
    }
    if !string("path").is_some_and(|p| PATHS.contains(&p)) {
        issues.push(issue(
            "path",
            "path",
            format!("path must be one of {}", PATHS.join("|")),
        ));
    }
    let order_ok = match get("order") {
        Some(Json::Number(n)) => n.fract() == 0.0 && *n >= 0.0 && *n <= 10_000.0,
        _ => false,
    };
    if !order_ok {
        issues.push(issue("order", "invalid", "order must be integer 0…10000"));
    }
    let (title, summary, body) = (string("title"), string("summary"), string("body"));
    if title.is_none() {
        issues.push(issue("title", "missing", "title required"));
    }
    if summary.is_none() {
        issues.push(issue("summary", "missing", "summary required"));
    }
    if body.is_none() {
        issues.push(issue("body", "missing", "body required"));
    }
    if let (true, Some(title), Some(summary), Some(body)) =
        (issues.is_empty(), title, summary, body)
    {
        let objectives = get("objectives").filter(|o| matches!(o, Json::Array(_)));
        issues.extend(brand_checklist(kind, title, summary, body, objectives));
    }
    Validation {
        ok: issues.is_empty(),
        issues,
    }
}

/// `validateImportBatch(raw)`: ok, accepted, and each record's result.
pub fn validate_batch(raw: &Json) -> (bool, usize, Vec<Validation>) {
    let Json::Array(records) = raw else {
        return (
            false,
            0,
            vec![Validation {
                ok: false,
                issues: vec![issue("_", "invalid", "Import batch must be a JSON array")],
            }],
        );
    };
    let results: Vec<Validation> = records.iter().map(validate_record).collect();
    let accepted = results.iter().filter(|r| r.ok).count();
    (results.iter().all(|r| r.ok), accepted, results)
}

/// `summarizeImportBatch`: total, accepted, rejected, ok.
pub fn summarize_batch(batch: &(bool, usize, Vec<Validation>)) -> (usize, usize, usize, bool) {
    let total = batch.2.len();
    (total, batch.1, total.saturating_sub(batch.1), batch.0)
}

/// `curriculumInventory`: the spine's counts against the title promise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inventory {
    pub total: usize,
    pub playbooks: usize,
    pub workbooks: usize,
    pub lessons: usize,
    pub residual_playbooks: usize,
    pub residual_workbooks: usize,
}

impl Inventory {
    pub fn title_promise_met(&self) -> bool {
        self.residual_playbooks == 0 && self.residual_workbooks == 0
    }

    /// `curriculumInventoryOut`.
    pub fn json(&self) -> Json {
        let n = |v: usize| Json::int(i64::try_from(v).unwrap_or(i64::MAX));
        Json::obj([
            ("contentSource", Json::str(CONTENT_SOURCE)),
            (
                "spine",
                Json::obj([
                    ("total", n(self.total)),
                    ("playbooks", n(self.playbooks)),
                    ("workbooks", n(self.workbooks)),
                    ("lessons", n(self.lessons)),
                ]),
            ),
            (
                "titleTarget",
                Json::obj([
                    ("playbooks", n(TITLE_PLAYBOOKS)),
                    ("workbooks", n(TITLE_WORKBOOKS)),
                ]),
            ),
            ("titlePromiseMet", Json::Bool(self.title_promise_met())),
            ("residualPlaybooks", n(self.residual_playbooks)),
            ("residualWorkbooks", n(self.residual_workbooks)),
        ])
    }
}

pub fn inventory() -> Inventory {
    let all = spine::list(None, None);
    let count = |k: &str| all.iter().filter(|i| i.kind == k).count();
    let (playbooks, workbooks, lessons) = (count("playbook"), count("workbook"), count("lesson"));
    Inventory {
        total: all.len(),
        playbooks,
        workbooks,
        lessons,
        residual_playbooks: TITLE_PLAYBOOKS.saturating_sub(playbooks),
        residual_workbooks: TITLE_WORKBOOKS.saturating_sub(workbooks),
    }
}

/// `curriculumSubstanceReport().theaterSlugs`: every spine item whose body and objectives fail the import bar, sorted.
pub fn theater_slugs() -> Vec<String> {
    let mut failing: Vec<String> = spine::list(None, None)
        .into_iter()
        .filter(|item| {
            let objectives = Json::Array(
                item.objectives
                    .iter()
                    .map(|o| Json::str(o.clone()))
                    .collect(),
            );
            !checklist(&item.body, Some(&objectives)).is_empty()
        })
        .map(|item| item.slug.clone())
        .collect();
    failing.sort_unstable();
    failing
}

/// `curriculumImportStageStatus` as `curriculumImportStatusOut` writes it.
pub fn import_stage_status() -> Json {
    let inv = inventory();
    let deep_links = super::links::deep_links_verified();
    let i18n = super::links::i18n_strategy_honest();
    let theater = theater_slugs();
    Json::obj([
        ("contentSource", Json::str(CONTENT_SOURCE)),
        ("titlePromiseMet", Json::Bool(inv.title_promise_met())),
        (
            "residualPlaybooks",
            Json::int(i64::try_from(inv.residual_playbooks).unwrap_or(i64::MAX)),
        ),
        (
            "residualWorkbooks",
            Json::int(i64::try_from(inv.residual_workbooks).unwrap_or(i64::MAX)),
        ),
        ("stage1Pipeline", Json::Bool(true)),
        ("stage2CatalogExpanded", Json::Bool(inv.title_promise_met())),
        (
            "stage3Polish",
            Json::obj([
                ("deepLinksVerified", Json::Bool(deep_links)),
                ("i18nStrategyHonest", Json::Bool(i18n)),
                ("ready", Json::Bool(deep_links && i18n)),
            ]),
        ),
        ("substanceBarMet", Json::Bool(theater.is_empty())),
        (
            "theaterSlugs",
            Json::Array(theater.into_iter().map(Json::String).collect()),
        ),
    ])
}
