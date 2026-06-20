'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  collectWarnings,
  compareWarnings,
  parseWarningLine
} = require('../lib/warnings');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'warnlock.js');

test('parses Node warning headlines and ignores follow-up hint lines', () => {
  const warnings = collectWarnings(
    [
      '(node:12345) [DEP0005] DeprecationWarning: Buffer() is deprecated',
      '(Use `node --trace-deprecation ...` to show where the warning was created)',
      '    at somewhere (/tmp/file.js:1:2)',
      '(node:67890) [DEP0005] DeprecationWarning: Buffer() is deprecated'
    ].join('\n')
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].name, 'DeprecationWarning');
  assert.equal(warnings[0].code, 'DEP0005');
  assert.equal(warnings[0].message, 'Buffer() is deprecated');
  assert.equal(warnings[0].count, 2);
});

test('normalizes cwd and line numbers in warning messages', () => {
  const warning = parseWarningLine(
    '(node:1) Warning: problem at /tmp/project/src/index.js:12:8',
    {
      cwd: '/tmp/project',
      home: '/Users/example'
    }
  );

  assert.equal(warning.message, 'problem at <cwd>/src/index.js:<line:col>');
});

test('compares by new fingerprints and increased counts', () => {
  const baseline = collectWarnings('(node:1) Warning: old warning\n');
  const current = collectWarnings(
    [
      '(node:2) Warning: old warning',
      '(node:3) Warning: old warning',
      '(node:4) Warning: brand new'
    ].join('\n')
  );

  const comparison = compareWarnings(baseline, current);

  assert.equal(comparison.hasNewWarnings, true);
  assert.equal(comparison.added.length, 1);
  assert.equal(comparison.added[0].message, 'brand new');
  assert.equal(comparison.increased.length, 1);
  assert.equal(comparison.increased[0].message, 'old warning');
});

test('update records the current warnings and check passes for the same warnings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnlock-'));
  const baseline = path.join(dir, '.warnlock.json');

  const update = await runWarnlock([
    '--baseline',
    baseline,
    '--update',
    '--',
    process.execPath,
    '-e',
    "process.emitWarning('legacy api', { type: 'DeprecationWarning', code: 'WARNLOCK_LEGACY' })"
  ]);

  assert.equal(update.code, 0, update.stderr);

  const baselineJson = JSON.parse(await fs.readFile(baseline, 'utf8'));
  assert.equal(baselineJson.version, 1);
  assert.equal(baselineJson.warnings.length, 1);
  assert.equal(baselineJson.warnings[0].message, 'legacy api');

  const check = await runWarnlock([
    '--baseline',
    baseline,
    '--',
    process.execPath,
    '-e',
    "process.emitWarning('legacy api', { type: 'DeprecationWarning', code: 'WARNLOCK_LEGACY' })"
  ]);

  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, /no new Node\.js warnings/);
});

test('check fails when a warning is not in the baseline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnlock-'));
  const baseline = path.join(dir, '.warnlock.json');

  const update = await runWarnlock([
    '--baseline',
    baseline,
    '--update',
    '--',
    process.execPath,
    '-e',
    "process.emitWarning('old warning')"
  ]);
  assert.equal(update.code, 0, update.stderr);

  const check = await runWarnlock([
    '--baseline',
    baseline,
    '--',
    process.execPath,
    '-e',
    "process.emitWarning('old warning'); process.emitWarning('new warning')"
  ]);

  assert.equal(check.code, 1);
  assert.match(check.stderr, /new Node\.js warnings detected/);
  assert.match(check.stderr, /new warning/);
});

test('update does not write a baseline when the wrapped command fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnlock-'));
  const baseline = path.join(dir, '.warnlock.json');

  const update = await runWarnlock([
    '--baseline',
    baseline,
    '--update',
    '--',
    process.execPath,
    '-e',
    "process.emitWarning('will not be recorded'); process.exit(7)"
  ]);

  assert.equal(update.code, 7);
  assert.match(update.stderr, /baseline was not updated/);
  await assert.rejects(fs.stat(baseline), { code: 'ENOENT' });
});

function runWarnlock(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FORCE_COLOR: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code: code === null ? 1 : code,
        signal,
        stdout,
        stderr
      });
    });
  });
}
