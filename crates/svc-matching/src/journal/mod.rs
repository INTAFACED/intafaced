//! The engine journal: every input written down, durable, before the book moves, so a cold start replays it to the
//! book it left. Ported from `services/svc-matching/src/engine/journal*.ts`.
//!
//! The journal records what was asked, never what happened: replaying inputs through the same matcher is what makes
//! the book's state checkable, where a transcript of outcomes would replay a matcher's bug perfectly. Amounts are the
//! decimal strings they arrived as: a journal is read years after it is written, by builds that may not share this
//! one's representation.
//!
//! - `record`: a record and the JavaScript reading rules its fields follow.
//! - `codec`: how a record is written, byte for byte.
//! - `io`: the in-memory and file journals, and how a body is decoded.
//! - `lock`: the file journal's one writer.
//! - `gaps`: holes in the tape, named.
//! - `replay`: the journal's rules for rebuilding the books, the snapshot and where it goes.

pub mod codec;
pub mod gaps;
pub mod io;
pub mod lock;
pub mod record;
pub mod replay;

use std::fmt;
use std::path::PathBuf;

pub use codec::{EncodeError, encode};
pub use gaps::{GatewayStamp, JOURNAL_GAP, JournalGap, reconstruct_transitions, seq_gap};
pub use io::{EngineJournal, FileJournal, MemoryJournal, decode_all};
pub use record::{JournalCommand, JournalRecord};

/// `FileJournalLockedError.code`.
pub const JOURNAL_LOCKED: &str = "journal_locked";

/// Why the journal refused an open or an append. Each message is the TypeScript's.
#[derive(Debug)]
pub enum JournalError {
    /// A second writer on the same journal.
    Locked {
        path: PathBuf,
    },
    /// An append after `close`.
    Closed,
    /// An earlier write's outcome is unknown: nothing more is admitted until a recovery reads the file again.
    IoUnknown,
    /// The write took fewer bytes than the record; the file was cut back and the record not admitted.
    ShortWrite {
        wrote: usize,
        expected: usize,
        path: PathBuf,
    },
    /// The boot rewrite took fewer bytes than the body; the live journal was not replaced.
    ShortRewrite {
        wrote: usize,
        expected: usize,
        path: PathBuf,
    },
    /// A broken line that is not the last one: corruption, not crash residue.
    Corrupt {
        line: usize,
        message: String,
    },
    Encode(EncodeError),
    Io(std::io::Error),
}

impl JournalError {
    /// The refusal's code, where the TypeScript names one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            JournalError::Locked { .. } => Some(JOURNAL_LOCKED),
            _ => None,
        }
    }
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JournalError::Locked { path } => {
                write!(
                    f,
                    "journal already has an exclusive writer: {}",
                    path.display()
                )
            }
            JournalError::Closed => f.write_str("journal_closed"),
            JournalError::IoUnknown => {
                f.write_str("journal_io_unknown: close and recover before admitting another input")
            }
            JournalError::ShortWrite {
                wrote,
                expected,
                path,
            } => write!(
                f,
                "short journal write: wrote {wrote} of {expected} bytes at {}",
                path.display()
            ),
            JournalError::ShortRewrite {
                wrote,
                expected,
                path,
            } => write!(
                f,
                "short journal rewrite: wrote {wrote} of {expected} bytes at {}",
                path.display()
            ),
            JournalError::Corrupt { line, message } => {
                write!(f, "journal line {line} is not JSON: {message}")
            }
            JournalError::Encode(e) => e.fmt(f),
            JournalError::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for JournalError {}

impl From<std::io::Error> for JournalError {
    fn from(e: std::io::Error) -> Self {
        JournalError::Io(e)
    }
}

impl From<EncodeError> for JournalError {
    fn from(e: EncodeError) -> Self {
        JournalError::Encode(e)
    }
}
