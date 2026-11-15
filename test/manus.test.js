'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Manus = require('../src/manus');
const { mockProvider, setup, startRouter, waitUp } = require('./helpers');

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
