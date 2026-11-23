//! No crate names an integer with a type alias (INTAFACED/project-state#3851). `pub type Amount = i128;` let a count, a
//! basis-point share, a timestamp or a raw integer pass anywhere money was meant, and the compiler said nothing; as the
//! newtype `service_kit::money::Amount` each of those is a compile error. An alias for an integer would open that door
//! again for whatever it names, so this test refuses any.

use std::path::{Path, PathBuf};

const INTEGERS: [&str; 12] = [
    "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
];

/// The integer a line aliases (`pub type Amount = i128;` gives `i128`), or None.
fn aliased_integer(line: &str) -> Option<&str> {
    let mut rest = line.trim_start();
    if let Some(after) = rest.strip_prefix("pub") {
        rest = after.trim_start();
        if rest.starts_with('(') {
            rest = rest.split_once(')').map(|(_, after)| after.trim_start())?;
        }
    }
    let (_, rhs) = rest.strip_prefix("type ")?.split_once('=')?;
    let rhs = rhs.trim().trim_end_matches(';').trim();
    INTEGERS.contains(&rhs).then_some(rhs)
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
fn no_crate_aliases_an_integer() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    rust_files(crates, &mut files).unwrap();
    let mut found = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        for (n, line) in text.lines().enumerate() {
            if let Some(int) = aliased_integer(line) {
                let at = file.strip_prefix(crates).unwrap().display();
                found.push(format!(
                    "crates/{at}:{}: `{}` aliases {int}",
                    n + 1,
                    line.trim()
                ));
            }
        }
    }
    assert!(
        found.is_empty(),
        "An integer alias lets any integer pass where the alias is meant. Money is \
         `service_kit::money::Amount`; any other kind of value gets its own newtype (`pub struct Name(i128);`) \
         with only the operations it needs (copy crates/service-kit/src/money.rs).\n{}",
        found.join("\n")
    );
}

#[test]
fn reads_the_alias_that_was_money() {
    assert_eq!(aliased_integer("pub type Amount = i128;"), Some("i128"));
    assert_eq!(aliased_integer("  pub(crate) type Bps = u32;"), Some("u32"));
    assert_eq!(aliased_integer("type Millis = i64;"), Some("i64"));
    assert_eq!(aliased_integer("pub struct Amount(i128);"), None);
    assert_eq!(aliased_integer("type Out = Result<i128, String>;"), None);
    assert_eq!(aliased_integer("let typed = i128::MAX;"), None);
}
