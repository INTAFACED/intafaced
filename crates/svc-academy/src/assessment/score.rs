//! How one answer to a course quiz question scores, and whether an answer fits its question
//! (`curriculum/course-quiz-score.ts`). Pure.
//!
//! A question is the stored JSON (`AcademyCourseQuizQuestion`); an answer is a string or an array of strings. Single
//! choice scores its points for the key; multi-select its points when every correct choice and no wrong one is chosen,
//! or with partial credit an equal whole share per correct choice; numeric compares exact decimals (18 places, scaled
//! integers) within the tolerance; an essay has no automatic score.

use std::collections::BTreeSet;

use service_kit::json::Json;
use service_kit::money::parse_amount;
use service_kit::schema::js_trim;

use super::{array, field, field_bool, field_int, field_str};

/// `ACADEMY_QUIZ_DECIMAL`: `^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$`.
pub fn is_quiz_decimal(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let whole_ok = whole == "0"
        || (!whole.is_empty() && whole.len() <= 18 && digits(whole) && !whole.starts_with('0'));
    let frac_ok = frac.is_none_or(|f| !f.is_empty() && f.len() <= 18 && digits(f));
    whole_ok && frac_ok
}

/// `ACADEMY_CHOICE_ID`: `^[A-Za-z0-9_-]{1,40}$`.
pub fn is_choice_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `scaledDecimal`: a decimal string as a count of 10^-18; none when it is not one.
pub fn scaled_decimal(value: &str) -> Option<i128> {
    let text = js_trim(value);
    if is_quiz_decimal(text) {
        parse_amount(text).ok()
    } else {
        None
    }
}

pub fn kind(q: &Json) -> &str {
    field_str(q, "kind").unwrap_or("single")
}

pub fn id(q: &Json) -> &str {
    field_str(q, "id").unwrap_or("")
}

pub fn points(q: &Json) -> i64 {
    field_int(q, "points").unwrap_or(0)
}

fn has_choice(q: &Json, id: &str) -> bool {
    array(field(q, "choices"))
        .iter()
        .any(|c| field_str(c, "id") == Some(id))
}

fn strings(answer: &Json) -> Option<Vec<&str>> {
    match answer {
        Json::Array(items) => items
            .iter()
            .map(|i| match i {
                Json::String(s) => Some(s.as_str()),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// `answerFits(question, answer)`.
pub fn answer_fits(q: &Json, answer: &Json) -> bool {
    match kind(q) {
        "single" => matches!(answer, Json::String(s) if has_choice(q, s)),
        "multi" => match strings(answer) {
            Some(ids) => {
                ids.iter().collect::<BTreeSet<_>>().len() == ids.len()
                    && ids.iter().all(|id| is_choice_id(id) && has_choice(q, id))
            }
            None => false,
        },
        "numeric" => matches!(answer, Json::String(s) if scaled_decimal(s).is_some()),
        "essay" => matches!(answer, Json::String(_)),
        _ => false,
    }
}

/// `scoreQuestion(question, answer)`: none for an essay; a missing or unfitting answer earns 0.
pub fn score_question(q: &Json, answer: Option<&Json>) -> Option<i64> {
    if kind(q) == "essay" {
        return None;
    }
    let Some(answer) = answer.filter(|a| answer_fits(q, a)) else {
        return Some(0);
    };
    let pts = points(q);
    Some(match kind(q) {
        "single" => {
            let key = field_str(q, "correctChoiceId");
            if matches!(answer, Json::String(s) if Some(s.as_str()) == key) {
                pts
            } else {
                0
            }
        }
        "multi" => {
            let key: BTreeSet<&str> = strings(field(q, "correctChoiceIds").unwrap_or(&Json::Null))
                .unwrap_or_default()
                .into_iter()
                .collect();
            let chosen = strings(answer).unwrap_or_default();
            if key.is_empty() || chosen.iter().any(|id| !key.contains(id)) {
                0
            } else if chosen.len() == key.len() {
                pts
            } else if field_bool(q, "partialCredit") == Some(true) {
                // (points / key.size) * chosen.length: the contract keeps points a whole multiple of the key's size.
                let size = i64::try_from(key.len()).unwrap_or(1).max(1);
                pts / size * i64::try_from(chosen.len()).unwrap_or(0)
            } else {
                0
            }
        }
        "numeric" => {
            let given = match answer {
                Json::String(s) => scaled_decimal(s),
                _ => None,
            };
            let key = field_str(q, "answer").and_then(scaled_decimal);
            let tolerance = field_str(q, "tolerance").and_then(scaled_decimal);
            match (given, key, tolerance) {
                (Some(g), Some(k), Some(t)) if (g - k).abs() <= t => pts,
                _ => 0,
            }
        }
        _ => 0,
    })
}

/// `scoreAttempt(questions, answers)`: the automatic score, the maximum, and whether an essay waits for staff.
pub fn score_attempt(questions: &[Json], answers: &Json) -> (i64, i64, bool) {
    let (mut auto, mut max, mut essays) = (0, 0, false);
    for q in questions {
        max += points(q);
        match score_question(q, answers.get(id(q))) {
            None => essays = true,
            Some(p) => auto += p,
        }
    }
    (auto, max, essays)
}

#[cfg(test)]
mod tests {
    use super::*;
    use service_kit::json::parse;

    fn j(s: &str) -> Json {
        parse(s).unwrap_or(Json::Null)
    }

    #[test]
    fn decimals_are_exact() {
        assert_eq!(scaled_decimal("0.1"), Some(100_000_000_000_000_000));
        assert_eq!(scaled_decimal(" 2 "), Some(2_000_000_000_000_000_000));
        assert_eq!(scaled_decimal("01"), None);
        assert_eq!(scaled_decimal("1."), None);
        assert_eq!(scaled_decimal("1e3"), None);
    }

    #[test]
    fn numeric_within_tolerance_scores() {
        let q = j(
            r#"{"kind":"numeric","id":"n","prompt":"p","points":3,"answer":"0.3","tolerance":"0.0001"}"#,
        );
        assert_eq!(score_question(&q, Some(&j(r#""0.30005""#))), Some(3));
        assert_eq!(score_question(&q, Some(&j(r#""0.3002""#))), Some(0));
    }
}
