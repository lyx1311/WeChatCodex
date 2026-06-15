import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';

import { DATA_DIR, LOG_DIR } from './constants.js';
import { buildTerminationCommand } from './utils/process.js';

const SERVICE_NAME = 'wechat-codex-bridge';
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN_PATH = join(PROJECT_DIR, 'dist', 'src', 'main.js');
const PID_PATH = join(DATA_DIR, `${SERVICE_NAME}.pid`);
const STDOUT_PATH = join(LOG_DIR, 'stdout.log');
const STDERR_PATH = join(LOG_DIR, 'stderr.log');
const COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'logs']);

export function parsePid(raw: string): number | undefined {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | undefined {
  try {
    return parsePid(readFileSync(PID_PATH, 'utf8'));
  } catch {
    return undefined;
  }
}

function removePidFile(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // Missing or already removed.
  }
}

function waitForProcessExit(pid: number, timeoutMs = 2_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !isProcessRunning(pid);
}

function startWindows(): void {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Already running (PID: ${existingPid})`);
    return;
  }
  removePidFile();

  if (!existsSync(MAIN_PATH)) {
    throw new Error(`Build output not found: ${MAIN_PATH}. Run npm run build first.`);
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const stdoutFd = openSync(STDOUT_PATH, 'a');
  const stderrFd = openSync(STDERR_PATH, 'a');

  try {
    const child = crossSpawn(process.execPath, [MAIN_PATH, 'start'], {
      cwd: PROJECT_DIR,
      detached: true,
      env: process.env,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    });

    if (!child.pid) {
      throw new Error('Failed to start daemon process');
    }

    child.on('error', () => {
      if (readPid() === child.pid) {
        removePidFile();
      }
    });
    child.unref();
    mkdirSync(dirname(PID_PATH), { recursive: true });
    writeFileSync(PID_PATH, `${child.pid}\n`, 'utf8');
    console.log(`Started WeChatCodex daemon (PID: ${child.pid})`);
    console.log(`Logs: ${STDOUT_PATH}`);
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function stopWindows(): void {
  const pid = readPid();
  if (!pid) {
    removePidFile();
    console.log('Not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    console.log('Not running (stale PID file removed)');
    return;
  }

  const termination = buildTerminationCommand(pid, 'win32');
  if (!termination) {
    throw new Error('Unable to build Windows termination command');
  }

  const result = crossSpawn.sync(termination.command, termination.args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (!waitForProcessExit(pid)) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Failed to stop daemon process ${pid}${detail ? `: ${detail}` : ''}`);
  }

  removePidFile();
  console.log(`Stopped WeChatCodex daemon (PID: ${pid})`);
}

function statusWindows(): void {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`Running (PID: ${pid})`);
    return;
  }

  if (pid) {
    removePidFile();
    console.log('Not running (stale PID file removed)');
    return;
  }

  console.log('Not running');
}

function tailFile(filePath: string, lineCount: number): void {
  if (!existsSync(filePath)) {
    return;
  }
  const lines = readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/);
  console.log(`=== ${filePath} ===`);
  console.log(lines.slice(-lineCount).join('\n'));
}

function logsWindows(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const bridgeLogs = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('bridge-') && name.endsWith('.log'))
    .sort()
    .reverse();

  if (bridgeLogs[0]) {
    tailFile(join(LOG_DIR, bridgeLogs[0]), 100);
    return;
  }

  if (!existsSync(STDOUT_PATH) && !existsSync(STDERR_PATH)) {
    console.log('No logs found');
    return;
  }

  tailFile(STDOUT_PATH, 50);
  tailFile(STDERR_PATH, 50);
}

function runUnix(command: string): void {
  const scriptPath = join(PROJECT_DIR, 'scripts', 'daemon.sh');
  const result = crossSpawn.sync('bash', [scriptPath, command], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

export function runDaemonCommand(command: string, platform = process.platform): void {
  if (!COMMANDS.has(command)) {
    throw new Error('Usage: npm run daemon -- {start|stop|restart|status|logs}');
  }

  if (platform !== 'win32') {
    runUnix(command);
    return;
  }

  switch (command) {
    case 'start':
      startWindows();
      break;
    case 'stop':
      stopWindows();
      break;
    case 'restart':
      stopWindows();
      startWindows();
      break;
    case 'status':
      statusWindows();
      break;
    case 'logs':
      logsWindows();
      break;
  }
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const command = process.argv[2] ?? '';
  try {
    runDaemonCommand(command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
