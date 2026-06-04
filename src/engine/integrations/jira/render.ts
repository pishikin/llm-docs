import path from 'node:path';
import type { JiraIssue, JiraPullAttachment } from './types.js';

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return '';
  }

  return JSON.stringify(value, null, 2);
}

function displayName(value: { displayName?: string | null; name?: string | null } | null): string {
  return value?.displayName?.trim() || value?.name?.trim() || '';
}

function namedValue(value: { name?: string | null } | null): string {
  return value?.name?.trim() || '';
}

function renderList(values: string[]): string {
  if (values.length === 0) {
    return '- none';
  }

  return values.map((value) => `- ${value}`).join('\n');
}

function attachmentLine(attachment: JiraPullAttachment): string {
  if (attachment.downloaded) {
    return `- ${attachment.filename} - ${attachment.path}`;
  }

  return `- ${attachment.filename} - ${attachment.sourceUrl}`;
}

export function jiraBrowseUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/browse/${issueKey}`;
}

export function jiraIssueTitle(issue: JiraIssue): string {
  return issue.fields.summary?.trim() || issue.key;
}

export function renderJiraIssueMarkdown(
  issue: JiraIssue,
  browseUrl: string,
  attachments: JiraPullAttachment[] = [],
): string {
  const fields = issue.fields;
  const labels = fields.labels ?? [];
  const components = (fields.components ?? []).map((component) => namedValue(component));
  const description = textValue(fields.description);

  return `${[
    `# ${issue.key}: ${jiraIssueTitle(issue)}`,
    '',
    '## Jira',
    `- Key: ${issue.key}`,
    `- URL: ${browseUrl}`,
    `- Type: ${namedValue(fields.issuetype ?? null)}`,
    `- Status: ${namedValue(fields.status ?? null)}`,
    `- Priority: ${namedValue(fields.priority ?? null)}`,
    `- Assignee: ${displayName(fields.assignee ?? null) || 'Unassigned'}`,
    `- Reporter: ${displayName(fields.reporter ?? null)}`,
    `- Created: ${fields.created ?? ''}`,
    `- Updated: ${fields.updated ?? ''}`,
    '',
    '## Labels',
    renderList(labels),
    '',
    '## Components',
    renderList(components.filter(Boolean)),
    '',
    '## Description',
    '',
    description || 'No description.',
    '',
    '## Attachments',
    renderList(attachments.map(attachmentLine)),
  ].join('\n')}\n`;
}

export function renderJiraTaskContext(
  issue: JiraIssue,
  browseUrl: string,
  attachments: JiraPullAttachment[] = [],
): string {
  const fields = issue.fields;
  const localAttachments = attachments
    .filter((attachment) => attachment.downloaded)
    .map((attachment) => `${attachment.filename} - ${attachment.path}`);

  return `${[
    `# ${issue.key}: ${jiraIssueTitle(issue)}`,
    '',
    '## Goal',
    jiraIssueTitle(issue),
    '',
    '## Jira',
    `- URL: ${browseUrl}`,
    `- status: ${namedValue(fields.status ?? null) || 'unknown'}`,
    `- priority: ${namedValue(fields.priority ?? null) || 'unknown'}`,
    `- assignee: ${displayName(fields.assignee ?? null) || 'Unassigned'}`,
    `- updated: ${fields.updated ?? 'unknown'}`,
    '',
    '## Source Brief',
    textValue(fields.description) || 'No Jira description.',
    '',
    '## Local Attachments',
    renderList(localAttachments),
    '',
    '## Current State',
    '- phase: implementation',
    '- status: active',
    '',
    '## Decisions',
    '- none',
    '',
    '## Files',
    '- none',
    '',
    '## Verification',
    '- not run yet',
    '',
    '## Risks',
    '- none',
    '',
    '## Next Steps',
    '- Inspect the Jira source and attachments.',
    '- Define the first implementation step.',
    '',
    '<!-- llm-docs:checkpoint:start -->',
    '## Latest Checkpoint',
    'No checkpoint saved yet.',
    '<!-- llm-docs:checkpoint:end -->',
  ].join('\n')}\n`;
}

export function localAttachmentPath(issueDir: string, filename: string): string {
  return path.posix.join(issueDir, 'attachments', filename);
}
