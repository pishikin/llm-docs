import path from 'node:path';
import {
  ensureDir,
  fileExists,
  normalizeRelativePath,
  writeJsonAtomic,
  writeTextAtomic,
} from '../../../utils/fs.js';
import type { LlmDocsConfigV2, WorkspacePaths } from '../../types.js';
import { downloadJiraAttachment, fetchJiraIssue } from './client.js';
import { resolveJiraClientConfig } from './config.js';
import { jiraBrowseUrl, localAttachmentPath, renderJiraIssueMarkdown } from './render.js';
import type {
  JiraAttachment,
  JiraClientConfig,
  JiraPullAttachment,
  JiraPullManifest,
  JiraPullResult,
} from './types.js';

export interface PullJiraIssueOptions {
  attachments?: boolean;
  force?: boolean;
  profile?: string | null;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/:\\]+/g, '-').replace(/^\.+$/g, 'attachment');
}

function uniqueFilename(usedFilenames: Set<string>, filename: string): string {
  const parsed = path.parse(filename);
  let candidate = filename;
  let attempt = 0;

  while (usedFilenames.has(candidate)) {
    attempt += 1;
    candidate = `${parsed.name}-${String(attempt).padStart(2, '0')}${parsed.ext}`;
  }

  usedFilenames.add(candidate);
  return candidate;
}

function inboxRoot(paths: WorkspacePaths): string {
  return path.join(paths.workspaceRoot, 'inbox/jira');
}

function issueInboxDir(paths: WorkspacePaths, issueKey: string): string {
  return path.join(inboxRoot(paths), issueKey);
}

function attachmentOutput(
  paths: WorkspacePaths,
  issueKey: string,
  attachment: JiraAttachment,
  usedFilenames: Set<string>,
): { absolutePath: string; relativePath: string; filename: string } {
  const filename = uniqueFilename(usedFilenames, sanitizeFilename(attachment.filename));
  const relativeIssueDir = normalizeRelativePath(
    path.relative(paths.projectRoot, issueInboxDir(paths, issueKey)),
  );
  const relativePath = localAttachmentPath(relativeIssueDir, filename);

  return {
    filename,
    absolutePath: path.join(paths.projectRoot, relativePath),
    relativePath,
  };
}

async function downloadAttachments(
  client: JiraClientConfig,
  paths: WorkspacePaths,
  issueKey: string,
  attachments: JiraAttachment[],
  options: PullJiraIssueOptions,
): Promise<JiraPullAttachment[]> {
  const results: JiraPullAttachment[] = [];
  const usedFilenames = new Set<string>(['jira-raw.json', 'jira-issue.md']);

  for (const attachment of attachments) {
    const output = attachmentOutput(paths, issueKey, attachment, usedFilenames);
    const shouldDownload = options.attachments === true;

    if (shouldDownload && (options.force || !(await fileExists(output.absolutePath)))) {
      await downloadJiraAttachment(client, attachment.content, output.absolutePath);
    }

    results.push({
      filename: output.filename,
      sourceUrl: attachment.content,
      path: output.relativePath,
      downloaded: shouldDownload && (await fileExists(output.absolutePath)),
      mimeType: attachment.mimeType ?? null,
      size: attachment.size ?? null,
    });
  }

  return results;
}

export async function pullJiraIssue(
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  issueKey: string,
  options: PullJiraIssueOptions = {},
): Promise<JiraPullResult> {
  const client = await resolveJiraClientConfig(config, { profile: options.profile });
  const issue = await fetchJiraIssue(client, issueKey);
  const resolvedIssueKey = issue.key || issueKey;
  const inboxDir = issueInboxDir(paths, resolvedIssueKey);
  const attachmentDir = path.join(inboxDir, 'attachments');
  const rawPath = path.join(inboxDir, 'raw.json');
  const issuePath = path.join(inboxDir, 'issue.md');
  const manifestPath = path.join(inboxDir, 'manifest.json');
  const browseUrl = jiraBrowseUrl(client.baseUrl, resolvedIssueKey);

  await ensureDir(inboxDir);
  if (options.attachments) {
    await ensureDir(attachmentDir);
  }

  const attachments = await downloadAttachments(
    client,
    paths,
    resolvedIssueKey,
    issue.fields.attachment ?? [],
    options,
  );
  const issueMarkdown = renderJiraIssueMarkdown(issue, browseUrl, attachments);
  const manifest: JiraPullManifest = {
    schemaVersion: 1,
    issueKey: resolvedIssueKey,
    browseUrl,
    fetchedAt: new Date().toISOString(),
    updated: issue.fields.updated ?? null,
    rawPath: normalizeRelativePath(path.relative(paths.projectRoot, rawPath)),
    issuePath: normalizeRelativePath(path.relative(paths.projectRoot, issuePath)),
    attachments,
  };

  await writeJsonAtomic(rawPath, issue);
  await writeTextAtomic(issuePath, issueMarkdown);
  await writeJsonAtomic(manifestPath, manifest);

  return {
    issue,
    issueKey: resolvedIssueKey,
    browseUrl,
    inboxDir: normalizeRelativePath(path.relative(paths.projectRoot, inboxDir)),
    rawPath: manifest.rawPath,
    issuePath: manifest.issuePath,
    manifestPath: normalizeRelativePath(path.relative(paths.projectRoot, manifestPath)),
    attachmentDir: normalizeRelativePath(path.relative(paths.projectRoot, attachmentDir)),
    attachments,
  };
}
