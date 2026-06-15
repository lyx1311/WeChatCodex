import type { ExecutionMode } from '../session.js';
import { parseCodexOutput, type CodexCommandExecution, type CodexFileChange } from './events.js';
import { CODEX_RUN_TIMEOUT_MS } from '../constants.js';
import { spawnCommand, terminateProcessTree } from '../utils/process.js';

export interface CodexRunOptions {
  prompt: string;
  cwd: string;
  threadId?: string;
  model?: string;
  mode: ExecutionMode;
  images?: string[];
}

export interface CodexRunResult {
  threadId?: string;
  replyText: string;
  commands: CodexCommandExecution[];
  fileChanges: CodexFileChange[];
  error?: string;
}

export function buildCodexArgs(options: CodexRunOptions): string[] {
  if (options.threadId) {
    const args: string[] = ['exec', 'resume', '--json', '--skip-git-repo-check'];
    if (options.model) {
      args.push('-m', options.model);
    }
    for (const imagePath of options.images ?? []) {
      args.push('--image', imagePath);
    }
    args.push(options.threadId, options.prompt);
    return args;
  }

  const args: string[] = ['exec', '--json', '--skip-git-repo-check', '-C', options.cwd];
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.mode === 'plan') {
    args.push('-s', 'read-only', '-c', 'approval_policy="never"');
  } else if (options.mode === 'workspace') {
    args.push('-s', 'workspace-write', '-c', 'approval_policy="never"');
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  for (const imagePath of options.images ?? []) {
    args.push('--image', imagePath);
  }
  args.push(options.prompt);
  return args;
}

export async function runCodex(options: CodexRunOptions): Promise<CodexRunResult> {
  const args = buildCodexArgs(options);

  return new Promise<CodexRunResult>((resolve, reject) => {
    const child = spawnCommand('codex', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      stderr += `Codex timed out after ${CODEX_RUN_TIMEOUT_MS}ms`;
      terminateProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (!settled) {
          terminateProcessTree(child, 'SIGKILL');
        }
      }, 3000);
    }, CODEX_RUN_TIMEOUT_MS);

    child.stdout!.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr!.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      const parsed = parseCodexOutput(stdout, stderr, code);
      resolve({
        threadId: parsed.threadId ?? options.threadId,
        replyText: parsed.replyText,
        commands: parsed.commands,
        fileChanges: parsed.fileChanges,
        error: parsed.error,
      });
    });
  });
}
