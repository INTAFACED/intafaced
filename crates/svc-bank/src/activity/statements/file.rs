//! `statements/statement-file.ts`: a statement file of the person's own posted lines. Amounts stay the decimal strings
//! the ledger sent; the file states no balance. The signature is `loans::reads::sign_statement` (HMAC-SHA256 under a key
//! HKDF-derived from the service secret), the one both files share.

use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::js_date;

use super::Line;
use crate::errors::Refusal;
pub use crate::loans::reads::{csv_cell, sign_statement};

/// `STATEMENT_NOT_TAX_FORM`: every file says so (J-portfolio-11 #3).
pub const NOT_TAX_FORM: &str = "This is not a tax form. It works out no gain, loss or tax.";

/// `STATEMENT_CSV_HEADER`.
pub const CSV_HEADER: [&str; 13] = [
    "Date (UTC)",
    "Type",
    "Direction",
    "Asset",
    "Amount",
    "Counterparty",
    "Account",
    "Reference",
    "Record",
    "Note",
    "Payment reference",
    "Report description",
    "Notice",
];

/// `/^0(\.0+)?$/`.
fn is_zero_text(s: &str) -> bool {
    match s.strip_prefix('0') {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|z| !z.is_empty() && z.bytes().all(|b| b == b'0')),
        None => false,
    }
}

/// `signedAmount`: an outgoing line's amount with a minus, unless it is zero.
pub fn signed_amount(line: &Line) -> String {
    if line.direction == "out" && !is_zero_text(&line.amount) {
        format!("-{}", line.amount)
    } else {
        line.amount.clone()
    }
}

/// `LineTotal`: the net of one asset's lines, money in minus money out. Not a balance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineTotal {
    pub asset: String,
    /// Signed decimal string.
    pub net: String,
    pub lines: usize,
}

/// JavaScript's `<` on two strings: UTF-16 code units in order.
fn js_less(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `lineTotals`: per asset, the sum of the signed amounts of exactly these lines, sorted by asset code.
pub fn line_totals(lines: &[Line]) -> Result<Vec<LineTotal>, Refusal> {
    let mut sums: Vec<(String, Amount, usize)> = Vec::new();
    for line in lines {
        let amount = parse_amount(&line.amount).map_err(Refusal::Other)?;
        let signed = if line.direction == "out" {
            -amount
        } else {
            amount
        };
        match sums.iter_mut().find(|(a, _, _)| *a == line.asset) {
            Some(held) => {
                held.1 += signed;
                held.2 += 1;
            }
            None => sums.push((line.asset.clone(), signed, 1)),
        }
    }
    sums.sort_by(|(a, _, _), (b, _, _)| js_less(a, b));
    Ok(sums
        .into_iter()
        .map(|(asset, net, lines)| LineTotal {
            asset,
            net: format_amount(net),
            lines,
        })
        .collect())
}

/// `statementCsv`: a BOM, the header, one row a line, CRLF after every row.
pub fn statement_csv(lines: &[Line]) -> String {
    let mut rows = vec![
        CSV_HEADER
            .iter()
            .map(|n| csv_cell(n, false))
            .collect::<Vec<_>>()
            .join(","),
    ];
    for l in lines {
        let when = js_date(&l.posted_at).map(|t| t.iso()).unwrap_or_default();
        let counterparty = l
            .counterparty
            .as_ref()
            .map(|h| format!("@{h}"))
            .unwrap_or_default();
        let opt = |v: &Option<String>| v.clone().unwrap_or_default();
        rows.push(
            [
                csv_cell(&when, false),
                csv_cell(&l.kind, true),
                csv_cell(&l.direction, false),
                csv_cell(&l.asset, true),
                csv_cell(&signed_amount(l), false),
                csv_cell(&counterparty, true),
                csv_cell(&opt(&l.space_name), true),
                csv_cell(&l.tx_id, true),
                csv_cell(&l.id, true),
                csv_cell(&opt(&l.note), true),
                csv_cell(&opt(&l.reference), true),
                csv_cell(&opt(&l.report_description), true),
                csv_cell(NOT_TAX_FORM, false),
            ]
            .join(","),
        );
    }
    format!("\u{FEFF}{}\r\n", rows.join("\r\n"))
}

/// `pdfText`: `(`, `)` and `\` escaped, printable ASCII kept, every other code point `?`.
fn pdf_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            ' '..='~' => out.push(ch),
            _ => out.push('?'),
        }
    }
    out
}

/// `PDF_BODY_LINES`: body lines on one page, besides the "Page i of n" line.
const PDF_BODY_LINES: usize = 54;

/// `statementPdf`: one page object and one content stream per page; every line is drawn.
pub fn statement_pdf(lines: &[String]) -> Vec<u8> {
    let page_count = lines.len().div_ceil(PDF_BODY_LINES).max(1);
    let mut streams: Vec<String> = Vec::with_capacity(page_count);
    for page in 0..page_count {
        let chunk = lines
            .iter()
            .skip(page * PDF_BODY_LINES)
            .take(PDF_BODY_LINES);
        let mut commands = vec![
            "BT".to_owned(),
            "/F1 9 Tf".to_owned(),
            "40 760 Td".to_owned(),
            "12 TL".to_owned(),
        ];
        commands.push(format!(
            "({}) Tj",
            pdf_text(&format!("Page {} of {page_count}", page + 1))
        ));
        for line in chunk {
            commands.push(format!("T* ({}) Tj", pdf_text(line)));
        }
        commands.push("ET".to_owned());
        streams.push(commands.join("\n"));
    }
    let font_object = 3 + page_count * 2;
    let kids = (0..page_count)
        .map(|i| format!("{} 0 R", 3 + i * 2))
        .collect::<Vec<_>>()
        .join(" ");
    let mut objects = vec![
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n".to_owned(),
        format!("2 0 obj << /Type /Pages /Kids [{kids}] /Count {page_count} >> endobj\n"),
    ];
    for (index, stream) in streams.iter().enumerate() {
        let page_object = 3 + index * 2;
        let contents_object = page_object + 1;
        objects.push(format!(
            "{page_object} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {contents_object} 0 R /Resources << /Font << /F1 {font_object} 0 R >> >> >> endobj\n"
        ));
        objects.push(format!(
            "{contents_object} 0 obj << /Length {} >> stream\n{stream}\nendstream\nendobj\n",
            stream.len()
        ));
    }
    objects.push(format!(
        "{font_object} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj\n"
    ));
    let mut body = "%PDF-1.4\n".to_owned();
    let mut offsets = vec![0_usize];
    for object in &objects {
        offsets.push(body.len());
        body.push_str(object);
    }
    let xref_at = body.len();
    let mut xref = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for offset in offsets.iter().skip(1) {
        xref.push_str(&format!("{offset:0>10} 00000 n \n"));
    }
    body.push_str(&xref);
    body.push_str(&format!(
        "trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF",
        objects.len() + 1
    ));
    body.into_bytes()
}

/// `statementLines`'s input.
pub struct LinesInput<'a> {
    pub holder_user_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub generated_at: &'a str,
    pub rows: &'a [Line],
    /// `trades` heads the file as a trade history; every other report is the account statement.
    pub trades: bool,
    /// One named space: `(id, name)`.
    pub space: Option<(&'a str, &'a str)>,
}

/// `statementLines`: the header, one line a row, and the per-asset totals of the rows.
pub fn statement_lines(input: &LinesInput<'_>) -> Result<Vec<String>, Refusal> {
    let mut lines = vec![format!(
        "INTAFACED {} {}",
        if input.space.is_some() {
            "space"
        } else {
            "account"
        },
        if input.trades {
            "trade history"
        } else {
            "statement"
        }
    )];
    if input.trades {
        lines.push(
            "Trade lines and their order fees only: every other line is left out.".to_owned(),
        );
    }
    lines.push("Proof of account: posted ledger lines for the holder below.".to_owned());
    lines.push("This file lists posted lines. It does not state a balance.".to_owned());
    lines.push(NOT_TAX_FORM.to_owned());
    lines.push(format!("Holder: {}", input.holder_user_id));
    if let Some((id, name)) = input.space {
        lines.push(format!("Space: {name} ({id})"));
    }
    lines.push(format!("Period: {} to {}", input.from, input.to));
    lines.push(format!("Generated: {}", input.generated_at));
    lines.push(format!("Rows: {}", input.rows.len()));
    lines.push("Date (UTC) | Type | Direction | Asset | Amount | Reference".to_owned());
    for item in input.rows {
        lines.push(format!(
            "{} | {} | {} | {} | {} | {}",
            item.posted_at,
            item.kind,
            item.direction,
            item.asset,
            signed_amount(item),
            item.tx_id
        ));
    }
    lines.push(
        "Total of the lines above (money in minus money out, per asset; not a balance):".to_owned(),
    );
    let totals = line_totals(input.rows)?;
    if totals.is_empty() {
        lines.push("No lines in this period.".to_owned());
    }
    for t in totals {
        lines.push(format!("Total {}: {} ({} lines)", t.asset, t.net, t.lines));
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::indexing_slicing,
        reason = "a test: a failure is the point"
    )]
    use super::*;

    fn line(asset: &str, direction: &str, amount: &str) -> Line {
        Line {
            asset: asset.to_owned(),
            direction: direction.to_owned(),
            amount: amount.to_owned(),
            ..Line::default()
        }
    }

    // statement-totals.test.ts: lineTotals
    #[test]
    fn nets_money_in_minus_money_out_per_asset_exactly_sorted_by_asset() {
        let totals = line_totals(&[
            line("USDT", "in", "100"),
            line("USDT", "out", "100.000000000000000001"),
            line("BTC", "in", "0.1"),
        ])
        .unwrap();
        assert_eq!(
            totals,
            vec![
                LineTotal {
                    asset: "BTC".into(),
                    net: "0.1".into(),
                    lines: 1
                },
                LineTotal {
                    asset: "USDT".into(),
                    net: "-0.000000000000000001".into(),
                    lines: 2
                },
            ]
        );
        assert!(line_totals(&[]).unwrap().is_empty());
    }

    #[test]
    fn a_zero_out_line_has_no_minus_and_a_formula_cell_is_quoted() {
        assert_eq!(signed_amount(&line("USDT", "out", "0.00")), "0.00");
        assert_eq!(signed_amount(&line("USDT", "out", "0.")), "-0.");
        assert_eq!(signed_amount(&line("USDT", "out", "1")), "-1");
        assert_eq!(signed_amount(&line("USDT", "in", "1")), "1");
        assert_eq!(csv_cell("=1+1", true), "'=1+1");
        assert_eq!(csv_cell("a,\"b\"", false), "\"a,\"\"b\"\"\"");
    }

    #[test]
    fn pdf_text_escapes_brackets_and_masks_what_courier_cannot_draw() {
        assert_eq!(pdf_text("a(b)\\c é\t"), "a\\(b\\)\\\\c ??");
    }

    #[test]
    fn the_pdf_xref_points_at_each_object() {
        let bytes = statement_pdf(&["one".to_owned()]);
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("%PDF-1.4\n"));
        let xref_at: usize = text
            .rsplit("startxref\n")
            .next()
            .unwrap()
            .trim_end_matches("\n%%EOF")
            .parse()
            .unwrap();
        assert!(text[xref_at..].starts_with("xref\n0 6\n"));
        let second = text.find("2 0 obj").unwrap();
        assert!(text.contains(&format!("{second:0>10} 00000 n \n")));
    }
}
