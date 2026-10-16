/**
 * Local review provenance and exact-head merge receipts.
 *
 * The gate computes the canonical patch itself and a review counts only when the
 * assistant report quotes that patch hash and file list. A transcript diff
 * command is not proof. This is an accident guard: someone who can edit
 * ~/.claude/projects or this user's private receipt cache can forge a report
 * that quotes a hash. Session separation proves distinct session IDs, not
 * distinct humans, independent judgment, or that the reviewer understood the
 * change. Only assistant text blocks supply verdicts. User prompts and thinking
 * cannot approve.
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
import { gateFilesTouched } from './gate-file-guard.mjs';

// New workspaces and policy documents require review without maintaining an
// ever-growing money allowlist. These are the only ordinary unprotected roots.
export const UNPROTECTED_PATH_ROOTS = ['packages/ui', 'packages/i18n'];
export const UNPROTECTED_EXACT_FILES = ['README.md', 'LICENSE', 'NOTICE'];

/** Invalid/unattributable paths fail closed. Matching respects path boundaries. */
export function isProtectedPath(file) {
  if (typeof file !== 'string' || !file || /[\0\r\n]/.test(file)) return true;
  const path = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((p) => p === '..' || p === '.')) return true;
  if (gateFilesTouched([path]).length) return true;
  return (
    !(UNPROTECTED_EXACT_FILES.includes(path) || UNPROTECTED_PATH_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) ||
    /(?:^|[/_.-])(?:money|security|auth|authentication|authorization|crypto|cryptography|keys?|secrets?|permissions?|kyc|sanctions?|wallet|signing|custody)(?:$|[/_.-])/i.test(
      path,
    )
  );
}

const SHA = /^[a-f0-9]{40}$/i;
const PATCH_HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const AGENT_ID = /^[a-f0-9]{7,64}$/i;
const reviewerId = (id) => typeof id === 'string' && (UUID.test(id) || AGENT_ID.test(id));
const DEFAULT_RECEIPTS = join(homedir(), '.cache/intafaced/merge-gate/receipts');
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const TRUNCATED_OUTPUT = /<persisted-output>|Output too large|Full output saved to|output was truncated/i;

function pathFromDiffMarker(line) {
  if (!line) return undefined;
  const body = line.replace(/^(?:---|\+\+\+) /, '').replace(/\t.*$/, '');
  if (body === '/dev/null') return undefined;
  const raw = body.startsWith('"') ? body.slice(1, -1).replace(/\\([\\"])/g, '$1') : body;
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : undefined;
}

/** File paths from one canonical patch. A header without a path fails closed. */
export function filesInCanonicalPatch(patch) {
  const files = [];
  const lines = String(patch).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('diff --git ')) continue;
    let minus;
    let plus;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('diff --git '); j++) {
      if (minus === undefined && lines[j].startsWith('--- ')) minus = lines[j];
      if (lines[j].startsWith('+++ ')) {
        plus = lines[j];
        break;
      }
    }
    const path = pathFromDiffMarker(plus) ?? pathFromDiffMarker(minus);
    if (!path) throw new Error('Canonical patch has a diff header without a file path.');
    files.push(path);
  }
  return files;
}

/**
 * The gate's own patch. `git` is `(args) => {status, stdout, stderr}` and is
 * called with exactly the lead's diff options. A checkout wrapper may prepend
 * `-C <origin/main worktree>`; it must not drop these options.
 * `.gitattributes -diff` is defeated by `--text`. `core.attributesFile=/dev/null`
 * drops the extra user attributes file. External diffs and textconv are off.
 */
export function canonicalPatch({ git, base, head }) {
  if (typeof git !== 'function' || !SHA.test(base ?? '') || !SHA.test(head ?? ''))
    throw new Error('Canonical patch requires a git runner and full merge-base and head SHAs.');
  const args = [
    '-c',
    'core.attributesFile=/dev/null',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--text',
    '--no-color',
    `${base}...${head}`,
  ];
  const result = git(args);
  if (!result || result.status !== 0) {
    throw new Error(
      `Canonical patch failed (${String(result?.stderr ?? '')
        .trim()
        .slice(0, 200)})`,
    );
  }
  const patch = String(result.stdout ?? '');
  return { hash: createHash('sha256').update(patch).digest('hex'), files: filesInCanonicalPatch(patch), patch };
}

function sameFileList(quoted, expected) {
  if (quoted.length !== expected.length) return false;
  const left = [...quoted].sort();
  const right = [...expected].sort();
  return left.every((file, index) => file === right[index]);
}

/** The report must quote the gate's hash and exactly its file list, on plain lines. */
function patchQuoted(lines, patch) {
  if (!patch || !PATCH_HASH.test(patch.hash ?? '') || !Array.isArray(patch.files)) return false;
  const hashes = [];
  const files = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Patch-Hash: [a-f0-9]{64}$/.test(trimmed)) hashes.push(trimmed.slice('Patch-Hash: '.length));
    else if (trimmed.startsWith('Patch-File: ')) files.push(trimmed.slice('Patch-File: '.length));
  }
  return hashes.length === 1 && hashes[0] === patch.hash && sameFileList(files, patch.files);
}

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

function reviewVerdict(line) {
  return /^Opus-Review: ([a-f0-9]{40}) (\S+) (\S.*)$/i.exec(line.trim());
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    : '';
}

// A deliberately small shell lexer distinguishes executed commands from quoted
// search terms. This does not execute shell text or establish a security boundary.
function shellCommands(source) {
  const commands = [];
  let words = [],
    word = '',
    quoted = false,
    quote,
    before;
  const flushWord = () => {
    if (word || quoted) words.push(word);
    word = '';
    quoted = false;
  };
  const flushCommand = (separator) => {
    flushWord();
    if (words.length) commands.push({ words, before, after: separator });
    words = [];
    before = separator;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && /["\\$`]/.test(source[i + 1] ?? '')) word += source[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === '\\') {
      if (i + 1 >= source.length) return undefined;
      word += source[++i];
    } else if (char === '#' && !word) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++;
    } else if (';&|\n()'.includes(char)) {
      const separator = (char === '&' || char === '|') && source[i + 1] === char ? char + source[++i] : char;
      flushCommand(separator);
    } else if (/\s/.test(char)) flushWord();
    else word += char;
  }
  if (quote) return undefined;
  flushCommand();
  return commands;
}

function executableWords(words) {
  const result = [...words];
  while (
    result.length &&
    (/^[A-Za-z_]\w*=/.test(result[0]) || ['command', 'env', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', '!'].includes(result[0]))
  )
    result.shift();
  return result;
}

function gitOperation(words) {
  const args = executableWords(words);
  if (!/(?:^|\/)git$/.test(args.shift() ?? '')) return undefined;
  while (args[0]?.startsWith('-')) {
    const flag = args.shift();
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(flag)) args.shift();
  }
  return args;
}

function reviewerMutation(commands, depth = 0) {
  if (depth > 4) return true;
  return commands.some(({ words }) => {
    const git = gitOperation(words);
    if (git && ['commit', 'push'].includes(git[0])) return true;
    if (words.some((word) => /(?:\$\(|`)[\s\S]*\bgit\s+(?:commit|push)\b/.test(word))) return true;
    const args = executableWords(words);
    if (/^(?:.*\/)?(?:ba|z|da)?sh$/.test(args[0] ?? '')) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag > 0 && typeof args[flag + 1] === 'string') {
        const nested = shellCommands(args[flag + 1]);
        return !nested || reviewerMutation(nested, depth + 1);
      }
    }
    return false;
  });
}

function gitInvocationRejection(words) {
  const rest = [...words];
  while (['command', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', '!'].includes(rest[0])) rest.shift();
  if (rest[0] === 'env') rest.shift();
  const assignments = [];
  while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0])) assignments.push(rest.shift());
  if (!/(?:^|\/)git$/.test(rest[0] ?? '')) return undefined;
  if (assignments.length) return 'Reviewer git command uses an environment-variable prefix.';
  rest.shift();
  while (rest[0]?.startsWith('-')) {
    const flag = rest.shift();
    if (flag === '--') break;
    if (flag === '--no-pager') continue;
    return 'Reviewer git command uses a global option other than --no-pager.';
  }
  return undefined;
}

function rejectedGitInvocation(commands, depth = 0) {
  if (depth > 4) return 'Reviewer shell command cannot be safely inspected.';
  for (const { words } of commands) {
    const reason = gitInvocationRejection(words);
    if (reason) return reason;
    const args = executableWords(words);
    if (/^(?:.*\/)?(?:ba|z|da)?sh$/.test(args[0] ?? '')) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag > 0 && typeof args[flag + 1] === 'string') {
        const nested = shellCommands(args[flag + 1]);
        if (!nested) return 'Reviewer shell command cannot be safely inspected.';
        const nestedReason = rejectedGitInvocation(nested, depth + 1);
        if (nestedReason) return nestedReason;
      }
    }
  }
  return undefined;
}

function contentBlocks(message) {
  if (!message) return [];
  return Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
}

function truncatedToolOutput(message) {
  return contentBlocks(message).some((block) => block?.type === 'tool_result' && TRUNCATED_OUTPUT.test(textContent(block.content)));
}

function reviewInTranscript(file, session, reviewer, head, patch, subagent = false) {
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
  const report = [];
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== 'object') return undefined;
    if (entry.sessionId !== undefined && entry.sessionId !== session) return undefined;
    if (entry.session_id !== undefined && entry.session_id !== session) return undefined;
    if (entry.type === 'user' && entry.sessionId !== session) return undefined;
    if (
      subagent &&
      ((entry.agentId !== undefined && entry.agentId !== reviewer) ||
        (entry.isSidechain !== undefined && entry.isSidechain !== true) ||
        (['user', 'assistant'].includes(entry.type) && (entry.agentId !== reviewer || entry.isSidechain !== true)))
    )
      return undefined;
    const message = entry.message;
    if (truncatedToolOutput(message)) return { blocked: 'Reviewer tool output is persisted or truncated.' };
    if (entry.type === 'user' && message?.role === 'user') {
      const prompt = textContent(message.content);
      if (/Opus-Review:/i.test(prompt) || (prompt.toLowerCase().includes(head.toLowerCase()) && /\bPASS\b/i.test(prompt)))
        return { blocked: 'Reviewer user prompt contains the verdict marker or exact head plus PASS.' };
    }
    if (entry.type !== 'assistant' || entry.sessionId !== session || message?.role !== 'assistant') continue;
    const blocks = contentBlocks(message);
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') {
        const commands = shellCommands(block.input.command);
        if (!commands) return { blocked: 'Reviewer shell command cannot be safely inspected.' };
        if (reviewerMutation(commands)) return { blocked: 'Reviewer transcript executes git commit or git push.' };
        const rejected = rejectedGitInvocation(commands);
        if (rejected) return { blocked: rejected };
      }
    }
    report.push(...plainLines(textContent(message.content)));
    for (const text of plainLines(textContent(message.content))) {
      const verdict = reviewVerdict(text);
      if (!verdict || verdict[1].toLowerCase() !== head.toLowerCase()) continue;
      if (verdict[3].toUpperCase() !== 'PASS') return { blocked: 'Reviewer transcript contains a non-PASS exact-head verdict.' };
      if (verdict[2].toLowerCase() === reviewer.toLowerCase() && patchQuoted(report, patch))
        matched = { model: message.model, patchHash: patch.hash, patchFiles: [...patch.files] };
    }
  }
  if (!matched || !/^claude-opus-[a-z0-9][a-z0-9.-]*$/i.test(matched.model)) return undefined;
  return {
    model: matched.model,
    patchHash: matched.patchHash,
    patchFiles: matched.patchFiles,
    transcriptSha256: createHash('sha256').update(source).digest('hex'),
    transcriptPath: file,
    ...(subagent ? { parentSession: session } : {}),
  };
}

/**
 * Declarations are PR body + comment text, each marker on its own line:
 * Author-Session: <UUID>
 * Opus-Review: <40-hex head> <reviewer UUID or agent ID> PASS
 * Any non-PASS exact-head verdict blocks. Assistant Opus PASS counts only when
 * that report quotes the gate's canonical patch hash and exact file list.
 * The parent/session must differ from the declared author. A diff command in
 * the transcript is not proof.
 */
export function validateOpusReview({ head, base, declarations, patch, projectsRoot = join(homedir(), '.claude/projects') }) {
  const fail = (reason) => ({ pass: false, reasons: [reason] });
  if (typeof head !== 'string' || !SHA.test(head)) return fail('Opus review requires a full 40-hex head SHA.');
  if (!SHA.test(base ?? '')) return fail('Opus review requires the full PR merge-base SHA.');
  if (typeof declarations !== 'string') return fail('Author-Session and Opus-Review declarations are required.');
  const lines = plainLines(declarations).map((line) => line.trim());
  const authors = lines.filter((line) => line.startsWith('Author-Session:')).map((line) => line.slice('Author-Session:'.length).trim());
  if (!authors.length || authors.some((id) => !UUID.test(id)) || new Set(authors.map((id) => id.toLowerCase())).size !== 1) {
    return fail('One unambiguous valid Author-Session UUID is required for protected changes.');
  }
  const authorSession = authors[0];
  const candidatesById = new Map();
  for (const line of lines) {
    const verdict = reviewVerdict(line);
    if (!verdict || verdict[1].toLowerCase() !== head.toLowerCase()) continue;
    if (verdict[3].toUpperCase() !== 'PASS') return fail('A non-PASS exact-head Opus-Review declaration blocks approval.');
    if (reviewerId(verdict[2])) candidatesById.set(verdict[2].toLowerCase(), verdict);
  }
  const candidates = [...candidatesById.values()];
  if (!candidates.length) return fail('Missing valid exact-head Opus-Review: <sha> <reviewer UUID or agent ID> PASS declaration.');
  if (!patch || !PATCH_HASH.test(patch.hash ?? '') || !Array.isArray(patch.files) || patch.files.some((file) => typeof file !== 'string'))
    return fail('Opus review requires the canonical patch hash and file list.');
  let directories;
  try {
    if (lstatSync(projectsRoot).isSymbolicLink()) return fail('Claude projects root must not be a symlink.');
    directories = readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch {
    return fail('Claude projects transcripts are unavailable; local Opus provenance cannot be verified.');
  }
  const reasons = [];
  let approved;
  for (const candidate of candidates) {
    const reviewerSession = candidate[2];
    if (reviewerSession.toLowerCase() === authorSession.toLowerCase()) {
      reasons.push('Opus reviewer session must differ from Author-Session.');
      continue;
    }
    for (const directory of directories) {
      const project = join(projectsRoot, directory.name);
      const paths = [];
      if (UUID.test(reviewerSession))
        paths.push({ file: join(project, `${reviewerSession}.jsonl`), session: reviewerSession, subagent: false });
      else {
        let parents;
        try {
          parents = readdirSync(project, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const parent of parents) {
          if (
            !parent.isDirectory() ||
            parent.isSymbolicLink() ||
            !UUID.test(parent.name) ||
            parent.name.toLowerCase() === authorSession.toLowerCase()
          )
            continue;
          const subagents = join(project, parent.name, 'subagents');
          try {
            const stat = lstatSync(subagents);
            if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
            paths.push({ file: join(subagents, `agent-${reviewerSession}.jsonl`), session: parent.name, subagent: true });
          } catch {
            /* An absent or unsafe subagent directory proves nothing. */
          }
        }
      }
      for (const { file, session, subagent } of paths) {
        try {
          const verified = reviewInTranscript(file, session, reviewerSession, head, patch, subagent);
          if (verified?.blocked) return fail(verified.blocked);
          if (verified) approved = { head: head.toLowerCase(), base: base.toLowerCase(), authorSession, reviewerSession, ...verified };
        } catch {
          /* Missing, unreadable, malformed or unsafe transcript proves nothing. */
        }
      }
    }
    reasons.push(`No valid assistant Opus PASS quoting the canonical patch hash and file list for reviewer ${reviewerSession}.`);
  }
  if (approved) return { pass: true, reasons: [], review: approved };
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
export function writePassReceipt({ repo, pr, head, liveHead, base, gateSha, evidence, review, receiptRoot }) {
  const location = receiptLocation({ repo, head, receiptRoot });
  if (!SHA.test(liveHead ?? '') || liveHead.toLowerCase() !== head.toLowerCase())
    throw new Error('Receipt liveHead must match the freshly checked full head SHA.');
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
      !reviewerId(review.reviewerSession) ||
      review.authorSession.toLowerCase() === review.reviewerSession.toLowerCase() ||
      (!UUID.test(review.reviewerSession) &&
        (!UUID.test(review.parentSession ?? '') || review.parentSession.toLowerCase() === review.authorSession.toLowerCase())) ||
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
    liveHead: liveHead.toLowerCase(),
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

/** Consumer freshness guard, not tamper resistance: a same-user process can forge JSON. */
export function validatePassReceipt(receipt, { head, gateSha, now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  const reasons = [];
  if (!receipt || typeof receipt !== 'object' || receipt.schemaVersion !== 1 || receipt.status !== 'PASS')
    reasons.push('Receipt is not a schema-version-1 PASS.');
  if (!SHA.test(head ?? '') || receipt?.head !== head || receipt?.liveHead !== head)
    reasons.push('Receipt does not match the live PR head.');
  if (!SHA.test(gateSha ?? '') || receipt?.gateSha !== gateSha) reasons.push('Receipt does not match the current trusted gate revision.');
  const createdAt = typeof receipt?.createdAt === 'string' ? Date.parse(receipt.createdAt) : NaN;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0 ||
    !Number.isFinite(createdAt) ||
    createdAt > now ||
    now - createdAt > maxAgeMs
  )
    reasons.push('Receipt timestamp is invalid, future-dated or expired.');
  return { pass: reasons.length === 0, reasons };
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
