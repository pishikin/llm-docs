export interface JiraUserRef {
  displayName?: string | null;
  name?: string | null;
  key?: string | null;
  emailAddress?: string | null;
}

export interface JiraNamedRef {
  id?: string | null;
  key?: string | null;
  name?: string | null;
}

export interface JiraAttachment {
  id?: string | null;
  filename: string;
  content: string;
  mimeType?: string | null;
  size?: number | null;
}

export interface JiraIssueFields {
  summary?: string | null;
  description?: unknown;
  status?: JiraNamedRef | null;
  assignee?: JiraUserRef | null;
  reporter?: JiraUserRef | null;
  priority?: JiraNamedRef | null;
  labels?: string[] | null;
  components?: JiraNamedRef[] | null;
  created?: string | null;
  updated?: string | null;
  issuetype?: JiraNamedRef | null;
  parent?: {
    key?: string | null;
    fields?: {
      summary?: string | null;
    };
  } | null;
  issuelinks?: unknown[] | null;
  attachment?: JiraAttachment[] | null;
}

export interface JiraIssue {
  id?: string;
  key: string;
  self?: string;
  fields: JiraIssueFields;
  renderedFields?: {
    description?: unknown;
  };
  names?: Record<string, string>;
}

export interface JiraClientConfig {
  baseUrl: string;
  apiBaseUrl: string;
  tokenEnvVar: string;
  token: string;
  authSource: 'env' | 'profile';
  profile: string | null;
}

export interface JiraAuthProfile {
  baseUrl: string;
  auth: {
    type: 'macos-keychain';
    service: string;
    account: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface JiraAuthProfilesFile {
  schemaVersion: 1;
  defaultProfile: string | null;
  profiles: Record<string, JiraAuthProfile>;
}

export interface JiraPullAttachment {
  filename: string;
  sourceUrl: string;
  path: string;
  downloaded: boolean;
  mimeType: string | null;
  size: number | null;
}

export interface JiraPullManifest {
  schemaVersion: 1;
  issueKey: string;
  browseUrl: string;
  fetchedAt: string;
  updated: string | null;
  rawPath: string;
  issuePath: string;
  attachments: JiraPullAttachment[];
}

export interface JiraPullResult {
  issue: JiraIssue;
  issueKey: string;
  browseUrl: string;
  inboxDir: string;
  rawPath: string;
  issuePath: string;
  manifestPath: string;
  attachmentDir: string;
  attachments: JiraPullAttachment[];
}

export interface JiraTaskImportResult {
  taskId: string;
  title: string;
  created: boolean;
  bundlePath: string;
  contextPath: string | null;
  rawPath: string;
  issuePath: string;
  manifestPath: string;
  artifacts: string[];
  activeScope: 'none' | 'workspace' | 'codex-session';
  sessionId: string | null;
}
