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
const sessionToken = readRequired(join(dataDir, 'agent-skill.session'), 'Floway Skill is not authorized. Sign in to the Dashboard and reinstall it.').trim();
if (!/^[0-9a-f]{64}$/.test(sessionToken)) throw new Error('Floway Skill authorization is invalid. Reinstall it from the Dashboard.');
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
  if (response.status === 401) throw new Error('Floway Skill authorization expired. Sign in to the Dashboard and reinstall it.');
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
const verifyModels = async id => {
  const record = await api('GET', `/api/upstreams/${encodeURIComponent(id)}`);
  const result = await api('POST', '/api/upstreams/list-models', { record });
  const models = modelIds(result);
  if (models.length === 0) throw new Error(`Floway found no models for Upstream ${id}. Check its URL, credentials, and model-list settings in ${dashboard}.`);
  return models;
};
const finishCreate = async record => {
  let models;
  try {
    models = await verifyModels(record.id);
  } catch (error) {
    output({ status: 'needs_attention', ...recordSummary(record), issue: safe(error.message) });
    process.exitCode = 2;
    return;
  }
  output({ status: 'verified', ...recordSummary(record), models });
};
const blueprint = async kind => await api('GET', `/api/upstreams/blueprint?kind=${encodeURIComponent(kind)}`);
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
    case 'create-custom': {
      if (args.length !== 3) throw new Error('Usage: floway create-custom NAME BASE_URL KEY_FILE');
      const [name, baseUrl, keyFile] = args;
      const keyStat = statSync(keyFile);
      if (!keyStat.isFile() || (process.platform !== 'win32' && (keyStat.mode & 0o077) !== 0)) {
        throw new Error('The provider key must be in an owner-only regular file (mode 0600).');
      }
      const apiKey = readFileSync(keyFile, 'utf8').trim();
      if (!apiKey) throw new Error('The provider key file is empty.');
      secrets.add(apiKey);
      const draft = await blueprint('custom');
      const created = await api('POST', '/api/upstreams', {
        ...draft,
        name,
        enabled: true,
        config: { ...draft.config, baseUrl, apiKey },
      });
      await finishCreate(created);
      break;
    }
    case 'create-ollama': {
      if (args.length !== 2) throw new Error('Usage: floway create-ollama NAME BASE_URL');
      const [name, baseUrl] = args;
      const draft = await blueprint('ollama');
      const created = await api('POST', '/api/upstreams', {
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
          const created = await api('POST', '/api/upstreams', {
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
      throw new Error('Usage: floway status | list | models ID | create-custom NAME BASE_URL KEY_FILE | create-ollama NAME BASE_URL | copilot-start NAME | copilot-finish HANDLE');
  }
} catch (error) {
  process.stderr.write(`${safe(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
}
