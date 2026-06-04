import type { TaskSourceInput } from '../types.js';

export function renderRawTemplate(source: TaskSourceInput, title: string): string {
  const rawText = source.rawText?.trim() || title;

  return `# Raw Input

## Source
- type: ${source.type}
- ref: ${source.ref ?? 'null'}

## Original Content

${rawText}

## Notes
- This file preserves the original source input.
- Do not rewrite this file into a polished spec.
`;
}
