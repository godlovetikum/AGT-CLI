# Changelog

## 1.2.0

- Add a separately pinned Manus API v2 task provider (`manus/agent`) with per-turn structured tool-request translation, private task continuity, account-aware recovery, and no automatic Manus-side action confirmations.
- Add selectable initial project context and editable persistent Manus instructions, project-knowledge templates, and reusable workflow resources (`agt resources`).
- Give users explicit control of lanes, exact provider/model pins, local chats, and Manus account task lists; add confirmed stop/delete operations, safe continuation of stopped Manus tasks, safe session deletion, and per-command help text.
- Harden project-file, resource, key, session, backup, and AGT data-directory handling against symlink escapes and secret-file reads; revalidate reviewed file changes before applying them.
- Prevent concurrent chat processes from corrupting a session, validate undo records and backups, and avoid retaining raw shell arguments or file contents in diagnostic logs.
- Make statistics available from the last persisted snapshot when the router is stopped, and improve Manus connector isolation, message-limit recovery, rate-limit retries, and task error recovery.
- Include comprehensive CLI, task API, install, path-security, session-lock, undo, and end-to-end regression tests; preserve existing synchronous provider lanes.

## 1.1.0

Renamed to **agt** and published to npm as `agt-cli` (install with `npm install -g agt-cli`). The command is `agt` (also `agt-cli`).

- **Cross-platform:** Windows, macOS, Linux and Android (Termux). The built-in diff replaces the external `diff`; log following no longer needs `tail`; path checks use `path.relative` (drive letters, case-insensitive paths, symlinks); edits keep a file's CRLF or LF line endings; the router starts hidden on Windows.
- **Models separate from lanes:** `/model <alias|provider/model>` (or `--model`) pins one exact model with no failover, `/model auto` returns to the lane. `agt models [--live]` lists lanes, aliases and the model ids each provider offers. Config gets `aliases`. The pin is saved with the chat and restored by `agt resume`.
- **Keys without shell setup:** `agt setup` (guided) and `agt keys set|list|remove`. Hidden input, private `keys.env`, environment variables still win. `agt doctor` shows where each key comes from.
- **Updates:** `agt update` (and a note in `agt doctor`).
- **`/compact`:** summarizes a long chat to save free-tier tokens; the full history is kept.
- **Termux:** a postinstall step fixes the `#!/usr/bin/env node` launcher where it does not resolve.
- Data folder is now `~/.agt` (an existing `~/.ag` is still used). `AGT_HOME` replaces `AG_HOME` (the old name still works).
- Fixed: the hidden key prompt could echo a key typed within a split second of the prompt.
- Removed `install.js` and `scripts/bootstrap.js`: npm is the installer now.
- CI runs on Linux, macOS and Windows; releases publish to npm from a GitHub release.

## Earlier (as `ag-termux` 1.0.0)
First packaged release, assembled from the working Termux setup.

- Router: lanes with ordered fallback, per-provider cooldowns (honours `retry-after`), one short wait-and-retry on rate limits, request timeouts, `/health[?deep=1]`, `/stats`, `/config`, admin reset/reload/shutdown, daily stats persisted for 7 days, localhost-only with Host header check.
- Gemini 3 fix: tool calls written by other providers get Google's documented `skip_thought_signature_validator` value; Gemini-only fields are stripped before other providers see them.
- Agent: reviewed writes and edits (y/n/diff/view/stage), command confirmation with risk warnings, change log, per-change backups, `undo` with a modified-since check, saved sessions with resume, clipped tool output (30k chars), `read_file` on a folder gives a clear error.
- CLI: `chat`, `resume`, `router`, `health`, `stats`, `doctor`, `logs`, `sessions`, `show`, `changes`, `undo`, `config`.
- Default edit lane is Groq `gpt-oss-120b`, then Gemini (Qwen removed: it wrote malformed tool calls).
- Installer (`install.js`), one-step bootstrap (`scripts/bootstrap.js`), tests and CI.
