//! `parseBulkCsv` (`business/business-payouts.ts`): a bulk payment file's lines, each valid one or its issue.

use service_kit::money::{Amount, parse_amount};

use super::{MAX_BULK_LINES, js_slice, js_trim};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::refs::{compact_upper, is_iban_ref};

/// One valid line (`BulkLine`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkLine {
    pub line: i64,
    pub name: String,
    pub iban: String,
    pub amount: Amount,
    pub reference: Option<String>,
}

/// One line that sends nothing (`BulkIssue`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkIssue {
    pub line: i64,
    pub code: &'static str,
    pub detail: String,
    pub raw: String,
}

/// `NAME_RE`, `/^[^\p{Cc}]{1,140}$/u`: 1 to 140 code points, none a control character.
pub fn name_ok(name: &str) -> bool {
    let n = name.chars().count();
    (1..=140).contains(&n) && !name.chars().any(char::is_control)
}

/// `AMOUNT_RE`, `/^\d{1,18}(\.\d{1,18})?$/`.
fn amount_shaped(s: &str) -> bool {
    let digits = |p: &str| (1..=18).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit());
    match s.split_once('.') {
        Some((whole, frac)) => digits(whole) && digits(frac),
        None => digits(s),
    }
}

/// `cells`: one CSV row's cells; commas split, a double-quoted cell may hold commas and `""` for a quote. An unclosed
/// quote is none.
fn cells(row: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut it = row.chars().peekable();
    while let Some(ch) = it.next() {
        if quoted {
            if ch == '"' && it.peek() == Some(&'"') {
                cur.push('"');
                it.next();
            } else if ch == '"' {
                quoted = false;
            } else {
                cur.push(ch);
            }
        } else if ch == '"' && cur.is_empty() {
            quoted = true;
        } else if ch == ',' {
            out.push(js_trim(&cur).to_owned());
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    if quoted {
        return None;
    }
    out.push(js_trim(&cur).to_owned());
    Some(out)
}

fn file_invalid(message: impl Into<String>) -> Refusal {
    refuse("bank.bulk_file_invalid", message)
}

/// `parseBulkCsv`: the header names the columns (any order; `reference` may be left out). A file with no such header,
/// with more than [`MAX_BULK_LINES`] lines, or with no line at all is refused whole: `bank.bulk_file_invalid`.
pub fn parse_bulk_csv(
    text: &str,
    asset_id: &str,
) -> Result<(Vec<BulkLine>, Vec<BulkIssue>), Refusal> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // `split(/\r?\n/)`.
    let rows: Vec<&str> = text
        .split('\n')
        .map(|r| r.strip_suffix('\r').unwrap_or(r))
        .collect();
    let header: Vec<String> = cells(rows.first().copied().unwrap_or(""))
        .map(|h| h.iter().map(|c| c.to_lowercase()).collect())
        .unwrap_or_default();
    let at = |col: &str| header.iter().position(|h| h == col);
    let (Some(at_name), Some(at_iban), Some(at_amount), Some(at_currency)) =
        (at("name"), at("iban"), at("amount"), at("currency"))
    else {
        return Err(file_invalid(
            "The file’s first row names its columns: name, iban, amount, currency and reference.",
        ));
    };
    let at_reference = at("reference");
    let mut lines = Vec::new();
    let mut issues = Vec::new();
    let mut seen: Vec<(String, i64)> = Vec::new();
    let mut n: i64 = 0;
    for raw in rows.iter().skip(1) {
        if js_trim(raw).is_empty() {
            continue;
        }
        n += 1;
        if n > MAX_BULK_LINES {
            return Err(file_invalid(format!(
                "A file has at most {MAX_BULK_LINES} lines."
            )));
        }
        let mut issue = |code: &'static str, detail: String| {
            issues.push(BulkIssue {
                line: n,
                code,
                detail,
                raw: js_slice(raw, 500),
            });
        };
        let row = match cells(raw) {
            Some(r) if r.len() == header.len() => r,
            other => {
                issue(
                    "columns_invalid",
                    format!(
                        "This line has {} columns; the header has {}.",
                        other.map_or(0, |r| r.len()),
                        header.len()
                    ),
                );
                continue;
            }
        };
        let cell = |i: usize| row.get(i).map(String::as_str).unwrap_or_default();
        let name = cell(at_name);
        let iban = compact_upper(cell(at_iban));
        let amount = cell(at_amount);
        let currency = cell(at_currency).to_uppercase();
        let reference = at_reference
            .map(cell)
            .filter(|r| !r.is_empty())
            .map(str::to_owned);
        let parsed = amount_shaped(amount)
            .then(|| parse_amount(amount).ok())
            .flatten()
            .filter(|a| *a > Amount::ZERO);
        if !name_ok(name) {
            issue(
                "name_missing",
                "A recipient’s name is 1 to 140 characters.".to_owned(),
            );
        } else if !is_iban_ref(&iban) {
            issue("iban_invalid", "The IBAN does not check out.".to_owned());
        } else if parsed.is_none() {
            issue(
                "amount_invalid",
                format!("“{}” is not an amount above zero.", js_slice(amount, 40)),
            );
        } else if currency != asset_id {
            let shown = js_slice(&currency, 12);
            issue(
                "asset_mismatch",
                format!(
                    "This line is in {}; the account pays in {asset_id}.",
                    if shown.is_empty() {
                        "no currency"
                    } else {
                        shown.as_str()
                    }
                ),
            );
        } else if reference
            .as_deref()
            .is_some_and(|r| r.encode_utf16().count() > 64)
        {
            issue(
                "columns_invalid",
                "A reference is 64 characters or fewer.".to_owned(),
            );
        } else if let Some((_, first)) = seen.iter().find(|(i, _)| *i == iban) {
            let first = *first;
            issue(
                "duplicate_line",
                format!("This account is already paid on line {first}."),
            );
        } else if let Some(amount) = parsed {
            seen.push((iban.clone(), n));
            lines.push(BulkLine {
                line: n,
                name: name.to_owned(),
                iban,
                amount,
                reference,
            });
        }
    }
    if n == 0 {
        return Err(file_invalid("The file has no lines to pay."));
    }
    Ok((lines, issues))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]
    use super::*;

    const IBANS: [&str; 3] = [
        "DE89370400440532013000",
        "GB82WEST12345698765432",
        "NL91ABNA0417164300",
    ];

    fn csv() -> String {
        [
            "name,iban,amount,currency,reference".to_owned(),
            format!("TEST Ana,{},100.00,USDT,Nov", IBANS[0]),
            format!("TEST Ben,{},150.50,USDT,Nov", IBANS[1]),
            format!("TEST Cy,{},49.50,USDT,Nov", IBANS[2]),
            "TEST Dee,FR1420041010050500013M02606,12.3.4,USDT,Nov".to_owned(),
            format!("TEST Ana,{},100.00,USDT,Nov", IBANS[0]),
        ]
        .join("\n")
    }

    fn code(r: Refusal) -> String {
        match r {
            Refusal::Bank(e) => format!("{}: {}", e.row.code, e.message),
            other => panic!("{other:?}"),
        }
    }

    /// `business-payouts.db.test.ts`: "the CSV: three good lines, a bad amount and a duplicate give exactly two
    /// issues; a line in another asset is refused".
    #[test]
    fn three_good_lines_a_bad_amount_and_a_duplicate() {
        let (lines, issues) = parse_bulk_csv(&csv(), "USDT").unwrap();
        assert_eq!(
            lines.iter().map(|l| l.line).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(
            issues.iter().map(|i| (i.line, i.code)).collect::<Vec<_>>(),
            vec![(4, "amount_invalid"), (5, "duplicate_line")]
        );
        assert_eq!(issues[1].detail, "This account is already paid on line 1.");
        let (lines, issues) = parse_bulk_csv(
            &format!("name,iban,amount,currency\nTEST Ana,{},10,EUR", IBANS[0]),
            "USDT",
        )
        .unwrap();
        assert!(lines.is_empty());
        assert_eq!(
            issues.iter().map(|i| i.code).collect::<Vec<_>>(),
            vec!["asset_mismatch"]
        );
        assert_eq!(
            issues[0].detail,
            "This line is in EUR; the account pays in USDT."
        );
        let refused = code(parse_bulk_csv("who,what\nx,y", "USDT").unwrap_err());
        assert!(
            refused.contains("bank.bulk_file_invalid") && refused.contains("columns"),
            "{refused}"
        );
    }

    #[test]
    fn quoted_cells_crlf_a_bom_and_the_whole_file_refusals() {
        let text = format!(
            "\u{feff}Reference,Currency,Amount,IBAN,Name\r\n\"Nov, \"\"late\"\"\",usdt,5, {} ,\"TEST Ana\"\r\n",
            "de89 3704 0044 0532 0130 00"
        );
        let (lines, issues) = parse_bulk_csv(&text, "USDT").unwrap();
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(lines[0].iban, IBANS[0]);
        assert_eq!(lines[0].reference.as_deref(), Some("Nov, \"late\""));
        assert_eq!(lines[0].name, "TEST Ana");
        let (_, issues) = parse_bulk_csv("name,iban,amount,currency\n\"open,x", "USDT").unwrap();
        assert_eq!(
            issues[0].detail,
            "This line has 0 columns; the header has 4."
        );
        assert!(
            code(parse_bulk_csv("name,iban,amount,currency\n \n", "USDT").unwrap_err())
                .contains("no lines")
        );
        let many = std::iter::once("name,iban,amount,currency".to_owned())
            .chain((0..=MAX_BULK_LINES).map(|_| "x,y,1,USDT".to_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code(parse_bulk_csv(&many, "USDT").unwrap_err()).contains("at most 500"));
        let (_, issues) = parse_bulk_csv("name,iban,amount,currency\n,DE89370400440532013000,1,USDT\nA,DE00,1,USDT\nA,DE89370400440532013000,0,USDT\nA,DE89370400440532013000,1,,", "USDT").unwrap();
        assert_eq!(
            issues.iter().map(|i| i.code).collect::<Vec<_>>(),
            vec![
                "name_missing",
                "iban_invalid",
                "amount_invalid",
                "columns_invalid"
            ]
        );
    }
}
