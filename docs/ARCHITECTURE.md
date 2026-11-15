# Architecture

```
terminal ──▶ agt (src/cli.js) ──HTTP──▶ router (src/router.js) ──▶ Gemini / Groq / ...
              │ tools: read, edit, run                │ lanes, cooldowns, retries, health
              ├─ sessions, approvals, backups         └─ Manus task adapter (src/manus.js)
              │                                        │ task.create/sendMessage/poll
              └────────────────────────────────────────┴──▶ Manus API v2
```

| File | Role |
|---|---|
| `bin/agt.js` | Launcher (`agt`, `agt-cli`) |
| `src/cli.js` | Commands, chat loop, local tools, review flow, sessions, and initial project context |
| `src/router.js` | Local OpenAI-compatible server: lanes, pins, failover, `/health`, `/stats`, admin |
| `src/manus.js` | Manus API v2 task lifecycle, polling, structured result validation, and OpenAI tool-call normalization |
| `src/common.js` | Paths, config, target resolution (lane / alias / `provider/model`), colors, probes |
| `src/keys.js` | `keys.env` reading, writing, and router reload support |
| `src/textutil.js` | Diff, line-ending handling, project-folder path check |
| `resources/` | Editable Manus integration instructions and user-customizable resource templates |
| `scripts/postinstall.js` | Termux launcher fix |

## Router

`POST /v1/chat/completions` takes a `model` that is a lane, an alias, or `provider/model-id`. Synchronous providers use the existing ordered failover behavior. `manus/agent` is a separately pinned task provider, not a lane member: the router calls `task.create` or `task.sendMessage`, polls `task.listMessages` and `task.detail`, and returns a Chat Completions-shaped response. Its structured result becomes an OpenAI-style `tool_calls` object; the CLI validates and executes that through the same tools and approval path used by other providers. A local tool result is sent as the next Manus task message, and the output schema is re-armed for that turn. Ordinary text remains an assistant message.

Manus task IDs and account IDs are saved in the AGT session. A changed account or inaccessible task starts a fresh task with bounded conversation history and project context. API errors and prompts are not written to router logs; logs contain request metadata. The router binds to `127.0.0.1`, checks the Host header and requires JSON bodies, so web pages cannot use it.

## Agent

Tool results are sent to the model clipped to `maxToolChars` but shown to you in full. Every write goes through `review()`; applied changes are backed up and logged in `changes.jsonl` with a hash so `undo` can refuse if the file changed since. The Manus bridge does not bypass this local approval flow and never automatically approves Manus-side actions.

## Tests

`npm test` (Node's built-in runner, no dependencies) covers the router against mock providers, Manus task lifecycle and structured output translation, the CLI, the diff engine (random round-trips), line endings, keys, update checks, the Termux postinstall, and packs and installs the real npm tarball. `npm run test:e2e` drives the chat through a pseudo-terminal (Linux/macOS).
