//! Who may call: the scope check (`packages/auth/src/guards.ts`) and the jurisdiction check
//! (`packages/config/src/jurisdiction.ts` `checkAccess`, `screening.ts`) for svc-tax's one module, `tax`, on the fiat
//! plane.
//!
//! The TypeScript reads the process environment on each call; this reads the same variables once, when the service is
//! put together, from the map it is given.

use std::collections::BTreeMap;

/// A refusal from the guard, in the form tRPC sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// The tRPC code: `FORBIDDEN`.
    pub message: String,
    /// `intafacedCode` and `cause.code`: `scope.denied`, `denied.region_blocked`, ...
    pub code: String,
}

/// `requireScope` for a tax scope. svc-tax's two scopes imply nothing and are in none of the key-forbidden, person-only
/// or two-factor lists (`packages/auth/src/scopes.ts`), so holding the scope is the whole check.
pub fn require_scope(scopes: &[String], scope: &str) -> Result<(), Refused> {
    if scopes.iter().any(|s| s == scope) {
        Ok(())
    } else {
        Err(Refused {
            message: format!("Scope \"{scope}\" is required"),
            code: "scope.denied".to_owned(),
        })
    }
}

/// One region the screening list or the business refuses, with why.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Blocked {
    region: String,
    reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Declaration {
    Unset,
    Listed,
    ReviewedEmpty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScreeningList {
    regions: Vec<Blocked>,
    declaration: Declaration,
    source: String,
}

/// What the jurisdiction check reads from the environment, read once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Jurisdiction {
    screening: ScreeningList,
    business: Vec<Blocked>,
    region_fail_closed: bool,
    screening_fail_closed: bool,
}

const SANCTIONS_REGIONS_ENV: &str = "INTAFACED_SANCTIONS_REGIONS";
const SANCTIONS_SOURCE_ENV: &str = "INTAFACED_SANCTIONS_LIST_SOURCE";
const UNSIGNED_SANCTIONS_ROWS_ENV: &str = "INTAFACED_UNSIGNED_SANCTIONS_ROWS";
const TEST_BUSINESS_BLOCKS_ENV: &str = "INTAFACED_TEST_BUSINESS_BLOCKS";
const REGION_FAIL_CLOSED_ENV: &str = "INTAFACED_REGION_FAIL_CLOSED";
const SCREENING_FAIL_CLOSED_ENV: &str = "INTAFACED_SCREENING_FAIL_CLOSED";
const UNRESOLVED_REGION: &str = "XX";

/// `SANCTIONED_LIST_ROWS` (`packages/config/src/screening.ts`): unsigned, so used only when APP_ENV is dev or test.
const SANCTIONED_LIST_ROWS: [(&str, &str); 8] = [
    (
        "CU",
        "Cuba: comprehensively sanctioned (OFAC Cuba sanctions)",
    ),
    (
        "IR",
        "Iran: comprehensively sanctioned (OFAC Iran sanctions)",
    ),
    (
        "KP",
        "North Korea: comprehensively sanctioned (OFAC North Korea sanctions)",
    ),
    (
        "SY",
        "Syria: comprehensively sanctioned (OFAC Syria sanctions)",
    ),
    (
        "UA-43",
        "Crimea region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)",
    ),
    (
        "UA-40",
        "Sevastopol, Crimea region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)",
    ),
    (
        "UA-14",
        "Donetsk region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)",
    ),
    (
        "UA-09",
        "Luhansk region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)",
    ),
];
const SANCTIONED_ROWS_SOURCE_UNSIGNED: &str = "config:SANCTIONED_LIST_ROWS (unsigned, agents' reading, not Hyperliquid's text; dev/test only)";

/// The shipped matrix's business blocks (`JURISDICTION_MATRIX`, `blocked: true`). The matrix has no `tax` row, so the
/// module's rule everywhere is its default: open, no verification tier.
const SHIPPED_BUSINESS_BLOCKS: [(&str, &str); 2] = [
    ("US", "The United States is not served at launch."),
    ("CA-ON", "Ontario, Canada is not served at launch."),
];

const FIXTURE_MARKERS: [&str; 3] = ["placeholder", "test-fixture", "not-a-real-list"];

fn is_dev_or_test(env: &BTreeMap<String, String>) -> bool {
    matches!(env.get("APP_ENV").map(String::as_str), Some("dev" | "test"))
}

fn env_lower(env: &BTreeMap<String, String>, key: &str) -> String {
    env.get(key)
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_default()
}

/// `/^[A-Za-z]{2}(?:-[A-Za-z0-9]{1,3})?$/`.
fn is_region_code(code: &str) -> bool {
    let b = code.as_bytes();
    let country = b.len() >= 2 && b.iter().take(2).all(u8::is_ascii_alphabetic);
    match b.get(2) {
        None => country,
        Some(b'-') => {
            country && (4..=6).contains(&b.len()) && b.iter().skip(3).all(u8::is_ascii_alphanumeric)
        }
        Some(_) => false,
    }
}

/// `regionCodeChain`: `CA-ON` answers to `CA-ON` then `CA`; a country only to itself.
fn region_chain(region: &str) -> Vec<String> {
    let code = region.trim().to_uppercase();
    let b = code.as_bytes();
    let subdivision = b.len() >= 4
        && b.len() <= 6
        && b.iter().take(2).all(u8::is_ascii_uppercase)
        && b.get(2) == Some(&b'-')
        && b.iter()
            .skip(3)
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    match code.get(0..2) {
        Some(country) if subdivision => vec![code.clone(), country.to_owned()],
        _ => vec![code],
    }
}

fn is_user_assigned(code: &str) -> bool {
    let up = code.trim().to_uppercase();
    let b = up.as_bytes();
    up != "XK"
        && (up == "AA"
            || up == "ZZ"
            || (b.len() == 2 && b.first() == Some(&b'Q') && matches!(b.get(1), Some(b'M'..=b'Z')))
            || (b.len() == 2
                && b.first() == Some(&b'X')
                && b.get(1).is_some_and(u8::is_ascii_uppercase)))
}

/// `parseScreeningList`: the env override.
fn parse_screening(raw: &str, source: Option<&String>) -> Result<ScreeningList, String> {
    let trimmed = raw.trim();
    let attribution = source.map(|s| s.trim().to_owned()).unwrap_or_default();
    if trimmed.to_lowercase() == "none" {
        if attribution.is_empty() {
            return Err(format!(
                "{SANCTIONS_REGIONS_ENV}=\"{trimmed}\" needs an attributable source"
            ));
        }
        return Ok(ScreeningList {
            regions: Vec::new(),
            declaration: Declaration::ReviewedEmpty,
            source: attribution,
        });
    }
    let provenance = if attribution.is_empty() {
        format!("env:{SANCTIONS_REGIONS_ENV}")
    } else {
        attribution
    };
    let mut issues = Vec::new();
    let mut regions: Vec<Blocked> = Vec::new();
    for (i, item) in trimmed.split(',').enumerate() {
        let entry = item.trim();
        if entry.is_empty() {
            continue;
        }
        let (code, reason) = match entry.split_once(':') {
            Some((c, r)) => (c.trim(), r.trim()),
            None => (entry, ""),
        };
        if !is_region_code(code) {
            issues.push(format!(
                "entry {} — expected an ISO 3166-1 alpha-2 or ISO 3166-2 code",
                i + 1
            ));
            continue;
        }
        let upper = code.to_uppercase();
        if regions.iter().any(|r| r.region == upper) {
            issues.push(format!("entry {} repeats an earlier region", i + 1));
            continue;
        }
        let reason = if reason.is_empty() {
            format!("Not served in {upper} (sanctions screening, §24 Lane A)")
        } else {
            reason.to_owned()
        };
        regions.push(Blocked {
            region: upper,
            reason: Some(reason),
        });
    }
    if !issues.is_empty() {
        return Err(format!(
            "Invalid {SANCTIONS_REGIONS_ENV}:\n  - {}",
            issues.join("\n  - ")
        ));
    }
    if regions.is_empty() {
        return Ok(unset());
    }
    Ok(ScreeningList {
        regions,
        declaration: Declaration::Listed,
        source: provenance,
    })
}

fn unset() -> ScreeningList {
    ScreeningList {
        regions: Vec::new(),
        declaration: Declaration::Unset,
        source: "unconfigured".to_owned(),
    }
}

impl Jurisdiction {
    /// `envScreeningList`, `activeBusinessBlocks` and the two fail-closed switches, from `env`. A malformed list or TEST
    /// block is refused here, at start-up, where the TypeScript throws on the first call that reads it.
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Jurisdiction, String> {
        let raw = env
            .get(SANCTIONS_REGIONS_ENV)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();
        let screening = if !raw.is_empty() {
            parse_screening(&raw, env.get(SANCTIONS_SOURCE_ENV))?
        } else if is_dev_or_test(env) && env_lower(env, UNSIGNED_SANCTIONS_ROWS_ENV) != "off" {
            // The rows carry no owner signature yet, so they screen only dev and test processes.
            ScreeningList {
                regions: SANCTIONED_LIST_ROWS
                    .iter()
                    .map(|(r, why)| Blocked {
                        region: (*r).to_owned(),
                        reason: Some((*why).to_owned()),
                    })
                    .collect(),
                declaration: Declaration::Listed,
                source: SANCTIONED_ROWS_SOURCE_UNSIGNED.to_owned(),
            }
        } else {
            unset()
        };
        let mut business: Vec<Blocked> = SHIPPED_BUSINESS_BLOCKS
            .iter()
            .map(|(r, why)| Blocked {
                region: (*r).to_owned(),
                reason: Some((*why).to_owned()),
            })
            .collect();
        let test_raw = env
            .get(TEST_BUSINESS_BLOCKS_ENV)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();
        if !test_raw.is_empty() && is_dev_or_test(env) {
            for item in test_raw.split(',') {
                let code = item
                    .trim()
                    .strip_prefix("TEST:")
                    .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()));
                match code {
                    Some(c) if is_user_assigned(c) => business.push(Blocked {
                        region: c.to_uppercase(),
                        reason: Some("TEST region, not served at launch".to_owned()),
                    }),
                    _ => {
                        return Err(format!(
                            "{TEST_BUSINESS_BLOCKS_ENV}: each entry must be TEST:<a user-assigned ISO code such as AA> (value not shown)"
                        ));
                    }
                }
            }
        }
        let region_fail_closed = matches!(
            env_lower(env, REGION_FAIL_CLOSED_ENV).as_str(),
            "1" | "true" | "yes" | "on"
        );
        let off = matches!(
            env_lower(env, SCREENING_FAIL_CLOSED_ENV).as_str(),
            "0" | "false" | "no" | "off"
        );
        let screening_fail_closed = !(off && is_dev_or_test(env));
        Ok(Jurisdiction {
            screening,
            business,
            region_fail_closed,
            screening_fail_closed,
        })
    }

    fn money_grade(&self) -> &'static str {
        if self.screening.declaration == Declaration::Unset {
            return "unconfigured";
        }
        let texts = std::iter::once(self.screening.source.as_str()).chain(
            self.screening
                .regions
                .iter()
                .filter_map(|r| r.reason.as_deref()),
        );
        let fixture = texts.into_iter().any(|t| {
            let lower = t.to_lowercase();
            FIXTURE_MARKERS.iter().any(|m| lower.contains(m))
        });
        if fixture { "fixture" } else { "counsel" }
    }

    fn hit<'a>(list: &'a [Blocked], region: &str) -> Option<&'a Blocked> {
        let code = region.trim().to_uppercase();
        if code.is_empty() || code == UNRESOLVED_REGION {
            return None;
        }
        region_chain(&code)
            .iter()
            .find_map(|c| list.iter().find(|b| b.region == *c))
    }

    /// `checkAccess({ module: 'tax', plane: 'fiat', region, kycTier })`: allowed, or the refusal with its code.
    pub fn check_tax(&self, region: &str) -> Result<(), Refused> {
        let grade = self.money_grade();
        if self.screening_fail_closed && grade == "unconfigured" {
            return Err(Refused {
                code: "denied.screening_unconfigured".to_owned(),
                message: format!(
                    "Sanctions screening list is unset — nothing was consulted. Hosted access refuses under {SCREENING_FAIL_CLOSED_ENV}. \
                     Counsel/Nitro must supply {SANCTIONS_REGIONS_ENV} (or attributed \"none\"); agents must not invent list content."
                ),
            });
        }
        if self.screening_fail_closed && grade == "fixture" {
            return Err(Refused {
                code: "denied.screening_fixture".to_owned(),
                message: format!(
                    "Sanctions screening list is a placeholder/test fixture — not counsel. Must not be read as screened clean. \
                     Hosted access refuses under {SCREENING_FAIL_CLOSED_ENV}. Replace fixture provenance with a governance record; \
                     agents must not invent country codes."
                ),
            });
        }
        let canonical = region.trim().to_uppercase();
        let resolved = !(canonical.is_empty() || canonical == UNRESOLVED_REGION);
        if !resolved && self.region_fail_closed {
            return Err(Refused {
                code: "denied.region_unknown".to_owned(),
                message: format!(
                    "Caller region is unresolved ({UNRESOLVED_REGION}). Hosted access refuses under {REGION_FAIL_CLOSED_ENV}. \
                     Set a real DEFAULT_REGION or close §13 socket.geo-region-resolution; do not treat {UNRESOLVED_REGION} as a \
                     restrictive jurisdiction — it is not."
                ),
            });
        }
        // Screening wins the attribution when both name the region.
        let screened = Self::hit(&self.screening.regions, region);
        let business = Self::hit(&self.business, region);
        if screened.is_some() || business.is_some() {
            let reason = screened
                .and_then(|b| b.reason.clone())
                .or_else(|| business.and_then(|b| b.reason.clone()));
            return Err(Refused {
                code: "denied.region_blocked".to_owned(),
                message: reason.unwrap_or_else(|| format!("Not served in {region}")),
            });
        }
        // The tax rule is open with no tier everywhere, so neither `denied.module_blocked` nor `denied.kyc_required` can
        // be reached for this module.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn refuses_blocked_and_screened_regions_and_fails_closed_without_a_list() {
        let test = Jurisdiction::from_env(&env(&[
            ("APP_ENV", "test"),
            (SCREENING_FAIL_CLOSED_ENV, "off"),
        ]))
        .unwrap();
        assert_eq!(test.check_tax("DE"), Ok(()));
        assert_eq!(
            test.check_tax("us").unwrap_err().message,
            "The United States is not served at launch."
        );
        assert_eq!(
            test.check_tax("CA-ON").unwrap_err().code,
            "denied.region_blocked"
        );
        assert_eq!(test.check_tax("CA-QC"), Ok(()));
        assert!(
            test.check_tax("UA-43")
                .unwrap_err()
                .message
                .starts_with("Crimea")
        );
        assert_eq!(test.check_tax("XX"), Ok(()));
        let prod = Jurisdiction::from_env(&env(&[
            ("APP_ENV", "prod"),
            (SCREENING_FAIL_CLOSED_ENV, "off"),
        ]))
        .unwrap();
        assert_eq!(
            prod.check_tax("DE").unwrap_err().code,
            "denied.screening_unconfigured"
        );
        let listed =
            Jurisdiction::from_env(&env(&[(SANCTIONS_REGIONS_ENV, "DE:counsel says no")])).unwrap();
        assert_eq!(
            listed.check_tax("de").unwrap_err().message,
            "counsel says no"
        );
        let fixture =
            Jurisdiction::from_env(&env(&[(SANCTIONS_REGIONS_ENV, "AA:placeholder")])).unwrap();
        assert_eq!(
            fixture.check_tax("DE").unwrap_err().code,
            "denied.screening_fixture"
        );
        assert!(Jurisdiction::from_env(&env(&[(SANCTIONS_REGIONS_ENV, "D3")])).is_err());
    }
}
