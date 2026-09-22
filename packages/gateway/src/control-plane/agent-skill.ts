import { Hono } from 'hono';
import { z } from 'zod';

import { type AuthVars, sessionIdFromContext, userFromContext } from '../middleware/auth.ts';
import { zValidator } from '../middleware/zod-validator.ts';
import { getRepo } from '../repo/index.ts';
import { getRuntimeProfile } from '@floway-dev/platform';

export interface PersonalAgentSkillInstaller {
  readSessionToken(): string | null;
  install(sessionToken: string): Promise<{ path: string }>;
}

let installer: PersonalAgentSkillInstaller | null = null;
let installQueue: Promise<void> = Promise.resolve();

const serializeInstall = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = installQueue;
  let release!: () => void;
  installQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

export const initPersonalAgentSkillInstaller = (value: PersonalAgentSkillInstaller | null): void => {
  installer = value;
};

const installBody = z.object({ agent: z.enum(['claude', 'codex']).optional() }).strict();

export const agentSkillRoutes = new Hono<{ Variables: AuthVars }>()
  .post('/install', zValidator('json', installBody), async c => {
    if (getRuntimeProfile().mode !== 'personal' || installer === null) {
      return c.json({ error: 'Floway Skill installation is available only in the local personal runtime.' }, 404);
    }
    if (sessionIdFromContext(c) === undefined) {
      return c.json({ error: 'Sign in to the Dashboard to authorize Floway Skill installation.' }, 401);
    }

    const activeInstaller = installer;
    const ownerId = userFromContext(c).id;
    return await serializeInstall(async () => {
      const existingToken = activeInstaller.readSessionToken();
      const existing = existingToken === null ? null : await getRepo().sessions.getByIdAndTouch(existingToken);
      const session = existing?.userId === ownerId
        ? existing
        : await getRepo().sessions.create(ownerId);
      const newlyCreated = session !== existing;
      try {
        const result = await activeInstaller.install(session.id);
        return c.json(result);
      } catch (error) {
        if (newlyCreated) await getRepo().sessions.deleteById(session.id);
        throw error;
      }
    });
  });
