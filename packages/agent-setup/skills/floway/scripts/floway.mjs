#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const secrets = new Set();
const safe = value => {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]');
  return result;
};
try {
const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readRequired = (path, guidance) => {
  try { return readFileSync(path, 'utf8'); }
  catch (cause) {
    if (cause?.code === 'ENOENT') throw new Error(guidance, { cause });
    throw cause;
  }
};
const { dataDir } = JSON.parse(readRequired(join(skillRoot, 'connection.json'), 'Floway Skill is incomplete. Reinstall it from the Dashboard.'));
const runtime = JSON.parse(readRequired(join(dataDir, 'runtime.json'), 'Floway is not running. Start the local app and retry.'));
if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) {
  throw new Error('Floway runtime state has no valid local port. Restart Floway.');
}
const origin = `http://127.0.0.1:${runtime.port}`;
const quickStart = `${origin}/dashboard/quick-start`;
const sessionToken = readRequired(join(dataDir, 'agent-skill.session'), `Floway Skill is not authorized. Sign in and reinstall it from ${quickStart}.`).trim();
if (!/^[0-9a-f]{64}$/.test(sessionToken)) throw new Error(`Floway Skill authorization is invalid. Reinstall it from ${quickStart}.`);
secrets.add(sessionToken);
const output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const errorText = payload => {
  const error = payload?.error;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  return 'The gateway rejected the request.';
};
const api = async (method, path, body) => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'x-floway-session': sessionToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(cause => { throw new Error(`Cannot reach local Floway at ${origin}. Start the app and retry.`, { cause }); });
  const payload = await response.json().catch(() => null);
  if (response.status === 401) throw new Error(`Floway Skill authorization expired. Sign in and reinstall it from ${quickStart}.`);
  if (!response.ok) throw new Error(`Floway HTTP ${response.status}: ${safe(errorText(payload))}`);
  return payload;
};
const dashboard = `${origin}/dashboard/providers/upstreams`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const recordSummary = row => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  enabled: row.enabled,
  modelsCache: row.modelsCache ?? null,
  dashboard,
});
const modelIds = payload => Array.isArray(payload?.data)
  ? payload.data.map(row => row.publicModelId ?? row.id).filter(id => typeof id === 'string')
  : [];
const usesDefaultCustomPaths = config => config.modelsFetch?.enabled === true
  && !config.modelsFetch.endpoint
  && Object.keys(config.pathOverrides ?? {}).length === 0;
const normalizeCustomBaseUrl = (value, config) => {
  if (value.includes('?') || value.includes('#')) {
    throw new Error('The provider URL must not contain a query or fragment.');
  }
  let url;
  try { url = new URL(value); }
  catch (cause) { throw new Error('The provider URL must be an http(s) URL.', { cause }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error('The provider URL must be an http(s) URL without credentials, a query, or a fragment.');
  }
  const suffix = usesDefaultCustomPaths(config) ? /\/v1(\/?)$/.exec(url.pathname) : null;
  if (suffix) url.pathname = `${url.pathname.slice(0, -suffix[0].length)}${suffix[1]}` || '/';
  return url.toString();
};
const verifyModels = async id => {
  const record = await api('GET', `/api/upstreams/${encodeURIComponent(id)}`);
  const result = await api('POST', '/api/upstreams/list-models', { record });
  const models = modelIds(result);
  if (models.length === 0) throw new Error(`Floway found no models for Upstream ${id}. Check its URL, credentials, and model-list settings in ${dashboard}.`);
  return models;
};
const finishCreate = async (record, details = {}) => {
  let models;
  try {
    models = await verifyModels(record.id);
  } catch (error) {
    output({ status: 'needs_attention', ...recordSummary(record), ...details, issue: safe(error.message) });
    process.exitCode = 2;
    return;
  }
  output({ status: 'verified', ...recordSummary(record), ...details, models });
};
const customFormats = [
  {
    api: 'openaiCompletions', path: '/v1/completions',
    body: model => ({ model, stream: true, prompt: 'Reply with OK.', max_tokens: 64 }),
  },
  {
    api: 'openaiChatCompletions', path: '/v1/chat/completions',
    body: model => ({ model, stream: true, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
  },
  {
    api: 'openaiResponses', path: '/v1/responses',
    body: model => ({ model, stream: true, input: [{ type: 'message', role: 'user', content: 'Reply with OK.' }] }),
  },
  {
    api: 'anthropicMessages', path: '/v1/messages',
    body: model => ({ model, stream: true, max_tokens: 256, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
  },
];
const playgroundFormats = [
  customFormats[2], customFormats[1], customFormats[3],
];
const probeText = (api, event) => {
  if (api === 'openaiCompletions') return event.choices?.[0]?.text ?? '';
  if (api === 'openaiChatCompletions') return event.choices?.[0]?.delta?.content ?? '';
  if (api === 'anthropicMessages') return event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? event.delta.text : '';
  return event.type === 'response.output_text.delta' ? event.delta : '';
};
const probeError = event => {
  if (event.type === 'response.failed') return event.response?.error?.message ?? 'The response failed.';
  if (event.type === 'error' || event.error) return errorText(event);
  return null;
};
const probeStreamingFormat = async (format, model, url, headers) => {
  const result = { api: format.api, path: format.path };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(format.body(model)),
      redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const body = await response.text();
      let payload;
      try { payload = JSON.parse(body); } catch { payload = null; }
      return { ...result, status: 'failed', httpStatus: response.status, issue: safe(payload ? errorText(payload) : body || `HTTP ${response.status}`) };
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      return { ...result, status: 'failed', httpStatus: response.status, issue: 'The endpoint did not return a streaming event response.' };
    }
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    let textReceived = false;
    let completed = false;
    let failure = null;
    const readFrame = frame => {
      const lines = frame.split('\n');
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { completed = true; return; }
      if (!data) return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;
      if (event.type === undefined) {
        const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        if (name) event.type = name;
      }
      failure ??= probeError(event);
      if (event.type === 'response.completed' || event.type === 'message_stop') completed = true;
      const delta = probeText(format.api, event);
      if (typeof delta === 'string' && delta.length > 0) textReceived = true;
    };
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1_000_000) throw new Error('The Gateway returned more than 1 MB of event data.');
      pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        readFrame(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
    }
    if (pending.trim()) readFrame(pending);
    if (failure) return { ...result, status: 'failed', httpStatus: response.status, issue: safe(failure) };
    return { ...result, status: !completed ? 'incomplete_response' : textReceived ? 'available' : 'empty_response', httpStatus: response.status };
  } catch (cause) {
    return { ...result, status: 'failed', issue: safe(cause instanceof Error ? cause.message : cause) };
  }
};
const probePlaygroundFormat = (format, model, apiKey) => probeStreamingFormat(
  format, model, `${origin}${format.path}`,
  format.api === 'anthropicMessages'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` },
);
const parseAuthStyle = value => {
  if (value === undefined || value === 'bearer') return 'bearer';
  if (value === 'anthropic') return value;
  throw new Error('AUTH_STYLE must be bearer or anthropic.');
};
const parseCustomOptions = values => {
  const authOptions = values.filter(value => value.startsWith('--auth-style='));
  const positional = values.filter(value => !value.startsWith('--auth-style='));
  if (authOptions.length > 1 || positional.length > 1) throw new Error('Expected at most one model or format list and one --auth-style option.');
  return { value: positional[0], authStyle: parseAuthStyle(authOptions[0]?.slice('--auth-style='.length)) };
};
const parseCustomEndpoints = value => {
  if (value === undefined) return { openaiChatCompletions: {} };
  const keys = value.split(',');
  if (keys.length === 0 || keys.some(key => !customFormats.some(format => format.api === key)) || new Set(keys).size !== keys.length) {
    throw new Error(`FORMATS must be a comma-separated nonempty subset of ${customFormats.map(format => format.api).join(', ')}.`);
  }
  return Object.fromEntries(keys.map(key => [key, {}]));
};
const probeCustom = async (inputUrl, keyFile, requestedModel, requestedAuthStyle) => {
  const draft = await blueprint('custom');
  const baseUrl = normalizeCustomBaseUrl(inputUrl, draft.config);
  const authStyle = parseAuthStyle(requestedAuthStyle);
  const apiKey = readProviderKey(keyFile);
  const config = { ...draft.config, baseUrl, apiKey, authStyle };
  const catalog = await api('POST', '/api/upstreams/list-models', { record: { ...draft, config } });
  const models = modelIds(catalog);
  if (models.length === 0) throw new Error(`Floway found no models at ${baseUrl}. Check the URL, credentials, and model-list path in ${dashboard}.`);
  if (requestedModel !== undefined && !models.includes(requestedModel)) {
    throw new Error(`Model ${requestedModel} was not in the upstream catalog. Choose one of the listed models.`);
  }
  const model = requestedModel ?? models[0];
  const headers = authStyle === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
  const formats = [];
  for (const format of customFormats) {
    formats.push(await probeStreamingFormat(format, model, `${baseUrl.replace(/\/+$/, '')}${format.path}`, headers));
  }
  const confirmedFormats = formats.filter(format => format.status === 'available').map(format => format.api);
  output({ status: confirmedFormats.length ? 'probed' : 'needs_attention', baseUrl, authStyle, models, model, formats,
    confirmedFormats, dashboard });
  if (!confirmedFormats.length) process.exitCode = 2;
};
const readProviderKey = keyFile => {
  const keyStat = statSync(keyFile);
  if (!keyStat.isFile() || (process.platform !== 'win32' && (keyStat.mode & 0o077) !== 0)) {
    throw new Error('The provider key must be in an owner-only regular file (mode 0600).');
  }
  const apiKey = readFileSync(keyFile, 'utf8').trim();
  if (!apiKey) throw new Error('The provider key file is empty.');
  secrets.add(apiKey);
  return apiKey;
};
const testModel = async (upstreamId, modelId) => {
  const catalog = await api('GET', '/api/models?aliases=false&include_unlisted=true');
  const model = catalog.data?.find(row => row.id === modelId && row.kind === 'chat' && row.upstreams?.some(upstream => upstream.id === upstreamId));
  if (!model) throw new Error(`Floway does not list ${modelId} as a chat model from ${upstreamId}. Check the model ID and refresh its catalog.`);
  const keys = await api('GET', '/api/keys');
  if (!Array.isArray(keys)) throw new Error('Floway did not return its API key list.');
  for (const key of keys) if (typeof key.key === 'string') secrets.add(key.key);
  const scoped = keys.find(key => typeof key.key === 'string' && key.key.length > 0
    && Array.isArray(key.upstream_ids) && key.upstream_ids.length === 1 && key.upstream_ids[0] === upstreamId);
  const key = scoped ?? await api('POST', '/api/keys', {
    name: `Floway Skill test ${upstreamId}`,
    upstream_ids: [upstreamId],
    key_source: 'generate',
  });
  if (typeof key?.key === 'string') secrets.add(key.key);
  const created = scoped === undefined;
  const formats = [];
  let testIssue;
  let cleanupIssue;
  try {
    if (typeof key?.key !== 'string' || !key.key || !Array.isArray(key.upstream_ids)
      || key.upstream_ids.length !== 1 || key.upstream_ids[0] !== upstreamId) {
      throw new Error('Floway did not return a key restricted to the selected model service.');
    }
    for (const format of playgroundFormats) formats.push(await probePlaygroundFormat(format, modelId, key.key));
  } catch (error) {
    testIssue = safe(error instanceof Error ? error.message : error);
  } finally {
    if (created) {
      if (typeof key?.id !== 'string' || !key.id) {
        cleanupIssue = 'Floway did not return the temporary key ID, so it could not be revoked.';
      } else {
        try { await api('DELETE', `/api/keys/${encodeURIComponent(key.id)}`); }
        catch (error) { cleanupIssue = safe(error instanceof Error ? error.message : error); }
      }
    }
  }
  const upstream = model.upstreams.find(candidate => candidate.id === upstreamId);
  output({ status: testIssue || cleanupIssue ? 'needs_attention' : 'tested', upstreamId, upstreamName: upstream.name,
    model: modelId, gateway: origin, keyName: key?.name ?? null, formats,
    ...(testIssue ? { issue: testIssue } : {}),
    ...(cleanupIssue ? { keyCleanup: { status: 'failed', keyId: key?.id ?? null, keyName: key?.name ?? null, issue: cleanupIssue } } : {}),
  });
  if (testIssue || cleanupIssue) process.exitCode = 2;
};
const blueprint = async kind => await api('GET', `/api/upstreams/blueprint?kind=${encodeURIComponent(kind)}`);
const pickHue = async () => {
  const upstreams = await api('GET', '/api/upstreams');
  const claimed = [...new Set(upstreams.map(upstream => upstream.hue))].sort((a, b) => a - b);
  if (claimed.length === 0) return Math.floor(Math.random() * 360);
  const gaps = claimed.map((hue, index) => ({
    hue,
    width: index === claimed.length - 1 ? claimed[0] + 360 - hue : claimed[index + 1] - hue,
  }));
  const widest = Math.max(...gaps.map(gap => gap.width));
  const candidates = gaps.filter(gap => gap.width === widest);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  return Math.round(chosen.hue + chosen.width / 2) % 360;
};
const createUpstream = async record => await api('POST', '/api/upstreams', { ...record, hue: await pickHue() });
const stageDirectory = join(dataDir, 'agent-skill-pending');
const stagePath = handle => {
  if (!/^[0-9a-f-]{36}$/.test(handle)) throw new Error('Invalid Copilot authorization handle.');
  return join(stageDirectory, `${handle}.json`);
};
const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'status': {
      const me = await api('GET', '/auth/me');
      output({ status: 'authorized', gateway: origin, owner: me.user?.username ?? null, dashboard });
      break;
    }
    case 'list': {
      const rows = await api('GET', '/api/upstreams');
      output({ gateway: origin, upstreams: rows.map(recordSummary), dashboard });
      break;
    }
    case 'models': {
      if (args.length !== 1) throw new Error('Usage: floway models UPSTREAM_ID');
      output({ status: 'verified', upstreamId: args[0], models: await verifyModels(args[0]), dashboard });
      break;
    }
    case 'test-model': {
      if (args.length !== 2) throw new Error('Usage: floway test-model UPSTREAM_ID MODEL_ID');
      await testModel(args[0], args[1]);
      break;
    }
    case 'probe-custom': {
      if (args.length < 2 || args.length > 4) throw new Error('Usage: floway probe-custom BASE_URL KEY_FILE [MODEL_ID] [--auth-style=anthropic]');
      const { value: modelId, authStyle } = parseCustomOptions(args.slice(2));
      await probeCustom(args[0], args[1], modelId, authStyle);
      break;
    }
    case 'create-custom': {
      if (args.length < 3 || args.length > 5) throw new Error('Usage: floway create-custom NAME BASE_URL KEY_FILE [FORMATS] [--auth-style=anthropic]');
      const [name, inputUrl, keyFile] = args;
      const { value: formatKeys, authStyle } = parseCustomOptions(args.slice(3));
      const draft = await blueprint('custom');
      const baseUrl = normalizeCustomBaseUrl(inputUrl, draft.config);
      const apiKey = readProviderKey(keyFile);
      const endpoints = parseCustomEndpoints(formatKeys);
      const created = await createUpstream({
        ...draft,
        name,
        enabled: true,
        config: { ...draft.config, baseUrl, apiKey, endpoints, authStyle },
      });
      await finishCreate(created, { baseUrl, authStyle, enabledFormats: Object.keys(endpoints) });
      break;
    }
    case 'create-ollama': {
      if (args.length !== 2) throw new Error('Usage: floway create-ollama NAME BASE_URL');
      const [name, baseUrl] = args;
      const draft = await blueprint('ollama');
      const created = await createUpstream({
        ...draft,
        name,
        enabled: true,
        config: { ...draft.config, baseUrl },
      });
      await finishCreate(created);
      break;
    }
    case 'copilot-start': {
      if (args.length !== 1) throw new Error('Usage: floway copilot-start NAME');
      const draft = { ...await blueprint('copilot'), name: args[0], enabled: true };
      const started = await api('POST', '/api/upstreams/copilot/oauth/device-login/start', { record: draft });
      if (!started.device_code || !started.user_code || !started.verification_uri) {
        throw new Error('GitHub did not return a complete device authorization challenge.');
      }
      mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
      const handle = randomUUID();
      writeFileSync(stagePath(handle), JSON.stringify({
        draft,
        deviceCode: started.device_code,
        interval: Math.max(5, Number(started.interval) || 5),
        expiresAt: Date.now() + Math.max(60, Number(started.expires_in) || 900) * 1000,
      }), { mode: 0o600, flag: 'wx' });
      output({ status: 'authorization_required', handle, verificationUrl: started.verification_uri, userCode: started.user_code, expiresInSeconds: started.expires_in });
      break;
    }
    case 'copilot-finish': {
      if (args.length !== 1) throw new Error('Usage: floway copilot-finish HANDLE');
      const path = stagePath(args[0]);
      if (!existsSync(path)) throw new Error('Copilot authorization handle was not found. Start authorization again.');
      const pending = JSON.parse(readFileSync(path, 'utf8'));
      if (Date.now() >= pending.expiresAt) {
        rmSync(path);
        throw new Error('GitHub device authorization expired. Start it again.');
      }
      const deadline = Math.min(pending.expiresAt, Date.now() + 55_000);
      let interval = pending.interval;
      while (Date.now() < deadline) {
        const result = await api('POST', '/api/upstreams/copilot/oauth/device-login/poll', {
          record: pending.draft,
          deviceCode: pending.deviceCode,
        });
        if (result.status === 'complete') {
          const created = await createUpstream({
            ...pending.draft,
            config: result.patch.config,
            state: result.patch.state,
          });
          rmSync(path);
          await finishCreate(created);
          break;
        }
        if (result.status === 'error') throw new Error(`${safe(result.error)}. Start a new GitHub authorization with floway copilot-start NAME.`);
        if (result.status === 'slow_down') interval += 5;
        await sleep(interval * 1000);
      }
      if (existsSync(path)) {
        output({ status: 'authorization_pending', handle: args[0], nextAction: 'Ask the owner to finish GitHub authorization, then retry copilot-finish with this handle.' });
        process.exitCode = 2;
      }
      break;
    }
    default:
      throw new Error('Usage: floway status | list | models ID | test-model UPSTREAM_ID MODEL_ID | probe-custom BASE_URL KEY_FILE [MODEL_ID] [--auth-style=anthropic] | create-custom NAME BASE_URL KEY_FILE [FORMATS] [--auth-style=anthropic] | create-ollama NAME BASE_URL | copilot-start NAME | copilot-finish HANDLE');
  }
} catch (error) {
  process.stderr.write(`${safe(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
}
