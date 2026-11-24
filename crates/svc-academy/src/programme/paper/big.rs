//! A signed integer of any width, for the drill valuation's sums (`simulated-result.ts` adds and multiplies bigint
//! amounts with no width limit). A published price and size each fit `numeric(38,18)`, but their products and the sums
//! of up to 256 of them do not fit an i128, and the TypeScript reports them exactly; so does this.

use std::cmp::Ordering;

use service_kit::money::Amount;

/// Sign and magnitude; the magnitude is little-endian 32-bit limbs with no high zero limb (zero is empty).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Big {
    negative: bool,
    mag: Vec<u32>,
}

/// `10n ** 18n`.
const SCALE: u64 = 1_000_000_000_000_000_000;

fn trim(mut v: Vec<u32>) -> Vec<u32> {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

fn mag_cmp(a: &[u32], b: &[u32]) -> Ordering {
    a.len()
        .cmp(&b.len())
        .then_with(|| a.iter().rev().cmp(b.iter().rev()))
}

fn mag_add(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len().max(b.len()) + 1);
    let mut carry = 0u64;
    for i in 0..a.len().max(b.len()) {
        let s = u64::from(*a.get(i).unwrap_or(&0)) + u64::from(*b.get(i).unwrap_or(&0)) + carry;
        out.push(low(s));
        carry = s >> 32;
    }
    if carry > 0 {
        out.push(low(carry));
    }
    trim(out)
}

/// `a - b` for `a >= b`.
fn mag_sub(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len());
    let mut borrow = 0i64;
    for (i, &x) in a.iter().enumerate() {
        let mut d = i64::from(x) - i64::from(*b.get(i).unwrap_or(&0)) - borrow;
        if d < 0 {
            d += 1 << 32;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out.push(u32::try_from(d).unwrap_or(0));
    }
    trim(out)
}

fn low(x: u64) -> u32 {
    u32::try_from(x & 0xffff_ffff).unwrap_or(0)
}

fn mag_mul(a: &[u32], b: &[u32]) -> Vec<u32> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0u32; a.len() + b.len()];
    for (i, &x) in a.iter().enumerate() {
        let mut carry = 0u64;
        for (slot, &y) in out.iter_mut().skip(i).zip(b) {
            let t = u64::from(x) * u64::from(y) + u64::from(*slot) + carry;
            *slot = low(t);
            carry = t >> 32;
        }
        // The product of an m- and an n-word number fits m + n words, so the carry always lands.
        for slot in out.iter_mut().skip(i + b.len()) {
            if carry == 0 {
                break;
            }
            let t = u64::from(*slot) + carry;
            *slot = low(t);
            carry = t >> 32;
        }
    }
    trim(out)
}

fn bit_len(a: &[u32]) -> usize {
    a.last().map_or(0, |top| {
        (a.len() - 1) * 32 + (32 - top.leading_zeros() as usize)
    })
}

fn bit(a: &[u32], i: usize) -> bool {
    a.get(i / 32).is_some_and(|w| (w >> (i % 32)) & 1 == 1)
}

fn shl1(a: &mut Vec<u32>, bit_in: bool) {
    let mut carry = u32::from(bit_in);
    for w in a.iter_mut() {
        let next = *w >> 31;
        *w = (*w << 1) | carry;
        carry = next;
    }
    if carry > 0 {
        a.push(carry);
    }
}

/// `(a / d, a % d)` on magnitudes, `d` nonzero: binary long division.
fn mag_divmod(a: &[u32], d: &[u32]) -> (Vec<u32>, Vec<u32>) {
    let n = bit_len(a);
    let mut q = vec![0u32; a.len()];
    let mut r: Vec<u32> = Vec::new();
    for i in (0..n).rev() {
        shl1(&mut r, bit(a, i));
        r = trim(r);
        if mag_cmp(&r, d) != Ordering::Less {
            r = mag_sub(&r, d);
            if let Some(w) = q.get_mut(i / 32) {
                *w |= 1 << (i % 32);
            }
        }
    }
    (trim(q), r)
}

fn mag_of_u128(mut v: u128) -> Vec<u32> {
    let mut out = Vec::new();
    while v > 0 {
        out.push(u32::try_from(v & 0xffff_ffff).unwrap_or(0));
        v >>= 32;
    }
    out
}

impl Big {
    pub fn zero() -> Big {
        Big {
            negative: false,
            mag: Vec::new(),
        }
    }

    pub fn from_amount(v: Amount) -> Big {
        Big {
            negative: v.is_negative(),
            mag: mag_of_u128(v.scaled().unsigned_abs()),
        }
    }

    fn make(negative: bool, mag: Vec<u32>) -> Big {
        let mag = trim(mag);
        Big {
            negative: negative && !mag.is_empty(),
            mag,
        }
    }

    pub fn is_zero(&self) -> bool {
        self.mag.is_empty()
    }

    pub fn is_negative(&self) -> bool {
        self.negative
    }

    pub fn is_positive(&self) -> bool {
        !self.negative && !self.mag.is_empty()
    }

    pub fn neg(&self) -> Big {
        Big::make(!self.negative, self.mag.clone())
    }

    pub fn add(&self, other: &Big) -> Big {
        if self.negative == other.negative {
            return Big::make(self.negative, mag_add(&self.mag, &other.mag));
        }
        match mag_cmp(&self.mag, &other.mag) {
            Ordering::Less => Big::make(other.negative, mag_sub(&other.mag, &self.mag)),
            _ => Big::make(self.negative, mag_sub(&self.mag, &other.mag)),
        }
    }

    pub fn sub(&self, other: &Big) -> Big {
        self.add(&other.neg())
    }

    pub fn mul(&self, other: &Big) -> Big {
        Big::make(
            self.negative != other.negative,
            mag_mul(&self.mag, &other.mag),
        )
    }

    /// `divideScaled(numerator, denominator, 'half-up')`: the quotient rounded half away from zero; `None` for a zero
    /// denominator (`MoneyError('Division by zero')`).
    pub fn divide_half_up(&self, d: &Big) -> Option<Big> {
        if d.is_zero() {
            return None;
        }
        let negative = self.negative != d.negative;
        let (q, r) = mag_divmod(&self.mag, &d.mag);
        let twice = mag_add(&r, &r);
        let q = if !r.is_empty() && mag_cmp(&twice, &d.mag) != Ordering::Less {
            mag_add(&q, &[1])
        } else {
            q
        };
        Some(Big::make(negative, q))
    }

    fn scale() -> Big {
        Big::from_amount(Amount::ONE)
    }

    /// `mul(a, b, 'half-up')`: two scaled amounts multiplied.
    pub fn mul_scaled(&self, other: &Big) -> Big {
        self.mul(other)
            .divide_half_up(&Big::scale())
            .unwrap_or_else(Big::zero)
    }

    /// `div(a, b, 'half-up')`: two scaled amounts divided; `None` when `b` is zero.
    pub fn div_scaled(&self, other: &Big) -> Option<Big> {
        self.mul(&Big::scale()).divide_half_up(other)
    }

    pub fn compare(&self, other: &Big) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => mag_cmp(&self.mag, &other.mag),
            (true, true) => mag_cmp(&other.mag, &self.mag),
        }
    }

    fn decimal(mag: &[u32]) -> String {
        if mag.is_empty() {
            return "0".to_owned();
        }
        let billion = mag_of_u128(1_000_000_000);
        let mut chunks = Vec::new();
        let mut rest = mag.to_vec();
        while !rest.is_empty() {
            let (q, r) = mag_divmod(&rest, &billion);
            chunks.push(r.first().copied().unwrap_or(0));
            rest = q;
        }
        let mut out = chunks.pop().map_or_else(String::new, |c| c.to_string());
        while let Some(c) = chunks.pop() {
            out.push_str(&format!("{c:09}"));
        }
        out
    }

    /// `formatAmount`: the shortest decimal string, no trailing zeros, `-` for a negative.
    pub fn format_amount(&self) -> String {
        let (whole, frac) = mag_divmod(&self.mag, &mag_of_u128(u128::from(SCALE)));
        let sign = if self.negative { "-" } else { "" };
        let whole = Big::decimal(&whole);
        if frac.is_empty() {
            return format!("{sign}{whole}");
        }
        let digits = format!("{:0>18}", Big::decimal(&frac));
        format!("{sign}{whole}.{}", digits.trim_end_matches('0'))
    }
}
