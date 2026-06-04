import type { ChangelogEpochInput } from '../types.js';

function renderBulletSection(title: string, items: string[]): string {
  if (items.length === 0) {
    return '';
  }

  return `### ${title}
${items.map((item) => `- ${item}`).join('\n')}

`;
}

export function renderChangelogEpochBlock(input: ChangelogEpochInput): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const structuredStateItems = [
    input.structuredState?.phase ? `phase: ${input.structuredState.phase}` : null,
    input.structuredState?.status ? `status: ${input.structuredState.status}` : null,
    input.structuredState?.branch ? `branch: ${input.structuredState.branch}` : null,
  ].filter((value): value is string => Boolean(value));

  return `## ${timestamp} — ${input.label}

${renderBulletSection('Summary', input.summary)}${renderBulletSection(
  'Structured State',
  structuredStateItems,
)}${renderBulletSection('Decisions', input.decisions ?? [])}${renderBulletSection(
  'Next Steps',
  input.nextSteps ?? [],
)}---
`;
}

export function renderInitialChangelogTemplate(taskId: string, input: ChangelogEpochInput): string {
  return `# Changelog — ${taskId}

${renderChangelogEpochBlock(input)}
`;
}
