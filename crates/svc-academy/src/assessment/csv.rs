//! The grade and curve files, read before anything applies (`curriculum/bulk-grade-file.ts`,
//! `course-quiz-trail.ts` `readCurveFile`). Pure.
//!
//! RFC 4180: quoted fields may hold commas, quotes doubled, CRLF or LF line ends; a quote after spaces only still opens
//! a quoted field. A learner is named by the alias staff see ("Learner 3" or "3").

use service_kit::money::is_js_whitespace;
use service_kit::schema::js_trim;

use super::{js_len, js_slice};
use crate::errors::{AcademyError, Refusal};

/// One record with the line it starts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub line: usize,
    pub fields: Vec<String>,
}

/// A row refused with its line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadRow {
    pub line: usize,
    pub alias: Option<u32>,
    pub code: String,
    pub message: String,
}

/// `csvRecords(text)`: throws `academy.bulk_file_invalid` on a quote left open.
pub fn records(text: &str) -> Result<Vec<Record>, Refusal> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut line = 1;
    let mut start = 1;
    let mut touched = false;
    let mut end =
        |fields: &mut Vec<String>, field: &mut String, touched: &mut bool, start: usize| {
            fields.push(std::mem::take(field));
            if *touched || fields.len() > 1 || fields.last().is_some_and(|f| !f.is_empty()) {
                out.push(Record {
                    line: start,
                    fields: std::mem::take(fields),
                });
            }
            fields.clear();
            *touched = false;
        };
    let mut i = 0;
    while let Some(&ch) = chars.get(i) {
        let next = chars.get(i + 1).copied();
        if quoted {
            if ch == '"' && next == Some('"') {
                field.push('"');
                i += 1;
            } else if ch == '"' {
                quoted = false;
            } else {
                if ch == '\n' {
                    line += 1;
                }
                field.push(ch);
            }
            i += 1;
            continue;
        }
        if ch == '"' && js_trim(&field).is_empty() {
            field.clear();
            quoted = true;
            touched = true;
        } else if ch == ',' {
            fields.push(std::mem::take(&mut field));
            touched = true;
        } else if ch == '\r' && next == Some('\n') {
            // the line feed ends the record
        } else if ch == '\n' {
            end(&mut fields, &mut field, &mut touched, start);
            line += 1;
            start = line;
        } else {
            field.push(ch);
        }
        i += 1;
    }
    if quoted {
        return Err(AcademyError::new(
            format!("a quote opened on line {start} is never closed"),
            "academy.bulk_file_invalid",
        )
        .into());
    }
    end(&mut fields, &mut field, &mut touched, start);
    Ok(out)
}

/// `ALIAS`: `^(?:learner\s+)?([1-9][0-9]{0,8})$`, case-insensitive.
pub fn alias(text: &str) -> Option<u32> {
    let digits = match text.get(..7) {
        // Without the `u` flag, `/i` folds ASCII letters only.
        Some(head) if head.eq_ignore_ascii_case("learner") => {
            let rest = text.get(7..).unwrap_or("");
            if !rest.starts_with(is_js_whitespace) {
                return None;
            }
            rest.trim_start_matches(is_js_whitespace)
        }
        _ => text,
    };
    if digits.is_empty()
        || digits.len() > 9
        || digits.starts_with('0')
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    digits.parse().ok()
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

fn header_of(all: &mut Vec<Record>) -> Vec<String> {
    if all.is_empty() {
        return Vec::new();
    }
    all.remove(0)
        .fields
        .iter()
        .map(|f| js_trim(f).to_lowercase())
        .collect()
}

/// `ACADEMY_POINTS`/`ACADEMY_SCORE`: `^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$`.
pub fn is_score(text: &str) -> bool {
    let (whole, frac) = match text.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (text, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    (whole == "0"
        || (!whole.is_empty() && whole.len() <= 6 && digits(whole) && !whole.starts_with('0')))
        && frac.is_none_or(|f| !f.is_empty() && f.len() <= 2 && digits(f))
}

/// A good row of a grade file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GradeRow {
    pub line: usize,
    pub alias: u32,
    pub score: String,
    pub comment: Option<String>,
    pub reason: Option<String>,
}

const GRADE_HEADER: [&str; 4] = ["learner", "score", "comment", "reason"];

fn first_field(fields: &[String]) -> &str {
    fields.first().map_or("", String::as_str)
}

/// `readBulkGradeFile(text)`.
pub fn read_grade_file(text: &str) -> Result<(Vec<GradeRow>, Vec<BadRow>), Refusal> {
    let mut all = records(strip_bom(text))?;
    let names = header_of(&mut all);
    if names.len() != GRADE_HEADER.len() || GRADE_HEADER.iter().zip(&names).any(|(a, b)| a != b) {
        return Err(AcademyError::new(
            format!(
                "the first line must be the header {}",
                GRADE_HEADER.join(",")
            ),
            "academy.bulk_file_invalid",
        )
        .into());
    }
    if all.is_empty() {
        return Err(AcademyError::new(
            "the file has a header and no rows",
            "academy.bulk_file_invalid",
        )
        .into());
    }
    let mut rows = Vec::new();
    let mut bad = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for Record { line, fields } in all {
        let a = alias(js_trim(first_field(&fields)));
        let mut refuse = |code: &str, message: String| {
            bad.push(BadRow {
                line,
                alias: a,
                code: code.to_owned(),
                message,
            });
        };
        if fields.len() != GRADE_HEADER.len() {
            refuse(
                "academy.bulk_row_invalid",
                format!(
                    "line {line} has {} fields, not {}",
                    fields.len(),
                    GRADE_HEADER.len()
                ),
            );
            continue;
        }
        let Some(a) = a else {
            refuse(
                "academy.bulk_row_invalid",
                format!(
                    "\"{}\" is not a learner alias such as \"Learner 3\"",
                    js_slice(js_trim(first_field(&fields)), 40)
                ),
            );
            continue;
        };
        let get = |i: usize| js_trim(fields.get(i).map_or("", String::as_str)).to_owned();
        let score = get(1);
        if !is_score(&score) {
            refuse(
                "academy.grade_invalid",
                format!(
                    "\"{}\" is not a score: a number from 0 with at most two decimals",
                    js_slice(&score, 40)
                ),
            );
            continue;
        }
        let comment = get(2);
        let reason = get(3);
        if js_len(&comment) > 5000 || js_len(&reason) > 500 {
            refuse(
                "academy.bulk_row_invalid",
                "a comment runs to 5,000 characters and a reason to 500".to_owned(),
            );
            continue;
        }
        if !seen.insert(a) {
            refuse(
                "academy.bulk_row_invalid",
                format!("Learner {a} is named on an earlier line of this file"),
            );
            continue;
        }
        rows.push(GradeRow {
            line,
            alias: a,
            score,
            comment: (!comment.is_empty()).then_some(comment),
            reason: (!reason.is_empty()).then_some(reason),
        });
    }
    Ok((rows, bad))
}

/// A good row of a curve file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurveRow {
    pub line: usize,
    pub alias: u32,
    pub score: i64,
}

/// `readCurveFile(text)`.
pub fn read_curve_file(text: &str) -> Result<(Vec<CurveRow>, Vec<BadRow>), Refusal> {
    let mut all = records(strip_bom(text))?;
    let header = header_of(&mut all);
    if header.len() != 2
        || header.first().map(String::as_str) != Some("learner")
        || header.get(1).map(String::as_str) != Some("score")
    {
        return Err(AcademyError::new(
            "the first line must be the header learner,score",
            "academy.bulk_file_invalid",
        )
        .into());
    }
    if all.is_empty() {
        return Err(AcademyError::new(
            "the file has a header and no rows",
            "academy.bulk_file_invalid",
        )
        .into());
    }
    let mut rows = Vec::new();
    let mut bad = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for Record { line, fields } in all {
        let a = alias(js_trim(first_field(&fields)));
        let score = js_trim(fields.get(1).map_or("", String::as_str)).to_owned();
        let mut refuse = |code: &str, message: String| {
            bad.push(BadRow {
                line,
                alias: a,
                code: code.to_owned(),
                message,
            });
        };
        let whole = score == "0"
            || (!score.is_empty()
                && score.len() <= 6
                && !score.starts_with('0')
                && score.bytes().all(|b| b.is_ascii_digit()));
        if fields.len() != 2 {
            refuse(
                "academy.bulk_row_invalid",
                format!("line {line} has {} fields, not 2", fields.len()),
            );
        } else if a.is_none() {
            refuse(
                "academy.bulk_row_invalid",
                format!(
                    "\"{}\" is not a learner such as \"Learner 3\"",
                    js_slice(js_trim(first_field(&fields)), 40)
                ),
            );
        } else if !whole {
            refuse(
                "academy.assessment_invalid",
                format!("\"{}\" is not a whole score from 0", js_slice(&score, 40)),
            );
        } else if let Some(a) = a {
            if seen.insert(a) {
                rows.push(CurveRow {
                    line,
                    alias: a,
                    score: score.parse().unwrap_or(0),
                });
            } else {
                refuse(
                    "academy.bulk_row_invalid",
                    format!("Learner {a} is named on an earlier line of this file"),
                );
            }
        }
    }
    Ok((rows, bad))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_fields_hold_commas_and_doubled_quotes() {
        let r = records("a,b\r\n\"x, y\",\"say \"\"hi\"\"\"\n\n  \"q\",z\n").unwrap_or_default();
        assert_eq!(r.len(), 3);
        assert_eq!(
            r.get(1).map(|x| x.fields.clone()),
            Some(vec!["x, y".to_owned(), "say \"hi\"".to_owned()])
        );
        assert_eq!(r.get(2).map(|x| x.line), Some(4));
        assert!(records("\"open").is_err());
    }

    #[test]
    fn aliases() {
        assert_eq!(alias("Learner 3"), Some(3));
        assert_eq!(alias("LEARNER\t12"), Some(12));
        assert_eq!(alias("3"), Some(3));
        assert_eq!(alias("Learner3"), None);
        assert_eq!(alias("0"), None);
        assert_eq!(alias("learner 1234567890"), None);
    }
}
