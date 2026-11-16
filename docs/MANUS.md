# Manus API integration

AGT uses Manus as a remote reasoning agent while keeping local file and command access in the AGT CLI process. This is not a normal `/chat/completions` provider. The public Manus API v2 exposes asynchronous tasks, event polling, and follow-up messages. It also supports schema-validated structured results after a task turn finishes. AGT combines those documented features into a turn-by-turn bridge; structured output is not a native OpenAI tool-call protocol. See the official [API overview](https://open.manus.im/docs/v2/introduction), [task lifecycle](https://open.manus.im/docs/v2/task-lifecycle), and [structured output](https://open.manus.im/docs/v2/structured-output) documentation.

## Get started

Create an API key in [Manus Developer settings](https://manus.im/app/developers), then run:

```sh
agt keys set manus
agt doctor
cd /path/to/project
agt --model manus/agent
```

Inside an existing chat, choose Manus with `/model manus/agent`. Switch back to the configured lane with `/model auto`. Manus is intentionally not a lane option because its asynchronous task lifecycle cannot use the router's ordinary synchronous failover behavior. Manus task usage consumes credits, and an agent turn can take longer than a conventional model request.

## How local operations work

At each turn, AGT sends the user request or most recent local-tool result to the Manus task and arms a strict structured-output schema. The result is translated into the same OpenAI-compatible `tool_calls` shape used by the existing AGT agent loop. AGT then validates the local tool name, parses the JSON arguments, and executes the operation using its existing tools. Reads remain read-only. Every file write/edit and shell command still requires the user's normal AGT approval.

After AGT runs or declines an operation, it sends the result or denial reason to the same Manus task as a follow-up and re-arms the schema. A final explanation or question is returned as an ordinary assistant response, so it cannot be mistaken for an operation. The integration does not automatically approve Manus-side confirmation events. The API treats an ordinary message during a pending action confirmation as skipping that action, so AGT blocks follow-ups while that confirmation is pending and directs you to review the task in Manus. If Manus pauses for a question, AGT displays it and sends your next reply to the same task.

Manus API v2 documents `task.create`, `task.sendMessage`, `task.listMessages`, and `task.detail`. It does not document a synchronous function-calling endpoint that accepts arbitrary external tool results. AGT's bridge therefore uses task follow-ups plus post-turn structured extraction rather than assuming Manus is an OpenAI chat model. API keys are checked with the read-only `user.me` endpoint, which returns a stable account ID.

## Project context

For a new Manus task, AGT sends a filtered directory tree by default, plus the current AGT coding instructions. It excludes common generated directories, `.git`, symlinks, environment files, and common private-key filenames. A tree reveals paths, not file contents. Manus can request current text with `read_file` and directory entries with `list_dir`.

You can control the initial project context with environment variables:

```sh
AGT_MANUS_CONTEXT=none agt --model manus/agent
AGT_MANUS_CONTEXT=src,docs agt --model manus/agent
AGT_MANUS_CONTEXT_FILES=README.md,package.json agt --model manus/agent
```

`AGT_MANUS_CONTEXT` accepts `tree` (the default), `none`, or comma/newline-separated project-relative paths that narrow the tree. `AGT_MANUS_CONTEXT_FILES` lists specific text files whose contents should be included initially. Paths outside the project root, symlinks, secret-like files, binary files, and oversized files are skipped. The Manus API limits visible text in a task message to roughly 5,000 estimated tokens, so AGT clips context to leave room for the request and instructions. See the official [task.create](https://open.manus.im/docs/v2/task.create) reference.

## Persistent instructions and reusable resources

AGT sends its integration contract when a Manus task is created and on each follow-up. It cannot use Manus's hidden application-context field with a regular API key; that field is restricted to Trusted public clients. AGT therefore keeps an editable copy at the path printed by `agt resources` and sends it as ordinary task text.

`agt resources` also shows the private resource directory. On first use, AGT seeds a project-knowledge template and editable workflow references for React/TypeScript, testing/debugging, code review, and Git. Manus can call `list_resources` and `read_resource` to discover or read these materials when relevant. They are not embedded in every request. Keep project knowledge free of credentials and other secrets.

## Session and account continuity

AGT saves the Manus task ID and stable Manus user ID in the local AGT chat session. On resume, AGT compares the current credential's `user.me` identity with the saved identity. If the account differs, or Manus no longer permits access to the task, AGT creates a new private task and supplies a bounded summary of local chat history plus the current project context. If the configured wait times out or you cancel a turn, AGT keeps the user turn in local history but detaches the possibly still-running remote task; the next turn starts a fresh task from that saved history rather than risking an ambiguous follow-up. A new `/new` chat has no prior Manus task attached. `/compact` also starts a fresh remote task from the compacted AGT history on the next Manus turn.

When credentials are changed with `agt keys set`, AGT asks a running router to reload its private key file. If the key comes from an environment variable instead, update the environment and restart the router with `agt router restart` so it reads the new credential.

## Managing Manus tasks

`agt tasks` lists the Manus tasks visible to the account configured by `MANUS_API_KEY`; the list is not limited to tasks created by AGT. It shows the remote task ID, status, title, credit usage when reported, task URL, and any local AGT chats linked to that task. Use `agt tasks show <task-id>` for details. The first page contains 20 tasks by default; `--limit 1` through `--limit 100` changes the page size, and the printed cursor can be passed back with `--cursor '<cursor>'`. Add `--include-deleted` to request deleted-task records.

`agt tasks stop <task-id>` asks for confirmation before stopping a running task. `--yes` bypasses the prompt for scripts. Manus documents that stopping changes the task to `stopped`, and that `task.sendMessage` can continue an existing task. Use `agt tasks resume <task-id>` to attach a local chat to a stopped standard/project task; AGT refuses running or waiting tasks and tasks with background jobs, so it cannot accidentally overlap a live run or skip a pending action. If the task is already linked to a saved AGT chat, use `agt resume <session-id>` instead; AGT prevents duplicate local histories for one remote task. In chat, `/tasks resume <task-id>` attaches the current chat. Your next message continues the remote task. A task created outside AGT has no local transcript; its remote Manus history remains on Manus. See the official [`task.sendMessage`](https://open.manus.im/docs/v2/task.sendMessage) and [`task.detail`](https://open.manus.im/docs/v2/task.detail) references.

`agt tasks delete <task-id>` is a separate, permanent action and asks for confirmation. Manus does not permit permanent deletion of some agent-related tasks; if its API rejects the request, AGT leaves local state intact and displays the API error. After a successful deletion, AGT clears the remote task ID from linked local chat sessions. Local chat deletion (`agt sessions rm <full-session-id>`) does not delete the remote Manus task; manage that separately with `agt tasks`.

Inside chat, `/tasks`, `/tasks show <id>`, `/tasks resume <id>`, `/tasks stop <id>`, and `/tasks delete <id>` provide the same controls. `/sessions` lists local AGT chats; `/sessions rm <full-session-id>` deletes a local chat after confirmation. Delete the current chat from inside that chat to prevent its running process from saving it again on exit.

AGT sends Manus's top-level `clear_connectors: true` flag when creating and continuing tasks, so account/project default connectors are not loaded. This is a boundary on connector selection, not a guarantee that every Manus-native capability is unavailable; other task features may still provide tools. Manus documents that message bodies have an approximately 5,000 estimated-token limit whose character equivalent varies by language and content. AGT retries an explicit input-limit rejection with a smaller context; it does not treat a fixed character count as a token guarantee.

## API references

The integration uses Manus API v2 and these official endpoints: [Authentication](https://open.manus.im/docs/v2/authentication), [`user.me`](https://open.manus.im/docs/v2/user.me), [`task.create`](https://open.manus.im/docs/v2/task.create), [`task.sendMessage`](https://open.manus.im/docs/v2/task.sendMessage), [`task.listMessages`](https://open.manus.im/docs/v2/task.listMessages), [`task.detail`](https://open.manus.im/docs/v2/task.detail), [`task.list`](https://open.manus.im/docs/v2/task.list), [`task.stop`](https://open.manus.im/docs/v2/task.stop), and [`task.delete`](https://open.manus.im/docs/v2/task.delete). The default two-second poll cadence stays below the documented per-user [`rate limits`](https://open.manus.im/docs/v2/rate-limits), and rate-limited requests honor `Retry-After` and use jittered backoff when the header is absent. API v1 is deprecated according to the [Manus API overview](https://open.manus.im/docs/v2/introduction).
