'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  compareWarnings,
  createWarningCollector,
  sortWarnings,
  totalWarningCount
} = require('./warnings');

const DEFAULT_BASELINE = '.warnlock.json';
const LOCKFILE_VERSION = 1;

async function main(argv, io = process, context = {}) {
  const cwd = context.cwd || process.cwd();
  const env = context.env || process.env;
  const parsed = parseArgs(argv);

  if (parsed.help) {
    io.stdout.write(helpText());
    return 0;
  }

  if (parsed.version) {
    const packageJson = require('../package.json');
    io.stdout.write(`${packageJson.version}\n`);
    return 0;
  }

  if (parsed.error) {
    io.stderr.write(`warnlock: ${parsed.error}\n\n${helpText()}`);
    return 2;
  }

  if (parsed.command.length === 0) {
    io.stderr.write(`warnlock: expected a command to run\n\n${helpText()}`);
    return 2;
  }

  const baselinePath = path.resolve(cwd, parsed.baseline);
  const baseline = parsed.update ? null : await readBaseline(baselinePath);
  const run = await runCommand(parsed.command, {
    cwd,
    env,
    stderr: io.stderr,
    stdout: io.stdout
  });

  if (parsed.update) {
    if (run.exitCode !== 0) {
      io.stderr.write(
        `warnlock: wrapped command exited with ${run.exitCode}; baseline was not updated\n`
      );
      return run.exitCode;
    }

    await writeBaseline(baselinePath, run.warnings);
    io.stdout.write(
      `warnlock: recorded ${formatCount(totalWarningCount(run.warnings), 'Node.js warning')} in ${path.relative(cwd, baselinePath) || baselinePath}\n`
    );
    return 0;
  }

  const comparison = compareWarnings(baseline.warnings, run.warnings);

  if (comparison.hasNewWarnings) {
    printFailure(io.stderr, comparison, {
      baselineMissing: baseline.missing,
      baselinePath,
      cwd
    });
    return 1;
  }

  io.stdout.write(
    `warnlock: no new Node.js warnings (${formatWarningCount(totalWarningCount(run.warnings), 'observed')}, ${formatWarningCount(totalWarningCount(baseline.warnings), 'allowed')})\n`
  );

  return run.exitCode;
}

function parseArgs(argv) {
  const options = {
    baseline: DEFAULT_BASELINE,
    command: [],
    help: false,
    update: false,
    version: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      options.command = argv.slice(index + 1);
      return options;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      options.version = true;
      continue;
    }

    if (arg === '--update' || arg === '-u') {
      options.update = true;
      continue;
    }

    if (arg === '--baseline' || arg === '-b') {
      const value = argv[index + 1];
      if (!value) {
        return { ...options, error: `${arg} requires a path` };
      }

      options.baseline = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--baseline=')) {
      const value = arg.slice('--baseline='.length);
      if (!value) {
        return { ...options, error: '--baseline requires a path' };
      }

      options.baseline = value;
      continue;
    }

    if (arg.startsWith('-')) {
      return { ...options, error: `unknown option ${arg}` };
    }

    options.command = argv.slice(index);
    return options;
  }

  return options;
}

function helpText() {
  return `Usage: warnlock [options] -- <command> [args...]

Run a command, collect Node.js warnings from stderr, and compare them against
a committed warning baseline.

Options:
  -b, --baseline <path>  Baseline file to read or write (default: .warnlock.json)
  -u, --update           Replace the baseline with the command's current warnings
  -h, --help             Show this help
  -v, --version          Show the package version

Examples:
  warnlock --update -- npm test
  warnlock -- npm test
`;
}

function runCommand(commandArgs, options) {
  const [command, ...args] = commandArgs;
  const collector = createWarningCollector({
    cwd: options.cwd,
    home: os.homedir()
  });

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === 'win32',
      stdio: ['inherit', 'pipe', 'pipe']
    });

    function finish(exitCode, signal) {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        exitCode,
        signal,
        warnings: collector.finish()
      });
    }

    child.stdout.on('data', (chunk) => {
      options.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      collector.push(chunk);
      options.stderr.write(chunk);
    });

    child.on('error', (error) => {
      options.stderr.write(`warnlock: failed to start ${command}: ${error.message}\n`);
      finish(error.code === 'ENOENT' ? 127 : 1, null);
    });

    child.on('close', (code, signal) => {
      finish(code === null ? exitCodeFromSignal(signal) : code, signal);
    });
  });
}

async function readBaseline(filePath) {
  let text;

  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { missing: true, warnings: [] };
    }

    throw error;
  }

  const parsed = JSON.parse(text);

  if (parsed.version !== LOCKFILE_VERSION || !Array.isArray(parsed.warnings)) {
    throw new Error(
      `${filePath} is not a warnlock v${LOCKFILE_VERSION} baseline`
    );
  }

  return {
    missing: false,
    warnings: sortWarnings(parsed.warnings.map(normalizeBaselineWarning))
  };
}

async function writeBaseline(filePath, warnings) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const baseline = {
    version: LOCKFILE_VERSION,
    warnings: sortWarnings(warnings).map((warning) => ({
      fingerprint: warning.fingerprint,
      name: warning.name,
      code: warning.code,
      message: warning.message,
      count: warning.count
    }))
  };

  await fs.writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function normalizeBaselineWarning(warning) {
  return {
    fingerprint: String(warning.fingerprint),
    name: String(warning.name),
    code: warning.code === null || warning.code === undefined ? null : String(warning.code),
    message: String(warning.message),
    count: Number.isInteger(warning.count) && warning.count > 0 ? warning.count : 1
  };
}

function printFailure(stream, comparison, options) {
  const baselineName = path.relative(options.cwd, options.baselinePath) || options.baselinePath;

  if (options.baselineMissing) {
    stream.write(`warnlock: ${baselineName} does not exist, so every warning is new\n`);
  }

  stream.write('warnlock: new Node.js warnings detected\n');

  if (comparison.added.length > 0) {
    stream.write('\nNew warnings:\n');
    for (const warning of comparison.added) {
      stream.write(`  - ${formatWarning(warning)}\n`);
    }
  }

  if (comparison.increased.length > 0) {
    stream.write('\nIncreased warnings:\n');
    for (const warning of comparison.increased) {
      stream.write(
        `  - ${formatWarning(warning)} (was ${warning.baselineCount}, now ${warning.currentCount})\n`
      );
    }
  }

  stream.write(`\nUpdate the baseline with: warnlock --update -- <command>\n`);
}

function formatWarning(warning) {
  const code = warning.code ? ` [${warning.code}]` : '';
  return `${warning.name}${code}: ${warning.message} (${warning.count}x)`;
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatWarningCount(count, adjective) {
  return `${count} ${adjective} Node.js warning${count === 1 ? '' : 's'}`;
}

function exitCodeFromSignal(signal) {
  if (!signal) {
    return 1;
  }

  const signalNumber = os.constants.signals[signal];
  return signalNumber ? 128 + signalNumber : 1;
}

module.exports = {
  DEFAULT_BASELINE,
  LOCKFILE_VERSION,
  main,
  parseArgs,
  readBaseline,
  runCommand,
  writeBaseline
};
