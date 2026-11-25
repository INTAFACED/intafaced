//! The share card (`composeCard` in `services/svc-blueprint/src/card/compose.ts`), byte for byte: a pure function of
//! the profile and the crew, no clock, no randomness, no I/O. Every string that reaches the SVG is escaped. No personal
//! data is drawn: the five axes, the crew role, the tone register and the crew's public name.
//!
//! The colours and the font stacks are the design system's own (`packages/ui/src/tokens.ts`, `color` and `font`), read
//! from that file at build time so the card never holds a second copy of the brand. `tests/card_parity.rs` holds every
//! card to what the TypeScript drew (`tests/fixtures/card.golden.json`).

use std::sync::OnceLock;

/// The design system's tokens, the one place a colour is written.
const TOKENS_TS: &str = include_str!("../../../../packages/ui/src/tokens.ts");

/// `CARD_DIMENSIONS` (`packages/contracts/src/blueprint.ts`).
pub fn dimensions(size: Size) -> (u32, u32) {
    match size {
        Size::Portrait => (1080, 1350),
        Size::Landscape => (1200, 630),
    }
}

/// `cardSizeSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Portrait,
    Landscape,
}

impl Size {
    pub fn parse(s: &str) -> Option<Size> {
        match s {
            "portrait" => Some(Size::Portrait),
            "landscape" => Some(Size::Landscape),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Size::Portrait => "portrait",
            Size::Landscape => "landscape",
        }
    }
}

/// What the card draws (`CardSubject`): the profile's tokens and the crew, when placed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub decision_style: String,
    pub risk_temperament: String,
    pub energy_rhythm: String,
    pub learning_mode: String,
    pub crew_role: String,
    pub curriculum_path: String,
    pub tone_register: String,
    pub crew_name: Option<String>,
    pub season: Option<i64>,
}

/// `AXIS_LABELS`.
const LABELS: [(&str, &str); 27] = [
    ("analytical", "Analytical"),
    ("intuitive", "Intuitive"),
    ("collaborative", "Collaborative"),
    ("decisive", "Decisive"),
    ("guarded", "Guarded"),
    ("measured", "Measured"),
    ("assertive", "Assertive"),
    ("bold", "Bold"),
    ("dawn", "Dawn"),
    ("steady", "Steady"),
    ("surge", "Surge"),
    ("nocturnal", "Nocturnal"),
    ("visual", "Visual"),
    ("narrative", "Narrative"),
    ("hands_on", "Hands-on"),
    ("systematic", "Systematic"),
    ("anchor", "Anchor"),
    ("scout", "Scout"),
    ("builder", "Builder"),
    ("catalyst", "Catalyst"),
    ("foundations", "Foundations"),
    ("markets", "Markets"),
    ("sovereign", "Sovereign"),
    ("direct", "Direct"),
    ("warm", "Warm"),
    ("socratic", "Socratic"),
    ("terse", "Terse"),
];

/// `label`: the token's label, or the token itself.
fn label(token: &str) -> &str {
    LABELS
        .iter()
        .find(|(t, _)| *t == token)
        .map_or(token, |(_, l)| l)
}

/// `escapeXml`.
pub fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// `PALETTE` and the two font stacks.
struct Palette {
    base: String,
    raised: String,
    accent: String,
    accent_bright: String,
    glow: String,
    border: String,
    text: String,
    muted: String,
    font_display: String,
    font_body: String,
}

/// The entries of `export const <name> = { ... } as const;` in `tokens.ts`: `key: '<value>'` or `key: "<value>"`.
fn token_block(name: &str) -> Result<Vec<(&'static str, &'static str)>, String> {
    let start = format!("export const {name} = {{");
    let at = TOKENS_TS
        .find(&start)
        .ok_or_else(|| format!("tokens.ts: no `{start}`"))?;
    let body = TOKENS_TS.get(at + start.len()..).unwrap_or("");
    let end = body
        .find("} as const;")
        .ok_or_else(|| format!("tokens.ts: `{name}` does not end"))?;
    let mut out = Vec::new();
    for line in body.get(..end).unwrap_or("").lines() {
        let line = line.trim();
        let Some((key, rest)) = line.split_once(": ") else {
            continue;
        };
        if !key.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let rest = rest.strip_suffix(',').unwrap_or(rest);
        let value = rest
            .strip_prefix('\'')
            .and_then(|r| r.strip_suffix('\''))
            .or_else(|| rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')));
        if let Some(value) = value {
            out.push((key, value));
        }
    }
    Ok(out)
}

fn palette() -> Result<&'static Palette, String> {
    static PALETTE: OnceLock<Result<Palette, String>> = OnceLock::new();
    PALETTE
        .get_or_init(|| {
            let color = token_block("color")?;
            let font = token_block("font")?;
            let pick = |block: &[(&str, &str)], key: &str| {
                block
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| (*v).to_owned())
                    .ok_or_else(|| format!("tokens.ts: no {key}"))
            };
            Ok(Palette {
                base: pick(&color, "base")?,
                raised: pick(&color, "surfaceRaised")?,
                accent: pick(&color, "accent")?,
                accent_bright: pick(&color, "accentBright")?,
                glow: pick(&color, "accentGlow")?,
                border: pick(&color, "borderStrong")?,
                text: pick(&color, "text")?,
                muted: pick(&color, "textMuted")?,
                font_display: pick(&font, "display")?,
                font_body: pick(&font, "body")?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The five axes, in §7.1's order.
fn axis_rows(s: &Subject) -> [(&'static str, &str); 5] {
    [
        ("Decision", label(&s.decision_style)),
        ("Risk", label(&s.risk_temperament)),
        ("Rhythm", label(&s.energy_rhythm)),
        ("Learning", label(&s.learning_mode)),
        ("Path", label(&s.curriculum_path)),
    ]
}

fn defs(p: &Palette, width: u32, height: u32) -> String {
    [
        "<defs>".to_owned(),
        r#"<radialGradient id="ifc-glow" cx="50%" cy="0%" r="85%">"#.to_owned(),
        format!(
            r#"<stop offset="0%" stop-color="{}" stop-opacity="0.28"/>"#,
            p.accent
        ),
        format!(
            r#"<stop offset="60%" stop-color="{}" stop-opacity="0.05"/>"#,
            p.accent
        ),
        format!(
            r#"<stop offset="100%" stop-color="{}" stop-opacity="0"/>"#,
            p.base
        ),
        "</radialGradient>".to_owned(),
        r#"<linearGradient id="ifc-rule" x1="0" y1="0" x2="1" y2="0">"#.to_owned(),
        format!(r#"<stop offset="0%" stop-color="{}"/>"#, p.accent),
        format!(
            r#"<stop offset="100%" stop-color="{}" stop-opacity="0"/>"#,
            p.accent
        ),
        "</linearGradient>".to_owned(),
        r#"<pattern id="ifc-grid" width="60" height="60" patternUnits="userSpaceOnUse">"#
            .to_owned(),
        format!(
            r#"<path d="M60 0H0V60" fill="none" stroke="{}" stroke-width="1"/>"#,
            p.border
        ),
        "</pattern>".to_owned(),
        "</defs>".to_owned(),
        format!(
            r#"<rect width="{width}" height="{height}" fill="{}"/>"#,
            p.base
        ),
        format!(r#"<rect width="{width}" height="{height}" fill="url(#ifc-grid)"/>"#),
        format!(r#"<rect width="{width}" height="{height}" fill="url(#ifc-glow)"/>"#),
    ]
    .concat()
}

/// `text`'s attributes.
struct T<'a> {
    x: i64,
    y: i64,
    size: u32,
    fill: &'a str,
    family: Option<&'a str>,
    weight: Option<u32>,
    spacing: Option<i32>,
    anchor: Option<&'a str>,
}

impl<'a> T<'a> {
    fn at(x: i64, y: i64, size: u32, fill: &'a str) -> T<'a> {
        T {
            x,
            y,
            size,
            fill,
            family: None,
            weight: None,
            spacing: None,
            anchor: None,
        }
    }
    fn family(mut self, f: &'a str) -> Self {
        self.family = Some(f);
        self
    }
    fn weight(mut self, w: u32) -> Self {
        self.weight = Some(w);
        self
    }
    fn spacing(mut self, s: i32) -> Self {
        self.spacing = Some(s);
        self
    }
    fn anchor(mut self, a: &'a str) -> Self {
        self.anchor = Some(a);
        self
    }
}

fn text(p: &Palette, content: &str, a: &T<'_>) -> String {
    let mut parts = vec![
        format!(r#"x="{}""#, a.x),
        format!(r#"y="{}""#, a.y),
        format!(
            r#"font-family="{}""#,
            escape_xml(a.family.unwrap_or(&p.font_body))
        ),
        format!(r#"font-size="{}""#, a.size),
        format!(r#"fill="{}""#, a.fill),
    ];
    if let Some(w) = a.weight {
        parts.push(format!(r#"font-weight="{w}""#));
    }
    if let Some(s) = a.spacing {
        parts.push(format!(r#"letter-spacing="{s}""#));
    }
    if let Some(anchor) = a.anchor {
        parts.push(format!(r#"text-anchor="{anchor}""#));
    }
    format!("<text {}>{}</text>", parts.join(" "), escape_xml(content))
}

/// `crewLine`: the crew, its season, or an honest absence.
fn crew_line(s: &Subject) -> String {
    match (s.crew_name.as_deref().filter(|n| !n.is_empty()), s.season) {
        (None, _) => "Unplaced".to_owned(),
        (Some(name), None) => name.to_owned(),
        (Some(name), Some(season)) => format!("{name} · Season {season}"),
    }
}

/// JavaScript's `toUpperCase` for the strings the card upper-cases (labels and tokens).
fn upper(s: &str) -> String {
    s.to_uppercase()
}

fn portrait(p: &Palette, s: &Subject) -> String {
    let (width, height) = dimensions(Size::Portrait);
    let (w, h) = (i64::from(width), i64::from(height));
    let margin: i64 = 90;
    let axes: String = axis_rows(s)
        .iter()
        .enumerate()
        .map(|(index, (row_label, value))| {
            let y = 700 + i64::try_from(index).unwrap_or(0) * 108;
            [
                format!(
                    r#"<rect x="{margin}" y="{}" width="{}" height="84" rx="14" fill="{}" stroke="{}"/>"#,
                    y - 52,
                    w - margin * 2,
                    p.raised,
                    p.border
                ),
                text(
                    p,
                    &upper(row_label),
                    &T::at(margin + 32, y, 26, &p.muted).weight(600).spacing(3),
                ),
                text(
                    p,
                    value,
                    &T::at(w - margin - 32, y, 38, &p.text)
                        .family(&p.font_display)
                        .weight(700)
                        .anchor("end"),
                ),
            ]
            .concat()
        })
        .collect();
    [
        defs(p, width, height),
        text(
            p,
            "IDENTITY BLUEPRINT",
            &T::at(margin, 150, 30, &p.accent).weight(700).spacing(10),
        ),
        format!(
            r#"<rect x="{margin}" y="182" width="{}" height="3" fill="url(#ifc-rule)"/>"#,
            w - margin * 2
        ),
        text(
            p,
            &upper(label(&s.crew_role)),
            &T::at(margin, 400, 168, &p.text)
                .family(&p.font_display)
                .weight(800)
                .spacing(-2),
        ),
        text(
            p,
            &crew_line(s),
            &T::at(margin, 470, 38, &p.accent_bright).weight(600),
        ),
        format!(
            r#"<rect x="{margin}" y="530" width="330" height="66" rx="33" fill="{}" stroke="{}"/>"#,
            p.glow, p.accent
        ),
        text(
            p,
            &format!("{} voice", label(&s.tone_register)),
            &T::at(margin + 40, 574, 32, &p.accent_bright).weight(600),
        ),
        axes,
        format!(
            r#"<rect x="{margin}" y="{}" width="{}" height="1" fill="{}"/>"#,
            h - 190,
            w - margin * 2,
            p.border
        ),
        text(
            p,
            "INTAFACED",
            &T::at(margin, h - 120, 46, &p.text)
                .family(&p.font_display)
                .weight(800)
                .spacing(8),
        ),
        text(
            p,
            "Sovereign Intelligence",
            &T::at(margin, h - 72, 28, &p.muted),
        ),
        text(
            p,
            "Built by the Neural Engine",
            &T::at(w - margin, h - 72, 26, &p.muted).anchor("end"),
        ),
    ]
    .concat()
}

fn landscape(p: &Palette, s: &Subject) -> String {
    let (width, height) = dimensions(Size::Landscape);
    let (w, h) = (i64::from(width), i64::from(height));
    let margin: i64 = 70;
    let axes: String = axis_rows(s)
        .iter()
        .enumerate()
        .map(|(index, (row_label, value))| {
            let index = i64::try_from(index).unwrap_or(0);
            let column_x = if index < 3 { margin } else { w / 2 + 20 };
            let y = 330 + (index % 3) * 78;
            [
                text(
                    p,
                    &upper(row_label),
                    &T::at(column_x, y, 20, &p.muted).weight(600).spacing(2),
                ),
                text(
                    p,
                    value,
                    &T::at(column_x, y + 34, 32, &p.text)
                        .family(&p.font_display)
                        .weight(700),
                ),
            ]
            .concat()
        })
        .collect();
    [
        defs(p, width, height),
        text(
            p,
            "IDENTITY BLUEPRINT",
            &T::at(margin, 100, 24, &p.accent).weight(700).spacing(8),
        ),
        format!(
            r#"<rect x="{margin}" y="126" width="{}" height="3" fill="url(#ifc-rule)"/>"#,
            w - margin * 2
        ),
        text(
            p,
            &upper(label(&s.crew_role)),
            &T::at(margin, 236, 96, &p.text)
                .family(&p.font_display)
                .weight(800)
                .spacing(-1),
        ),
        text(
            p,
            &crew_line(s),
            &T::at(margin, 282, 28, &p.accent_bright).weight(600),
        ),
        axes,
        format!(
            r#"<rect x="{margin}" y="{}" width="{}" height="1" fill="{}"/>"#,
            h - 92,
            w - margin * 2,
            p.border
        ),
        text(
            p,
            "INTAFACED",
            &T::at(margin, h - 40, 34, &p.text)
                .family(&p.font_display)
                .weight(800)
                .spacing(6),
        ),
        text(
            p,
            "Sovereign Intelligence",
            &T::at(w - margin, h - 40, 22, &p.muted).anchor("end"),
        ),
    ]
    .concat()
}

/// `composeCard(subject, size)` after its zero-PII check (the caller's): the SVG, with its pixel size as attributes and
/// as the viewBox. `Err` only when the design system's tokens cannot be read.
pub fn compose(subject: &Subject, size: Size) -> Result<String, String> {
    let p = palette()?;
    let (width, height) = dimensions(size);
    let body = match size {
        Size::Portrait => portrait(p, subject),
        Size::Landscape => landscape(p, subject),
    };
    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Identity Blueprint card">{body}</svg>"#
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn every_token_the_card_draws_is_read_from_the_design_system() {
        let p = palette().unwrap();
        for v in [
            &p.base,
            &p.raised,
            &p.accent,
            &p.accent_bright,
            &p.glow,
            &p.border,
            &p.text,
            &p.muted,
            &p.font_display,
            &p.font_body,
        ] {
            assert!(!v.is_empty());
        }
    }
}
