'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs'), path = require('path');
const Manus = require('../src/manus');
const { mockProvider, setup, startRouter, waitUp, cliAsync } = require('./helpers');

function mockManus(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
      const u = new URL(req.url, 'http://localhost');
      seen.push({ method: req.method, path: u.pathname, query: u.searchParams, auth: req.headers['x-manus-api-key'], body });
      try {
        const result = await handler({ req, u, body, seen, res });
        if (res.writableEnded) return;
        const [status, obj] = result || [200, { ok: true }];
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { message: e.message } }));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => server.close(done)));
    resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

const TOOL = [{ type: 'function', function: { name: 'read_file', description: 'Read a local file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
function stoppedAction(action, extra = {}) {
  const timestamp = Date.now() + 5;
  const prefix = extra.prefix || '';
  return [
    { id: prefix + 'status', type: 'status_update', timestamp, status_update: { agent_status: 'stopped' } },
    { id: prefix + 'result', type: 'structured_output_result', timestamp: timestamp + 1, structured_output_result: { success: true, value: action } },
    ...(extra.assistant ? [{ id: prefix + 'assistant', type: 'assistant_message', timestamp: timestamp + 2, assistant_message: { content: extra.assistant } }] : []),
  ];
}

test('structured output schema follows strict Manus rules and translates local operations to OpenAI tool_calls', async t => {
  let taskCreate;
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-1' }];
    if (u.pathname === '/v2/task.create') { taskCreate = body; return [200, { ok: true, task_id: 'task-1' }]; }
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: stoppedAction({ action: 'tool_call', content: '', tool_name: 'read_file', arguments: '{"path":"src/cli.js"}' }) }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { status: 'stopped', has_running_background_jobs: false } }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.run({
    provider: { type: 'manus', url: api.url }, key: 'private-test-key',
    body: { tools: TOOL, messages: [{ role: 'user', content: 'Inspect the CLI.' }], manus: { input: 'Inspect the CLI.', instructions: 'Keep changes small.', project_context: 'src/cli.js' } },
    timeoutMs: 2000, pollMs: 1,
  });
  assert.strictEqual(result.manus_task_id, 'task-1');
  assert.strictEqual(result.manus_user_id, 'user-1');
  assert.strictEqual(result.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(result.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.deepStrictEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: 'src/cli.js' });
  assert.strictEqual(taskCreate.share_visibility, 'private');
  assert.strictEqual(taskCreate.interactive_mode, true);
  assert.strictEqual(taskCreate.clear_connectors, true);
  assert.strictEqual(taskCreate.structured_output_schema.additionalProperties, false);
  assert.deepStrictEqual(taskCreate.structured_output_schema.required, ['action', 'content', 'tool_name', 'arguments']);
  assert.match(taskCreate.message.content, /Keep changes small/);
  assert.match(taskCreate.message.content, /src\/cli.js/);
  assert.ok(api.seen.every(x => x.auth === 'private-test-key'));
});

test('existing Manus task receives local tool results as follow-up messages and re-arms the schema', async t => {
  let followup, listCalls = 0;
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-1' }];
    if (u.pathname === '/v2/task.sendMessage') { followup = body; return [200, { ok: true, task_id: body.task_id }]; }
    if (u.pathname === '/v2/task.listMessages') {
      if (++listCalls === 1) return [200, { ok: true, messages: stoppedAction({ action: 'tool_call', content: '', tool_name: 'read_file', arguments: '{"path":"old.txt"}' }) }];
      return [200, { ok: true, messages: stoppedAction({ action: 'final', content: 'The file defines the chat loop.', tool_name: null, arguments: null }, { prefix: 'new-' }) }];
    }
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { status: 'stopped', has_running_background_jobs: false } }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.run({
    provider: { url: api.url }, key: 'key',
    body: { tools: TOOL, messages: [{ role: 'tool', tool_call_id: 'c1', content: '3: async function runTurn(text) {' }], manus: { task_id: 'task-1', user_id: 'user-1', input: 'Result from read_file: 3: async function runTurn(text) {' } },
    timeoutMs: 2000, pollMs: 1,
  });
  assert.strictEqual(result.choices[0].finish_reason, 'stop');
  assert.strictEqual(result.choices[0].message.content, 'The file defines the chat loop.');
  assert.strictEqual(followup.task_id, 'task-1');
  assert.match(followup.message.content, /Result from read_file/);
  assert.ok(followup.structured_output_schema);
  assert.strictEqual(followup.clear_connectors, true);
  assert.strictEqual(api.seen.filter(x => x.path === '/v2/task.create').length, 0);
});

test('a different Manus account or inaccessible task starts a fresh task with local context restored', async t => {
  let create;
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'new-user' }];
    if (u.pathname === '/v2/task.create') { create = body; return [200, { ok: true, task_id: 'new-task' }]; }
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: stoppedAction({ action: 'final', content: 'Ready.' , tool_name: null, arguments: null}) }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { status: 'stopped', has_running_background_jobs: false } }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.run({
    provider: { url: api.url }, key: 'key',
    body: { tools: TOOL, messages: [{ role: 'user', content: 'Continue.' }], manus: { task_id: 'old-task', user_id: 'old-user', input: 'Continue.', project_context: 'Directory tree: src/', seed_history: 'USER: earlier request' } },
    timeoutMs: 2000, pollMs: 1,
  });
  assert.strictEqual(result.manus_task_id, 'new-task');
  assert.ok(!api.seen.some(x => x.path === '/v2/task.sendMessage'));
  assert.match(create.message.content, /Directory tree: src/);
  assert.match(create.message.content, /USER: earlier request/);
});

test('Manus questions remain ordinary assistant replies and are not treated as local operations', async t => {
  const api = await mockManus(t, ({ u }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-1' }];
    if (u.pathname === '/v2/task.create') return [200, { ok: true, task_id: 'ask-task' }];
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: [
      { id: 'status', type: 'status_update', timestamp: Date.now() + 5, status_update: { agent_status: 'waiting', status_detail: { waiting_for_event_type: 'messageAskUser' } } },
      { id: 'question', type: 'assistant_message', timestamp: Date.now() + 6, assistant_message: { content: 'Which test command should I run?' } },
    ] }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.run({ provider: { url: api.url }, key: 'key', body: { tools: TOOL, messages: [{ role: 'user', content: 'Check tests.' }] }, timeoutMs: 2000, pollMs: 1 });
  assert.strictEqual(result.choices[0].finish_reason, 'stop');
  assert.strictEqual(result.choices[0].message.content, 'Which test command should I run?');
  assert.strictEqual(result.choices[0].message.tool_calls, undefined);
});

test('polling waits for post-task structured extraction instead of returning a premature assistant message', async t => {
  let polls = 0;
  const api = await mockManus(t, ({ u }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-1' }];
    if (u.pathname === '/v2/task.create') return [200, { ok: true, task_id: 'delayed-task' }];
    if (u.pathname === '/v2/task.listMessages') {
      polls++;
      if (polls === 1) return [200, { ok: true, messages: [
        { id: 'stopped-first', type: 'status_update', timestamp: Date.now() + 5, status_update: { agent_status: 'stopped' } },
        { id: 'assistant-first', type: 'assistant_message', timestamp: Date.now() + 6, assistant_message: { content: 'I am inspecting the project.' } },
      ] }];
      return [200, { ok: true, messages: stoppedAction({ action: 'tool_call', content: '', tool_name: 'read_file', arguments: '{"path":"README.md"}' }, { prefix: 'delayed-' }) }];
    }
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { status: 'stopped', has_running_background_jobs: false } }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.run({ provider: { url: api.url }, key: 'key', body: { tools: TOOL, messages: [{ role: 'user', content: 'Read README.' }] }, timeoutMs: 2000, pollMs: 1 });
  assert.strictEqual(result.choices[0].finish_reason, 'tool_calls');
  assert.ok(polls >= 2);
});

test('a polling timeout reports Manus task and account IDs for recovery', async t => {
  const api = await mockManus(t, ({ u }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-timeout' }];
    if (u.pathname === '/v2/task.create') return [200, { ok: true, task_id: 'still-running' }];
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: [{ id: 'running', type: 'status_update', timestamp: Date.now() + 5, status_update: { agent_status: 'running' } }] }];
    throw new Error('unexpected route ' + u.pathname);
  });
  await assert.rejects(Manus.run({ provider: { url: api.url }, key: 'key', body: { tools: TOOL, messages: [{ role: 'user', content: 'Long task.' }] }, timeoutMs: 40, pollMs: 1 }), e => {
    assert.strictEqual(e.manusTaskId, 'still-running');
    assert.strictEqual(e.manusUserId, 'user-timeout');
    assert.match(e.message, /fresh task from saved local history/);
    return true;
  });
});

test('a pending Manus action confirmation blocks ordinary follow-up messages', async t => {
  const api = await mockManus(t, ({ u }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-1' }];
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: [{ id: 'confirm', type: 'status_update', timestamp: Date.now(), status_update: { agent_status: 'waiting', status_detail: { waiting_for_event_type: 'gmailSendAction' } } }] }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { task_url: 'https://manus.im/app/task/abc' } }];
    throw new Error('ordinary follow-up must not be sent: ' + u.pathname);
  });
  const result = await Manus.run({ provider: { url: api.url }, key: 'key', body: { tools: TOOL, messages: [{ role: 'user', content: 'Continue.' }], manus: { task_id: 'waiting-task', user_id: 'user-1', input: 'Continue.' } } });
  assert.strictEqual(result.choices[0].finish_reason, 'stop');
  assert.strictEqual(result.manus_waiting_external_action, true);
  assert.match(result.choices[0].message.content, /will not send a follow-up/);
  assert.strictEqual(api.seen.some(x => x.path === '/v2/task.sendMessage'), false);
});

test('router accepts manus/agent and returns the task completion in OpenAI chat format', async t => {
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'router-user' }];
    if (u.pathname === '/v2/task.create') return [200, { ok: true, task_id: 'router-task' }];
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: stoppedAction({ action: 'final', content: 'Hello from Manus.', tool_name: null, arguments: null }) }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { status: 'stopped', has_running_background_jobs: false } }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const provider = await mockProvider(() => null);
  t.after(() => provider.close());
  const s = await setup({
    a: { url: provider.url, keyEnv: 'A_KEY' },
    manus: { type: 'manus', url: api.url, keyEnv: 'MANUS_KEY' },
  }, { edit: [['a', 'model-a']] });
  s.env.MANUS_KEY = 'api-key';
  const child = startRouter(s.env);
  t.after(() => child.kill('SIGTERM'));
  await waitUp(s.base);
  const r = await fetch(s.base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'manus/agent', messages: [{ role: 'user', content: 'Hello' }], tools: [] }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-manus-task-id'), 'router-task');
  assert.strictEqual((await r.json()).choices[0].message.content, 'Hello from Manus.');
});

test('Manus task-management API uses the documented list, detail, stop, and delete routes', async t => {
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/task.list') return [200, { ok: true, data: [{ id: 'task-1', status: 'stopped' }], has_more: true, next_cursor: 'next/+==' }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { id: u.searchParams.get('task_id'), status: 'running' } }];
    if (u.pathname === '/v2/task.stop') return [200, { ok: true, request_id: 'stop-1', received: body.task_id }];
    if (u.pathname === '/v2/task.delete') return [200, { ok: true, id: body.task_id, deleted: true }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const provider = { url: api.url };
  const listed = await Manus.listTasks({ provider, key: 'key', limit: 7, cursor: 'opaque/+==', includeDeleted: true });
  assert.strictEqual(listed.data[0].id, 'task-1');
  const listRequest = api.seen.find(x => x.path === '/v2/task.list');
  assert.strictEqual(listRequest.query.get('limit'), '7');
  assert.strictEqual(listRequest.query.get('cursor'), 'opaque/+==');
  assert.strictEqual(listRequest.query.get('include_deleted'), 'true');
  assert.strictEqual((await Manus.getTask({ provider, key: 'key', taskId: 'task /+?' })).task.id, 'task /+?');
  await Manus.stopTask({ provider, key: 'key', taskId: 'task-1' });
  const deleted = await Manus.deleteTask({ provider, key: 'key', taskId: 'task-1' });
  assert.strictEqual(deleted.deleted, true);
  assert.deepStrictEqual(api.seen.filter(x => x.path === '/v2/task.stop' || x.path === '/v2/task.delete').map(x => x.body.task_id), ['task-1', 'task-1']);
  assert.ok(api.seen.every(x => x.auth === 'key'));
  await assert.rejects(Manus.listTasks({ provider, key: 'key', limit: 101 }), /1 to 100/);
  await assert.rejects(Manus.getTask({ provider, key: 'key' }), /task ID is required/);
});

test('agt tasks lists account tasks, stops only running tasks, deletes stopped tasks, and detaches local chats', async t => {
  let status = 'running';
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/task.list') return [200, { ok: true, data: [{ id: 'task-1', status, title: 'Saved Manus task', task_type: 'standard', created_at: Math.floor(Date.now() / 1000), credit_usage: 12 }], has_more: true, next_cursor: 'page-2' }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { id: u.searchParams.get('task_id'), status, title: 'Saved Manus task' } }];
    if (u.pathname === '/v2/task.stop') { status = 'stopped'; return [200, { ok: true }]; }
    if (u.pathname === '/v2/task.delete') return [200, { ok: true, id: body.task_id, deleted: true }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' }, manus: { type: 'manus', url: api.url, keyEnv: 'MANUS_KEY' } }, { edit: [['a', 'model-a']], plan: [['a', 'model-a']] });
  s.env.MANUS_KEY = 'test-key';
  const id = '20261115000000-abcd';
  const sessionDir = path.join(s.home, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${id}.json`);
  fs.writeFileSync(sessionFile, JSON.stringify({ id, cwd: '/tmp/project', lane: 'edit', messages: [], manusTaskId: 'task-1', manusUserId: 'user-1' }));

  const malformed = await cliAsync(['tasks', 'list', 'ignored-typo'], s.env);
  assert.strictEqual(malformed.status, 1);
  assert.match(malformed.stdout, /usage: agt tasks \[list\]/);
  assert.strictEqual(api.seen.length, 0);
  const listed = await cliAsync(['tasks', '--limit', '1', '--cursor', 'cursor+/='], s.env);
  assert.strictEqual(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /Saved Manus task/);
  assert.match(listed.stdout, /linked AGT chat/);
  assert.match(listed.stdout, /--cursor 'page-2'/);
  const listRequest = api.seen.find(x => x.path === '/v2/task.list');
  assert.strictEqual(listRequest.query.get('cursor'), 'cursor+/=');

  const stopped = await cliAsync(['tasks', 'stop', 'task-1', '--yes'], s.env);
  assert.strictEqual(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /can still be resumed/);
  assert.strictEqual(status, 'stopped');
  const deleted = await cliAsync(['tasks', 'delete', 'task-1', '--yes'], s.env);
  assert.strictEqual(deleted.status, 0, deleted.stdout + deleted.stderr);
  assert.match(deleted.stdout, /detached 1 local AGT chat/);
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(saved.manusTaskId, null);
  assert.strictEqual(saved.manusUserId, null);
  assert.strictEqual(api.seen.filter(x => x.path === '/v2/task.delete').length, 1);
});

test('agt tasks will not delete a running task or silently delete an agent task Manus rejects', async t => {
  let deleted = 0;
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { id: u.searchParams.get('task_id'), status: u.searchParams.get('task_id') === 'running' ? 'running' : 'stopped' } }];
    if (u.pathname === '/v2/task.delete') { deleted++; return [400, { ok: false, error: { code: 'invalid_argument', message: 'Agent-related tasks cannot be deleted' } }]; }
    throw new Error('unexpected route ' + u.pathname);
  });
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' }, manus: { type: 'manus', url: api.url, keyEnv: 'MANUS_KEY' } }, { edit: [['a', 'model-a']], plan: [['a', 'model-a']] });
  s.env.MANUS_KEY = 'test-key';
  const running = await cliAsync(['tasks', 'delete', 'running', '--yes'], s.env);
  assert.strictEqual(running.status, 1);
  assert.match(running.stdout, /stop it first/);
  assert.strictEqual(deleted, 0);
  const rejected = await cliAsync(['tasks', 'delete', 'agent-main', '--yes'], s.env);
  assert.strictEqual(rejected.status, 1);
  assert.match(rejected.stdout, /Agent-related tasks cannot be deleted/);
  assert.match(rejected.stdout, /Manus does not allow permanent deletion/);
  assert.strictEqual(deleted, 1);
});

test('agt tasks resume refuses waiting, running, background, and agent-subtask records', async t => {
  const states = new Map([
    ['waiting', { status: 'waiting', task_type: 'standard' }],
    ['running', { status: 'running', task_type: 'standard' }],
    ['background', { status: 'stopped', task_type: 'standard', has_running_background_jobs: true }],
    ['subtask', { status: 'stopped', task_type: 'agent_subtask' }],
    ['stopped', { status: 'stopped', task_type: 'standard', has_running_background_jobs: false }],
    ['linked', { status: 'stopped', task_type: 'standard', has_running_background_jobs: false }],
  ]);
  let messages = 0;
  const api = await mockManus(t, ({ u }) => {
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { id: u.searchParams.get('task_id'), ...states.get(u.searchParams.get('task_id')) } }];
    if (u.pathname === '/v2/task.sendMessage') { messages++; return [200, { ok: true }]; }
    throw new Error('unexpected route ' + u.pathname);
  });
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' }, manus: { type: 'manus', url: api.url, keyEnv: 'MANUS_KEY' } }, { edit: [['a', 'model-a']] });
  s.env.MANUS_KEY = 'test-key';
  for (const [id, expected] of [['waiting', /pending question or action/], ['running', /wait for it to stop/], ['background', /background jobs/], ['subtask', /only standard or project tasks/]]) {
    const r = await cliAsync(['tasks', 'resume', id], s.env);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, expected);
  }
  const stopped = await cliAsync(['tasks', 'resume', 'stopped'], s.env);
  assert.strictEqual(stopped.status, 1);
  assert.match(stopped.stdout, /chat needs an interactive terminal/);
  const sessionId = '20261115000000-linked';
  fs.writeFileSync(path.join(s.home, 'sessions', `${sessionId}.json`), JSON.stringify({ id: sessionId, cwd: '/tmp/project', lane: 'edit', messages: [], manusTaskId: 'linked' }));
  const duplicate = await cliAsync(['tasks', 'resume', 'linked'], s.env);
  assert.strictEqual(duplicate.status, 1);
  assert.match(duplicate.stdout, new RegExp(`already linked to local chat ${sessionId}`));
  assert.match(duplicate.stdout, new RegExp(`agt resume ${sessionId}`));
  assert.strictEqual(messages, 0, 'resume attaches the task; it must not send a message before the user enters one');
});

test('Manus retries documented message-size rejections with smaller prompts and clears account connectors', async t => {
  const sizes = [];
  let invalid = 2;
  const api = await mockManus(t, ({ u, body }) => {
    if (u.pathname === '/v2/user.me') return [200, { ok: true, user_id: 'user-1' }];
    if (u.pathname === '/v2/task.create') {
      sizes.push(body.message.content.length);
      assert.strictEqual(body.clear_connectors, true);
      if (invalid-- > 0) return [400, { ok: false, error: { code: 'invalid_argument', message: 'message exceeds the 5,000 estimated token limit' } }];
      return [200, { ok: true, task_id: 'budget-task' }];
    }
    if (u.pathname === '/v2/task.listMessages') return [200, { ok: true, messages: stoppedAction({ action: 'final', content: 'Ready.', tool_name: null, arguments: null }) }];
    if (u.pathname === '/v2/task.detail') return [200, { ok: true, task: { status: 'stopped', has_running_background_jobs: false } }];
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.run({ provider: { url: api.url }, key: 'key', body: { tools: [], messages: [{ role: 'user', content: 'x'.repeat(6000) }], manus: { input: 'x'.repeat(6000) } }, timeoutMs: 2000, pollMs: 1 });
  assert.strictEqual(result.manus_task_id, 'budget-task');
  assert.strictEqual(sizes.length, 3);
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], `expected progressively smaller prompts, got ${sizes}`);
});

test('Manus honors a zero Retry-After instead of retrying early against a capped positive delay', async t => {
  let calls = 0;
  const api = await mockManus(t, ({ u, res }) => {
    if (u.pathname === '/v2/task.list') {
      calls++;
      if (calls === 1) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' }); res.end(JSON.stringify({ ok: false, error: { message: 'rate limited' } })); return null; }
      return [200, { ok: true, data: [], has_more: false }];
    }
    throw new Error('unexpected route ' + u.pathname);
  });
  const result = await Manus.listTasks({ provider: { url: api.url }, key: 'key' });
  assert.deepStrictEqual(result.data, []);
  assert.strictEqual(calls, 2);
});
