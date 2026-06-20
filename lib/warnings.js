'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const NODE_PREFIX_RE = /^\(node:\d+\)\s*/;
const WARNING_CODE_RE = /^\[([^\]]+)\]\s*/;

function stripAnsi(value) {
  return value.replace(ANSI_RE, '');
}

function normalizeMessage(message, options = {}) {
  let value = stripAnsi(String(message));
  const cwd = options.cwd || process.cwd();
  const home = options.home || os.homedir();

  for (const [needle, replacement] of [
    [cwd, '<cwd>'],
    [home, '<home>']
  ]) {
    if (needle) {
      value = value.split(needle).join(replacement);
    }
  }

  return value
    .replace(/\b\d+:\d+\b/g, '<line:col>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWarningLine(line, options = {}) {
  const cleanLine = stripAnsi(String(line)).trimEnd();

  if (!NODE_PREFIX_RE.test(cleanLine)) {
    return null;
  }

  let rest = cleanLine.replace(NODE_PREFIX_RE, '');
  let code = null;
  const codeMatch = rest.match(WARNING_CODE_RE);

  if (codeMatch) {
    code = codeMatch[1];
    rest = rest.slice(codeMatch[0].length);
  }

  const warningMatch = rest.match(/^([A-Za-z][\w.-]*Warning|Warning):\s*(.*)$/);
  if (!warningMatch) {
    return null;
  }

  const name = warningMatch[1];
  const message = normalizeMessage(warningMatch[2], options);

  if (!message) {
    return null;
  }

  return {
    name,
    code,
    message,
    fingerprint: fingerprintWarning({ name, code, message })
  };
}

function fingerprintWarning(warning) {
  return crypto
    .createHash('sha256')
    .update(['warnlock:v1', warning.name, warning.code || '', warning.message].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function createWarningCollector(options = {}) {
  let pending = '';
  const warningsByFingerprint = new Map();

  function observeLine(line) {
    const warning = parseWarningLine(line, options);

    if (!warning) {
      return;
    }

    const existing = warningsByFingerprint.get(warning.fingerprint);
    if (existing) {
      existing.count += 1;
      return;
    }

    warningsByFingerprint.set(warning.fingerprint, {
      ...warning,
      count: 1
    });
  }

  return {
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';

      for (const line of lines) {
        observeLine(line);
      }
    },

    finish() {
      if (pending) {
        observeLine(pending);
        pending = '';
      }

      return sortWarnings([...warningsByFingerprint.values()]);
    }
  };
}

function collectWarnings(text, options = {}) {
  const collector = createWarningCollector(options);
  collector.push(text);
  return collector.finish();
}

function sortWarnings(warnings) {
  return [...warnings].sort((left, right) => {
    return (
      left.name.localeCompare(right.name) ||
      String(left.code || '').localeCompare(String(right.code || '')) ||
      left.message.localeCompare(right.message)
    );
  });
}

function compareWarnings(baselineWarnings, currentWarnings) {
  const baselineByFingerprint = new Map(
    baselineWarnings.map((warning) => [warning.fingerprint, warning])
  );
  const currentByFingerprint = new Map(
    currentWarnings.map((warning) => [warning.fingerprint, warning])
  );

  const added = [];
  const increased = [];
  const resolved = [];

  for (const warning of currentWarnings) {
    const baseline = baselineByFingerprint.get(warning.fingerprint);

    if (!baseline) {
      added.push(warning);
      continue;
    }

    if (warning.count > baseline.count) {
      increased.push({
        ...warning,
        baselineCount: baseline.count,
        currentCount: warning.count
      });
    }
  }

  for (const warning of baselineWarnings) {
    const current = currentByFingerprint.get(warning.fingerprint);

    if (!current || current.count < warning.count) {
      resolved.push({
        ...warning,
        baselineCount: warning.count,
        currentCount: current ? current.count : 0
      });
    }
  }

  return {
    added,
    increased,
    resolved,
    hasNewWarnings: added.length > 0 || increased.length > 0
  };
}

function totalWarningCount(warnings) {
  return warnings.reduce((count, warning) => count + warning.count, 0);
}

module.exports = {
  collectWarnings,
  compareWarnings,
  createWarningCollector,
  fingerprintWarning,
  parseWarningLine,
  sortWarnings,
  totalWarningCount
};
