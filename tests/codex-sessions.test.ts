import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatConversationContext,
  normalizeSessionPath,
  readRecentConversationTurns,
  scanCodexSessions,
  sessionsForDirectory,
  truncateContextText,
} from '../src/codex/sessions.js';

function createCodexHome(): string {
  return mkdtempSync(join(tmpdir(), 'wcb-codex-home-'));
}

function writeSession(
  codexHome: string,
  id: string,
  cwd: string,
  timestamp: string,
  source = 'cli',
  suffix = id,
): void {
  const directory = join(codexHome, 'sessions', '2026', '06', '16');
  mkdirSync(directory, { recursive: true });
  const event = {
    timestamp,
    type: 'session_meta',
    payload: { id, cwd, timestamp, source, originator: 'codex-tui' },
  };
  writeFileSync(
    join(directory, `rollout-${suffix}.jsonl`),
    `${JSON.stringify(event)}\n{"type":"response_item","payload":{"secret":"not read"}}\n`,
  );
}

function writeRollout(codexHome: string, id: string, events: unknown[]): string {
  const directory = join(codexHome, 'sessions', '2026', '06', '16');
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, `rollout-${id}.jsonl`);
  writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return filePath;
}

test('scanCodexSessions merges names and sorts by latest update', () => {
  const codexHome = createCodexHome();
  writeSession(codexHome, 'session-old', '/work/project', '2026-06-15T10:00:00.000Z');
  writeSession(codexHome, 'session-new', '/work/project', '2026-06-16T10:00:00.000Z', 'vscode');
  writeFileSync(
    join(codexHome, 'session_index.jsonl'),
    [
      JSON.stringify({ id: 'session-old', thread_name: 'Old session', updated_at: '2026-06-15T11:00:00.000Z' }),
      '{bad json',
      JSON.stringify({ id: 'session-new', thread_name: 'New session', updated_at: '2026-06-16T11:00:00.000Z' }),
    ].join('\n'),
  );

  const sessions = scanCodexSessions({ codexHome, platform: 'linux' });
  assert.deepEqual(sessions.map((session) => session.id), ['session-new', 'session-old']);
  assert.equal(sessions[0].name, 'New session');
  assert.equal(sessions[0].source, 'vscode');
});

test('sessionsForDirectory filters by normalized working directory', () => {
  const codexHome = createCodexHome();
  writeSession(codexHome, 'matching', '/work/project', '2026-06-16T10:00:00.000Z');
  writeSession(codexHome, 'other', '/work/other', '2026-06-16T11:00:00.000Z');

  const sessions = sessionsForDirectory('/work/project/.', { codexHome, platform: 'linux' });
  assert.deepEqual(sessions.map((session) => session.id), ['matching']);
});

test('Windows paths are compared case-insensitively', () => {
  assert.equal(
    normalizeSessionPath('C:\\Work\\Project', 'win32'),
    normalizeSessionPath('c:\\work\\project\\.', 'win32'),
  );
});

test('scanner skips malformed session files and missing directories', () => {
  const codexHome = createCodexHome();
  const directory = join(codexHome, 'sessions', '2026');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'rollout-bad.jsonl'), '{not json}\n');
  assert.deepEqual(scanCodexSessions({ codexHome }), []);
  assert.deepEqual(scanCodexSessions({ codexHome: join(codexHome, 'missing') }), []);
});

test('readRecentConversationTurns extracts the latest three event_msg turns', () => {
  const codexHome = createCodexHome();
  const filePath = writeRollout(codexHome, 'history', [
    { type: 'session_meta', payload: { id: 'history', cwd: '/work', timestamp: '2026-06-16T10:00:00.000Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'u1' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'a1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'u2' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'a2' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'u3' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'a3' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'u4' } },
  ]);

  const turns = readRecentConversationTurns({ filePath });
  assert.deepEqual(turns.map((turn) => turn.user?.text), ['u2', 'u3', 'u4']);
  assert.deepEqual(turns.map((turn) => turn.assistant?.text), ['a2', 'a3', undefined]);
});

test('readRecentConversationTurns falls back to response_item messages', () => {
  const codexHome = createCodexHome();
  const filePath = writeRollout(codexHome, 'response-history', [
    { type: 'session_meta', payload: { id: 'response-history', cwd: '/work', timestamp: '2026-06-16T10:00:00.000Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'world' }] } },
  ]);

  const turns = readRecentConversationTurns({ filePath });
  assert.equal(turns[0].user?.text, 'hello');
  assert.equal(turns[0].assistant?.text, 'world');
});

test('event_msg history is preferred over response_item to avoid duplicates', () => {
  const codexHome = createCodexHome();
  const filePath = writeRollout(codexHome, 'dedupe-history', [
    { type: 'session_meta', payload: { id: 'dedupe-history', cwd: '/work', timestamp: '2026-06-16T10:00:00.000Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'response user' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'event user' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'event assistant' } },
  ]);

  const turns = readRecentConversationTurns({ filePath });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user?.text, 'event user');
});

test('formatConversationContext truncates long user and assistant messages', () => {
  const longText = 'x'.repeat(700);
  const formatted = formatConversationContext([
    { user: { role: 'user', text: longText }, assistant: { role: 'assistant', text: longText } },
  ]);
  assert.match(formatted, /中间已隐藏，原文共 700 字/);
  assert.equal(truncateContextText('short'), 'short');
});
