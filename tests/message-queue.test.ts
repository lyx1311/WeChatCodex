import test from 'node:test';
import assert from 'node:assert/strict';

import { dequeueQueuedMessage, enqueueQueuedMessage, getQueuedMessageCount } from '../src/message-queue.js';

test('queued messages are returned in FIFO order', () => {
  const queues = new Map<string, string[]>();

  assert.equal(enqueueQueuedMessage(queues, 'acct-1', 'first'), 1);
  assert.equal(enqueueQueuedMessage(queues, 'acct-1', 'second'), 2);
  assert.equal(getQueuedMessageCount(queues, 'acct-1'), 2);

  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), 'first');
  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), 'second');
  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), undefined);
  assert.equal(getQueuedMessageCount(queues, 'acct-1'), 0);
});

test('queues are isolated per account', () => {
  const queues = new Map<string, string[]>();

  enqueueQueuedMessage(queues, 'acct-1', 'first');
  enqueueQueuedMessage(queues, 'acct-2', 'other');

  assert.equal(dequeueQueuedMessage(queues, 'acct-2'), 'other');
  assert.equal(dequeueQueuedMessage(queues, 'acct-1'), 'first');
});
