'use strict';

/**
 * Repository secret scanner (CHECK 8).
 *
 * Nothing in this repository may contain a credential, key, password, token,
 * session secret, database URL with credentials, or an authenticated URL --
 * configuration is loaded from environment variables and `.env` is git-ignored.
 *
 * Two tiers of detection, deliberately:
 *
 *   STRONG patterns (provider-shaped secrets, private keys, credentialed URLs)
 *   are checked in EVERY file, including tests and documentation.
 *
 *   WEAK patterns (an assignment named like a secret) are only checked outside
 *   `tests/`, and obvious fixture values are excluded -- a test harness legitimately
 *   contains `password: 'test-password-1234'`, which is not a credential.
 *
 * It scans the working tree AND the full git history (`git log -p --all`),
 * because the check fails if a secret ever appeared in a tracked file "at any
 * point in the repo's history".
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'data', 'coverage', '.nyc_output']);

const TEXT_FILE_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.md',
  '.sql',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.txt',
  '.example',
  '.env',
  '.sh',
  '.ps1',
  '.toml',
]);

/** High-confidence secret shapes. Reported wherever they appear. */
const STRONG_PATTERNS = [
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', pattern: /\baws_secret_access_key\s*[:=]\s*\S{20,}/i },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'OpenAI key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'SendGrid key', pattern: /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
  { name: 'credentialed URL', pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,64}:[^\s/:@]{1,64}@/i },
  { name: 'hardcoded bearer token', pattern: /Bearer\s+[A-Za-z0-9._\-]{20,}/ },
];

/** Assignment-shaped hints. Only checked outside `tests/`. */
const WEAK_PATTERNS = [
  {
    name: 'secret-like assignment',
    pattern:
      /\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret|session[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"`]([^'"`\n]{8,})['"`]/i,
  },
];

/** Values that are obviously placeholders or test fixtures, not credentials. */
const PLACEHOLDER_VALUES = [
  /example/i,
  /placeholder/i,
  /change[_-]?me/i,
  /your[_-]/i,
  /dummy/i,
  /fake/i,
  /test/i,
  /sample/i,
  /redacted/i,
  /x{4,}/i,
  /^\$\{?\w+\}?$/,
  /^env\./i,
  /^process\.env/i,
];

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.some((pattern) => pattern.test(value));
}

function looksTextual(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(extension)) {
    return true;
  }
  return path.basename(filePath) === '.env' || path.basename(filePath).startsWith('.env.');
}

/** Walk the working tree, skipping .git/node_modules/data/coverage. */
function walkWorkingTree(dir = REPO_ROOT, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walkWorkingTree(path.join(dir, entry.name), collected);
    } else if (looksTextual(entry.name)) {
      collected.push(path.join(dir, entry.name));
    }
  }
  return collected;
}

/** Never echo a full secret in output, even in a report. */
function redact(value) {
  const text = String(value);
  if (text.length <= 8) {
    return '<redacted>';
  }
  return `${text.slice(0, 4)}...(${text.length} chars)`;
}

function scanText({ text, label, includeWeak }) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const { name, pattern } of STRONG_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        findings.push({ label, line: index + 1, rule: name, excerpt: redact(match[0]) });
      }
    }

    if (!includeWeak) {
      return;
    }
    for (const { name, pattern } of WEAK_PATTERNS) {
      const match = line.match(pattern);
      if (match && !isPlaceholder(match[2])) {
        findings.push({
          label,
          line: index + 1,
          rule: name,
          excerpt: `${match[1]}=${redact(match[2])}`,
        });
      }
    }
  });

  return findings;
}

/** Scan every file in the working tree. */
function scanWorkingTree() {
  const findings = [];

  for (const file of walkWorkingTree()) {
    const relative = path.relative(REPO_ROOT, file);
    const inTests = relative.split(path.sep)[0] === 'tests';
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanText({ text, label: relative, includeWeak: !inTests }));
  }

  return findings;
}

function isGitRepository() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Scan the patch text of every commit on every ref. */
function scanGitHistory() {
  if (!isGitRepository()) {
    return [];
  }

  let history;
  try {
    history = execFileSync(
      'git',
      ['--no-pager', 'log', '-p', '--all', '--pretty=format:commit %H'],
      { cwd: REPO_ROOT, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
    );
  } catch {
    return [];
  }

  // Only added lines matter: a deletion is a fix, not a leak.
  const addedLines = history
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));

  return scanText({
    text: addedLines.join('\n'),
    label: 'git history (added lines)',
    includeWeak: true,
  });
}

/** Files that must never be tracked, whatever their contents. */
function checkForbiddenTrackedFiles() {
  const findings = [];

  let tracked = [];
  if (isGitRepository()) {
    try {
      tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      tracked = [];
    }
  }

  const forbidden = [
    { test: (file) => /(^|\/)\.env$/.test(file), reason: 'a real .env file must never be tracked' },
    {
      test: (file) => /\.(db|sqlite|sqlite3)(-shm|-wal)?$/.test(file),
      reason: 'local database files must never be tracked',
    },
    { test: (file) => /(^|\/)node_modules\//.test(file), reason: 'dependencies must never be tracked' },
    { test: (file) => /\.(pem|key|p12|pfx)$/.test(file), reason: 'key material must never be tracked' },
  ];

  for (const file of tracked) {
    for (const { test, reason } of forbidden) {
      if (test(file)) {
        findings.push({ label: file, line: 0, rule: 'forbidden tracked file', excerpt: reason });
      }
    }
  }

  // The .gitignore must genuinely exclude the local environment file.
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  if (!/^\.env$/m.test(gitignore)) {
    findings.push({
      label: '.gitignore',
      line: 0,
      rule: 'missing ignore rule',
      excerpt: '.env is not listed in .gitignore',
    });
  }

  return findings;
}

function scanRepository() {
  const findings = [...scanWorkingTree(), ...checkForbiddenTrackedFiles(), ...scanGitHistory()];
  return { findings, clean: findings.length === 0 };
}

function formatFindings(findings) {
  if (findings.length === 0) {
    return 'No credentials, keys, tokens, secrets or authenticated URLs found.';
  }
  return findings
    .map((finding) => `  - [${finding.rule}] ${finding.label}:${finding.line} -> ${finding.excerpt}`)
    .join('\n');
}

if (require.main === module) {
  const { findings, clean } = scanRepository();

  console.log('Secret scan (CHECK 8)');
  console.log(`  repository:          ${REPO_ROOT}`);
  console.log(`  git history scanned: ${isGitRepository() ? 'yes' : 'not a git repository'}`);
  console.log(formatFindings(findings));
  console.log(clean ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(clean ? 0 : 1);
}

module.exports = {
  REPO_ROOT,
  STRONG_PATTERNS,
  WEAK_PATTERNS,
  PLACEHOLDER_VALUES,
  scanText,
  scanWorkingTree,
  scanGitHistory,
  checkForbiddenTrackedFiles,
  scanRepository,
  formatFindings,
  isGitRepository,
};
