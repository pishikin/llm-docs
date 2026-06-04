import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../../utils/fs.js';
import type { JiraClientConfig, JiraIssue } from './types.js';

const DEFAULT_ISSUE_FIELDS = [
  'summary',
  'status',
  'description',
  'assignee',
  'reporter',
  'priority',
  'labels',
  'components',
  'created',
  'updated',
  'issuetype',
  'parent',
  'issuelinks',
  'attachment',
];

function authHeaders(client: JiraClientConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${client.token}`,
    Accept: 'application/json',
  };
}

async function responseSnippet(response: Response): Promise<string> {
  const text = await response.text();
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function readJsonResponse<T>(response: Response, description: string): Promise<T> {
  if (!response.ok) {
    const snippet = await responseSnippet(response);
    throw new Error(`${description} failed with HTTP ${response.status}: ${snippet}`);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(`${description} returned non-JSON response`, { cause: error });
  }
}

export async function fetchJiraServerInfo(client: JiraClientConfig): Promise<unknown> {
  const response = await fetch(`${client.apiBaseUrl}/serverInfo`, {
    headers: authHeaders(client),
  });

  return readJsonResponse<unknown>(response, 'Jira serverInfo request');
}

export async function fetchJiraCurrentUser(client: JiraClientConfig): Promise<unknown> {
  const response = await fetch(`${client.apiBaseUrl}/myself`, {
    headers: authHeaders(client),
  });

  return readJsonResponse<unknown>(response, 'Jira myself request');
}

export async function fetchJiraIssue(
  client: JiraClientConfig,
  issueKey: string,
  fields: string[] = DEFAULT_ISSUE_FIELDS,
): Promise<JiraIssue> {
  const url = new URL(`${client.apiBaseUrl}/issue/${encodeURIComponent(issueKey)}`);
  url.searchParams.set('fields', fields.join(','));
  url.searchParams.set('expand', 'names,renderedFields');

  const response = await fetch(url, {
    headers: authHeaders(client),
  });

  return readJsonResponse<JiraIssue>(response, `Jira issue request for ${issueKey}`);
}

export async function downloadJiraAttachment(
  client: JiraClientConfig,
  url: string,
  destinationPath: string,
): Promise<void> {
  const response = await fetch(url, {
    headers: authHeaders(client),
    redirect: 'follow',
  });

  if (!response.ok) {
    const snippet = await responseSnippet(response);
    throw new Error(`Jira attachment download failed with HTTP ${response.status}: ${snippet}`);
  }

  await ensureDir(path.dirname(destinationPath));
  await fs.writeFile(destinationPath, Buffer.from(await response.arrayBuffer()));
}
