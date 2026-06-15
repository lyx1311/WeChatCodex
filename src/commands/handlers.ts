import type { CommandContext, CommandResult } from './router.js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { scanAllSkills, findSkill, type SkillInfo } from '../codex/skill-scanner.js';
import { formatConversationContext, readRecentConversationTurns, sessionsForDirectory, type CodexSessionInfo } from '../codex/sessions.js';

const HELP_TEXT = `可用命令：

  /help             显示帮助
  /clear            清除当前会话
  /model <名称>     切换 Codex 模型
  /cwd <路径>       切换工作目录
  /mode <模式>      切换执行模式
  /status           查看当前会话状态
  /threads          列出当前目录的 Codex 会话
  /resume <ID|名称|latest>  接入已有 Codex 会话
  /skills           列出已安装的 skills
  /<skill> [参数]   触发已安装的 skill

直接输入文字即可与本机 Codex 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model gpt-5.4', handled: true };
  }
  ctx.updateSession({ model: args, threadId: undefined });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

function expandUserPath(input: string): string {
  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }
  if (input === '~') {
    return homedir();
  }
  return resolve(input);
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /cwd <目录路径>', handled: true };
  }
  const nextPath = expandUserPath(args.trim());
  if (!existsSync(nextPath)) {
    return { reply: `目录不存在: ${nextPath}`, handled: true };
  }
  if (!statSync(nextPath).isDirectory()) {
    return { reply: `不是目录: ${nextPath}`, handled: true };
  }
  ctx.updateSession({ workingDirectory: nextPath, threadId: undefined });
  return { reply: `✅ 工作目录已切换为: ${nextPath}\n已重置会话线程，新目录会在下一条请求生效。`, handled: true };
}

const MODE_DESCRIPTIONS: Record<string, string> = {
  plan: '只读分析模式',
  workspace: '工作区可写模式',
  danger: '无沙箱模式',
};

export function handleMode(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.mode ?? 'workspace';
    const lines = [
      '🔒 当前执行模式: ' + current,
      '',
      '可用模式:',
      ...Object.entries(MODE_DESCRIPTIONS).map(([mode, desc]) => `  ${mode} — ${desc}`),
      '',
      '用法: /mode <模式>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim().toLowerCase();
  if (!(mode in MODE_DESCRIPTIONS)) {
    return {
      reply: `未知模式: ${mode}\n可用: ${Object.keys(MODE_DESCRIPTIONS).join(', ')}`,
      handled: true,
    };
  }
  ctx.updateSession({ mode: mode as any, threadId: undefined });
  const warning = mode === 'danger' ? '\n\n⚠️ danger 模式会以无沙箱方式运行本机 Codex。' : '';
  return { reply: `✅ 执行模式已切换为: ${mode}\n${MODE_DESCRIPTIONS[mode]}\n已重置会话线程，新模式会在下一条请求生效。${warning}`, handled: true };
}

export function handlePermissionAlias(): CommandResult {
  return {
    handled: true,
    reply: 'Codex bridge 不支持 Claude SDK 那种逐工具权限回调。请使用 /mode plan|workspace|danger 控制执行级别。',
  };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.mode ?? 'workspace';
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `执行模式: ${mode}`,
    `线程ID: ${s.threadId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

function cleanSessionName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const singleLine = name.replace(/\s+/g, ' ').trim();
  if (!singleLine) return undefined;
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

function formatSessionTime(timestamp: string): string {
  return timestamp.replace('T', ' ').slice(0, 16);
}

function formatSessionSource(source: string): string {
  if (source === 'cli') return 'CLI';
  if (source === 'vscode') return 'IDE';
  return source;
}

function getDirectorySessions(ctx: CommandContext): CodexSessionInfo[] {
  return sessionsForDirectory(ctx.session.workingDirectory, { codexHome: ctx.codexHome });
}

export function handleThreads(ctx: CommandContext): CommandResult {
  const sessions = getDirectorySessions(ctx);
  if (sessions.length === 0) {
    return {
      reply: `当前工作目录没有可恢复的 Codex 会话。\n${ctx.session.workingDirectory}`,
      handled: true,
    };
  }

  const visible = sessions.slice(0, 10);
  const lines = visible.map((session, index) => {
    const name = cleanSessionName(session.name) ?? session.id.slice(0, 8);
    return `${index + 1}. ${name}\n${formatSessionTime(session.updatedAt)} | ${formatSessionSource(session.source)}\n${session.id}`;
  });
  if (sessions.length > visible.length) {
    lines.push(`仅显示最近 ${visible.length} 个，共 ${sessions.length} 个。`);
  }
  return {
    reply: `当前目录的 Codex 会话：\n\n${lines.join('\n\n')}`,
    handled: true,
  };
}

export function handleResume(ctx: CommandContext, args: string): CommandResult {
  const identifier = args.trim();
  if (!identifier) {
    return { reply: '用法: /resume <会话ID|会话名称|latest>', handled: true };
  }

  const sessions = getDirectorySessions(ctx);
  let selected: CodexSessionInfo | undefined;

  if (identifier.toLowerCase() === 'latest') {
    selected = sessions[0];
  } else {
    selected = sessions.find((session) => session.id === identifier);
    if (!selected) {
      const nameMatches = sessions.filter(
        (session) => session.name?.localeCompare(identifier, undefined, { sensitivity: 'accent' }) === 0,
      );
      if (nameMatches.length > 1) {
        return {
          reply: `会话名称重复，请使用完整 ID：\n${nameMatches.map((session) => session.id).join('\n')}`,
          handled: true,
        };
      }
      selected = nameMatches[0];
    }
  }

  if (!selected) {
    return {
      reply: `未找到当前工作目录下的会话: ${identifier}\n请运行 /threads 查看可用会话，或使用 /cwd 切换目录。`,
      handled: true,
    };
  }

  ctx.updateSession({ threadId: selected.id });
  const name = cleanSessionName(selected.name);
  const context = formatConversationContext(readRecentConversationTurns(selected));
  return {
    reply: `已接入 Codex 会话${name ? `: ${name}` : ''}\n线程ID: ${selected.id}\n下一条普通消息将继续该会话。\n\n${context}`,
    handled: true,
  };
}

export function handleSkills(): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }
  const lines = skills.map(s => `/${s.name} — ${s.description}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}`, handled: true };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args
      ? `Use the ${skill.name} skill for this request: ${args}`
      : `Use the ${skill.name} skill for the user's request.`;
    return { handled: true, codexPrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
