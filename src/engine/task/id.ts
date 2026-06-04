import { normalizeRelativePath } from '../../utils/fs.js';

const JIRA_LIKE_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const ISSUE_LIKE_PATTERN = /^issue-\d+$/;

function normalizeSeparators(value: string): string {
  return value
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
}

function slugify(value: string): string {
  return normalizeSeparators(value).toLowerCase();
}

export function isJiraLikeTaskId(value: string): boolean {
  return JIRA_LIKE_PATTERN.test(value.trim());
}

export function normalizeTaskId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Task id cannot be empty');
  }

  const candidate = trimmed.replace(/\s*-\s*/g, '-').replace(/\s+/g, '-');
  const issueLikeCandidate = slugify(candidate);
  if (ISSUE_LIKE_PATTERN.test(issueLikeCandidate)) {
    return issueLikeCandidate;
  }

  const upperCandidate = normalizeSeparators(candidate).toUpperCase();

  if (isJiraLikeTaskId(upperCandidate)) {
    return upperCandidate;
  }

  const normalized = issueLikeCandidate;
  if (!normalized) {
    throw new Error('Task id cannot be normalized to an empty string');
  }

  return normalizeRelativePath(normalized).replace(/\//g, '-');
}

export function generateLocalTaskId(title: string, now: Date): string {
  const slug = slugify(title);
  if (!slug) {
    throw new Error('Task title cannot be normalized to a local task id');
  }

  const date = now.toISOString().slice(0, 10);
  return `local-${slug}-${date}`;
}

export function deriveTaskId(input: {
  taskId?: string | null;
  title?: string;
  sourceRef?: string | null;
  sourceType?: 'jira' | 'issue' | 'prompt' | 'imported' | 'external-doc';
  now?: Date;
}): string {
  if (input.taskId?.trim()) {
    return normalizeTaskId(input.taskId);
  }

  if (input.sourceRef?.trim()) {
    return normalizeTaskId(input.sourceRef);
  }

  if (input.title?.trim()) {
    return generateLocalTaskId(input.title, input.now ?? new Date());
  }

  throw new Error('Cannot derive task id without taskId, sourceRef, or title');
}
