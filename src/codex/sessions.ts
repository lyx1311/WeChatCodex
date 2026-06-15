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
