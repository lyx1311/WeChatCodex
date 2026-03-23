import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexOutput } from '../src/codex/events.js';
import { buildCodexArgs } from '../src/codex/bridge.js';

test('parseCodexOutput extracts thread id, final reply, commands, and file changes', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'intermediate' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: '/bin/zsh -lc pwd', exit_code: 0, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/tmp/a.ts', kind: 'add' }] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final reply' } }),
  ].join('\n');

  const result = parseCodexOutput(stdout, '', 0);
  assert.equal(result.threadId, 'thread-123');
  assert.equal(result.replyText, 'final reply');
  assert.equal(result.commands.length, 1);
  assert.equal(result.fileChanges.length, 1);
});

test('parseCodexOutput returns stderr as error on non-zero exit', () => {
  const result = parseCodexOutput('', 'boom', 1);
  assert.equal(result.error, 'boom');
});

test('buildCodexArgs maps workspace mode to workspace-write sandbox', () => {
  const args = buildCodexArgs({
    prompt: 'hello',
    cwd: '/tmp/project',
    mode: 'workspace',
  });

  assert.deepEqual(args.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '-C', '/tmp/project', '-s', 'workspace-write']);
  assert.ok(args.includes('approval_policy="never"'));
});

test('buildCodexArgs omits cwd flags on resume', () => {
  const args = buildCodexArgs({
    prompt: 'follow up',
    cwd: '/tmp/project',
    threadId: 'thread-1',
    mode: 'plan',
  });

  assert.deepEqual(args.slice(0, 4), ['exec', 'resume', '--json', '--skip-git-repo-check']);
  assert.equal(args.includes('-C'), false);
  assert.equal(args.at(-2), 'thread-1');
  assert.equal(args.at(-1), 'follow up');
});
