import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { buildCodexPrompt, cleanupTempFiles, extractFirstSupportedMedia, extractText, prepareMediaForCodex } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { runCodex } from './codex/bridge.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { dequeueQueuedMessage, enqueueQueuedMessage } from './message-queue.js';
import { DATA_DIR } from './constants.js';
import { splitMessage } from './utils/chunk.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

interface QueuedCodexMessage {
  userText: string;
  media: ReturnType<typeof extractFirstSupportedMedia>;
  fromUserId: string;
  contextToken: string;
}

const queuedMessages = new Map<string, QueuedCodexMessage[]>();

function promptUser(question: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue || '');
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function openFile(filePath: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'darwin' ? [filePath] : platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

function ensureUsableDirectory(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`不是目录: ${cwd}`);
  }
}

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const qrPath = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    const isHeadlessLinux = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
      } catch {
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(qrPath, pngData);
      openFile(qrPath);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${qrPath}\n`);
    }

    console.log('等待扫码绑定...');
    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  try {
    unlinkSync(qrPath);
  } catch {
    logger.warn('Failed to clean up QR image', { path: qrPath });
  }

  const workingDir = await promptUser('请输入默认工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  if (!config.mode) {
    config.mode = 'workspace';
  }
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 npm run setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session = sessionStore.load(account.accountId);
  if (session.state === 'processing') {
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }
  const sender = createSender(api, account.accountId);

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      await handleMessage(msg, account, session, sessionStore, sender, config);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, please rerun setup');
      console.error('⚠️ 微信会话已过期，请重新运行 npm run setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  const shutdown = (): void => {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);
  await monitor.run();
}

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  const userText = extractTextFromItems(msg.item_list);
  const media = extractFirstSupportedMedia(msg.item_list);
  const isSlashCommand = userText.startsWith('/');

  if (session.state === 'processing') {
    if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      if (!isSlashCommand && (userText || media)) {
        const queueLength = enqueueQueuedMessage(queuedMessages, account.accountId, {
          userText,
          media,
          fromUserId,
          contextToken,
        });
        await sender.sendText(
          fromUserId,
          contextToken,
          `⏳ 正在处理上一条消息，这条已加入队列（前面还有 ${queueLength} 条）。处理完会自动继续，无需重发。`,
        );
        return;
      }
      await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后...');
      return;
    }
  }

  if (isSlashCommand) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId, session),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);
    if (result.reply) {
      for (const chunk of splitMessage(result.reply)) {
        await sender.sendText(fromUserId, contextToken, chunk);
      }
      return;
    }
    if (result.codexPrompt) {
      void sendToCodex(result.codexPrompt, media, fromUserId, contextToken, account, session, sessionStore, sender, config);
      return;
    }
    if (result.handled) {
      return;
    }
  }

  if (!userText && !media) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、图片、语音、音频或视频');
    return;
  }

  void sendToCodex(userText, media, fromUserId, contextToken, account, session, sessionStore, sender, config);
}

async function sendToCodex(
  userText: string,
  media: ReturnType<typeof extractFirstSupportedMedia>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  const tempFiles: string[] = [];
  let prompt = userText.trim();
  let imagePaths: string[] = [];

  try {
    if (media) {
      const preparedMedia = await prepareMediaForCodex(media);
      tempFiles.push(...preparedMedia.tempFiles);

      if (preparedMedia.immediateReply) {
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        await sender.sendText(fromUserId, contextToken, preparedMedia.immediateReply);
        return;
      }

      prompt = buildCodexPrompt(userText, preparedMedia);
      imagePaths = preparedMedia.imagePaths;
    }

    if (!prompt) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      await sender.sendText(fromUserId, contextToken, '⚠️ 未提取到可发送给 Codex 的内容，请重试。');
      return;
    }

    const cwd = session.workingDirectory || config.workingDirectory;
    const mode = session.mode ?? config.mode ?? 'workspace';
    ensureUsableDirectory(cwd);

    const result = await runCodex({
      prompt,
      cwd,
      threadId: session.threadId,
      model: session.model ?? config.model,
      mode,
      images: imagePaths,
    });

    session.threadId = result.threadId ?? session.threadId;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);

    if (result.error) {
      logger.error('Codex execution error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, `⚠️ Codex 执行失败\n${result.error.slice(0, 1200)}`);
      return;
    }

    const replyText = result.replyText || (
      result.fileChanges.length > 0
        ? `已完成，变更文件：\n${result.fileChanges.map((change) => `${change.kind}: ${change.path}`).join('\n')}`
        : ''
    );

    if (!replyText) {
      await sender.sendText(fromUserId, contextToken, 'ℹ️ Codex 无返回内容。');
      return;
    }

    for (const chunk of splitMessage(replyText)) {
      await sender.sendText(fromUserId, contextToken, chunk);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to process WeChat message', { error: errorMsg });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
    await sender.sendText(fromUserId, contextToken, `⚠️ 处理消息时出错\n${errorMsg.slice(0, 1200)}`);
  } finally {
    cleanupTempFiles(tempFiles);
    if (session.state === 'idle') {
      const nextQueuedMessage = dequeueQueuedMessage(queuedMessages, account.accountId);
      if (nextQueuedMessage) {
        logger.info('Processing queued WeChat message', { accountId: account.accountId });
        void sendToCodex(
          nextQueuedMessage.userText,
          nextQueuedMessage.media,
          nextQueuedMessage.fromUserId,
          nextQueuedMessage.contextToken,
          account,
          session,
          sessionStore,
          sender,
          config,
        );
      }
    }
  }
}

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
