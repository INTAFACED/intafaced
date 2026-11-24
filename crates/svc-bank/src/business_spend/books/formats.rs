//! A business's statement as four files (`business/statement-formats.ts`; J-bank-23 #3, BK-bexp-05): CSV, SWIFT MT940,
//! ISO 20022 CAMT.053 and QIF, byte for byte as the TypeScript writes them. Each is made from the same lines and the
//! same opening and closing balance, so each carries the partner statement's closing balance and line count, and every
//! line carries its id (the partner's own reference for it).
//!
//! Amounts are [`Amount`] in, decimal strings out: never a float.

use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;

use crate::loans::reads::csv_cell;

/// `BOOK_STATEMENT_FORMATS`.
pub const FORMATS: [&str; 4] = ["csv", "mt940", "camt053", "qif"];

/// `BookLine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookLine {
    /// The partner's own reference for the line.
    pub id: String,
    pub booked_at: Instant,
    /// Signed: money in above zero, money out below.
    pub amount: Amount,
    pub payee: String,
    pub category: Option<String>,
    pub gl_code: Option<String>,
}

/// `BookStatement`.
pub struct BookStatement<'a> {
    /// The business's account id.
    pub account_id: &'a str,
    pub account_name: &'a str,
    pub currency: &'a str,
    /// Whose record this is, e.g. "TEST partner bank".
    pub servicer: &'a str,
    pub from: Instant,
    /// Exclusive.
    pub to: Instant,
    pub opening: Amount,
    pub closing: Amount,
    /// Oldest first.
    pub lines: &'a [BookLine],
    pub generated_at: Instant,
}

/// `BookFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookFile {
    pub format: &'static str,
    pub file_name: String,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

fn day(d: Instant) -> String {
    d.iso().get(..10).unwrap_or_default().to_owned()
}

/// The last instant inside an exclusive end.
fn last_day(s: &BookStatement<'_>) -> Instant {
    Instant(s.from.0.max(s.to.0 - 1))
}

fn yymmdd(d: Instant) -> String {
    day(d).get(2..).unwrap_or_default().replace('-', "")
}

/// `String#slice(0, n)` on ASCII text (every caller's text is ASCII by then).
fn head(s: &str, n: usize) -> &str {
    s.get(..n.min(s.len())).unwrap_or(s)
}

/// `Buffer.from(text, 'ascii')`: Node writes each UTF-16 unit's low byte.
fn ascii_bytes(s: &str) -> Vec<u8> {
    s.encode_utf16().map(|u| u.to_le_bytes()[0]).collect()
}

/// `renderBookStatement`. `None` for a format outside [`FORMATS`].
pub fn render(s: &BookStatement<'_>, format: &str) -> Option<BookFile> {
    let stem = format!(
        "statement-{}-{}-{}",
        head(s.account_id, 8),
        day(s.from),
        day(last_day(s))
    );
    Some(match format {
        "csv" => BookFile {
            format: "csv",
            file_name: format!("{stem}.csv"),
            content_type: "text/csv; charset=utf-8",
            body: csv(s).into_bytes(),
        },
        "mt940" => BookFile {
            format: "mt940",
            file_name: format!("{stem}.sta"),
            content_type: "text/plain; charset=us-ascii",
            body: ascii_bytes(&mt940(s)),
        },
        "camt053" => BookFile {
            format: "camt053",
            file_name: format!("{stem}.xml"),
            content_type: "application/xml; charset=utf-8",
            body: camt053(s).into_bytes(),
        },
        "qif" => BookFile {
            format: "qif",
            file_name: format!("{stem}.qif"),
            content_type: "application/qif; charset=utf-8",
            body: qif(s).into_bytes(),
        },
        _ => return None,
    })
}

/// `bookCsv`: two cells a row, the statement's own facts first, then one row per line under its header.
pub fn csv(s: &BookStatement<'_>) -> String {
    let mut rows: Vec<Vec<String>> = vec![
        vec!["Account".into(), s.account_name.into()],
        vec!["Account id".into(), s.account_id.into()],
        vec!["Currency".into(), s.currency.into()],
        vec!["Held by".into(), s.servicer.into()],
        vec!["Period from (UTC)".into(), s.from.iso()],
        vec!["Period to (UTC, exclusive)".into(), s.to.iso()],
        vec!["Opening balance".into(), format_amount(s.opening)],
        vec!["Closing balance".into(), format_amount(s.closing)],
        vec!["Line count".into(), s.lines.len().to_string()],
        vec![],
        [
            "Line id",
            "Booked (UTC)",
            "Amount",
            "Currency",
            "Payee",
            "Category",
            "GL code",
        ]
        .iter()
        .map(|c| (*c).to_owned())
        .collect(),
    ];
    for l in s.lines {
        rows.push(vec![
            l.id.clone(),
            l.booked_at.iso(),
            format_amount(l.amount),
            s.currency.to_owned(),
            l.payee.clone(),
            l.category.clone().unwrap_or_default(),
            l.gl_code.clone().unwrap_or_default(),
        ]);
    }
    let body: Vec<String> = rows
        .iter()
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(i, c)| csv_cell(c, i != 2))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect();
    format!("\u{feff}{}\r\n", body.join("\r\n"))
}

/// The SWIFT X character set; anything else (each UTF-16 unit of it) becomes a full stop.
fn swift(v: &str, max: usize) -> String {
    let out: String = v
        .encode_utf16()
        .map(|u| match u8::try_from(u) {
            Ok(b) if b.is_ascii_alphanumeric() || b"/-?:().,'+ ".contains(&b) => char::from(b),
            _ => '.',
        })
        .collect();
    head(&out, max).to_owned()
}

fn mt_amount(v: Amount) -> String {
    let text = format_amount(v.abs());
    let comma = if text.contains('.') { "" } else { "," };
    format!("{}{comma}", text.replacen('.', ",", 1))
}

fn mt_mark(v: Amount) -> char {
    if v.is_negative() { 'D' } else { 'C' }
}

/// `bookMt940`: `:60F:` opening, one `:61:` and `:86:` per line (the line id in `:86:`), `:62F:` closing.
pub fn mt940(s: &BookStatement<'_>) -> String {
    let mut out = vec![
        format!(":20:{}", swift(&format!("STMT{}", yymmdd(s.from)), 16)),
        format!(":25:{}", swift(&s.account_id.replace('-', ""), 35)),
        ":28C:00001/001".to_owned(),
        format!(
            ":60F:{}{}{}{}",
            mt_mark(s.opening),
            yymmdd(s.from),
            s.currency,
            mt_amount(s.opening)
        ),
    ];
    for l in s.lines {
        let date = yymmdd(l.booked_at);
        out.push(format!(
            ":61:{date}{}{}{}NTRFNONREF",
            date.get(2..).unwrap_or_default(),
            mt_mark(l.amount),
            mt_amount(l.amount)
        ));
        out.push(format!(":86:/ID/{}", swift(&l.id, 60)));
        out.push(format!("/NAME/{}", swift(&l.payee, 59)));
        if let Some(c) = l.category.as_deref().filter(|c| !c.is_empty()) {
            out.push(format!("/CAT/{}", swift(c, 60)));
        }
        if let Some(g) = l.gl_code.as_deref().filter(|g| !g.is_empty()) {
            out.push(format!("/GL/{}", swift(g, 61)));
        }
    }
    out.push(format!(
        ":62F:{}{}{}{}",
        mt_mark(s.closing),
        yymmdd(last_day(s)),
        s.currency,
        mt_amount(s.closing)
    ));
    format!("{}\r\n-\r\n", out.join("\r\n"))
}

/// XML 1.0 takes no control character but tab, line feed and carriage return: the rest are left out.
fn xml(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        if u32::from(c) < 0x20 && !matches!(c, '\t' | '\n' | '\r') {
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// `bookCamt053` (version 08): an OPBD and a CLBD balance, the entry count, and one `Ntry` per line under its id.
pub fn camt053(s: &BookStatement<'_>) -> String {
    let amt = |v: Amount| {
        format!(
            "<Amt Ccy=\"{}\">{}</Amt>",
            xml(s.currency),
            format_amount(v.abs())
        )
    };
    let ind = |v: Amount| {
        format!(
            "<CdtDbtInd>{}</CdtDbtInd>",
            if v.is_negative() { "DBIT" } else { "CRDT" }
        )
    };
    let bal = |code: &str, v: Amount, d: Instant| {
        format!(
            "<Bal><Tp><CdOrPrtry><Cd>{code}</Cd></CdOrPrtry></Tp>{}{}<Dt><Dt>{}</Dt></Dt></Bal>",
            amt(v),
            ind(v),
            day(d)
        )
    };
    let sum: Amount = s.lines.iter().map(|l| l.amount.abs()).sum();
    let net = s.closing - s.opening;
    let entries = s.lines.iter().map(|l| {
        let party = if l.amount.is_negative() {
            "Cdtr"
        } else {
            "Dbtr"
        };
        let coding: Vec<&str> = [l.category.as_deref(), l.gl_code.as_deref()]
            .into_iter()
            .flatten()
            .filter(|c| !c.is_empty())
            .collect();
        let extra = if coding.is_empty() {
            String::new()
        } else {
            format!("<AddtlTxInf>{}</AddtlTxInf>", xml(&coding.join(" / ")))
        };
        format!(
            "<Ntry><NtryRef>{id}</NtryRef>{}{}<Sts><Cd>BOOK</Cd></Sts>\
             <BookgDt><DtTm>{}</DtTm></BookgDt><BkTxCd><Prtry><Cd>TRANSFER</Cd></Prtry></BkTxCd>\
             <NtryDtls><TxDtls><Refs><AcctSvcrRef>{id}</AcctSvcrRef></Refs>\
             <RltdPties><{party}><Pty><Nm>{}</Nm></Pty></{party}></RltdPties>{extra}\
             </TxDtls></NtryDtls></Ntry>",
            amt(l.amount),
            ind(l.amount),
            l.booked_at.iso(),
            xml(&l.payee),
            id = xml(&l.id),
        )
    });
    let id = format!("STMT-{}-{}", head(s.account_id, 8), day(s.from));
    let mut out = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_owned(),
        "<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\">".to_owned(),
        "<BkToCstmrStmt>".to_owned(),
        format!(
            "<GrpHdr><MsgId>{}</MsgId><CreDtTm>{}</CreDtTm></GrpHdr>",
            xml(&id),
            s.generated_at.iso()
        ),
        format!(
            "<Stmt><Id>{}</Id><CreDtTm>{}</CreDtTm>",
            xml(&id),
            s.generated_at.iso()
        ),
        format!(
            "<FrToDt><FrDtTm>{}</FrDtTm><ToDtTm>{}</ToDtTm></FrToDt>",
            s.from.iso(),
            last_day(s).iso()
        ),
        format!(
            "<Acct><Id><Othr><Id>{}</Id></Othr></Id><Ccy>{}</Ccy><Nm>{}</Nm>\
             <Svcr><FinInstnId><Nm>{}</Nm></FinInstnId></Svcr></Acct>",
            xml(s.account_id),
            xml(s.currency),
            xml(s.account_name),
            xml(s.servicer)
        ),
        bal("OPBD", s.opening, s.from),
        bal("CLBD", s.closing, last_day(s)),
        format!(
            "<TxsSummry><TtlNtries><NbOfNtries>{}</NbOfNtries><Sum>{}</Sum>\
             <TtlNetNtry><Amt>{}</Amt>{}</TtlNetNtry></TtlNtries></TxsSummry>",
            s.lines.len(),
            format_amount(sum),
            format_amount(net.abs()),
            ind(net)
        ),
    ];
    out.extend(entries);
    out.extend(
        ["</Stmt>", "</BkToCstmrStmt>", "</Document>", ""]
            .iter()
            .map(|t| (*t).to_owned()),
    );
    out.join("\n")
}

fn qif_text(v: &str) -> String {
    v.replace(['\r', '\n', '^'], " ")
}

fn qif_date(d: Instant) -> String {
    let t = day(d);
    format!(
        "{}/{}/{}",
        t.get(5..7).unwrap_or_default(),
        t.get(8..10).unwrap_or_default(),
        t.get(..4).unwrap_or_default()
    )
}

/// `bookQif`: as Quicken reads a bank account, its first record the opening balance, then one record per line with
/// the line id as its number.
pub fn qif(s: &BookStatement<'_>) -> String {
    let mut out = vec![
        "!Type:Bank".to_owned(),
        format!("D{}", qif_date(s.from)),
        format!("T{}", format_amount(s.opening)),
        "POpening Balance".to_owned(),
        format!("L[{}]", qif_text(s.account_name)),
        "^".to_owned(),
    ];
    for l in s.lines {
        out.push(format!("D{}", qif_date(l.booked_at)));
        out.push(format!("T{}", format_amount(l.amount)));
        out.push(format!("N{}", qif_text(&l.id)));
        out.push(format!("P{}", qif_text(&l.payee)));
        if let Some(c) = l.category.as_deref().filter(|c| !c.is_empty()) {
            out.push(format!("L{}", qif_text(c)));
        }
        if let Some(g) = l.gl_code.as_deref().filter(|g| !g.is_empty()) {
            out.push(format!("MGL {}", qif_text(g)));
        }
        out.push("^".to_owned());
    }
    format!("{}\r\n", out.join("\r\n"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]

    use service_kit::time::zod_datetime;
    use sha2::{Digest, Sha256};

    use super::*;

    fn at(t: &str) -> Instant {
        zod_datetime(t, false).unwrap()
    }

    fn line(
        id: &str,
        t: &str,
        scaled: i128,
        payee: &str,
        cat: Option<&str>,
        gl: Option<&str>,
    ) -> BookLine {
        BookLine {
            id: id.to_owned(),
            booked_at: at(t),
            amount: Amount::from_scaled(scaled),
            payee: payee.to_owned(),
            category: cat.map(str::to_owned),
            gl_code: gl.map(str::to_owned),
        }
    }

    fn hash(b: &[u8]) -> String {
        Sha256::digest(b)
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect()
    }

    /// Each format's bytes, held to `renderBookStatement`'s own: the hashes are what the TypeScript printed for the
    /// same statement (`npx tsx` over `statement-formats.ts`, 2026-11-23), with quotes, commas, a formula, markup,
    /// control characters, a non-ASCII letter and an astral emoji in its text.
    #[test]
    fn every_format_is_the_typescripts_byte_for_byte() {
        let lines = [
            line(
                "test-partner-move-1",
                "2026-11-02T03:04:05.006Z",
                1_000_000_000_000_000_000_000,
                "Pay-in",
                None,
                None,
            ),
            line(
                "test-partner-move-2",
                "2026-11-03T03:04:05.006Z",
                -12_500_000_000_000_000_000,
                "=TESTSHOP \u{fc}\u{1f600} Berlin^\r\nx",
                Some("Supplies, \"office\""),
                Some("6100"),
            ),
            line(
                "test-partner-move-3",
                "2026-11-04T00:00:00.000Z",
                -41_500_000_000_000_000_000,
                "O'Cafe <&>",
                None,
                Some("A1/2"),
            ),
        ];
        let s = BookStatement {
            account_id: "abcdef12-3456-4789-8abc-def012345678",
            account_name: "TEST \"Books\", Ltd & <Co> \u{fc}\u{1f600}\u{1}",
            currency: "EUR",
            servicer: "TEST partner bank",
            from: at("2026-11-01T00:00:00.000Z"),
            to: at("2026-11-23T10:11:12.345Z"),
            opening: Amount::from_scaled(1_234_500_000_000_000_000),
            closing: Amount::from_scaled(
                1_000_000_000_000_000_000_000 - 54_000_000_000_000_000_000
                    + 1_234_500_000_000_000_000,
            ),
            lines: &lines,
            generated_at: at("2026-11-23T10:00:00.000Z"),
        };
        let want = [
            (
                "csv",
                "text/csv; charset=utf-8",
                "5310d0b80c5bc7164e6a118e8d990c0c5ea24ce3c72d7a2f832831356b2393c0",
                617,
            ),
            (
                "mt940",
                "text/plain; charset=us-ascii",
                "943bd3fe6f76d2afdc8cca5d6215a58f09cb147603f78b128d87dd7a2f76d359",
                411,
            ),
            (
                "camt053",
                "application/xml; charset=utf-8",
                "dff75c042e44ba81be7d5471b2cfa93a5a0b7f39c4e217498b3a58ab532beadf",
                2399,
            ),
            (
                "qif",
                "application/qif; charset=utf-8",
                "5f6733210ec0dab6f99477c63d08f1f21eafd25156a0703da4498c176276f727",
                322,
            ),
        ];
        for (format, content_type, sha, len) in want {
            let f = render(&s, format).unwrap();
            assert_eq!(f.content_type, content_type);
            assert!(
                f.file_name
                    .starts_with("statement-abcdef12-2026-11-01-2026-11-23."),
                "{}",
                f.file_name
            );
            assert_eq!(
                (hash(&f.body), f.body.len()),
                (sha.to_owned(), len),
                "{format}: {}",
                String::from_utf8_lossy(&f.body)
            );
        }
        let empty = BookStatement {
            account_name: "Empty",
            to: s.from,
            lines: &[],
            ..s
        };
        for (format, sha) in [
            (
                "csv",
                "1bf5b7fb057fbf7a73368342d0c76977b3bdff69778583de31442e3cb1a504f7",
            ),
            (
                "mt940",
                "6b8f5b7454c171a5ca921bd63cc9b27d695b7c85373b6c116fff06fcd18c7c5d",
            ),
            (
                "camt053",
                "6f4844e23e6c47ac792c1568210a8446c4179a452849310fab3c782c23d2d995",
            ),
            (
                "qif",
                "5c3ee2fd7e9abf47ef28fd7892568bd80ced0c9b2c946b7d25025cc614158b36",
            ),
        ] {
            let f = render(&empty, format).unwrap();
            assert!(
                f.file_name
                    .starts_with("statement-abcdef12-2026-11-01-2026-11-01."),
                "{}",
                f.file_name
            );
            assert_eq!(hash(&f.body), sha, "empty {format}");
        }
        assert!(render(&s, "pdf").is_none());
    }
}
