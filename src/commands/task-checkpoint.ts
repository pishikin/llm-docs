import { Command } from 'commander';
import { createRuntime } from '../engine/runtime.js';
import { resolveCodexSessionIdFromEnv } from '../engine/task/session-binding.js';
import type {
  CheckpointKind,
  SaveContextCheckpointInput,
  TaskQualityProfile,
} from '../engine/types.js';
import { getProjectRoot } from '../utils/fs.js';

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

const taskCheckpointCommand = new Command('checkpoint')
  .description('Save a compact working-context checkpoint for a task')
  .argument('[taskId]', 'task id to checkpoint; defaults to the resolved active task')
  .option('--summary <item>', 'summary item', collect, [])
  .option('--current-state <item>', 'current state item', collect, [])
  .option('--requirement <item>', 'source requirement or brief item', collect, [])
  .option('--plan <item>', 'prepared plan item', collect, [])
  .option('--behavior <item>', 'user-facing behavior item', collect, [])
  .option('--completed-work <item>', 'completed work item', collect, [])
  .option('--implementation-detail <item>', 'implementation detail item', collect, [])
  .option('--implementation-map <item>', 'grouped implementation map item', collect, [])
  .option('--decision <item>', 'decision item', collect, [])
  .option('--constraint <item>', 'design or product constraint item', collect, [])
  .option('--superseded <item>', 'superseded or historical note', collect, [])
  .option('--file <path>', 'touched file', collect, [])
  .option('--verification <item>', 'verification item', collect, [])
  .option('--validation-gap <item>', 'validation gap item', collect, [])
  .option('--risk <item>', 'risk item', collect, [])
  .option('--next-step <item>', 'next step item', collect, [])
  .option('--note <item>', 'note item', collect, [])
  .option('--head <commit>', 'commit or ref captured by the checkpoint')
  .option(
    '--kind <kind>',
    'checkpoint kind: progress, milestone, handoff, pause, incident, publish',
  )
  .option('--append-changelog', 'append a compact changelog epoch with this checkpoint')
  .option('--no-append-changelog', 'do not append changelog even for long-task profiles')
  .option('--phase-label <label>', 'human label for the checkpoint epoch')
  .option(
    '--profile <profile>',
    'quality profile: compact, normal, long-running, large-ui, research-heavy',
  )
  .option('--session-id <id>', 'resolve task from a Codex session binding when task id is omitted')
  .option('--json', 'print JSON output')
  .action(
    async (
      taskId: string | undefined,
      options: {
        summary: string[];
        currentState: string[];
        requirement: string[];
        plan: string[];
        behavior: string[];
        completedWork: string[];
        implementationDetail: string[];
        implementationMap: string[];
        decision: string[];
        constraint: string[];
        superseded: string[];
        file: string[];
        verification: string[];
        validationGap: string[];
        risk: string[];
        nextStep: string[];
        note: string[];
        head?: string;
        kind?: CheckpointKind;
        appendChangelog?: boolean;
        phaseLabel?: string;
        profile?: TaskQualityProfile;
        sessionId?: string;
        json?: boolean;
      },
    ) => {
      const projectRoot = await getProjectRoot();
      const runtime = await createRuntime(projectRoot);
      const sessionId = options.sessionId ?? resolveCodexSessionIdFromEnv();
      const resolvedTaskId =
        taskId ??
        (
          await runtime.resolveActiveTask({
            preferRegistryActive: true,
            codexSessionId: sessionId,
          })
        )?.taskId;

      if (!resolvedTaskId) {
        throw new Error('Cannot save checkpoint because no active task is resolved.');
      }

      const input: SaveContextCheckpointInput = {
        summary: options.summary,
        currentState: options.currentState,
        requirements: options.requirement,
        plan: options.plan,
        userFacingBehavior: options.behavior,
        completedWork: options.completedWork,
        implementationDetails: options.implementationDetail,
        implementationMap: options.implementationMap,
        decisions: options.decision,
        designConstraints: options.constraint,
        superseded: options.superseded,
        files: options.file,
        verification: options.verification,
        validationGaps: options.validationGap,
        risks: options.risk,
        nextSteps: options.nextStep,
        notes: options.note,
        lastCheckpointHead: options.head ?? null,
        checkpointKind: options.kind,
        appendChangelog: options.appendChangelog,
        phaseLabel: options.phaseLabel ?? null,
        qualityProfile: options.profile,
      };
      const result = await runtime.saveContextCheckpoint(resolvedTaskId, input);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Checkpoint saved for ${result.taskId}`);
      console.log(`Context: ${result.contextPath}`);
      console.log(`State: ${result.statePath}`);
      if (result.changelogAppended) {
        console.log(`Changelog: ${result.changelogPath ?? 'appended'}`);
      }
      for (const warning of result.warnings) {
        console.log(`Warning: ${warning}`);
      }
    },
  );

export default taskCheckpointCommand;
