import { password } from '@inquirer/prompts';
import { Command } from 'commander';
import { getProjectRoot } from '../utils/fs.js';
import {
  jiraProfilesPath,
  readJiraAuthProfiles,
  removeJiraAuthProfile,
  saveJiraAuthProfile,
} from '../v2/integrations/jira/auth.js';
import { fetchJiraCurrentUser, fetchJiraServerInfo } from '../v2/integrations/jira/client.js';
import { resolveJiraClientConfig } from '../v2/integrations/jira/config.js';
import { pullJiraIssue } from '../v2/integrations/jira/pull.js';
import { createV2Runtime } from '../v2/runtime.js';

interface JiraDoctorOptions {
  profile?: string;
  json?: boolean;
}

interface JiraPullOptions {
  attachments?: boolean;
  force?: boolean;
  profile?: string;
  json?: boolean;
}

interface JiraAuthLoginOptions {
  baseUrl?: string;
  profile?: string;
  tokenEnv?: string;
  default?: boolean;
  json?: boolean;
}

interface JiraAuthProfileOptions {
  profile?: string;
  json?: boolean;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const jiraDoctorCommand = new Command('doctor')
  .description('Check Jira REST API configuration and authentication')
  .option('--profile <name>', 'Jira auth profile name')
  .option('--json', 'print JSON output')
  .action(async (options: JiraDoctorOptions) => {
    const projectRoot = await getProjectRoot();
    const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
    const client = await resolveJiraClientConfig(runtime.config, { profile: options.profile });
    const [serverInfo, currentUser] = await Promise.all([
      fetchJiraServerInfo(client),
      fetchJiraCurrentUser(client),
    ]);
    const result = {
      ok: true,
      baseUrl: client.baseUrl,
      apiBaseUrl: client.apiBaseUrl,
      tokenEnvVar: client.tokenEnvVar,
      authSource: client.authSource,
      profile: client.profile,
      serverInfo,
      currentUser,
    };

    if (options.json) {
      printJson(result);
      return;
    }

    console.log('Jira connection: ok');
    console.log(`Base URL: ${client.baseUrl}`);
    console.log(`Auth source: ${client.authSource}${client.profile ? ` (${client.profile})` : ''}`);
  });

const jiraPullCommand = new Command('pull')
  .description('Download a Jira issue into the local llm-docs inbox')
  .argument('<issueKey>', 'Jira issue key, for example PROJ-286')
  .option('--attachments', 'download Jira attachments')
  .option('--force', 're-download files that already exist')
  .option('--profile <name>', 'Jira auth profile name')
  .option('--json', 'print JSON output')
  .action(async (issueKey: string, options: JiraPullOptions) => {
    const projectRoot = await getProjectRoot();
    const runtime = await createV2Runtime(projectRoot, { createIfMissing: false });
    const result = await pullJiraIssue(runtime.config, runtime.paths, issueKey, {
      attachments: options.attachments,
      force: options.force,
      profile: options.profile,
    });

    if (options.json) {
      printJson(result);
      return;
    }

    console.log(`Jira issue: ${result.issueKey}`);
    console.log(`Raw: ${result.rawPath}`);
    console.log(`Issue: ${result.issuePath}`);
    console.log(`Manifest: ${result.manifestPath}`);
    if (options.attachments) {
      console.log(`Attachments: ${result.attachments.filter((item) => item.downloaded).length}`);
    }
  });

const jiraAuthLoginCommand = new Command('login')
  .description('Store Jira auth in the global llm-docs profile and macOS Keychain')
  .requiredOption('--base-url <url>', 'Jira base URL, for example https://jira.example.com')
  .option('--profile <name>', 'profile name', 'default')
  .option('--token-env <name>', 'read token from this env var instead of prompting')
  .option('--no-default', 'do not set this profile as the default')
  .option('--json', 'print JSON output')
  .action(async (options: JiraAuthLoginOptions) => {
    const token =
      (options.tokenEnv ? process.env[options.tokenEnv]?.trim() : null) ??
      (await password({ message: 'Jira token:' }));

    if (!token) {
      throw new Error('Jira token is empty.');
    }

    const result = await saveJiraAuthProfile({
      profile: options.profile,
      baseUrl: options.baseUrl ?? '',
      token,
      setDefault: options.default,
    });

    if (options.json) {
      printJson(result);
      return;
    }

    console.log(`Saved Jira profile: ${result.profileName}`);
    console.log(`Profiles: ${result.profilesPath}`);
    console.log('Token: macOS Keychain');
  });

const jiraAuthStatusCommand = new Command('status')
  .description('Show configured Jira auth profiles')
  .option('--profile <name>', 'profile name to inspect')
  .option('--json', 'print JSON output')
  .action(async (options: JiraAuthProfileOptions) => {
    const profiles = await readJiraAuthProfiles();
    const profileNames = Object.keys(profiles.profiles).sort();
    const selectedProfile = options.profile ?? profiles.defaultProfile;
    const selected = selectedProfile ? profiles.profiles[selectedProfile] : null;
    const result = {
      profilesPath: jiraProfilesPath(),
      defaultProfile: profiles.defaultProfile,
      profiles: profileNames,
      selectedProfile: selectedProfile ?? null,
      selected: selected
        ? {
            baseUrl: selected.baseUrl,
            authType: selected.auth.type,
            service: selected.auth.service,
            account: selected.auth.account,
          }
        : null,
    };

    if (options.json) {
      printJson(result);
      return;
    }

    console.log(`Profiles: ${result.profilesPath}`);
    console.log(`Default: ${result.defaultProfile ?? 'none'}`);
    console.log(`Available: ${profileNames.length ? profileNames.join(', ') : 'none'}`);
    if (result.selected) {
      console.log(`Selected: ${result.selectedProfile}`);
      console.log(`Base URL: ${result.selected.baseUrl}`);
      console.log(`Auth: ${result.selected.authType}`);
    }
  });

const jiraAuthLogoutCommand = new Command('logout')
  .description('Remove a Jira auth profile and its Keychain token')
  .option('--profile <name>', 'profile name to remove')
  .option('--json', 'print JSON output')
  .action(async (options: JiraAuthProfileOptions) => {
    const result = await removeJiraAuthProfile(options.profile);

    if (options.json) {
      printJson(result);
      return;
    }

    console.log(`${result.removed ? 'Removed' : 'No profile found'}: ${result.profileName}`);
    console.log(`Profiles: ${result.profilesPath}`);
  });

const jiraAuthCommand = new Command('auth').description('Manage persistent Jira authentication');

jiraAuthCommand.addCommand(jiraAuthLoginCommand);
jiraAuthCommand.addCommand(jiraAuthStatusCommand);
jiraAuthCommand.addCommand(jiraAuthLogoutCommand);

const jiraCommand = new Command('jira').description('Jira import helpers for task bundles');

jiraCommand.addCommand(jiraAuthCommand);
jiraCommand.addCommand(jiraDoctorCommand);
jiraCommand.addCommand(jiraPullCommand);

export default jiraCommand;
