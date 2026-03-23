# WeChat Codex Bridge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local WeChat-to-Codex bridge that receives personal WeChat messages through the ilink protocol and routes them into local `codex` CLI sessions with persistent conversation state.

**Architecture:** Start from the `wechat-claude-code` skeleton for WeChat transport and daemon behavior, then replace the Claude SDK layer with a dedicated Codex CLI JSON bridge. Session state persists Codex thread ids, execution mode, model, and working directory so WeChat users can keep multi-turn coding sessions alive locally.

**Tech Stack:** Node.js, TypeScript, `codex` CLI, WeChat ilink HTTP APIs, launchd

---

## File Structure

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `scripts/daemon.sh`
- Create: `src/main.ts`
- Create: `src/config.ts`
- Create: `src/constants.ts`
- Create: `src/logger.ts`
- Create: `src/store.ts`
- Create: `src/session.ts`
- Create: `src/utils/chunk.ts`
- Create: `src/codex/bridge.ts`
- Create: `src/codex/events.ts`
- Create: `src/codex/skill-scanner.ts`
- Create: `src/wechat/accounts.ts`
- Create: `src/wechat/api.ts`
- Create: `src/wechat/cdn.ts`
- Create: `src/wechat/crypto.ts`
- Create: `src/wechat/login.ts`
- Create: `src/wechat/media.ts`
- Create: `src/wechat/monitor.ts`
- Create: `src/wechat/send.ts`
- Create: `src/wechat/sync-buf.ts`
- Create: `src/wechat/types.ts`
- Create: `src/commands/handlers.ts`
- Create: `src/commands/router.ts`
- Create: `tests/codex-events.test.ts`
- Create: `tests/commands.test.ts`
- Create: `tests/chunk.test.ts`

### Task 1: Scaffold Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `scripts/daemon.sh`

- [ ] **Step 1: Create project manifest and TypeScript config**
- [ ] **Step 2: Add daemon management script for macOS launchd**
- [ ] **Step 3: Add README with setup/start/update instructions**
- [ ] **Step 4: Run `npm install`**
- [ ] **Step 5: Run `npm run build` and fix scaffold issues**

### Task 2: Port WeChat Transport Layer

**Files:**
- Create: `src/wechat/accounts.ts`
- Create: `src/wechat/api.ts`
- Create: `src/wechat/cdn.ts`
- Create: `src/wechat/crypto.ts`
- Create: `src/wechat/login.ts`
- Create: `src/wechat/media.ts`
- Create: `src/wechat/monitor.ts`
- Create: `src/wechat/send.ts`
- Create: `src/wechat/sync-buf.ts`
- Create: `src/wechat/types.ts`
- Create: `src/logger.ts`
- Create: `src/store.ts`
- Create: `src/constants.ts`

- [ ] **Step 1: Copy the proven ilink transport structure from the reference project**
- [ ] **Step 2: Rename data roots and constants to the Codex bridge project**
- [ ] **Step 3: Keep API allowlist and timeout logic intact**
- [ ] **Step 4: Run `npm run build`**

### Task 3: Implement Codex Event Parsing

**Files:**
- Create: `src/codex/events.ts`
- Test: `tests/codex-events.test.ts`

- [ ] **Step 1: Write failing tests for parsing `thread.started`, `item.completed`, `file_change`, and error cases**
- [ ] **Step 2: Implement JSONL event parser utilities**
- [ ] **Step 3: Run `npm test -- tests/codex-events.test.ts` or project test command**
- [ ] **Step 4: Refine parsing until tests pass**

### Task 4: Implement Codex Bridge

**Files:**
- Create: `src/codex/bridge.ts`
- Create: `src/codex/skill-scanner.ts`
- Modify: `src/constants.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing tests for mode-to-command translation and skill scanning**
- [ ] **Step 2: Implement `codex exec` and `codex exec resume` command construction**
- [ ] **Step 3: Capture final assistant text, thread id, command executions, and file changes**
- [ ] **Step 4: Implement installed-skill scanning against `~/.codex/skills`**
- [ ] **Step 5: Run tests and `npm run build`**

### Task 5: Implement Session and Command Layers

**Files:**
- Create: `src/session.ts`
- Create: `src/config.ts`
- Create: `src/commands/router.ts`
- Create: `src/commands/handlers.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing tests for `/help`, `/clear`, `/status`, `/cwd`, `/mode`, `/skills`, and skill dispatch**
- [ ] **Step 2: Implement persistent session store with `threadId`, `mode`, `model`, `workingDirectory`, and `state`**
- [ ] **Step 3: Implement global config loading/saving**
- [ ] **Step 4: Implement command handlers and router**
- [ ] **Step 5: Run tests**

### Task 6: Integrate Main Daemon Flow

**Files:**
- Create: `src/main.ts`
- Create: `src/utils/chunk.ts`
- Test: `tests/chunk.test.ts`

- [ ] **Step 1: Write failing tests for response chunking**
- [ ] **Step 2: Implement message extraction, command routing, and Codex dispatch flow**
- [ ] **Step 3: Add image-download to Codex `--image` forwarding**
- [ ] **Step 4: Add in-flight state protection**
- [ ] **Step 5: Run `npm run build` and full tests**

### Task 7: Validate End-to-End Behavior

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run `codex exec --json` smoke checks from the bridge project**
- [ ] **Step 2: Run local daemon startup command**
- [ ] **Step 3: Verify setup flow and command help text**
- [ ] **Step 4: Document operational caveats, especially execution modes vs article-style approvals**
- [ ] **Step 5: Commit project state**
