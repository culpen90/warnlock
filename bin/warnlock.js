#!/usr/bin/env node
'use strict';

const { main } = require('../lib/cli');

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`warnlock: ${error.message}\n`);
    process.exitCode = 1;
  }
);
