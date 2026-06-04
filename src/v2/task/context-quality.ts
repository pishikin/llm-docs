import type { SaveContextCheckpointInput, SimpleTaskState, TaskMeta } from '../types.js';

export const CURRENT_STATE_START = '<!-- llm-docs:current-state:start -->';
export const CURRENT_STATE_END = '<!-- llm-docs:current-state:end -->';

interface StarterSectionSpec {
  title: string;
  inputKey: keyof Pick<
    SaveContextCheckpointInput,
    | 'currentState'
    | 'plan'
    | 'userFacingBehavior'
    | 'implementationDetails'
    | 'implementationMap'
    | 'decisions'
    | 'files'
    | 'verification'
    | 'risks'
    | 'nextSteps'
  >;
  placeholderPatterns: RegExp[];
  fallback: string;
}

const STARTER_SECTIONS: StarterSectionSpec[] = [
  {
    title: 'Current State',
    inputKey: 'currentState',
    placeholderPatterns: [/context file was recreated by llm-docs/i],
    fallback: 'See Current Working State and Latest Checkpoint.',
  },
  {
    title: 'Prepared Plan',
    inputKey: 'plan',
    placeholderPatterns: [/summarize the intended implementation strategy/i],
    fallback: 'No prepared plan captured in the latest checkpoint.',
  },
  {
    title: 'User-Facing Behavior',
    inputKey: 'userFacingBehavior',
    placeholderPatterns: [/describe what changed/i],
    fallback: 'No user-facing behavior captured in the latest checkpoint.',
  },
  {
    title: 'Implementation Details',
    inputKey: 'implementationDetails',
    placeholderPatterns: [/capture the main code-level approach/i],
    fallback: 'No implementation details captured in the latest checkpoint.',
  },
  {
    title: 'Source / Files Map',
    inputKey: 'implementationMap',
    placeholderPatterns: [/group touched files by purpose/i],
    fallback: 'No implementation map captured in the latest checkpoint.',
  },
  {
    title: 'Decisions',
    inputKey: 'decisions',
    placeholderPatterns: [/^[-*]\s*none\.?$/i],
    fallback: 'No decisions captured in the latest checkpoint.',
  },
  {
    title: 'Files',
    inputKey: 'files',
    placeholderPatterns: [/^[-*]\s*none\.?$/i],
    fallback: 'No touched files captured in the latest checkpoint.',
  },
  {
    title: 'Verification',
    inputKey: 'verification',
    placeholderPatterns: [/^[-*]\s*not run yet\.?$/i, /^[-*]\s*none\.?$/i],
    fallback: 'No verification captured in the latest checkpoint.',
  },
  {
    title: 'Risks',
    inputKey: 'risks',
    placeholderPatterns: [/^[-*]\s*none\.?$/i],
    fallback: 'No residual risks captured in the latest checkpoint.',
  },
  {
    title: 'Next Steps',
    inputKey: 'nextSteps',
    placeholderPatterns: [
      /define the first implementation step/i,
      /inspect the jira source/i,
      /normalize task spec/i,
      /build initial context/i,
    ],
    fallback: 'Continue from Current Working State and Latest Checkpoint.',
  },
];

function normalizeItems(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function renderBullets(values: string[], fallback: string): string {
  const items = values.length > 0 ? values : [fallback];
  return `${items.map((item) => `- ${item}`).join('\n')}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findH2Section(content: string, title: string): RegExpMatchArray | null {
  const pattern = new RegExp(
    `^## ${escapeRegExp(title)}\\s*\\n([\\s\\S]*?)(?=^## |^${escapeRegExp(CURRENT_STATE_START)}|^<!-- llm-docs:checkpoint:start -->|$)`,
    'm',
  );
  return content.match(pattern);
}

function sectionHasPlaceholder(body: string, spec: StarterSectionSpec): boolean {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => spec.placeholderPatterns.some((pattern) => pattern.test(line)));
}

export function detectStaleContextPlaceholders(content: string): string[] {
  const warnings: string[] = [];

  for (const spec of STARTER_SECTIONS) {
    const match = findH2Section(content, spec.title);
    if (match && sectionHasPlaceholder(match[1], spec)) {
      warnings.push(`context.md has stale starter placeholder in "${spec.title}".`);
    }
  }

  return warnings;
}

export function cleanupStarterPlaceholders(
  content: string,
  input: SaveContextCheckpointInput,
): string {
  let next = content;

  for (const spec of STARTER_SECTIONS) {
    const pattern = new RegExp(
      `(^## ${escapeRegExp(spec.title)}\\s*\\n)([\\s\\S]*?)(?=^## |^${escapeRegExp(CURRENT_STATE_START)}|^<!-- llm-docs:checkpoint:start -->|$)`,
      'm',
    );
    const match = next.match(pattern);
    if (!match || !sectionHasPlaceholder(match[2], spec)) {
      continue;
    }

    next = next.replace(pattern, (_full, heading: string) => {
      const sectionItems = normalizeItems(input[spec.inputKey]);
      return `${heading}${renderBullets(sectionItems, spec.fallback)}\n`;
    });
  }

  return next;
}

function renderSection(title: string, items: string[]): string {
  if (items.length === 0) {
    return '';
  }

  return `### ${title}\n${items.map((item) => `- ${item}`).join('\n')}\n\n`;
}

export function renderCurrentStateBlock(args: {
  taskId: string;
  input: SaveContextCheckpointInput;
  timestamp: string;
  meta: TaskMeta;
  state: SimpleTaskState;
  branch: string | null;
}): string {
  const currentState = [
    `phase: ${args.state.phase}`,
    `status: ${args.state.status}`,
    `branch: ${args.branch ?? args.state.branch.current ?? 'n/a'}`,
    ...normalizeItems(args.input.currentState),
  ];
  const sourceOfTruth = [
    ...args.state.truth.sourceOfTruthPaths.map((item) => `source path: ${item}`),
    ...args.state.truth.sourceOfTruthDocs.map((item) => `source doc: ${item}`),
  ];
  const body = [
    renderSection('Summary', normalizeItems(args.input.summary)),
    renderSection('Current State', currentState),
    renderSection('Requirements / Source Brief', normalizeItems(args.input.requirements)),
    renderSection('Prepared Plan', normalizeItems(args.input.plan)),
    renderSection('User-Facing Behavior', normalizeItems(args.input.userFacingBehavior)),
    renderSection('Completed Work', normalizeItems(args.input.completedWork)),
    renderSection('Implementation Details', normalizeItems(args.input.implementationDetails)),
    renderSection('Implementation Map', normalizeItems(args.input.implementationMap)),
    renderSection('Decisions', normalizeItems(args.input.decisions)),
    renderSection('Design Constraints', normalizeItems(args.input.designConstraints)),
    renderSection('Superseded / Historical Notes', normalizeItems(args.input.superseded)),
    renderSection('Files', normalizeItems(args.input.files)),
    renderSection('Verification', normalizeItems(args.input.verification)),
    renderSection('Validation Gaps', normalizeItems(args.input.validationGaps)),
    renderSection('Risks', normalizeItems(args.input.risks)),
    renderSection('Next Steps', normalizeItems(args.input.nextSteps)),
    renderSection('Source of Truth', sourceOfTruth),
    renderSection('Notes', normalizeItems(args.input.notes)),
  ]
    .join('')
    .trim();

  return `${CURRENT_STATE_START}\n## Current Working State\nUpdated: ${args.timestamp}\n\n${body || '- No current state details provided.'}\n${CURRENT_STATE_END}`;
}

function insertAfterHeading(content: string, block: string): string {
  const heading = content.match(/^# .+$/m);
  if (!heading || heading.index === undefined) {
    return `${block}\n\n${content.trimStart()}`;
  }

  const insertAt = heading.index + heading[0].length;
  return `${content.slice(0, insertAt).trimEnd()}\n\n${block}\n${content.slice(insertAt).trimStart()}`;
}

export function upsertCurrentStateBlock(content: string, block: string): string {
  const startIndex = content.indexOf(CURRENT_STATE_START);
  const endIndex = content.indexOf(CURRENT_STATE_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    return `${content.slice(0, startIndex).trimEnd()}\n\n${block}\n${content
      .slice(endIndex + CURRENT_STATE_END.length)
      .trimStart()}`;
  }

  return insertAfterHeading(content, block);
}

export function checkpointQualityWarnings(input: SaveContextCheckpointInput): string[] {
  const warnings: string[] = [];

  if (
    normalizeItems(input.summary).length === 0 &&
    normalizeItems(input.currentState).length === 0
  ) {
    warnings.push('Checkpoint has no summary or currentState items.');
  }
  const isSemanticCheckpoint =
    input.checkpointKind === 'milestone' ||
    input.checkpointKind === 'handoff' ||
    input.checkpointKind === 'publish';

  if (isSemanticCheckpoint && normalizeItems(input.plan).length === 0) {
    warnings.push('Semantic checkpoint has no prepared plan items.');
  }
  if (
    isSemanticCheckpoint &&
    normalizeItems(input.userFacingBehavior).length === 0 &&
    normalizeItems(input.implementationDetails).length === 0
  ) {
    warnings.push('Semantic checkpoint has no userFacingBehavior or implementationDetails items.');
  }
  if (normalizeItems(input.decisions).length === 0) {
    warnings.push('Checkpoint has no decisions items.');
  }
  if (normalizeItems(input.verification).length === 0) {
    warnings.push('Checkpoint has no verification items.');
  }
  if (normalizeItems(input.nextSteps).length === 0) {
    warnings.push('Checkpoint has no nextSteps items.');
  }

  return warnings;
}
