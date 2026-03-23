export interface CodexCommandExecution {
  command: string;
  exitCode: number | null;
  status: string;
}

export interface CodexFileChange {
  path: string;
  kind: string;
}

export interface ParsedCodexOutput {
  threadId?: string;
  replyText: string;
  messages: string[];
  commands: CodexCommandExecution[];
  fileChanges: CodexFileChange[];
  stderrText: string;
  error?: string;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function parseCodexOutput(stdout: string, stderr: string, exitCode: number | null): ParsedCodexOutput {
  let threadId: string | undefined;
  const messages: string[] = [];
  const commands: CodexCommandExecution[] = [];
  const fileChanges: CodexFileChange[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJsonLine(line) as any;
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      continue;
    }

    if (event.type !== 'item.completed' && event.type !== 'item.started') {
      continue;
    }

    const item = event.item;
    if (!item || typeof item !== 'object') continue;

    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      messages.push(item.text);
      continue;
    }

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      commands.push({
        command: item.command,
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : 'unknown',
      });
      continue;
    }

    if (event.type === 'item.completed' && item.type === 'file_change' && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change && typeof change.path === 'string' && typeof change.kind === 'string') {
          fileChanges.push({ path: change.path, kind: change.kind });
        }
      }
    }
  }

  const replyText = messages.length > 0 ? messages[messages.length - 1].trim() : '';

  let error: string | undefined;
  const trimmedStderr = stderr.trim();
  if (exitCode && exitCode !== 0) {
    error = trimmedStderr || `Codex exited with code ${exitCode}`;
  } else if (!replyText && trimmedStderr) {
    error = trimmedStderr;
  }

  return {
    threadId,
    replyText,
    messages,
    commands,
    fileChanges,
    stderrText: trimmedStderr,
    error,
  };
}
