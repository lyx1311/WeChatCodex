import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePid } from '../src/daemon.js';
import { buildTerminationCommand } from '../src/utils/process.js';

test('parsePid accepts a positive integer PID', () => {
  assert.equal(parsePid('1234\n'), 1234);
});

test('parsePid rejects invalid PID values', () => {
  assert.equal(parsePid(''), undefined);
  assert.equal(parsePid('0'), undefined);
  assert.equal(parsePid('-1'), undefined);
  assert.equal(parsePid('not-a-pid'), undefined);
});

test('Windows process termination uses taskkill for the full process tree', () => {
  assert.deepEqual(buildTerminationCommand(4321, 'win32'), {
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F'],
  });
});

test('Unix process termination does not require an external command', () => {
  assert.equal(buildTerminationCommand(4321, 'linux'), undefined);
});
