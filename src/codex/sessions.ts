import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export interface CodexSessionInfo {
  id: string;
  name?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  filePath: string;
}

export interface CodexConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface CodexConversationTurn {
  user?: CodexConversationMessage;
  assistant?: CodexConversationMessage;
}

export interface ScanCodexSessionsOptions {
  codexHome?: string;
  platform?: NodeJS.Platform;
}

interface SessionIndexEntry {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
}

interface SessionMetadata {
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  source?: unknown;
  originator?: unknown;
}

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CONTEXT_TURNS = 3;
export const CONTEXT_MESSAGE_LIMIT = 600;

function readFirstLine(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (total < MAX_METADATA_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_METADATA_BYTES - total));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
      }
      chunks.push(chunk);
      total += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8').replace(/\r$/, '') : undefined;
}

function collectSessionFiles(directory: string, output: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSessionFiles(entryPath, output);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      output.push(entryPath);
    }
  }
}

function loadSessionIndex(codexHome: string): Map<string, { name?: string; updatedAt?: string }> {
  const result = new Map<string, { name?: string; updatedAt?: string }>();
  let content: string;
  try {
    content = readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return result;
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionIndexEntry;
      if (typeof entry.id !== 'string') continue;
      result.set(entry.id, {
        name: typeof entry.thread_name === 'string' ? entry.thread_name : undefined,
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : undefined,
      });
    } catch {
      // Skip malformed index records.
    }
  }
  return result;
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function newestDate(...values: Array<string | undefined>): string {
  const valid = values.filter((value): value is string => Boolean(validDate(value)));
  return valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? new Date(0).toISOString();
}

function sourceName(metadata: SessionMetadata): string {
  if (typeof metadata.source === 'string' && metadata.source) {
    return metadata.source;
  }
  if (typeof metadata.originator === 'string' && metadata.originator) {
    return metadata.originator;
  }
  return 'unknown';
}

export function normalizeSessionPath(input: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return win32.resolve(input).toLowerCase();
  }
  return posix.resolve(input);
}

export function sameSessionPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === process.platform) {
    try {
      return normalizeSessionPath(realpathSync(a), platform) === normalizeSessionPath(realpathSync(b), platform);
    } catch {
      // Fall back to lexical normalization for deleted or inaccessible paths.
    }
  }
  return normalizeSessionPath(a, platform) === normalizeSessionPath(b, platform);
}

export function scanCodexSessions(options: ScanCodexSessionsOptions = {}): CodexSessionInfo[] {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const index = loadSessionIndex(codexHome);
  const files: string[] = [];
  collectSessionFiles(join(codexHome, 'sessions'), files);

  const sessions: CodexSessionInfo[] = [];
  for (const filePath of files) {
    try {
      const firstLine = readFirstLine(filePath);
      if (!firstLine) continue;
      const event = JSON.parse(firstLine) as { payload?: SessionMetadata };
      const metadata = event.payload;
      if (!metadata || typeof metadata.id !== 'string' || typeof metadata.cwd !== 'string') continue;
      const createdAt = validDate(metadata.timestamp);
      if (!createdAt) continue;

      const indexEntry = index.get(metadata.id);
      sessions.push({
        id: metadata.id,
        name: indexEntry?.name,
        cwd: metadata.cwd,
        createdAt,
        updatedAt: newestDate(indexEntry?.updatedAt, statSync(filePath).mtime.toISOString(), createdAt),
        source: sourceName(metadata),
        filePath,
      });
    } catch {
      // Skip malformed or concurrently removed session files.
    }
  }

  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function sessionsForDirectory(
  cwd: string,
  options: ScanCodexSessionsOptions = {},
): CodexSessionInfo[] {
  const platform = options.platform ?? process.platform;
  return scanCodexSessions(options).filter((session) => sameSessionPath(session.cwd, cwd, platform));
}

function extractResponseItemText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as { text?: unknown; content?: unknown };
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    })
    .filter(Boolean);
  const text = parts.join('\n').trim();
  return text || undefined;
}

function parseEventMessage(event: unknown): CodexConversationMessage | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as { timestamp?: unknown; type?: unknown; payload?: unknown };
  if (record.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object') return undefined;
  const payload = record.payload as { type?: unknown; message?: unknown };
  if (payload.type !== 'user_message' && payload.type !== 'agent_message') return undefined;
  if (typeof payload.message !== 'string' || !payload.message.trim()) return undefined;
  return {
    role: payload.type === 'user_message' ? 'user' : 'assistant',
    text: payload.message.trim(),
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
  };
}

function parseResponseItemMessage(event: unknown): CodexConversationMessage | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as { timestamp?: unknown; type?: unknown; payload?: unknown };
  if (record.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') return undefined;
  const payload = record.payload as { type?: unknown; role?: unknown; content?: unknown };
  if (payload.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) return undefined;
  const text = extractResponseItemText(payload.content);
  if (!text) return undefined;
  return {
    role: payload.role,
    text,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
  };
}

function groupConversationTurns(messages: CodexConversationMessage[]): CodexConversationTurn[] {
  const turns: CodexConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ user: message });
      continue;
    }

    const current = turns.at(-1);
    if (!current?.user) continue;
    if (current.assistant) {
      current.assistant = {
        ...message,
        text: `${current.assistant.text}\n\n${message.text}`,
      };
    } else {
      current.assistant = message;
    }
  }
  return turns;
}

export function readRecentConversationTurns(
  session: Pick<CodexSessionInfo, 'filePath'>,
  count = DEFAULT_CONTEXT_TURNS,
): CodexConversationTurn[] {
  let content: string;
  try {
    content = readFileSync(session.filePath, 'utf8');
  } catch {
    return [];
  }

  const eventMessages: CodexConversationMessage[] = [];
  const responseItemMessages: CodexConversationMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const eventMessage = parseEventMessage(event);
      if (eventMessage) {
        eventMessages.push(eventMessage);
        continue;
      }
      const responseMessage = parseResponseItemMessage(event);
      if (responseMessage) {
        responseItemMessages.push(responseMessage);
      }
    } catch {
      // Skip malformed records in otherwise readable rollout files.
    }
  }

  const messages = eventMessages.length > 0 ? eventMessages : responseItemMessages;
  return groupConversationTurns(messages).slice(-count);
}

export function truncateContextText(text: string, limit = CONTEXT_MESSAGE_LIMIT): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit / 2));
  const tail = text.slice(text.length - Math.ceil(limit / 2));
  return `${head}\n...（中间已隐藏，原文共 ${text.length} 字）...\n${tail}`;
}

export function formatConversationContext(turns: CodexConversationTurn[]): string {
  if (turns.length === 0) {
    return '最近三轮对话：未找到可展示的历史对话。';
  }

  const lines = ['最近三轮对话：'];
  turns.forEach((turn, index) => {
    lines.push('');
    lines.push(`第 ${index + 1} 轮`);
    if (turn.user) {
      lines.push(`你：\n${truncateContextText(turn.user.text)}`);
    }
    if (turn.assistant) {
      lines.push(`Codex：\n${truncateContextText(turn.assistant.text)}`);
    }
  });
  return lines.join('\n');
}
