'use strict';

const DEFAULT_URL = 'https://api.manus.ai';
const MAX_MESSAGE_CHARS = 16000; // leaves headroom below the API's ~5k-token text limit

const clip = (text, n) => {
  text = String(text || '');
  return text.length <= n ? text : text.slice(0, n) + '\n[context clipped by agt]';
};
const encodeQuery = value => encodeURIComponent(value);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(signal.reason || new Error('request cancelled'));
  const timer = setTimeout(done, ms);
  function done() { if (signal) signal.removeEventListener('abort', aborted); resolve(); }
  function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason || new Error('request cancelled')); }
  if (signal) signal.addEventListener('abort', aborted, { once: true });
});

function responseError(status, data, text) {
  const e = data && data.error;
  const code = e && e.code;
  const message = (e && e.message) || (typeof e === 'string' ? e : '') || text || `HTTP ${status}`;
  const err = new Error(`Manus API HTTP ${status}${code ? ` (${code})` : ''}: ${message}`);
  err.status = status;
  err.code = code;
  return err;
}

async function request(base, key, route, { method = 'GET', body, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-manus-api-key': key },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)].filter(Boolean)),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (r.status === 429 && attempt < 4) {
      const header = Number(r.headers.get('retry-after'));
      await sleep(header > 0 ? Math.min(header * 1000, 10000) : Math.min(1000 * (2 ** attempt), 10000), signal);
      continue;
    }
    if (!r.ok || data.ok === false) throw responseError(r.status, data, text);
    return data;
  }
}

function toolNames(body) {
  return (body.tools || [])
    .filter(t => t && t.type === 'function' && t.function && typeof t.function.name === 'string')
    .map(t => t.function.name);
}

function outputSchema(names) {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['tool_call', 'final'] },
      content: { type: 'string', description: 'User-facing reply when action is final; empty when requesting a local tool.' },
      tool_name: { type: ['string', 'null'], description: `Name of one available AGT local tool: ${names.join(', ') || '(none)'}` },
      arguments: { type: ['string', 'null'], description: 'JSON object encoded as a string, matching the named tool parameters.' },
    },
    required: ['action', 'content', 'tool_name', 'arguments'],
    additionalProperties: false,
  };
}

const CONTRACT = `You are Manus, the reasoning agent inside AGT CLI. AGT CLI owns the user's local project and execution environment; your remote Manus workspace is not the project. Never claim to have read or changed local files unless AGT returned that result. Do not use remote shell, filesystem, browser, connectors, or other Manus-side actions to modify this project. Use only the local tools listed below for project operations. Return exactly one requested local tool call per turn, or a normal user-facing final response. A tool request is a proposal: AGT will apply its existing path restrictions and ask the user to approve every file write and command. Never bypass or imply approval. Use complete project-relative paths and choose the narrowest suitable operation. If more information is needed, ask the user in a normal response.`;

function makeMessage(body, isNewTask) {
  const state = body.manus || {};
  const input = clip(state.input || '', 6000);
  const editable = clip(state.instructions || '', 1800);
  const systemContext = clip(state.system_context || '', 2400);
  const context = isNewTask ? clip(state.project_context || '', 3500) : '';
  const history = isNewTask ? clip(state.seed_history || '', 1000) : '';
  const sections = [
    `\n\nAvailable local tools (OpenAI function definitions):\n${clip(JSON.stringify(body.tools || []), 2000)}`,
    editable ? `\n\nUser-editable persistent Manus instructions:\n${editable}` : '',
    systemContext ? `\n\nAGT's current project/system guidance:\n${systemContext}` : '',
    context ? `\n\nInitial local project context (paths are relative to the project root):\n${context}` : '',
    history ? `\n\nEarlier AGT conversation to restore (this is context, not a new user request):\n${history}` : '',
    `\n\nCurrent user message or local tool result:\n${input}`,
  ];
  let text = CONTRACT + sections.join('');
  for (const i of [4, 3, 1, 2, 0, 5]) {
    if (text.length <= MAX_MESSAGE_CHARS) break;
    const excess = text.length - MAX_MESSAGE_CHARS;
    sections[i] = sections[i].slice(0, Math.max(0, sections[i].length - excess));
    text = CONTRACT + sections.join('');
  }
  return { content: text };
}

function latestInput(body) {
  const explicit = body.manus && body.manus.input;
  if (typeof explicit === 'string') return explicit;
  const messages = body.messages || [];
  const last = [...messages].reverse().find(m => m && (m.role === 'user' || m.role === 'tool'));
  return last ? String(last.content || '') : '';
}

function asChatCompletion(value, fallbackText, taskId, userId) {
  const tool = value && value.action === 'tool_call';
  let message;
  if (tool) {
    const name = value.tool_name;
    if (typeof name !== 'string' || !value.arguments) throw new Error('Manus returned an incomplete local tool request.');
    let args;
    try { args = JSON.parse(value.arguments); } catch (e) { throw new Error(`Manus returned invalid JSON tool arguments: ${e.message}`); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Manus tool arguments must be a JSON object.');
    message = {
      role: 'assistant',
      content: value.content || null,
      tool_calls: [{ id: 'call_' + Math.random().toString(36).slice(2, 12), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    };
  } else {
    message = { role: 'assistant', content: String((value && value.content) || fallbackText || '') };
  }
  return {
    id: 'chatcmpl-manus-' + Math.random().toString(36).slice(2, 12),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'manus/agent',
    choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    manus_task_id: taskId,
    manus_user_id: userId,
  };
}

function isNewEvent(m, since, baselineIds, baselineTimestamp) {
  return baselineIds ? !baselineIds.has(m.id) && Number(m.timestamp || 0) >= baselineTimestamp : Number(m.timestamp || 0) >= since;
}
function newest(messages, type, since, baselineIds, baselineTimestamp) {
  return (messages || []).filter(m => m && m.type === type && isNewEvent(m, since, baselineIds, baselineTimestamp))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0] || null;
}
function textFromEvents(messages, since, baselineIds, baselineTimestamp) {
  const found = (messages || []).filter(m => m && m.type === 'assistant_message' && isNewEvent(m, since, baselineIds, baselineTimestamp))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return found.map(m => m.assistant_message && m.assistant_message.content).find(Boolean) || '';
}

async function pollTask(base, key, taskId, startedAt, names, signal, { timeoutMs, pollMs, baselineIds, baselineTimestamp }) {
  const deadline = Date.now() + timeoutMs;
  let stoppedAt = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw signal.reason || new Error('request cancelled');
    const page = await request(base, key, `/v2/task.listMessages?task_id=${encodeQuery(taskId)}&order=desc&limit=100`, { signal });
    const messages = page.messages || [];
    const statusEvent = newest(messages, 'status_update', startedAt, baselineIds, baselineTimestamp);
    const status = statusEvent && statusEvent.status_update;
    const state = status && status.agent_status;

    if (state === 'error') {
      const failure = newest(messages, 'error_message', startedAt, baselineIds, baselineTimestamp);
      throw new Error(`Manus task failed: ${failure && failure.error_message && failure.error_message.content || status.description || 'unknown error'}`);
    }

    if (state === 'waiting') {
      const waitType = status.status_detail && status.status_detail.waiting_for_event_type;
      const text = textFromEvents(messages, startedAt, baselineIds, baselineTimestamp);
      if (waitType === 'messageAskUser' || waitType === 'cascadeAskUser') {
        return asChatCompletion({ action: 'final', content: text || 'Manus needs a reply before it can continue.' }, text, taskId, null);
      }
      const task = await request(base, key, `/v2/task.detail?task_id=${encodeQuery(taskId)}`, { signal });
      const url = task.task && task.task.task_url;
      return asChatCompletion({ action: 'final', content: `Manus is waiting for an action that AGT cannot approve automatically${url ? `. Review it in Manus: ${url}` : '.'}` }, text, taskId, null);
    }

    if (state === 'stopped') {
      if (!stoppedAt) stoppedAt = Date.now();
      const detail = await request(base, key, `/v2/task.detail?task_id=${encodeQuery(taskId)}`, { signal });
      if (detail.task && detail.task.has_running_background_jobs) {
        await sleep(pollMs, signal);
        continue;
      }
      const resultEvent = newest(messages, 'structured_output_result', startedAt, baselineIds, baselineTimestamp);
      const result = resultEvent && resultEvent.structured_output_result;
      if (result) {
        if (!result.success) throw new Error(`Manus structured result failed: ${result.error || 'no details'}`);
        const value = result.value || {};
        if (value.action === 'tool_call' && !names.includes(value.tool_name)) throw new Error(`Manus requested unknown local tool "${value.tool_name}".`);
        const finalText = textFromEvents(messages, startedAt, baselineIds, baselineTimestamp);
        return asChatCompletion(value, finalText, taskId, null);
      }
      const finalText = textFromEvents(messages, startedAt, baselineIds, baselineTimestamp);
      // Structured output is a post-processing step and can arrive just after
      // the main agent's stopped event. Do not prematurely lose a tool request.
      if (Date.now() - stoppedAt >= 15000) {
        if (finalText) return asChatCompletion({ action: 'final', content: finalText }, finalText, taskId, null);
        throw new Error('Manus stopped without returning the requested structured result.');
      }
      await sleep(pollMs, signal);
      continue;
    }
    stoppedAt = null;
    await sleep(pollMs, signal);
  }
  const err = new Error(`Manus task did not finish within ${Math.ceil(timeoutMs / 1000)} seconds. Task ID: ${taskId}. It may still be running in Manus; AGT will start a fresh task from saved local history on the next turn.`);
  err.manusTaskId = taskId;
  throw err;
}

async function run({ provider = {}, key, body, signal, timeoutMs = 600000, pollMs = 2000 }) {
  if (!key) throw new Error('MANUS_API_KEY is not set. Set it with: agt keys set manus');
  const base = String(provider.url || DEFAULT_URL).replace(/\/+$/, '');
  const identity = await request(base, key, '/v2/user.me', { signal });
  if (!identity.user_id) throw new Error('Manus API did not return a user_id for the configured credential.');

  const names = toolNames(body);
  const state = body.manus || {};
  let taskId = state.task_id || null;
  if (state.user_id && state.user_id !== identity.user_id) taskId = null;
  const schema = outputSchema(names);
  let message = makeMessage({ ...body, manus: { ...state, input: latestInput(body) } }, !taskId);
  let startedAt = Date.now();
  let baselineIds = null;
  let baselineTimestamp = null;

  if (taskId) {
    try {
      const prior = await request(base, key, `/v2/task.listMessages?task_id=${encodeQuery(taskId)}&order=desc&limit=100`, { signal });
      baselineIds = new Set((prior.messages || []).map(m => m.id).filter(Boolean));
      baselineTimestamp = Math.max(0, ...(prior.messages || []).map(m => Number(m.timestamp || 0)));
      const priorStatus = newest(prior.messages, 'status_update', 0, null);
      const waiting = priorStatus && priorStatus.status_update && priorStatus.status_update.agent_status === 'waiting';
      const waitType = waiting && priorStatus.status_update.status_detail && priorStatus.status_update.status_detail.waiting_for_event_type;
      if (waiting && waitType !== 'messageAskUser' && waitType !== 'cascadeAskUser') {
        const detail = await request(base, key, `/v2/task.detail?task_id=${encodeQuery(taskId)}`, { signal });
        const url = detail.task && detail.task.task_url;
        const blocked = asChatCompletion({ action: 'final', content: `This Manus task is waiting for an external action decision. AGT will not send a follow-up because the Manus API treats an ordinary message as skipping that action. Review it in Manus${url ? `: ${url}` : ''}, then try again.` }, '', taskId, identity.user_id);
        blocked.manus_waiting_external_action = true;
        return blocked;
      }
      startedAt = Date.now();
      await request(base, key, '/v2/task.sendMessage', {
        method: 'POST',
        body: { task_id: taskId, message, structured_output_schema: schema },
        signal,
      });
    } catch (e) {
      if (!(e.status === 404 || e.code === 'not_found' || e.code === 'permission_denied')) throw e;
      taskId = null;
      baselineIds = null;
      baselineTimestamp = null;
      message = makeMessage({ ...body, manus: { ...state, input: latestInput(body) } }, true);
    }
  }

  if (!taskId) {
    startedAt = Date.now();
    const created = await request(base, key, '/v2/task.create', {
      method: 'POST',
      body: {
        message,
        structured_output_schema: schema,
        interactive_mode: true,
        share_visibility: 'private',
      },
      signal,
    });
    taskId = created.task_id;
    if (!taskId) throw new Error('Manus API did not return a task_id.');
  }

  let result;
  try {
    result = await pollTask(base, key, taskId, startedAt, names, signal, { timeoutMs, pollMs, baselineIds, baselineTimestamp });
  } catch (e) {
    if (e.manusTaskId) e.manusUserId = identity.user_id;
    throw e;
  }
  result.manus_user_id = identity.user_id;
  result.manus_task_id = taskId;
  return result;
}

module.exports = { run, outputSchema, makeMessage, asChatCompletion };
