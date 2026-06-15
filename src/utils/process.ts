import crossSpawn from 'cross-spawn';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface TerminationCommand {
  command: string;
  args: string[];
}

export function buildTerminationCommand(pid: number, platform = process.platform): TerminationCommand | undefined {
  if (platform !== 'win32') {
    return undefined;
  }

  return {
    command: 'taskkill',
    args: ['/PID', String(pid), '/T', '/F'],
  };
}

export function spawnCommand(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return crossSpawn(command, [...args], options);
}

export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  platform = process.platform,
): void {
  if (!child.pid) {
    return;
  }

  const termination = buildTerminationCommand(child.pid, platform);
  if (termination) {
    const killer = crossSpawn(termination.command, termination.args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      // The process may already have exited.
    });
    return;
  }

  child.kill(signal);
}
