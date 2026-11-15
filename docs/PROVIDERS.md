# Providers

Gemini, Groq, and other providers that implement OpenAI-compatible `/chat/completions` with function calling can be placed in AGT's ordered failover lanes. They return synchronous model responses, so AGT can preserve its normal tool-call loop.

Manus is different: its public API is an asynchronous agent-task API, not a drop-in chat-completions model. AGT therefore exposes Manus as a separately pinned provider, `manus/agent`, rather than allowing it in lanes. Select it with `/model manus/agent` or `agt --model manus/agent`. Existing lanes and providers keep their behavior.

## Manus task bridge

AGT starts or continues a private Manus task, polls for completion, and requests a strict structured result for each turn. When Manus requests a local operation, AGT translates that result into the existing OpenAI-compatible `tool_calls` shape. The CLI runs the same path checks and approval prompts as it does for other providers, then sends the local result back through a Manus follow-up message. Ordinary explanations and questions remain assistant text, not executable operations.

This bridge is an AGT integration protocol built on documented Manus features. Manus documents asynchronous tasks, follow-up messages, event polling, and structured-output extraction; structured output is extracted after a task finishes and is not itself a native OpenAI function-call exchange. Each follow-up re-arms the output schema. AGT never automatically confirms Manus-side actions and asks Manus to use AGT's local tools instead of its remote workspace for project operations. See [Manus API integration](MANUS.md).

## Setup

1. Add a Manus API key from [Manus Developer settings](https://manus.im/app/developers) with `agt keys set manus`, or enter it in `agt setup`. The key is stored in the same private `keys.env` file as other provider keys; it is never printed or logged.
2. Check the credential with `agt doctor` or `agt keys set manus` (the CLI verifies the account with the read-only `user.me` endpoint).
3. In a project directory, run `agt --model manus/agent` or switch in a chat with `/model manus/agent`.

Manus API usage consumes account credits and may take longer than synchronous chat providers. AGT uses a private task and keeps the task ID and Manus account ID in the saved AGT session. If the task is unavailable after a key/account change, AGT starts a new task and reintroduces the local context available to that session. No Manus request is made unless you select Manus and send a chat turn.

## Context and reusable resources

By default, a new Manus task starts with a filtered project directory tree, AGT's local-agent notes, the current user request, and persistent AGT integration instructions. Set `AGT_MANUS_CONTEXT=none` to omit the tree, or set it to a comma-separated list of relative paths to narrow the tree. To send actual source/config contents initially, list relative paths in `AGT_MANUS_CONTEXT_FILES`; secret-like files and symlinks are excluded.

Run `agt resources` to locate editable Markdown resources under AGT's private data folder. AGT seeds an integration-instructions file, a project-knowledge template, and reusable skill notes. Manus can discover and read these with `list_resources` and `read_resource` when they are relevant; they are not appended to every request.

## Compatibility and safety

Manus cannot be added to a failover lane because its asynchronous task lifecycle does not match the router's synchronous failover contract. Pin `manus/agent` directly. The Manus API may pause for user input; AGT displays the question and continues the same task when you reply. For Manus-side action confirmations, AGT will not send an automatic approval. Since the API treats an ordinary follow-up message as skipping a pending action, AGT blocks task continuation until the external decision is resolved. Review the task in Manus instead.

Every local file write or edit and every terminal command still goes through AGT's existing user approval step. Paths remain relative to the local project root. AGT blocks environment files and `.git`, clips tool results before sending them back, and does not upload the project as attachments.
