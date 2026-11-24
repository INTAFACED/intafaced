//! Where the journal lives (`journal-io.ts`): in memory for tests, or an append-only newline-delimited JSON file,
//! fsynced per record, with one writer.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use service_kit::json;

use super::JournalError;
use super::codec::encode;
use super::lock::{self, WriterLock};
use super::record::{JournalCommand, JournalRecord};

/// The engine's journal: it keeps an input durable before the book moves, and gives every input back in order.
pub trait EngineJournal {
    /// Append and make durable. Returns the record with its position.
    fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError>;
    fn read(&self) -> &[JournalRecord];
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn close(&mut self) -> Result<(), JournalError>;
}

/// For tests and one-process development: durable only for the life of the process.
#[derive(Debug, Default)]
pub struct MemoryJournal {
    records: Vec<JournalRecord>,
}

impl MemoryJournal {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EngineJournal for MemoryJournal {
    fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError> {
        let record = command.with_seq(self.records.len() + 1);
        self.records.push(record.clone());
        Ok(record)
    }

    fn read(&self) -> &[JournalRecord] {
        &self.records
    }

    fn len(&self) -> usize {
        self.records.len()
    }

    fn close(&mut self) -> Result<(), JournalError> {
        Ok(())
    }
}

/// Append-only NDJSON on disk, fsynced per record. The fsync is the whole point: an input only in the page cache is
/// one the recovery guarantee does not cover.
#[derive(Debug)]
pub struct FileJournal {
    path: PathBuf,
    file: Option<File>,
    lock: WriterLock,
    records: Vec<JournalRecord>,
    io_unknown: bool,
    closed: bool,
}

impl FileJournal {
    /// Take the one writer lock, read what the file holds, and rewrite it as exactly its durable records before any
    /// append. The lock comes first so a second process cannot rewrite under this one. A crash mid-write can leave a
    /// torn last line; [`decode_all`] skips it, and the rewrite drops it from disk, so the next append is not glued to
    /// the tear.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalError> {
        let path = path.as_ref().to_path_buf();
        let lock = lock::acquire(&path)?;
        let opened = (|| -> Result<(Vec<JournalRecord>, File), JournalError> {
            let records = if path.exists() {
                decode_all(&String::from_utf8_lossy(&fs::read(&path)?))?
            } else {
                Vec::new()
            };
            rewrite_clean(&path, &records)?;
            let file = OpenOptions::new().append(true).create(true).open(&path)?;
            Ok((records, file))
        })();
        match opened {
            Ok((records, file)) => Ok(FileJournal {
                path,
                file: Some(file),
                lock,
                records,
                io_unknown: false,
                closed: false,
            }),
            Err(e) => {
                lock::release(&lock)?;
                Err(e)
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl EngineJournal for FileJournal {
    fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError> {
        if self.closed {
            return Err(JournalError::Closed);
        }
        if self.io_unknown {
            return Err(JournalError::IoUnknown);
        }
        let Some(file) = self.file.as_mut() else {
            return Err(JournalError::Closed);
        };
        let record = command.with_seq(self.records.len() + 1);
        let line = format!("{}\n", encode(&record)?);
        let expected = line.len();
        let offset = file.metadata()?.len();
        let written = match file.write(line.as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                // A failed write can have made partial progress: refuse every input until recovery reads the
                // durable prefix again.
                self.io_unknown = true;
                return Err(e.into());
            }
        };
        if written != expected {
            // A short write leaves its bytes on the appending descriptor, and a retry would land after the tear. Cut the
            // file back to where this record began, and do not admit it.
            if let Err(e) = file.set_len(offset).and_then(|()| file.sync_all()) {
                self.io_unknown = true;
                return Err(e.into());
            }
            return Err(JournalError::ShortWrite {
                wrote: written,
                expected,
                path: self.path.clone(),
            });
        }
        if let Err(e) = file.sync_all() {
            // The whole record may already be durable: reusing its position would put two inputs at one seq.
            self.io_unknown = true;
            return Err(e.into());
        }
        self.records.push(record.clone());
        Ok(record)
    }

    fn read(&self) -> &[JournalRecord] {
        &self.records
    }

    fn len(&self) -> usize {
        self.records.len()
    }

    fn close(&mut self) -> Result<(), JournalError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        drop(self.file.take());
        lock::release(&self.lock)?;
        Ok(())
    }
}

impl Drop for FileJournal {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn parent_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Publish exactly the durable records: write the new body to a temporary file in the same directory, fsync it, rename
/// it over the journal and fsync the directory. A crash before the rename leaves the old bytes; truncating the live
/// file first would destroy an fsynced prefix if the process died before the replacement was durable.
fn rewrite_clean(path: &Path, records: &[JournalRecord]) -> Result<(), JournalError> {
    let mut body = String::new();
    for record in records {
        body.push_str(&encode(record)?);
        body.push('\n');
    }
    let dir = parent_dir(path);
    let tmp = dir.join(format!(".{}.journal-rewrite", lock::random_hex()?));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let written = (|| -> Result<(), JournalError> {
        if !body.is_empty() {
            let wrote = file.write(body.as_bytes())?;
            if wrote != body.len() {
                return Err(JournalError::ShortRewrite {
                    wrote,
                    expected: body.len(),
                    path: path.to_path_buf(),
                });
            }
        }
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(e) = written {
        // The rewrite's error is the one that surfaces.
        let _ = discard(&tmp);
        return Err(e);
    }
    let published = fs::rename(&tmp, path).and_then(|()| File::open(&dir)?.sync_all());
    if let Err(e) = published {
        let _ = discard(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn discard(tmp: &Path) -> io::Result<()> {
    match fs::remove_file(tmp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// `String.prototype.trim()` leaves nothing: every character is JavaScript white space or a line terminator.
fn js_blank(line: &str) -> bool {
    line.chars().all(|c| {
        matches!(
            c,
            '\u{9}'
                | '\u{a}'
                | '\u{b}'
                | '\u{c}'
                | '\u{d}'
                | ' '
                | '\u{a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

/// Decode a journal's body. A torn last line is an input that never became durable: it is skipped so recovery can
/// boot. A broken line anywhere else is real corruption, and refuses.
pub fn decode_all(contents: &str) -> Result<Vec<JournalRecord>, JournalError> {
    let lines: Vec<&str> = contents.split('\n').collect();
    let last = lines.iter().rposition(|line| !js_blank(line));
    let mut records = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if js_blank(line) {
            continue;
        }
        match json::parse(line) {
            Ok(value) => records.push(JournalRecord(value)),
            Err(_) if Some(i) == last => {}
            Err(e) => {
                return Err(JournalError::Corrupt {
                    line: i + 1,
                    message: e.message,
                });
            }
        }
    }
    Ok(records)
}
