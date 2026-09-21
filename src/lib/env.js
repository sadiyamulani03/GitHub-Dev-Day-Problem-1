'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Minimal, dependency-free `.env` loader (constraint: keep dependencies small).
 *
 * Rules:
 *  - real process environment variables always win (important for deployment)
 *  - missing `.env` is fine, never an error
 *  - supports `KEY=value`, `export KEY=value`, `#` comments and quoted values
 *
 * Secrets are therefore never sourced from tracked files (CHECK 8): the only
 * tracked file is `.env.example`, whose values are safe placeholders.
 */
function loadEnvFile(filePath = path.resolve(process.cwd(), '.env'), target = process.env) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const raw = fs.readFileSync(filePath, 'utf8');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separator = withoutExport.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = withoutExport.slice(separator + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (isQuoted) {
      value = value.slice(1, -1);
    }

    if (target[key] === undefined) {
      target[key] = value;
    }
  }

  return true;
}

module.exports = { loadEnvFile };
