import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureDir, writeJsonAtomic } from '../../../utils/fs.js';
import type { JiraAuthProfile, JiraAuthProfilesFile } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_PROFILE = 'default';

export interface SaveJiraAuthInput {
  profile?: string | null;
  baseUrl: string;
  token: string;
  setDefault?: boolean;
}

export interface ResolveJiraAuthInput {
  profile?: string | null;
}

export interface ResolvedJiraAuthProfile {
  profileName: string;
  profile: JiraAuthProfile;
}

interface JiraTokenStore {
  write(service: string, account: string, token: string): Promise<void>;
  read(service: string, account: string): Promise<string | null>;
  delete(service: string, account: string): Promise<void>;
}

function globalConfigRoot(): string {
  return process.env.LLMDOCS_HOME?.trim() || path.join(os.homedir(), '.config', 'llm-docs');
}

export function jiraProfilesPath(): string {
  return path.join(globalConfigRoot(), 'jira', 'profiles.json');
}

export function normalizeJiraProfileName(profile: string | null | undefined): string {
  const value = profile?.trim();
  return value || DEFAULT_PROFILE;
}

export function normalizeJiraBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/rest\/api\/\d+$/u, '');
}

function keychainService(baseUrl: string): string {
  return `llm-docs:jira:${normalizeJiraBaseUrl(baseUrl)}`;
}

function emptyProfiles(): JiraAuthProfilesFile {
  return {
    schemaVersion: 1,
    defaultProfile: null,
    profiles: {},
  };
}

function parseProfiles(value: unknown): JiraAuthProfilesFile {
  const candidate = value as Partial<JiraAuthProfilesFile>;
  if (candidate?.schemaVersion !== 1 || typeof candidate.profiles !== 'object') {
    return emptyProfiles();
  }

  return {
    schemaVersion: 1,
    defaultProfile: candidate.defaultProfile ?? null,
    profiles: candidate.profiles as Record<string, JiraAuthProfile>,
  };
}

export async function readJiraAuthProfiles(): Promise<JiraAuthProfilesFile> {
  try {
    const content = await fs.readFile(jiraProfilesPath(), 'utf-8');
    return parseProfiles(JSON.parse(content) as unknown);
  } catch {
    return emptyProfiles();
  }
}

async function writeJiraAuthProfiles(profiles: JiraAuthProfilesFile): Promise<void> {
  await ensureDir(path.dirname(jiraProfilesPath()));
  await writeJsonAtomic(jiraProfilesPath(), profiles);
}

function assertMacosKeychainAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Persistent Jira auth currently uses macOS Keychain. Use JIRA_TOKEN env on this platform.',
    );
  }
}

async function writeMacosKeychainToken(
  service: string,
  account: string,
  token: string,
): Promise<void> {
  assertMacosKeychainAvailable();
  await execFileAsync('security', [
    'add-generic-password',
    '-a',
    account,
    '-s',
    service,
    '-w',
    token,
    '-U',
  ]);
}

export async function readMacosKeychainToken(
  service: string,
  account: string,
): Promise<string | null> {
  assertMacosKeychainAvailable();
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      service,
      '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function deleteMacosKeychainToken(service: string, account: string): Promise<void> {
  assertMacosKeychainAvailable();
  try {
    await execFileAsync('security', ['delete-generic-password', '-a', account, '-s', service]);
  } catch {
    // Missing credentials are already logged out from llm-docs' perspective.
  }
}

const macosKeychainStore: JiraTokenStore = {
  write: writeMacosKeychainToken,
  read: readMacosKeychainToken,
  delete: deleteMacosKeychainToken,
};

let tokenStore: JiraTokenStore = macosKeychainStore;

export function setJiraTokenStoreForTests(store: JiraTokenStore | null): void {
  tokenStore = store ?? macosKeychainStore;
}

export async function saveJiraAuthProfile(input: SaveJiraAuthInput): Promise<{
  profileName: string;
  profilesPath: string;
  service: string;
  account: string;
}> {
  const profileName = normalizeJiraProfileName(input.profile);
  const baseUrl = normalizeJiraBaseUrl(input.baseUrl);
  const now = new Date().toISOString();
  const profiles = await readJiraAuthProfiles();
  const existing = profiles.profiles[profileName];
  const service = keychainService(baseUrl);
  const account = profileName;
  const token = input.token.trim();

  if (!baseUrl) {
    throw new Error('Jira base URL is empty.');
  }
  if (!token) {
    throw new Error('Jira token is empty.');
  }

  await tokenStore.write(service, account, token);

  profiles.profiles[profileName] = {
    baseUrl,
    auth: {
      type: 'macos-keychain',
      service,
      account,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (input.setDefault !== false || !profiles.defaultProfile) {
    profiles.defaultProfile = profileName;
  }

  await writeJiraAuthProfiles(profiles);

  return {
    profileName,
    profilesPath: jiraProfilesPath(),
    service,
    account,
  };
}

export async function resolveJiraAuthProfile(
  input: ResolveJiraAuthInput = {},
): Promise<ResolvedJiraAuthProfile | null> {
  const profiles = await readJiraAuthProfiles();
  const profileName = input.profile?.trim() || profiles.defaultProfile;
  if (!profileName) {
    return null;
  }

  const profile = profiles.profiles[profileName];
  return profile ? { profileName, profile } : null;
}

export async function readJiraProfileToken(profile: JiraAuthProfile): Promise<string | null> {
  if (profile.auth.type !== 'macos-keychain') {
    return null;
  }

  return tokenStore.read(profile.auth.service, profile.auth.account);
}

export async function removeJiraAuthProfile(profile?: string | null): Promise<{
  profileName: string;
  removed: boolean;
  profilesPath: string;
}> {
  const profiles = await readJiraAuthProfiles();
  const profileName = profile?.trim() || profiles.defaultProfile || DEFAULT_PROFILE;
  const existing = profiles.profiles[profileName];

  if (existing?.auth.type === 'macos-keychain') {
    await tokenStore.delete(existing.auth.service, existing.auth.account);
  }

  delete profiles.profiles[profileName];
  if (profiles.defaultProfile === profileName) {
    profiles.defaultProfile = Object.keys(profiles.profiles).sort()[0] ?? null;
  }

  await writeJiraAuthProfiles(profiles);

  return {
    profileName,
    removed: !!existing,
    profilesPath: jiraProfilesPath(),
  };
}
