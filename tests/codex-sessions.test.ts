import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeSessionPath, scanCodexSessions, sessionsForDirectory } from '../src/codex/sessions.js';

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
