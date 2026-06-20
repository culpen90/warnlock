# warnlock

A zero-dependency npm package CI tool that records existing Node.js warnings and fails only when new warnings are introduced.

## Why

Node.js warnings often show up in mature projects long before a team can fix all of them. `warnlock` lets you commit the current warning set as a baseline, then keep CI strict against regressions.

## Install

```sh
npm install --save-dev warnlock
```

## Usage

Create or refresh the baseline:

```sh
npx warnlock --update -- npm test
```

Commit the generated `.warnlock.json`, then run the same command in CI without `--update`:

```sh
npx warnlock -- npm test
```

`warnlock` streams the wrapped command's output unchanged. It watches stderr for Node.js warning headers such as:

```text
(node:12345) [DEP0005] DeprecationWarning: Buffer() is deprecated
```

CI passes when the current warnings are already allowed by the baseline. CI fails when:

- a warning fingerprint is not in the baseline
- an existing warning appears more times than the baseline allows
- the wrapped command itself exits non-zero

Resolved or reduced warnings do not fail CI. Run `warnlock --update -- <command>` when you intentionally accept a changed warning set.

## Options

```text
Usage: warnlock [options] -- <command> [args...]

Options:
  -b, --baseline <path>  Baseline file to read or write (default: .warnlock.json)
  -u, --update           Replace the baseline with the command's current warnings
  -h, --help             Show help
  -v, --version          Show the package version
```

## Baseline format

The baseline is deterministic JSON:

```json
{
  "version": 1,
  "warnings": [
    {
      "fingerprint": "2ac48ac75d80f790",
      "name": "DeprecationWarning",
      "code": "DEP0005",
      "message": "Buffer() is deprecated",
      "count": 1
    }
  ]
}
```

Warning fingerprints ignore Node process IDs and normalize the current working directory, home directory, and line-column pairs in warning messages.
