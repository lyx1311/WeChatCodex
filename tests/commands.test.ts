import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
