import { afterEach, test } from 'vitest';

import { initPersonalAgentSkillInstaller } from '../../src/control-plane/agent-skill.ts';
import { requestApp, setupAppTest, setupPersonalAppTest } from '../test-utils/app.ts';
import { initRuntimeProfile } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

afterEach(() => {
  initPersonalAgentSkillInstaller(null);
  initRuntimeProfile('server');
});

const requestInstall = (session: string, agent: 'codex' | 'claude' = 'codex') => requestApp('/api/agent-skill/install', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': session },
  body: JSON.stringify({ agent }),
});

test('Floway Skill installation requires a personal owner Dashboard session', async () => {
  const server = await setupAppTest();
  initPersonalAgentSkillInstaller({ readSessionToken: () => null, install: async () => ({ path: '/skill' }) });
  assertEquals((await requestInstall(server.adminSession)).status, 404);

  const personal = await setupPersonalAppTest();
  const apiKeyResponse = await requestApp('/api/agent-skill/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': personal.adminKey },
    body: JSON.stringify({ agent: 'codex' }),
  });
  assertEquals(apiKeyResponse.status, 401);
  assertEquals((await requestInstall(personal.adminSession)).status, 200);
});

test('Floway Skill installation reuses one authorized session across agents and concurrent clicks', async () => {
  const { repo, adminSession } = await setupPersonalAppTest();
  let savedToken: string | null = null;
  const tokens: string[] = [];
  initPersonalAgentSkillInstaller({
    readSessionToken: () => savedToken,
    install: async (agent, token) => {
      tokens.push(token);
      await new Promise(resolve => setTimeout(resolve, 10));
      savedToken = token;
      return { path: `/skills/${agent}/floway/SKILL.md` };
    },
  });

  const responses = await Promise.all([requestInstall(adminSession, 'codex'), requestInstall(adminSession, 'claude')]);
  assertEquals(responses.map(response => response.status), [200, 200]);
  assertEquals(tokens.length, 2);
  assertEquals(tokens[0], tokens[1]);
  assert(await repo.sessions.getByIdAndTouch(tokens[0]));
});

test('failed Floway Skill installation removes its newly minted session', async () => {
  const { repo, adminSession } = await setupPersonalAppTest();
  let minted = '';
  initPersonalAgentSkillInstaller({
    readSessionToken: () => null,
    install: async (_agent, token) => {
      minted = token;
      throw new Error('disk full');
    },
  });

  assertEquals((await requestInstall(adminSession)).status, 500);
  assertEquals(await repo.sessions.getByIdAndTouch(minted), null);
});
