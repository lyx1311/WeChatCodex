import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeCommand } from '../src/commands/router.js';
import type { Session } from '../src/session.js';

function buildContext(text: string, session?: Partial<Session>) {
  const current: Session = {
    workingDirectory: '/tmp/default',
    state: 'idle',
    mode: 'workspace',
    ...session,
  };

  return {
    accountId: 'acct-1',
    session: current,
    updateSession(partial: Partial<Session>) {
      Object.assign(current, partial);
    },
    clearSession() {
      return {
        workingDirectory: current.workingDirectory,
        model: current.model,
        mode: current.mode,
        state: 'idle' as const,
      };
    },
    text,
  };
}

function buildCodexHome(
  cwd: string,
  sessions: Array<{ id: string; name?: string; updatedAt: string; events?: unknown[] }>,
): string {
  const codexHome = mkdtempSync(join(tmpdir(), 'wcb-command-codex-'));
  const directory = join(codexHome, 'sessions', '2026', '06', '16');
  mkdirSync(directory, { recursive: true });
  for (const session of sessions) {
    const metadata = {
        type: 'session_meta',
        payload: {
          id: session.id,
          cwd,
          timestamp: session.updatedAt,
          source: 'cli',
        },
      };
    const events = [metadata, ...(session.events ?? [])];
    writeFileSync(join(directory, `rollout-${session.id}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
  writeFileSync(
    join(codexHome, 'session_index.jsonl'),
    sessions
      .filter((session) => session.name)
      .map((session) => JSON.stringify({
        id: session.id,
        thread_name: session.name,
        updated_at: session.updatedAt,
      }))
      .join('\n'),
  );
  return codexHome;
}

test('/mode updates the execution mode', () => {
  const ctx = buildContext('/mode plan', { threadId: 'thread-1' });
  const result = routeCommand(ctx);
  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /plan/);
  assert.equal(ctx.session.mode, 'plan');
  assert.equal(ctx.session.threadId, undefined);
});

test('/cwd validates and updates the working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wcb-cwd-'));
  const ctx = buildContext(`/cwd ${dir}`);
  const result = routeCommand(ctx);
  assert.match(result.reply ?? '', /工作目录已切换/);
  assert.equal(ctx.session.workingDirectory, dir);
});

test('unknown slash command falls back to help when skill is absent', () => {
  const ctx = buildContext('/no-such-skill');
  const result = routeCommand(ctx);
  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /未找到 skill/);
});

test('/threads lists sessions for the current working directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wcb-threads-cwd-'));
  const codexHome = buildCodexHome(cwd, [
    { id: 'session-1', name: 'Existing CLI conversation', updatedAt: '2026-06-16T10:00:00.000Z' },
  ]);
  const ctx = { ...buildContext('/threads', { workingDirectory: cwd }), codexHome };
  const result = routeCommand(ctx);
  assert.match(result.reply ?? '', /Existing CLI conversation/);
  assert.match(result.reply ?? '', /session-1/);
});

test('/threads limits output to 10 sessions and sanitizes long names', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wcb-threads-limit-'));
  const sessions = Array.from({ length: 11 }, (_, index) => ({
    id: `session-${index}`,
    name: index === 10 ? `${'Long '.repeat(20)}\nTitle` : `Session ${index}`,
    updatedAt: `2026-06-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
  }));
  const codexHome = buildCodexHome(cwd, sessions);
  const ctx = { ...buildContext('/threads', { workingDirectory: cwd }), codexHome };
  const result = routeCommand(ctx);
  const reply = result.reply ?? '';
  assert.match(reply, /仅显示最近 10 个，共 11 个/);
  assert.match(reply, /\.\.\./);
  assert.doesNotMatch(reply, /Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long/);
});

test('/resume latest selects the newest session without changing other settings', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wcb-resume-cwd-'));
  const codexHome = buildCodexHome(cwd, [
    { id: 'session-old', name: 'Old', updatedAt: '2026-06-15T10:00:00.000Z' },
    {
      id: 'session-new',
      name: 'New',
      updatedAt: '2026-06-16T10:00:00.000Z',
      events: [
        { type: 'event_msg', payload: { type: 'user_message', message: 'previous question' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'previous answer' } },
      ],
    },
  ]);
  const ctx = {
    ...buildContext('/resume latest', { workingDirectory: cwd, model: 'gpt-test', mode: 'plan' }),
    codexHome,
  };
  const result = routeCommand(ctx);
  assert.equal(ctx.session.threadId, 'session-new');
  assert.equal(ctx.session.model, 'gpt-test');
  assert.equal(ctx.session.mode, 'plan');
  assert.match(result.reply ?? '', /最近三轮对话/);
  assert.match(result.reply ?? '', /previous question/);
  assert.match(result.reply ?? '', /previous answer/);
});

test('/resume selects a uniquely named session', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wcb-resume-name-'));
  const codexHome = buildCodexHome(cwd, [
    { id: 'session-named', name: 'My CLI session', updatedAt: '2026-06-16T10:00:00.000Z' },
  ]);
  const ctx = { ...buildContext('/resume My CLI session', { workingDirectory: cwd }), codexHome };
  routeCommand(ctx);
  assert.equal(ctx.session.threadId, 'session-named');
});

test('/resume succeeds when no history is displayable', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wcb-resume-empty-history-'));
  const codexHome = buildCodexHome(cwd, [
    { id: 'session-empty', name: 'Empty', updatedAt: '2026-06-16T10:00:00.000Z' },
  ]);
  const ctx = { ...buildContext('/resume Empty', { workingDirectory: cwd }), codexHome };
  const result = routeCommand(ctx);
  assert.equal(ctx.session.threadId, 'session-empty');
  assert.match(result.reply ?? '', /未找到可展示的历史对话/);
});

test('/resume rejects duplicate names and sessions from another directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wcb-resume-duplicate-'));
  const otherCwd = mkdtempSync(join(tmpdir(), 'wcb-resume-other-'));
  const codexHome = buildCodexHome(cwd, [
    { id: 'session-a', name: 'Duplicate', updatedAt: '2026-06-16T10:00:00.000Z' },
    { id: 'session-b', name: 'Duplicate', updatedAt: '2026-06-16T11:00:00.000Z' },
  ]);
  const otherDirectory = join(codexHome, 'sessions', '2026', '06', '17');
  mkdirSync(otherDirectory, { recursive: true });
  writeFileSync(
    join(otherDirectory, 'rollout-other.jsonl'),
    `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'session-other', cwd: otherCwd, timestamp: '2026-06-17T10:00:00.000Z', source: 'cli' },
    })}\n`,
  );

  const duplicateCtx = { ...buildContext('/resume Duplicate', { workingDirectory: cwd }), codexHome };
  const duplicateResult = routeCommand(duplicateCtx);
  assert.match(duplicateResult.reply ?? '', /session-a/);
  assert.match(duplicateResult.reply ?? '', /session-b/);
  assert.equal(duplicateCtx.session.threadId, undefined);

  const otherCtx = { ...buildContext('/resume session-other', { workingDirectory: cwd }), codexHome };
  routeCommand(otherCtx);
  assert.equal(otherCtx.session.threadId, undefined);
});
