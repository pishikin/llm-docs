import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../src/engine/config/migrate.js';
import {
  readJiraAuthProfiles,
  removeJiraAuthProfile,
  saveJiraAuthProfile,
  setJiraTokenStoreForTests,
} from '../../src/engine/integrations/jira/auth.js';
import { resolveJiraClientConfig } from '../../src/engine/integrations/jira/config.js';
import { makeTempProject } from './test-helpers.js';

function useMemoryTokenStore(): Map<string, string> {
  const tokens = new Map<string, string>();
  setJiraTokenStoreForTests({
    async write(service, account, token) {
      tokens.set(`${service}:${account}`, token);
    },
    async read(service, account) {
      return tokens.get(`${service}:${account}`) ?? null;
    },
    async delete(service, account) {
      tokens.delete(`${service}:${account}`);
    },
  });
  return tokens;
}

afterEach(() => {
  setJiraTokenStoreForTests(null);
  vi.unstubAllEnvs();
});

describe('Jira auth profiles', () => {
  it('stores profile metadata globally and reads the token through the token store', async () => {
    const projectRoot = await makeTempProject();
    const llmdocsHome = path.join(projectRoot, '.llmdocs-home');
    const tokens = useMemoryTokenStore();
    vi.stubEnv('LLMDOCS_HOME', llmdocsHome);

    await saveJiraAuthProfile({
      profile: 'team',
      baseUrl: 'https://jira.example.com/rest/api/2',
      token: 'stored-token',
    });

    const profiles = await readJiraAuthProfiles();
    const config = await createDefaultConfig(projectRoot);
    const client = await resolveJiraClientConfig(config);

    expect(profiles.defaultProfile).toBe('team');
    expect(profiles.profiles.team.baseUrl).toBe('https://jira.example.com');
    expect(tokens.size).toBe(1);
    expect(client).toMatchObject({
      baseUrl: 'https://jira.example.com',
      apiBaseUrl: 'https://jira.example.com/rest/api/2',
      token: 'stored-token',
      authSource: 'profile',
      profile: 'team',
    });
  });

  it('keeps env auth as the highest-priority override', async () => {
    const projectRoot = await makeTempProject();
    useMemoryTokenStore();
    vi.stubEnv('LLMDOCS_HOME', path.join(projectRoot, '.llmdocs-home'));
    vi.stubEnv('JIRA_URL', 'https://env-jira.example');
    vi.stubEnv('JIRA_TOKEN', 'env-token');

    await saveJiraAuthProfile({
      profile: 'team',
      baseUrl: 'https://stored-jira.example',
      token: 'stored-token',
    });

    const config = await createDefaultConfig(projectRoot);
    const client = await resolveJiraClientConfig(config);

    expect(client).toMatchObject({
      baseUrl: 'https://env-jira.example',
      token: 'env-token',
      authSource: 'env',
      profile: null,
    });
  });

  it('removes profile metadata and stored token on logout', async () => {
    const projectRoot = await makeTempProject();
    const tokens = useMemoryTokenStore();
    vi.stubEnv('LLMDOCS_HOME', path.join(projectRoot, '.llmdocs-home'));

    await saveJiraAuthProfile({
      profile: 'team',
      baseUrl: 'https://jira.example.com',
      token: 'stored-token',
    });
    const result = await removeJiraAuthProfile('team');
    const profiles = await readJiraAuthProfiles();

    expect(result.removed).toBe(true);
    expect(profiles.defaultProfile).toBeNull();
    expect(profiles.profiles.team).toBeUndefined();
    expect(tokens.size).toBe(0);
  });
});
