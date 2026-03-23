# WeChat Codex Bridge Design

**Date:** 2026-03-23

## Goal

Build a local Node.js daemon that binds a personal WeChat account through the ClawBot/ilink protocol, receives WeChat messages on the local machine, forwards them to the local `codex` CLI, and sends Codex replies back to WeChat without OpenClaw Gateway, public IPs, or a public domain.

## Reference Method

This project follows the method described in the provided article:

- reuse the WeChat protocol layer exposed by the ClawBot/ilink flow
- run a local Node.js process only
- do not depend on OpenClaw Gateway
- replace the original agent backend with the local coding agent runtime

The public reference implementation used for structure and protocol behavior is `Wechat-ggGitHub/wechat-claude-code`, but the agent backend is replaced with a Codex CLI bridge.

## Scope

### In Scope

- QR-code login and local credential persistence
- WeChat long-poll receive/send flow
- text chat
- image input forwarding to Codex
- multi-turn session continuity through Codex thread reuse
- slash commands for session control
- launchd-based daemon management on macOS
- logs, local config, local session persistence

### Out of Scope for v1

- OpenClaw Gateway integration
- true per-tool `y/n` approval parity with Claude Agent SDK callbacks
- group chat routing
- voice/audio messages
- media generation upload beyond simple images

## Architecture

The system is split into five bounded units.

### 1. `wechat-protocol`

Responsibilities:

- request QR code and poll login state
- persist account tokens
- perform `getupdates` long polling
- send text replies
- upload and download media
- keep the protocol-specific types isolated

This unit knows nothing about Codex.

### 2. `codex-bridge`

Responsibilities:

- spawn `codex exec --json`
- spawn `codex exec resume --json`
- optionally pass image paths through `--image`
- parse JSONL events from stdout
- extract `thread_id`, final assistant text, file-change events, command-execution events, and errors

This unit knows nothing about WeChat protocol details.

### 3. `session-manager`

Responsibilities:

- map a WeChat account/session to a Codex `thread_id`
- store current working directory
- store selected model
- store selected execution mode
- store in-flight state

This unit is the join point between WeChat identity and Codex conversation continuity.

### 4. `command-router`

Responsibilities:

- handle slash commands before dispatching to Codex
- expose operational controls to WeChat
- transform supported slash commands into config/session updates or specialized Codex prompts

### 5. `daemon-runtime`

Responsibilities:

- bootstrap config
- start monitoring
- handle retries and backoff
- write logs
- manage macOS launchd lifecycle

## Key Adaptation From the Article

The article's Claude implementation uses an SDK callback to request permission approval from WeChat in real time. Codex CLI does not expose an equivalent structured callback in `exec --json`, so the exact same approval model is not implementable safely.

v1 therefore adapts approvals at the request level:

- `plan` mode: read-only analysis mode
- `workspace` mode: sandboxed write mode for normal project work
- `danger` mode: fully unsandboxed mode for explicit high-trust use

The user switches modes through WeChat commands instead of responding to per-tool prompts. This preserves explicit control while staying on a stable Codex interface.

## Execution Modes

### `plan`

- `codex exec` with read-only sandbox
- suitable for planning, explanation, debugging analysis, and reviews

### `workspace`

- `codex exec` with workspace-write sandbox
- default mode for normal coding tasks in the chosen working directory

### `danger`

- `codex exec` with dangerous bypass flag
- only for explicitly trusted local workflows

## Command Set

The command surface should be intentionally small.

- `/help`
- `/clear`
- `/status`
- `/model <name>`
- `/cwd <path>`
- `/mode <plan|workspace|danger>`
- `/skills`
- `/<skill> [args]`

Command routing rules:

- operational commands are handled locally
- unknown slash commands are resolved against installed Codex skills
- matched skills are converted into a Codex prompt such as `Use the <skill> skill: ...`

## Message Flow

### Normal Text Flow

1. WeChat message arrives through long polling
2. protocol layer extracts text and attachments
3. command router checks for slash commands
4. session manager resolves current Codex thread
5. codex bridge runs `exec` or `exec resume`
6. final reply text is chunked for WeChat length limits
7. reply is sent back through `sendmessage`

### Image Flow

1. WeChat message includes an image item
2. protocol layer downloads the image to a temp path
3. codex bridge appends `--image <temp-file>`
4. after completion, temp files are cleaned up

## Codex Bridge Contract

The bridge should return a structured result:

- `threadId`
- `replyText`
- `commandExecutions`
- `fileChanges`
- `error`

The initial thread id comes from the `thread.started` event. Subsequent turns reuse it through `codex exec resume`.

The final user-visible text comes from the last completed `agent_message` item in the turn. Intermediate agent chatter is not sent live in v1.

## Data Storage

Use a dedicated data root:

```text
~/.wechat-codex-bridge/
├── accounts/
├── sessions/
├── logs/
├── tmp/
├── get_updates_buf
└── config.env
```

Stored session fields:

- `threadId`
- `workingDirectory`
- `model`
- `mode`
- `state`

## Project Structure

```text
src/
├── main.ts
├── config.ts
├── constants.ts
├── logger.ts
├── store.ts
├── session.ts
├── commands/
│   ├── handlers.ts
│   └── router.ts
├── codex/
│   ├── bridge.ts
│   ├── events.ts
│   └── skill-scanner.ts
└── wechat/
    ├── accounts.ts
    ├── api.ts
    ├── cdn.ts
    ├── crypto.ts
    ├── login.ts
    ├── media.ts
    ├── monitor.ts
    ├── send.ts
    ├── sync-buf.ts
    └── types.ts
```

## Error Handling

- long-poll failures use incremental backoff
- expired login state surfaces a re-bind instruction
- Codex process failures are logged and returned as a generic WeChat failure message
- malformed slash commands receive explicit usage messages
- missing or invalid working directories are rejected before invoking Codex

## Security Model

- default to local-only operation
- credentials stored in user home with restrictive permissions
- validate `cwd` before running Codex
- keep `danger` mode opt-in and visible in `/status`
- never silently escalate sandbox mode

## Testing Strategy

### Unit Tests

- command routing
- session persistence
- Codex JSON event parsing
- mode-to-command translation
- message chunking

### Integration Tests

- fake WeChat update -> mocked Codex process -> reply generation
- new session -> thread capture
- resumed session -> `exec resume` uses stored thread id
- image message -> temp file path forwarded to Codex

### Manual Verification

- run setup and bind QR
- send plain text from WeChat
- send a follow-up message and verify continuity
- send an image
- switch `/mode`
- restart daemon and verify session persistence

## Recommended Build Approach

Use `Wechat-ggGitHub/wechat-claude-code` as the starting skeleton for the WeChat transport/runtime pieces, then replace the Claude provider with a Codex bridge and adjust config/session/command semantics accordingly. This minimizes protocol risk and keeps the implementation close to the article's proven path.
