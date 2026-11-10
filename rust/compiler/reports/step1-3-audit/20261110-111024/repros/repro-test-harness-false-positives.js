'use strict';
const fs = require('fs');
const path = require('path');

const runnerPath = path.resolve(__dirname, '../../../../tests/differential/runner.js');
const step3TestPath = path.resolve(__dirname, '../../../../tests/integration/step3-parser-walk-scope.test.js');

const runnerLines = fs.readFileSync(runnerPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
const step3Lines = fs.readFileSync(step3TestPath, 'utf8').replace(/\r\n/g, '\n').split('\n');

console.log('=== ISSUE-TEST-01: runner.js lines 815-835 ===');
console.log(runnerLines.slice(814, 835).join('\n'));

console.log('\n=== ISSUE-TEST-02: runner.js lines 955-1006 ===');
console.log(runnerLines.slice(954, 1006).join('\n'));

console.log('\n=== ISSUE-TEST-03: step3-parser-walk-scope.test.js lines 172-186 ===');
console.log(step3Lines.slice(171, 186).join('\n'));
