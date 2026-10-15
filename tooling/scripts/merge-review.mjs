/**
 * Local review provenance and exact-head merge receipts.
 *
 * This verifies local Claude transcript structure, not a cryptographic identity:
 * someone who can edit ~/.claude/projects or this user's private receipt cache
 * can forge it. Session separation proves distinct session IDs, not distinct
 * humans, independent judgment, or that the reviewer inspected every change.
 * Only assistant text blocks count; prompts, thinking and tool output do not.
 */
import {
  constants,
  closeSync,
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MONEY_PATH_ROOTS } from '../ci/money-skip-inventory.mjs';
import { SHARDS } from '../ci/ci-affected.mjs';

// Reuse canonical money-skip and CI shard roots. Protocol, execution and shared
// money dependencies are conservatively protected alongside security surfaces.
export const PROTECTED_PATH_ROOTS = [
  ...new Set([
    ...MONEY_PATH_ROOTS,
    ...Object.values(SHARDS)
      .flat()
      .map((root) => root.replace(/\/$/, '')),
    'services/svc-identity',
    'services/svc-edge',
    'services/svc-execution',
    'services/svc-fix',
    'services/svc-dex',
    'services/svc-indexer',
    'services/svc-protocol',
    'services/svc-chain',
    'services/svc-bridge',
    'services/svc-quant',
    'packages/auth',
    'packages/config',
    'packages/contracts',
    'packages/events',
    'packages/db',
    'packages/venue-adapter',
    'packages/venue-contracts',
    'packages/execution-arb',
    'packages/execution-mm',
    'packages/execution-house-tenant',
    'packages/greeks-adapter',
    'packages/sbe-codec',
    'packages/exchange-contract',
    'packages/quant-honesty',
    'packages/academy-ambassadors-pay',
  ]),
];

/** Invalid/unattributable paths fail closed. Matching respects path boundaries. */
export function isProtectedPath(file) {
  if (typeof file !== 'string' || !file || /[\0\r\n]/.test(file)) return true;
  const path = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((p) => p === '..' || p === '.')) return true;
  return (
    PROTECTED_PATH_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)) ||
    /(?:^|[/_.-])(?:money|security|auth|authentication|authorization|crypto|cryptography|keys?|secrets?|permissions?|kyc|sanctions?|wallet|signing|custody)(?:$|[/_.-])/i.test(
      path,
    )
  );
}

const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEFAULT_RECEIPTS = join(homedir(), '.cache/intafaced/merge-gate/receipts');
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

// A marker embedded in a fenced example or blockquote is not a review verdict.
function plainLines(text) {
  let fence;
  return text.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = { char: match[1][0], count: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.count) fence = undefined;
      return false;
    }
    return !fence && !/^\s*>/.test(line) && !/^(?: {4}|\t)/.test(line);
  });
}

function reviewInTranscript(file, session, expectedMarker) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_TRANSCRIPT_BYTES) return undefined;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let source;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_TRANSCRIPT_BYTES || opened.ino !== st.ino || opened.dev !== st.dev) return undefined;
    source = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  let matched;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== 'object') return undefined;
    if (entry.sessionId !== undefined && entry.sessionId !== session) return undefined;
    if (entry.session_id !== undefined && entry.session_id !== session) return undefined;
    const message = entry.message;
    if (
      entry.type !== 'assistant' ||
      entry.sessionId !== session ||
      message?.role !== 'assistant' ||
      typeof message.model !== 'string' ||
      !/^claude-opus-[a-z0-9][a-z0-9.-]*$/i.test(message.model)
    )
      continue;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && plainLines(block.text).some((text) => text.trim() === expectedMarker))
        matched = message.model;
    }
  }
  if (!matched) return undefined;
  return { model: matched, transcriptSha256: createHash('sha256').update(source).digest('hex'), transcriptPath: file };
}

/**
 * Declarations are PR body + comment text, each marker on its own line:
 * Author-Session: <UUID>
 * Opus-Review: <40-hex head> <reviewer UUID> PASS
 * The exact Opus-Review marker must also occur in the reviewer's assistant text.
 */
export function validateOpusReview({ head, declarations, projectsRoot = join(homedir(), '.claude/projects') }) {
  const fail = (reason) => ({ pass: false, reasons: [reason] });
  if (typeof head !== 'string' || !SHA.test(head)) return fail('Opus review requires a full 40-hex head SHA.');
  if (typeof declarations !== 'string') return fail('Author-Session and Opus-Review declarations are required.');
  const lines = plainLines(declarations).map((line) => line.trim());
  const authors = lines.filter((line) => line.startsWith('Author-Session:')).map((line) => line.slice('Author-Session:'.length).trim());
  if (!authors.length || authors.some((id) => !UUID.test(id)) || new Set(authors.map((id) => id.toLowerCase())).size !== 1) {
    return fail('One unambiguous valid Author-Session UUID is required for protected changes.');
  }
  const authorSession = authors[0];
  const candidates = lines
    .map((line) => /^Opus-Review: ([a-f0-9]{40}) ([a-f0-9-]+) PASS$/i.exec(line))
    .filter((match) => match && match[1].toLowerCase() === head.toLowerCase() && UUID.test(match[2]));
  if (!candidates.length) return fail('Missing valid exact-head Opus-Review: <sha> <reviewer UUID> PASS declaration.');
  let directories;
  try {
    if (lstatSync(projectsRoot).isSymbolicLink()) return fail('Claude projects root must not be a symlink.');
    directories = readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch {
    return fail('Claude projects transcripts are unavailable; local Opus provenance cannot be verified.');
  }
  const reasons = [];
  for (const candidate of candidates) {
    const reviewerSession = candidate[2];
    if (reviewerSession.toLowerCase() === authorSession.toLowerCase()) {
      reasons.push('Opus reviewer session must differ from Author-Session.');
      continue;
    }
    const marker = `Opus-Review: ${candidate[1]} ${reviewerSession} PASS`;
    for (const directory of directories) {
      const file = join(projectsRoot, directory.name, `${reviewerSession}.jsonl`);
      try {
        const verified = reviewInTranscript(file, reviewerSession, marker);
        if (verified) return { pass: true, reasons: [], review: { head: head.toLowerCase(), authorSession, reviewerSession, ...verified } };
      } catch {
        /* Missing, unreadable, malformed or unsafe transcript proves nothing. */
      }
    }
    reasons.push(`No matching assistant Opus PASS with exact session metadata and head for reviewer ${reviewerSession}.`);
  }
  return { pass: false, reasons: [...new Set(reasons)] };
}

function receiptLocation({ repo, head, receiptRoot = DEFAULT_RECEIPTS }) {
  if (
    typeof repo !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Receipt repository must be a valid owner/repository identifier.');
  }
  if (typeof head !== 'string' || !SHA.test(head)) throw new Error('Receipt head must be a full 40-hex SHA.');
  if (typeof receiptRoot !== 'string' || !isAbsolute(receiptRoot) || receiptRoot.includes('\0'))
    throw new Error('Receipt root must be an absolute path.');
  return { root: resolve(receiptRoot), parts: repo.split('/'), name: `${head.toLowerCase()}.json` };
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Receipt directory must be a real directory, never a symlink.');
  chmodSync(path, 0o700);
  return realpathSync(path);
}

/** Caller must supply a fresh successful live gate result. Tests MUST set receiptRoot. */
export function writePassReceipt({ repo, pr, head, base, gateSha, evidence, review, receiptRoot }) {
  const location = receiptLocation({ repo, head, receiptRoot });
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('Receipt PR must be a positive safe integer.');
  if (typeof base !== 'string' || !SHA.test(base) || typeof gateSha !== 'string' || !SHA.test(gateSha))
    throw new Error('Receipt base and gateSha must be full 40-hex SHAs.');
  if (!evidence || typeof evidence !== 'object') throw new Error('Receipt requires gate evidence.');
  if (
    review !== undefined &&
    review !== null &&
    (typeof review !== 'object' ||
      review.head?.toLowerCase() !== head.toLowerCase() ||
      !UUID.test(review.authorSession ?? '') ||
      !UUID.test(review.reviewerSession ?? '') ||
      review.authorSession.toLowerCase() === review.reviewerSession.toLowerCase() ||
      !/^claude-opus-/i.test(review.model ?? ''))
  ) {
    throw new Error('Receipt review must be an independent exact-head Opus review.');
  }
  const receipt = {
    schemaVersion: 1,
    status: 'PASS',
    repo,
    pr,
    head: head.toLowerCase(),
    base: base.toLowerCase(),
    gateSha: gateSha.toLowerCase(),
    evidence,
    review: review ?? null,
    createdAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  let directory = privateDirectory(location.root);
  for (const part of location.parts) directory = privateDirectory(join(directory, part));
  const path = join(directory, location.name);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('Receipt target must be a regular file.');
  const temporary = join(directory, `.${location.name}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path, receipt };
}

/** Remove an old receipt before a new attempt, so a later failure cannot leave PASS. */
export function invalidateReceipt({ repo, head, receiptRoot }) {
  const location = receiptLocation({ repo, head, receiptRoot });
  let directory = location.root;
  for (const path of [directory, ...location.parts.map((part) => (directory = join(directory, part)))]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe receipt directory.');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  try {
    unlinkSync(join(directory, location.name));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
