import { Command } from 'commander';
import { simpleGit } from 'simple-git';
import { getProjectRoot } from '../utils/fs.js';
import type {
  WorktreeSeedConflictPolicy,
  WorktreeSeedInput,
  WorktreeSeedReport,
} from '../v2/types.js';
import { applyWorktreeSeed, prepareWorktreeSeed } from '../v2/worktree/seed.js';

export interface WorktreeSeedCommandOptions {
  from?: string;
  profile?: string;
  conflict?: WorktreeSeedConflictPolicy;
  dryRun?: boolean;
  json?: boolean;
}

function assertConflictPolicy(value: string | undefined): WorktreeSeedConflictPolicy | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'fail' || value === 'candidate' || value === 'overwrite-managed') {
    return value;
  }

  throw new Error('Unsupported conflict policy. Expected fail, candidate, or overwrite-managed.');
}

async function resolveGitProjectRoot(startDir?: string): Promise<string> {
  const cwd = startDir ?? process.cwd();

  try {
    return (await simpleGit(cwd).raw(['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return getProjectRoot(startDir);
  }
}

function toInput(destinationRoot: string, options: WorktreeSeedCommandOptions): WorktreeSeedInput {
  if (!options.from) {
    throw new Error('Missing required --from <main-worktree-path> option.');
  }

  return {
    sourceRoot: options.from,
    destinationRoot,
    profile: options.profile,
    conflictPolicy: assertConflictPolicy(options.conflict),
    dryRun: options.dryRun,
  };
}

function formatSeedHuman(report: WorktreeSeedReport): void {
  console.log(`${report.dryRun ? 'Seed plan' : 'Seeded'} worktree context:`);
  console.log(`- Source: ${report.sourceRoot}`);
  console.log(`- Destination: ${report.destinationRoot}`);
  console.log(`- Profile: ${report.profile}`);
  console.log(`- Copied: ${report.summary.copied}`);
  console.log(`- Skipped: ${report.summary.skipped}`);
  console.log(`- Candidates: ${report.summary.candidates}`);
  console.log(`- Conflicts: ${report.summary.conflicts}`);

  const notable = report.files.filter(
    (file) => file.action === 'candidate' || file.action === 'conflict',
  );
  if (notable.length > 0) {
    console.log('Attention:');
    for (const file of notable) {
      const target = file.candidatePath ? ` -> ${file.candidatePath}` : '';
      console.log(`- ${file.action}: ${file.path}${target}`);
    }
  }
}

export async function runWorktreeSeed(
  options: WorktreeSeedCommandOptions,
  startDir?: string,
): Promise<WorktreeSeedReport> {
  const destinationRoot = await resolveGitProjectRoot(startDir);
  const input = toInput(destinationRoot, options);
  return options.dryRun ? prepareWorktreeSeed(input) : applyWorktreeSeed(input);
}

const worktreeSeedCommand = new Command('seed')
  .description('Copy curated llm-docs context from the main worktree into the current worktree')
  .requiredOption('--from <path>', 'main worktree to seed from')
  .option('--profile <profile>', 'seed profile from .claude/docs/seed.manifest.json', 'default')
  .option('--conflict <policy>', 'fail, candidate, or overwrite-managed', 'candidate')
  .option('--dry-run', 'build a seed plan without writing files')
  .option('--json', 'print seed plan/report as JSON')
  .action(async (options: WorktreeSeedCommandOptions) => {
    const report = await runWorktreeSeed(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      formatSeedHuman(report);
    }
  });

export default worktreeSeedCommand;
