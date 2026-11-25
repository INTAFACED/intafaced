//! No crate passes a plain count as money into the kit's wide arithmetic (INTAFACED/project-state#3868). A rate in
//! basis points, 10,000 or a tally made into an `Amount` with `from_scaled` compiles, and reads as money at every line
//! after it. Counts have their own calls: `mul_ratio` (an amount times a count over a count), `ratio_of` (two amounts
//! as a count), `cmp_times` (an amount times a count against another) and `mul_div_count` (plain integers).

use std::path::{Path, PathBuf};

/// The kit's calls that take only amounts.
const AMOUNT_ONLY: [&str; 2] = ["mul_div", "cmp_products"];

/// Each call to an amount-only function in `text` whose arguments make an amount with `from_scaled`, as
/// (line, call).
fn counts_as_money(text: &str) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    for name in AMOUNT_ONLY {
        let call = format!("{name}(");
        let mut from = 0;
        while let Some(at) = text[from..].find(&call).map(|i| from + i) {
            from = at + call.len();
            let before = text[..at].chars().next_back();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_')
                || text[..at].trim_end().ends_with("fn")
            {
                continue;
            }
            let mut depth = 1;
            let mut end = from;
            for (i, c) in text[from..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    end = from + i;
                    break;
                }
            }
            if text[from..end].contains("from_scaled(") {
                let line = text[..at].lines().count().max(1);
                found.push((line, name.to_owned()));
            }
        }
    }
    found
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            // vendor holds third-party crates kept byte for byte; target is build output.
            if name != "vendor" && name != "target" {
                rust_files(&path, out)?;
            }
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
    Ok(())
}

#[test]
fn no_crate_passes_a_count_as_money() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // The kit's own file is where `from_scaled` is defined and tested at the unit; this file quotes past mistakes.
    let skip = [
        crates.join("service-kit/src/money.rs"),
        crates.join("service-kit/tests/counts_as_money.rs"),
    ];
    let mut files = Vec::new();
    rust_files(crates, &mut files).unwrap();
    let mut found = Vec::new();
    for file in files.iter().filter(|f| !skip.contains(f)) {
        let text = std::fs::read_to_string(file).unwrap();
        for (line, call) in counts_as_money(&text) {
            let at = file.strip_prefix(crates).unwrap().display();
            found.push(format!(
                "crates/{at}:{line}: `{call}` takes an amount made with `from_scaled`"
            ));
        }
    }
    assert!(
        found.is_empty(),
        "A count passed as money reads as money everywhere after it. Use `service_kit::money::mul_ratio` (amount \
         times a count over a count), `ratio_of` (two amounts as a count), `cmp_times` (amount times a count against \
         another) or `mul_div_count` (plain integers); a real amount comes from `parse_amount`, `Amount::whole` or a \
         named constant.\n{}",
        found.join("\n")
    );
}

#[test]
fn finds_the_counts_that_were_passed_as_money() {
    // The cashback rate as it stood before #3868.
    let cashback = "    mul_div(\n        captured,\n        Amount::from_scaled(i128::from(rate_bps)),\n        \
                    Amount::from_scaled(10_000),\n        Rounding::Floor,\n    )\n";
    assert_eq!(counts_as_money(cashback), vec![(1, "mul_div".to_owned())]);
    // The maker-rebate bound's rate.
    let rebate =
        "let x = 1;\nlet ok = cmp_products(amount, Amount::from_scaled(10_000), paid, bps);";
    assert_eq!(
        counts_as_money(rebate),
        vec![(2, "cmp_products".to_owned())]
    );
    assert!(counts_as_money("mul_div(debt, BPS * ONE, price, Rounding::Ceil)").is_empty());
    assert!(
        counts_as_money("pub fn mul_div(a: Amount, b: Amount) { Amount::from_scaled(1) }")
            .is_empty()
    );
    assert!(counts_as_money("wide_mul_div(Amount::from_scaled(1).0, 2, 3)").is_empty());
    assert!(
        counts_as_money("mul_ratio(captured, i128::from(rate_bps), 10_000, Rounding::Floor)")
            .is_empty()
    );
}
