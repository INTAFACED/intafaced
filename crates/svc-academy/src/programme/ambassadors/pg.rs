//! How postgres.js hands values across, for the area's SQL: a parameter goes as untyped text that the server reads as
//! the column's type (uuid, an enum, text), and a uuid or enum comes back as its text. `Text` and `Param` keep the
//! TypeScript's SQL as written (no `::text` casts); [`ms`] reads a `timestamptz` as the JavaScript `Date` postgres.js
//! makes of it (milliseconds, the rest dropped).

use std::error::Error;
use std::time::{SystemTime, UNIX_EPOCH};

use postgres::types::private::BytesMut;
use postgres::types::{FromSql, IsNull, Kind, ToSql, Type, to_sql_checked};

type BoxError = Box<dyn Error + Sync + Send>;

fn texty(ty: &Type) -> bool {
    matches!(
        *ty,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN
    ) || matches!(ty.kind(), Kind::Enum(_))
}

/// A text, uuid or enum value as postgres.js returns it: its text (a uuid lower-case and hyphenated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Text(pub String);

impl<'a> FromSql<'a> for Text {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Text, BoxError> {
        if *ty == Type::UUID {
            let bytes: &[u8; 16] = raw.try_into().map_err(|_| "a uuid is 16 bytes")?;
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let part = |a: usize, b: usize| hex.get(a..b).unwrap_or_default().to_owned();
            return Ok(Text(format!(
                "{}-{}-{}-{}-{}",
                part(0, 8),
                part(8, 12),
                part(12, 16),
                part(16, 20),
                part(20, 32)
            )));
        }
        Ok(Text(std::str::from_utf8(raw)?.to_owned()))
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::UUID || texty(ty)
    }
}

/// A parameter as postgres.js sends a string: text the server reads as the column's type. A uuid that does not parse
/// fails as the server's cast would.
#[derive(Debug, Clone, Copy)]
pub struct Param<'a>(pub &'a str);

impl ToSql for Param<'_> {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> Result<IsNull, BoxError> {
        if *ty == Type::UUID {
            let hex: String = self.0.chars().filter(|c| *c != '-').collect();
            let well_formed = hex.len() == 32
                && hex.chars().all(|c| c.is_ascii_hexdigit())
                && (self.0.len() == 32 || self.0.len() == 36);
            if !well_formed {
                return Err(format!("invalid input syntax for type uuid: \"{}\"", self.0).into());
            }
            for i in 0..16 {
                let pair = hex.get(i * 2..i * 2 + 2).ok_or("uuid")?;
                out.extend_from_slice(&[u8::from_str_radix(pair, 16)?]);
            }
            return Ok(IsNull::No);
        }
        out.extend_from_slice(self.0.as_bytes());
        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::UUID || texty(ty)
    }

    to_sql_checked!();
}

/// A `timestamptz` as a JavaScript `Date`: whole milliseconds since the epoch.
pub fn ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => {
            let back = e.duration();
            let whole = i64::try_from(back.as_millis()).unwrap_or(i64::MAX);
            // floor: a time before the epoch with a fraction of a millisecond rounds down, as `Date` does.
            if back.as_nanos() % 1_000_000 == 0 {
                -whole
            } else {
                -whole - 1
            }
        }
    }
}
