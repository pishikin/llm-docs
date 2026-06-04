import type { LlmDocsConfigV2 } from '../../types.js';
import { normalizeJiraBaseUrl, readJiraProfileToken, resolveJiraAuthProfile } from './auth.js';
import type { JiraClientConfig } from './types.js';

export interface ResolveJiraClientConfigOptions {
  profile?: string | null;
}

export async function resolveJiraClientConfig(
  config: LlmDocsConfigV2,
  options: ResolveJiraClientConfigOptions = {},
): Promise<JiraClientConfig> {
  const configuredBaseUrl = config.integrations.jira.baseUrl?.trim();
  const envBaseUrl = process.env.JIRA_URL?.trim();
  const tokenEnvVar = config.integrations.jira.tokenEnvVar || 'JIRA_TOKEN';
  const token = process.env[tokenEnvVar]?.trim();
  const envBase = configuredBaseUrl || envBaseUrl;

  if (token && envBase) {
    const normalizedBaseUrl = normalizeJiraBaseUrl(envBase);
    return {
      baseUrl: normalizedBaseUrl,
      apiBaseUrl: `${normalizedBaseUrl}/rest/api/2`,
      tokenEnvVar,
      token,
      authSource: 'env',
      profile: null,
    };
  }

  const storedAuth = await resolveJiraAuthProfile({
    profile: options.profile ?? process.env.LLMDOCS_JIRA_PROFILE ?? process.env.JIRA_PROFILE,
  });
  const profileToken = token || !storedAuth ? null : await readJiraProfileToken(storedAuth.profile);
  const baseUrl = envBase || storedAuth?.profile.baseUrl;

  if (!baseUrl) {
    throw new Error(
      'Jira base URL is not configured. Set integrations.jira.baseUrl, JIRA_URL, or run `llm-docs jira auth login`.',
    );
  }

  if (!token && !profileToken) {
    throw new Error(
      `Jira token is missing. Set ${tokenEnvVar} or run \`llm-docs jira auth login --base-url ${baseUrl}\`.`,
    );
  }

  const normalizedBaseUrl = normalizeJiraBaseUrl(baseUrl);

  return {
    baseUrl: normalizedBaseUrl,
    apiBaseUrl: `${normalizedBaseUrl}/rest/api/2`,
    tokenEnvVar,
    token: token || profileToken || '',
    authSource: token ? 'env' : 'profile',
    profile: token ? null : (storedAuth?.profileName ?? null),
  };
}
