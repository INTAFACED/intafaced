//! The workbook drill loop (`paper/workbook-loop.ts`): a pure state machine over a paper market trade flagged. It
//! never invents fills, prices or balances, a live market refuses the drill, and every projection of a run carries the
//! fact that it is simulated. Academy holds no run state: a caller replays its steps and fills
//! ([`replay_paper_drill`]) and gets the same refusals, in the same order, as the step-by-step path.
//!
//! The projections below the loop (labels, cards, pages, exports, status lines) are ported with it, number for
//! number: ratios are `toFixed(4)` of the double, percents `Math.round`.

use service_kit::money::is_js_whitespace;
use service_kit::schema::{Value, js_trim};
use service_kit::time::Instant;

use crate::errors::{AcademyError, Refusal};

/// `PaperMarketRef`: trade's flag for a market. `paper` must be true; false refuses the drill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperMarketRef {
    pub market_id: String,
    pub paper: bool,
    pub symbol: String,
}

/// `DrillStep`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillStep {
    pub id: String,
    pub instruction: String,
}

/// `PaperFillRef`: a fill trade supplied; `side`, `price` and `size` are kept exactly as trade published them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperFillRef {
    pub fill_id: String,
    pub market_id: String,
    pub recorded_at: Instant,
    pub side: Option<String>,
    pub price: Option<String>,
    pub size: Option<String>,
}

/// `DrillRun['status']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrillStatus {
    Active,
    Complete,
    Refused,
}

impl DrillStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DrillStatus::Active => "active",
            DrillStatus::Complete => "complete",
            DrillStatus::Refused => "refused",
        }
    }
}

/// Why a drill refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefuseReason {
    NotPaper,
    NoMarket,
    UnknownStep,
    BadFill,
}

impl RefuseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RefuseReason::NotPaper => "not_paper",
            RefuseReason::NoMarket => "no_market",
            RefuseReason::UnknownStep => "unknown_step",
            RefuseReason::BadFill => "bad_fill",
        }
    }
}

/// `DrillRun`. `simulated` is always true: [`start_paper_drill`] is its only producer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillRun {
    pub workbook_slug: String,
    pub market_id: String,
    pub symbol: String,
    pub steps: Vec<DrillStep>,
    pub completed_step_ids: Vec<String>,
    pub status: DrillStatus,
    pub refuse_reason: Option<RefuseReason>,
    pub fill_refs: Vec<PaperFillRef>,
    pub simulated: bool,
}

/// `DrillResult`'s refused branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillRefused {
    pub reason: RefuseReason,
    pub message: String,
}

/// `DrillResult`.
pub type DrillResult = Result<DrillRun, DrillRefused>;

fn refused(reason: RefuseReason, message: impl Into<String>) -> DrillResult {
    Err(DrillRefused {
        reason,
        message: message.into(),
    })
}

/// `FOUNDATIONS_PAPER_STEPS`.
pub fn foundations_paper_steps() -> Vec<DrillStep> {
    [
        (
            "size-from-invalidation",
            "Size a risk-first entry from an invalidation level (paper only).",
        ),
        (
            "limit-cancel",
            "Place a limit that does not fill; cancel cleanly (paper only).",
        ),
        (
            "prewritten-stop",
            "Hit a stop you wrote before entry (paper only).",
        ),
    ]
    .iter()
    .map(|(id, instruction)| DrillStep {
        id: (*id).to_owned(),
        instruction: (*instruction).to_owned(),
    })
    .collect()
}

/// `startPaperDrill`: a live or missing market refuses.
pub fn start_paper_drill(
    workbook_slug: &str,
    market: Option<&PaperMarketRef>,
    steps: Option<&[DrillStep]>,
) -> DrillResult {
    let Some(market) = market else {
        return refused(
            RefuseReason::NoMarket,
            "No market ref — refuse paper drill (fail closed).",
        );
    };
    if !market.paper {
        return refused(
            RefuseReason::NotPaper,
            format!(
                "Market {} is not paper — refuse drill (no live risk).",
                market.market_id
            ),
        );
    }
    Ok(DrillRun {
        workbook_slug: workbook_slug.to_owned(),
        market_id: market.market_id.clone(),
        symbol: market.symbol.clone(),
        steps: steps.map_or_else(foundations_paper_steps, <[DrillStep]>::to_vec),
        completed_step_ids: Vec::new(),
        status: DrillStatus::Active,
        refuse_reason: None,
        fill_refs: Vec::new(),
        simulated: true,
    })
}

fn already_refused(run: &DrillRun) -> DrillResult {
    refused(
        run.refuse_reason.unwrap_or(RefuseReason::NotPaper),
        "Run already refused.",
    )
}

/// `completeDrillStep`: an unknown step refuses; a step done twice counts once.
pub fn complete_drill_step(run: &DrillRun, step_id: &str) -> DrillResult {
    if run.status == DrillStatus::Refused {
        return already_refused(run);
    }
    if !run.steps.iter().any(|s| s.id == step_id) {
        return refused(RefuseReason::UnknownStep, format!("Unknown step {step_id}"));
    }
    if run.completed_step_ids.iter().any(|id| id == step_id) {
        return Ok(run.clone());
    }
    let mut next = run.clone();
    next.completed_step_ids.push(step_id.to_owned());
    next.status = if next.completed_step_ids.len() >= run.steps.len() {
        DrillStatus::Complete
    } else {
        DrillStatus::Active
    };
    Ok(next)
}

/// JavaScript's `typeof`.
fn js_typeof(v: &Value) -> &'static str {
    match v {
        Value::Undefined => "undefined",
        Value::Null | Value::Array(_) | Value::Object(_) | Value::Date(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

/// `publishedDecimal(raw)`: `^\d+(\.\d+)?$` after trim, or why not.
fn published_decimal(raw: &Value) -> Result<String, String> {
    let Some(text) = raw.as_str() else {
        return Err(format!("must be a decimal string, got {}", js_typeof(raw)));
    };
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return Err("must not be blank".to_owned());
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let ok = match trimmed.split_once('.') {
        Some((whole, frac)) => digits(whole) && digits(frac),
        None => digits(trimmed),
    };
    if !ok {
        return Err(format!(
            "\"{trimmed}\" is not a non-negative decimal string"
        ));
    }
    Ok(trimmed.to_owned())
}

/// A fill as a caller hands it in: `side`, `price` and `size` as they arrived (`Undefined` when absent).
#[derive(Debug, Clone, PartialEq)]
pub struct FillIn {
    pub fill_id: String,
    pub market_id: String,
    pub recorded_at: Option<Instant>,
    pub side: Value,
    pub price: Value,
    pub size: Value,
}

impl FillIn {
    /// A fill with only its id and market.
    pub fn bare(fill_id: &str, market_id: &str) -> FillIn {
        FillIn {
            fill_id: fill_id.to_owned(),
            market_id: market_id.to_owned(),
            recorded_at: None,
            side: Value::Undefined,
            price: Value::Undefined,
            size: Value::Undefined,
        }
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `attachPaperFillRef`: idempotent on fillId; a wrong side, price or size refuses, an absent one does not.
pub fn attach_paper_fill_ref(run: &DrillRun, input: &FillIn) -> DrillResult {
    if run.status == DrillStatus::Refused {
        return already_refused(run);
    }
    let fill_id = js_trim(&input.fill_id).to_owned();
    let n = utf16_len(&fill_id);
    if !(1..=128).contains(&n) {
        return refused(
            RefuseReason::BadFill,
            "fillId required (1–128 chars) — no invent fill.",
        );
    }
    if js_trim(&input.market_id).is_empty() {
        return refused(RefuseReason::BadFill, "marketId required on fill ref.");
    }
    if input.market_id != run.market_id {
        return refused(
            RefuseReason::BadFill,
            format!(
                "Fill market {} does not match drill market {}",
                input.market_id, run.market_id
            ),
        );
    }

    let side = match &input.side {
        Value::Undefined => None,
        Value::String(s) if s == "buy" || s == "sell" => Some(s.clone()),
        _ => {
            return refused(
                RefuseReason::BadFill,
                format!("Fill {fill_id}: side must be \"buy\" or \"sell\"."),
            );
        }
    };
    let price = match &input.price {
        Value::Undefined => None,
        raw => match published_decimal(raw) {
            Ok(v) => Some(v),
            Err(why) => {
                return refused(
                    RefuseReason::BadFill,
                    format!("Fill {fill_id}: price {why}."),
                );
            }
        },
    };
    let size = match &input.size {
        Value::Undefined => None,
        raw => match published_decimal(raw) {
            Ok(v) => Some(v),
            Err(why) => {
                return refused(
                    RefuseReason::BadFill,
                    format!("Fill {fill_id}: size {why}."),
                );
            }
        },
    };

    if let Some(existing) = run.fill_refs.iter().find(|f| f.fill_id == fill_id) {
        if existing.market_id != input.market_id {
            return refused(
                RefuseReason::BadFill,
                format!("Fill {fill_id}: marketId conflicts with prior attach"),
            );
        }
        let conflicts = |new: &Option<String>, old: &Option<String>| matches!((new, old), (Some(a), Some(b)) if a != b);
        if conflicts(&side, &existing.side) {
            return refused(
                RefuseReason::BadFill,
                format!("Fill {fill_id}: side conflicts with prior attach"),
            );
        }
        if conflicts(&price, &existing.price) {
            return refused(
                RefuseReason::BadFill,
                format!("Fill {fill_id}: price conflicts with prior attach"),
            );
        }
        if conflicts(&size, &existing.size) {
            return refused(
                RefuseReason::BadFill,
                format!("Fill {fill_id}: size conflicts with prior attach"),
            );
        }
        return Ok(run.clone());
    }
    // `...(price ? { price } : {})`: an empty string is falsy and left off (never reachable: a published decimal is
    // never blank).
    let keep = |v: Option<String>| v.filter(|s| !s.is_empty());
    let mut next = run.clone();
    next.fill_refs.push(PaperFillRef {
        fill_id,
        market_id: input.market_id.clone(),
        recorded_at: input.recorded_at.unwrap_or_else(crate::door::system_now),
        side: keep(side),
        price: keep(price),
        size: keep(size),
    });
    Ok(next)
}

/// `replayPaperDrill`: the whole drill from the caller's record of it; a refusal anywhere is the replay's result.
pub fn replay_paper_drill(
    slug: &str,
    kind: Option<&str>,
    market: Option<&PaperMarketRef>,
    completed_step_ids: &[String],
    fills: &[FillIn],
    steps: Option<&[DrillStep]>,
) -> DrillResult {
    let mut run = start_paper_drill_for_catalog_item(slug, kind, market, steps)?;
    for step_id in completed_step_ids {
        run = complete_drill_step(&run, step_id)?;
    }
    for fill in fills {
        run = attach_paper_fill_ref(&run, fill)?;
    }
    Ok(run)
}

/// `listPaperFillRefs`.
pub fn list_paper_fill_refs(run: &DrillRun) -> &[PaperFillRef] {
    &run.fill_refs
}

/// `DrillProgress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillProgress {
    pub simulated: bool,
    pub real_money: bool,
    pub workbook_slug: String,
    pub status: DrillStatus,
    pub step_count: usize,
    pub completed_count: usize,
    pub ratio: String,
    pub fill_count: usize,
}

#[expect(
    clippy::cast_precision_loss,
    reason = "step counts are tiny; the TypeScript divides doubles"
)]
fn as_f64(n: usize) -> f64 {
    n as f64
}

/// `x.toFixed(digits)` for a finite, non-negative double below 1e21: the exact value rounded half up (ties to the
/// larger), as ECMAScript's `Number.prototype.toFixed` does.
pub fn to_fixed(x: f64, digits: usize) -> String {
    let exact = format!("{x:.1100}");
    let (whole, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(frac.bytes().take(digits)).collect();
    let next = frac.as_bytes().get(digits).copied().unwrap_or(b'0');
    if next >= b'5' {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            match kept.get_mut(i) {
                Some(d) if *d == b'9' => *d = b'0',
                Some(d) => {
                    *d += 1;
                    break;
                }
                None => break,
            }
        }
    }
    let split = kept.len() - digits;
    let text = String::from_utf8(kept).unwrap_or_default();
    if digits == 0 {
        text
    } else {
        format!("{}.{}", &text[..split], &text[split..])
    }
}

/// `Math.round(x)`: to the nearest integer, ties toward +∞.
#[expect(
    clippy::float_arithmetic,
    reason = "a step-count percent, never money; JavaScript rounds a double"
)]
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `drillProgress`: ratio is `toFixed(4)`; a refused run reports `0.0000`.
#[expect(
    clippy::float_arithmetic,
    reason = "a step-count ratio, never money; JavaScript divides doubles"
)]
pub fn drill_progress(run: &DrillRun) -> DrillProgress {
    let step_count = run.steps.len();
    let completed_count = if run.status == DrillStatus::Refused {
        0
    } else {
        run.completed_step_ids.len()
    };
    let ratio = if step_count == 0 {
        "0.0000".to_owned()
    } else {
        to_fixed(as_f64(completed_count) / as_f64(step_count), 4)
    };
    DrillProgress {
        simulated: true,
        real_money: false,
        workbook_slug: run.workbook_slug.clone(),
        status: run.status,
        step_count,
        completed_count,
        ratio,
        fill_count: run.fill_refs.len(),
    }
}

/// `assertWorkbookKind`: only workbook slugs may start a drill.
pub fn assert_workbook_kind(kind: Option<&str>) -> bool {
    kind == Some("workbook")
}

/// `startPaperDrillForCatalogItem`.
pub fn start_paper_drill_for_catalog_item(
    slug: &str,
    kind: Option<&str>,
    market: Option<&PaperMarketRef>,
    steps: Option<&[DrillStep]>,
) -> DrillResult {
    if !assert_workbook_kind(kind) {
        return refused(
            RefuseReason::UnknownStep,
            format!("Catalog item {slug} is not a workbook — refuse paper drill invent."),
        );
    }
    start_paper_drill(slug, market, steps)
}

/// `remainingStepIds`: a refused run has every step remaining.
pub fn remaining_step_ids(run: &DrillRun) -> Vec<String> {
    run.steps
        .iter()
        .map(|s| s.id.clone())
        .filter(|id| run.status == DrillStatus::Refused || !run.completed_step_ids.contains(id))
        .collect()
}

/// `isDrillComplete`.
pub fn is_drill_complete(run: &DrillRun) -> bool {
    run.status == DrillStatus::Complete && remaining_step_ids(run).is_empty()
}

/// `completedStepCount`: a refused run has done nothing.
pub fn completed_step_count(run: &DrillRun) -> usize {
    if run.status == DrillStatus::Refused {
        0
    } else {
        run.completed_step_ids.len()
    }
}

/// `fillRefCount`.
pub fn fill_ref_count(run: &DrillRun) -> usize {
    run.fill_refs.len()
}

/// `isDrillRefused`.
pub fn is_drill_refused(run: &DrillRun) -> bool {
    run.status == DrillStatus::Refused
}

/// `remainingStepCount`.
pub fn remaining_step_count(run: &DrillRun) -> usize {
    remaining_step_ids(run).len()
}

/// `totalStepCount`.
pub fn total_step_count(run: &DrillRun) -> usize {
    run.steps.len()
}

/// `isDrillInProgress`.
pub fn is_drill_in_progress(run: &DrillRun) -> bool {
    run.status == DrillStatus::Active && !remaining_step_ids(run).is_empty()
}

/// `isDrillStatusComplete`.
pub fn is_drill_status_complete(run: &DrillRun) -> bool {
    run.status == DrillStatus::Complete
}

/// `isDrillStatusActive`.
pub fn is_drill_status_active(run: &DrillRun) -> bool {
    run.status == DrillStatus::Active
}

/// `drillCompletionRatio`.
pub fn drill_completion_ratio(run: &DrillRun) -> String {
    drill_progress(run).ratio
}

/// `drillMarketId`.
pub fn drill_market_id(run: &DrillRun) -> &str {
    &run.market_id
}

/// `hasNoFillRefs`.
pub fn has_no_fill_refs(run: &DrillRun) -> bool {
    run.fill_refs.is_empty()
}

/// `drillSymbol`.
pub fn drill_symbol(run: &DrillRun) -> &str {
    &run.symbol
}

/// `drillWorkbookSlug`.
pub fn drill_workbook_slug(run: &DrillRun) -> &str {
    &run.workbook_slug
}

/// `hasPartialProgress`.
pub fn has_partial_progress(run: &DrillRun) -> bool {
    run.status == DrillStatus::Active
        && completed_step_count(run) > 0
        && remaining_step_count(run) > 0
}

/// `hasFillRefs`.
pub fn has_fill_refs(run: &DrillRun) -> bool {
    !run.fill_refs.is_empty()
}

/// `firstRemainingStepId`.
pub fn first_remaining_step_id(run: &DrillRun) -> Option<String> {
    remaining_step_ids(run).into_iter().next()
}

/// `lastRemainingStepId`.
pub fn last_remaining_step_id(run: &DrillRun) -> Option<String> {
    remaining_step_ids(run).pop()
}

/// `drillCompletionRatioNumber`: `Number(ratio)`.
pub fn drill_completion_ratio_number(run: &DrillRun) -> f64 {
    drill_progress(run).ratio.parse().unwrap_or(f64::NAN)
}

/// `firstCompletedStepId`.
pub fn first_completed_step_id(run: &DrillRun) -> Option<String> {
    run.completed_step_ids.first().cloned()
}

/// `lastCompletedStepId`.
pub fn last_completed_step_id(run: &DrillRun) -> Option<String> {
    run.completed_step_ids.last().cloned()
}

/// `hasNoRemainingSteps`.
pub fn has_no_remaining_steps(run: &DrillRun) -> bool {
    remaining_step_count(run) == 0
}

/// `isStepListEmpty`.
pub fn is_step_list_empty(run: &DrillRun) -> bool {
    run.steps.is_empty()
}

/// `isDrillUntouched`.
pub fn is_drill_untouched(run: &DrillRun) -> bool {
    drill_completion_ratio_number(run) == 0.0 && run.status == DrillStatus::Active
}

/// `isDrillFullyRatioed`.
#[expect(
    clippy::float_cmp,
    reason = "`=== 1` on a parsed ratio, as the TypeScript compares"
)]
pub fn is_drill_fully_ratioed(run: &DrillRun) -> bool {
    drill_completion_ratio_number(run) == 1.0
}

/// `drillCompletionPercent`: `Math.round(ratio * 100)`, UI only.
#[expect(
    clippy::float_arithmetic,
    reason = "a step-count percent, never money; JavaScript multiplies doubles"
)]
pub fn drill_completion_percent(run: &DrillRun) -> f64 {
    js_round(drill_completion_ratio_number(run) * 100.0)
}

/// `remainingStepRatio`.
#[expect(
    clippy::float_arithmetic,
    reason = "a step-count ratio, never money; JavaScript divides doubles"
)]
pub fn remaining_step_ratio(run: &DrillRun) -> String {
    let total = run.steps.len();
    if total == 0 {
        return "0.0000".to_owned();
    }
    to_fixed(as_f64(remaining_step_count(run)) / as_f64(total), 4)
}

/// `String(n)` for a whole number.
fn js_int(n: f64) -> String {
    service_kit::json::js_number_string(n)
}

/// `totalStepCountLabel`.
pub fn total_step_count_label(run: &DrillRun) -> String {
    total_step_count(run).to_string()
}

/// `completedStepCountLabel`.
pub fn completed_step_count_label(run: &DrillRun) -> String {
    completed_step_count(run).to_string()
}

/// `remainingStepCountLabel`.
pub fn remaining_step_count_label(run: &DrillRun) -> String {
    remaining_step_count(run).to_string()
}

/// `fillRefCountLabel`.
pub fn fill_ref_count_label(run: &DrillRun) -> String {
    fill_ref_count(run).to_string()
}

/// `remainingStepIdsJoined`.
pub fn remaining_step_ids_joined(run: &DrillRun) -> String {
    remaining_step_ids(run).join(",")
}

/// `completedStepIdsJoined`.
pub fn completed_step_ids_joined(run: &DrillRun) -> String {
    run.completed_step_ids.join(",")
}

/// `drillStatusLabel`.
pub fn drill_status_label(run: &DrillRun) -> &'static str {
    run.status.as_str()
}

/// `drillRatioLabel`.
pub fn drill_ratio_label(run: &DrillRun) -> String {
    drill_progress(run).ratio
}

/// `drillMarketIdLabel`.
pub fn drill_market_id_label(run: &DrillRun) -> String {
    drill_market_id(run).to_owned()
}

/// `drillSymbolLabel`.
pub fn drill_symbol_label(run: &DrillRun) -> String {
    drill_symbol(run).to_owned()
}

/// `drillWorkbookSlugLabel`.
pub fn drill_workbook_slug_label(run: &DrillRun) -> String {
    drill_workbook_slug(run).to_owned()
}

/// `drillCompletionPercentLabel`.
pub fn drill_completion_percent_label(run: &DrillRun) -> String {
    js_int(drill_completion_percent(run))
}

/// `drillProgressSnapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct DrillProgressSnapshot {
    pub simulated: bool,
    pub real_money: bool,
    pub status: DrillStatus,
    pub total: usize,
    pub completed: usize,
    pub remaining: usize,
    pub ratio: String,
    pub percent: f64,
    pub fills: usize,
}

/// `drillProgressSnapshot`.
pub fn drill_progress_snapshot(run: &DrillRun) -> DrillProgressSnapshot {
    DrillProgressSnapshot {
        simulated: true,
        real_money: false,
        status: run.status,
        total: total_step_count(run),
        completed: completed_step_count(run),
        remaining: remaining_step_count(run),
        ratio: drill_progress(run).ratio,
        percent: drill_completion_percent(run),
        fills: fill_ref_count(run),
    }
}

/// `drillStepCountsConsistent`.
pub fn drill_step_counts_consistent(run: &DrillRun) -> bool {
    let s = drill_progress_snapshot(run);
    s.total == s.completed + s.remaining || run.status == DrillStatus::Refused
}

/// `drillIdentitySnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillIdentitySnapshot {
    pub simulated: bool,
    pub real_money: bool,
    pub market_id: String,
    pub symbol: String,
    pub workbook_slug: String,
}

/// `drillIdentitySnapshot`.
pub fn drill_identity_snapshot(run: &DrillRun) -> DrillIdentitySnapshot {
    DrillIdentitySnapshot {
        simulated: true,
        real_money: false,
        market_id: run.market_id.clone(),
        symbol: run.symbol.clone(),
        workbook_slug: run.workbook_slug.clone(),
    }
}

/// `isFreshActiveDrill`.
pub fn is_fresh_active_drill(run: &DrillRun) -> bool {
    run.status == DrillStatus::Active && completed_step_count(run) == 0
}

/// `drillBoardCard`: `simulated` first, `realMoney` false; every other projection is built from it.
#[derive(Debug, Clone, PartialEq)]
pub struct DrillBoardCard {
    pub simulated: bool,
    pub real_money: bool,
    pub status: DrillStatus,
    pub workbook_slug: String,
    pub market_id: String,
    pub symbol: String,
    pub total: usize,
    pub completed: usize,
    pub remaining: usize,
    pub percent: f64,
    pub ratio: String,
    pub fills: usize,
    pub fresh: bool,
    pub complete: bool,
    pub refused: bool,
}

/// `drillBoardCard`.
pub fn drill_board_card(run: &DrillRun) -> DrillBoardCard {
    let snap = drill_progress_snapshot(run);
    DrillBoardCard {
        simulated: run.simulated,
        real_money: false,
        status: snap.status,
        workbook_slug: run.workbook_slug.clone(),
        market_id: run.market_id.clone(),
        symbol: run.symbol.clone(),
        total: snap.total,
        completed: snap.completed,
        remaining: snap.remaining,
        percent: snap.percent,
        ratio: snap.ratio,
        fills: snap.fills,
        fresh: is_fresh_active_drill(run),
        complete: is_drill_complete(run),
        refused: is_drill_refused(run),
    }
}

/// `drillStepBar`.
#[derive(Debug, Clone, PartialEq)]
pub struct DrillStepBar {
    pub simulated: bool,
    pub real_money: bool,
    pub completed: usize,
    pub remaining: usize,
    pub total: usize,
    pub percent: f64,
}

/// `drillStepBar`.
pub fn drill_step_bar(run: &DrillRun) -> DrillStepBar {
    let c = drill_board_card(run);
    DrillStepBar {
        simulated: true,
        real_money: false,
        completed: c.completed,
        remaining: c.remaining,
        total: c.total,
        percent: c.percent,
    }
}

/// `drillCardIsRefused`.
pub fn drill_card_is_refused(run: &DrillRun) -> bool {
    drill_board_card(run).refused
}

/// `drillCardIsFresh`.
pub fn drill_card_is_fresh(run: &DrillRun) -> bool {
    drill_board_card(run).fresh
}

/// `filterRemainingStepIds`: an empty needle finds nothing.
pub fn filter_remaining_step_ids(run: &DrillRun, needle: &str) -> Vec<String> {
    let n = js_trim(needle);
    if n.is_empty() {
        return Vec::new();
    }
    remaining_step_ids(run)
        .into_iter()
        .filter(|id| id.contains(n))
        .collect()
}

/// `filterCompletedStepIds`.
pub fn filter_completed_step_ids(run: &DrillRun, needle: &str) -> Vec<String> {
    let n = js_trim(needle);
    if n.is_empty() {
        return Vec::new();
    }
    run.completed_step_ids
        .iter()
        .filter(|id| id.contains(n))
        .cloned()
        .collect()
}

/// `remainingStepsMatch`.
pub fn remaining_steps_match(run: &DrillRun, needle: &str) -> bool {
    !filter_remaining_step_ids(run, needle).is_empty()
}

/// `completedStepsMatch`.
pub fn completed_steps_match(run: &DrillRun, needle: &str) -> bool {
    !filter_completed_step_ids(run, needle).is_empty()
}

fn paper_list_limit_unset() -> Refusal {
    AcademyError::new(
        "Paper drill list limit is unset — pass limit (never invent all.length)",
        "academy.paper_list_limit_unset",
    )
    .into()
}

/// `assertPaperListPageLimit(limit)`: an owner-published page size, at most 200; blank, non-finite or below 1 refuses.
pub fn assert_paper_list_page_limit(limit: &Value) -> Result<usize, Refusal> {
    let Some(n) = limit.as_number().filter(|n| n.is_finite()) else {
        return Err(paper_list_limit_unset());
    };
    let n = n.floor();
    if n < 1.0 {
        return Err(paper_list_limit_unset());
    }
    Ok(index_of(n.min(200.0)))
}

/// A whole, non-negative double as an index (saturating).
fn index_of(n: f64) -> usize {
    if n.is_nan() || n <= 0.0 {
        0
    } else if n >= 1e15 {
        usize::MAX
    } else {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a whole number in range"
        )]
        let i = n as usize;
        i
    }
}

/// `{ offset?, limit? }`: `limit` as it was passed (it may be anything).
#[derive(Debug, Clone, PartialEq)]
pub struct PageOptions {
    pub offset: Option<f64>,
    pub limit: Value,
}

impl PageOptions {
    pub fn limit(limit: f64) -> PageOptions {
        PageOptions {
            offset: None,
            limit: Value::Number(limit),
        }
    }

    pub fn none() -> PageOptions {
        PageOptions {
            offset: None,
            limit: Value::Undefined,
        }
    }
}

fn page(all: &[String], options: &PageOptions) -> Result<Vec<String>, Refusal> {
    let offset = options.offset.unwrap_or(0.0).floor().max(0.0);
    let limit = assert_paper_list_page_limit(&options.limit)?;
    let start = index_of(offset).min(all.len());
    let end = start.saturating_add(limit).min(all.len());
    Ok(all
        .get(start..end)
        .map_or_else(Vec::new, <[String]>::to_vec))
}

/// `pageRemainingStepIds`: the limit must be published.
pub fn page_remaining_step_ids(
    run: &DrillRun,
    options: &PageOptions,
) -> Result<Vec<String>, Refusal> {
    page(&remaining_step_ids(run), options)
}

/// `pageCompletedStepIds`.
pub fn page_completed_step_ids(
    run: &DrillRun,
    options: &PageOptions,
) -> Result<Vec<String>, Refusal> {
    page(&run.completed_step_ids, options)
}

/// `remainingStepsPageCount`.
#[expect(
    clippy::float_arithmetic,
    reason = "a page count, never money; JavaScript divides doubles"
)]
pub fn remaining_steps_page_count(run: &DrillRun, page_size: f64) -> usize {
    if !page_size.is_finite() || page_size < 1.0 {
        return 0;
    }
    let n = remaining_step_count(run);
    if n == 0 {
        return 0;
    }
    index_of((as_f64(n) / page_size.floor()).ceil())
}

/// `reverseRemainingStepIds`.
pub fn reverse_remaining_step_ids(run: &DrillRun) -> Vec<String> {
    let mut ids = remaining_step_ids(run);
    ids.reverse();
    ids
}

/// `remainingStepsOnlyLeft`.
pub fn remaining_steps_only_left(left: &DrillRun, right: &DrillRun) -> Vec<String> {
    let r = remaining_step_ids(right);
    remaining_step_ids(left)
        .into_iter()
        .filter(|id| !r.contains(id))
        .collect()
}

/// `completedStepsOnlyLeft`.
pub fn completed_steps_only_left(left: &DrillRun, right: &DrillRun) -> Vec<String> {
    left.completed_step_ids
        .iter()
        .filter(|id| !right.completed_step_ids.contains(id))
        .cloned()
        .collect()
}

/// `drillPercentDelta`.
#[expect(
    clippy::float_arithmetic,
    reason = "two step-count percents, never money"
)]
pub fn drill_percent_delta(left: &DrillRun, right: &DrillRun) -> f64 {
    drill_completion_percent(left) - drill_completion_percent(right)
}

/// `drillsSameStatus`.
pub fn drills_same_status(left: &DrillRun, right: &DrillRun) -> bool {
    left.status == right.status
}

/// `safePageRemainingStepIds`: bounds clamped.
#[expect(
    clippy::float_arithmetic,
    reason = "page bounds, never money; JavaScript subtracts doubles"
)]
pub fn safe_page_remaining_step_ids(run: &DrillRun, offset: f64, limit: f64) -> Vec<String> {
    if !offset.is_finite() || !limit.is_finite() {
        return Vec::new();
    }
    let all = remaining_step_ids(run);
    let len = as_f64(all.len());
    let o = offset.floor().min(len).max(0.0);
    let l = limit.floor().min(len - o).max(0.0);
    let (o, l) = (index_of(o), index_of(l));
    all.get(o..o.saturating_add(l))
        .map_or_else(Vec::new, <[String]>::to_vec)
}

/// `clampRemainingStepsPageIndex`.
pub fn clamp_remaining_steps_page_index(run: &DrillRun, page_index: f64, page_size: f64) -> usize {
    let pages = remaining_steps_page_count(run, page_size);
    if pages == 0 || !page_index.is_finite() {
        return 0;
    }
    index_of(page_index.floor().min(as_f64(pages - 1)).max(0.0))
}

/// `remainingStepIdsAtPage`.
#[expect(
    clippy::float_arithmetic,
    reason = "a page offset, never money; JavaScript multiplies doubles"
)]
pub fn remaining_step_ids_at_page(run: &DrillRun, page_index: f64, page_size: f64) -> Vec<String> {
    if !page_size.is_finite() || page_size < 1.0 {
        return Vec::new();
    }
    let idx = as_f64(clamp_remaining_steps_page_index(run, page_index, page_size));
    let size = page_size.floor();
    safe_page_remaining_step_ids(run, idx * size, size)
}

/// `isValidRemainingStepsPage`.
pub fn is_valid_remaining_steps_page(run: &DrillRun, page_index: f64, page_size: f64) -> bool {
    let pages = remaining_steps_page_count(run, page_size);
    if pages == 0 || !page_index.is_finite() {
        return false;
    }
    let i = page_index.floor();
    i >= 0.0 && i < as_f64(pages)
}

/// `remainingStepsExportLines`.
pub fn remaining_steps_export_lines(run: &DrillRun) -> Vec<String> {
    remaining_step_ids(run)
        .into_iter()
        .map(|id| format!("{id},remaining"))
        .collect()
}

/// `completedStepsExportLines`.
pub fn completed_steps_export_lines(run: &DrillRun) -> Vec<String> {
    run.completed_step_ids
        .iter()
        .map(|id| format!("{id},completed"))
        .collect()
}

/// `drillStepsExportHeader`.
pub fn drill_steps_export_header() -> &'static str {
    "stepId,state"
}

/// `drillStepsExportLabelLine`: a `#` comment ahead of the header, so an export says it is simulated first.
pub fn drill_steps_export_label_line() -> &'static str {
    "# simulated=1 venue=paper realMoney=0 — paper trading drill, no value moved"
}

/// `drillStepsExportText`: label, header, completed then remaining.
pub fn drill_steps_export_text(run: &DrillRun) -> String {
    let mut lines = vec![
        drill_steps_export_label_line().to_owned(),
        drill_steps_export_header().to_owned(),
    ];
    lines.extend(completed_steps_export_lines(run));
    lines.extend(remaining_steps_export_lines(run));
    lines.join("\n")
}

/// `parseDrillStepsExportLine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillStepsExportRow {
    pub step_id: String,
    pub state: &'static str,
}

/// `parseDrillStepsExportLine`: a data row, or `None`.
pub fn parse_drill_steps_export_line(line: &str) -> Option<DrillStepsExportRow> {
    let t = js_trim(line);
    if t.is_empty() || t.starts_with('#') || t == drill_steps_export_header() {
        return None;
    }
    let parts: Vec<&str> = t.split(',').collect();
    let [step, state] = parts.as_slice() else {
        return None;
    };
    let step_id = js_trim(step);
    if step_id.is_empty() {
        return None;
    }
    let state = match js_trim(state) {
        "remaining" => "remaining",
        "completed" => "completed",
        _ => return None,
    };
    Some(DrillStepsExportRow {
        step_id: step_id.to_owned(),
        state,
    })
}

/// `countDrillStepsExportDataLines`.
pub fn count_drill_steps_export_data_lines(text: &str) -> usize {
    text.split('\n')
        .filter(|l| parse_drill_steps_export_line(l).is_some())
        .count()
}

/// `drillStepsExportHasHeader`: past any leading `#` label.
pub fn drill_steps_export_has_header(text: &str) -> bool {
    let first = text
        .split('\n')
        .map(js_trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("");
    first == drill_steps_export_header()
}

/// `drillStepsExportIsLabelled`.
pub fn drill_steps_export_is_labelled(text: &str) -> bool {
    text.split('\n').next().map(js_trim) == Some(drill_steps_export_label_line())
}

/// `drillStepsExportRoundTripOk`.
pub fn drill_steps_export_round_trip_ok(run: &DrillRun) -> bool {
    let expected = 1 + completed_step_count(run) + remaining_step_count(run);
    expected == 1 + count_drill_steps_export_data_lines(&drill_steps_export_text(run))
}

/// `drillStatusLine`: leads with `simulated=1 realMoney=0`, so a pasted line stays labelled.
pub fn drill_status_line(run: &DrillRun) -> String {
    let c = drill_board_card(run);
    format!(
        "simulated=1 realMoney=0 status={} done={}/{} percent={}",
        c.status.as_str(),
        c.completed,
        c.total,
        js_int(c.percent)
    )
}

/// `drillStatusLineIsFresh`.
pub fn drill_status_line_is_fresh(run: &DrillRun) -> bool {
    drill_status_line(run).contains("percent=0") && run.status == DrillStatus::Active
}

/// `drillStatusLineDetailed`.
pub fn drill_status_line_detailed(run: &DrillRun) -> String {
    let c = drill_board_card(run);
    format!(
        "simulated=1 realMoney=0 status={} workbook={} market={} done={}/{} fills={} refused={}",
        c.status.as_str(),
        c.workbook_slug,
        c.market_id,
        c.completed,
        c.total,
        c.fills,
        if c.refused { "1" } else { "0" }
    )
}

/// `drillStatusLineTokenCount`: `split(/\s+/).filter(Boolean).length`.
pub fn drill_status_line_token_count(run: &DrillRun) -> usize {
    drill_status_line_detailed(run)
        .split(is_js_whitespace)
        .filter(|t| !t.is_empty())
        .count()
}

/// The tokens of a line the status regexes would read: single spaces between, no other whitespace anywhere.
fn tokens(line: &str) -> Option<Vec<&str>> {
    let t = js_trim(line);
    if t.chars().any(|c| c != ' ' && is_js_whitespace(c)) {
        return None;
    }
    let parts: Vec<&str> = t.split(' ').collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    Some(parts)
}

fn after<'a>(token: &'a str, prefix: &str) -> Option<&'a str> {
    token.strip_prefix(prefix).filter(|rest| !rest.is_empty())
}

fn digits(s: &str) -> Option<f64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn done(token: &str) -> Option<(f64, f64)> {
    let (c, t) = after(token, "done=")?.split_once('/')?;
    Some((digits(c)?, digits(t)?))
}

/// A parsed `drillStatusLine`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDrillStatusLine {
    pub simulated: bool,
    pub real_money: bool,
    pub status: String,
    pub completed: f64,
    pub total: f64,
    pub percent: f64,
}

/// `parseDrillStatusLine`: `simulated=1` and `realMoney=0` are both required, so a stripped label does not parse.
pub fn parse_drill_status_line(line: &str) -> Option<ParsedDrillStatusLine> {
    let parts = tokens(line)?;
    let [sim, real, status, done_token, percent] = parts.as_slice() else {
        return None;
    };
    if *sim != "simulated=1" || *real != "realMoney=0" {
        return None;
    }
    let (completed, total) = done(done_token)?;
    Some(ParsedDrillStatusLine {
        simulated: true,
        real_money: false,
        status: after(status, "status=")?.to_owned(),
        completed,
        total,
        percent: digits(after(percent, "percent=")?)?,
    })
}

/// `drillStatusLineMatches`.
#[expect(
    clippy::float_cmp,
    reason = "whole numbers compared as the TypeScript compares them"
)]
pub fn drill_status_line_matches(run: &DrillRun) -> bool {
    let Some(p) = parse_drill_status_line(&drill_status_line(run)) else {
        return false;
    };
    let c = drill_board_card(run);
    p.status == c.status.as_str()
        && p.completed == as_f64(c.completed)
        && p.total == as_f64(c.total)
        && p.percent == c.percent
}

/// A parsed `drillStatusLineDetailed`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDrillStatusLineDetailed {
    pub simulated: bool,
    pub real_money: bool,
    pub status: String,
    pub workbook: String,
    pub market: String,
    pub completed: f64,
    pub total: f64,
    pub fills: f64,
    pub refused: bool,
}

/// `parseDrillStatusLineDetailed`.
pub fn parse_drill_status_line_detailed(line: &str) -> Option<ParsedDrillStatusLineDetailed> {
    let parts = tokens(line)?;
    let [
        sim,
        real,
        status,
        workbook,
        market,
        done_token,
        fills,
        refused_token,
    ] = parts.as_slice()
    else {
        return None;
    };
    if *sim != "simulated=1" || *real != "realMoney=0" {
        return None;
    }
    let (completed, total) = done(done_token)?;
    let refused = match *refused_token {
        "refused=1" => true,
        "refused=0" => false,
        _ => return None,
    };
    Some(ParsedDrillStatusLineDetailed {
        simulated: true,
        real_money: false,
        status: after(status, "status=")?.to_owned(),
        workbook: after(workbook, "workbook=")?.to_owned(),
        market: after(market, "market=")?.to_owned(),
        completed,
        total,
        fills: digits(after(fills, "fills=")?)?,
        refused,
    })
}

/// `drillStatusLineConsistent`.
pub fn drill_status_line_consistent(line: &str) -> bool {
    parse_drill_status_line(line)
        .is_some_and(|p| p.completed <= p.total && p.percent >= 0.0 && p.percent <= 100.0)
}

/// `remainingStepCountInRange`.
pub fn remaining_step_count_in_range(run: &DrillRun, min: f64, max: f64) -> bool {
    if !min.is_finite() || !max.is_finite() || min > max {
        return false;
    }
    let n = as_f64(remaining_step_count(run));
    n >= min && n <= max
}

/// `drillPercentAtLeast`.
pub fn drill_percent_at_least(run: &DrillRun, percent: f64) -> bool {
    percent.is_finite() && drill_completion_percent(run) >= percent
}

/// `clampRemainingStepsPageSize`: into `[1, remaining]` (empty → 1).
pub fn clamp_remaining_steps_page_size(run: &DrillRun, page_size: f64) -> usize {
    if !page_size.is_finite() {
        return 1;
    }
    let total = as_f64(remaining_step_count(run).max(1));
    index_of(page_size.floor().min(total).max(1.0))
}

/// `fillCountAtMost`.
pub fn fill_count_at_most(run: &DrillRun, n: f64) -> bool {
    n.is_finite() && as_f64(fill_ref_count(run)) <= n
}
