import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  AGENT_GUIDE_RECIPES_MAX_BYTES,
  AGENT_GUIDE_RECIPES_RELATIVE_PATH,
  AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES,
  AGENT_GUIDE_SKILL_MAX_BYTES,
  AGENT_GUIDE_SKILL_RELATIVE_PATH,
  renderAgentGuideRecipes,
  renderAgentGuideSkill,
  renderAgentGuideSkillFiles,
} from '../../src/v2/templates/agent-guide.js';
import { renderAgentsRootDoc, renderClaudeRootDoc } from '../../src/v2/templates/root-docs.js';

function size(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function managedBlock(value: string): string {
  const start = '<!-- llm-docs:start -->';
  const end = '<!-- llm-docs:end -->';
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex + end.length);
}

function parseFrontmatter(value: string): Record<string, unknown> {
  const match = value.match(/^---\n([\s\S]*?)\n---/);
  expect(match).not.toBeNull();
  return YAML.parse(match?.[1] ?? '') as Record<string, unknown>;
}

describe('llm-docs agent guide pack templates', () => {
  it('renders one compact skill and one recipes reference', () => {
    const files = renderAgentGuideSkillFiles();

    expect(Object.keys(files).sort()).toEqual([
      AGENT_GUIDE_SKILL_RELATIVE_PATH,
      AGENT_GUIDE_RECIPES_RELATIVE_PATH,
    ]);
    expect(files[AGENT_GUIDE_SKILL_RELATIVE_PATH]).toBe(renderAgentGuideSkill());
    expect(files[AGENT_GUIDE_RECIPES_RELATIVE_PATH]).toBe(renderAgentGuideRecipes());
  });

  it('keeps the skill compact and focused on workflow selection', () => {
    const skill = renderAgentGuideSkill();
    const frontmatter = parseFrontmatter(skill);

    expect(skill.startsWith('---\nname: llm-docs\n')).toBe(true);
    expect(frontmatter.name).toBe('llm-docs');
    expect(frontmatter.description).toContain('llm-docs workflows: task bundle');
    expect(skill).toContain('таск бандл');
    expect(skill).toContain('worktree/ворктри');
    expect(skill).toContain('checkpoint');
    expect(skill).toContain('actualize/актуализируй');
    expect(skill).toContain('Commands-only');
    expect(skill).toContain('Execute workflow');
    expect(skill).toContain('Do not run `llm-docs doctor` before every operation.');
    expect(skill).toContain('Use `--help` only when exact flags are uncertain.');
    expect(skill).not.toContain('allowed-tools');
    expect(skill).not.toContain('llm-docs agent route');
    expect(skill).not.toContain('suggest_workflow');
    expect(size(skill)).toBeLessThanOrEqual(AGENT_GUIDE_SKILL_MAX_BYTES);
  });

  it('keeps recipes bounded and avoids runtime-router concepts', () => {
    const recipes = renderAgentGuideRecipes();

    expect(recipes).toContain('Commands-only requests');
    expect(recipes).toContain('llm-docs task from-jira PROJ-324 --attachments');
    expect(recipes).toContain('llm-docs worktree create PROJ-356 --hosts claude,codex');
    expect(recipes).toContain('llm-docs task quality PROJ-356');
    expect(recipes).toContain('llm-docs doctor');
    expect(recipes).not.toContain('llm-docs agent route');
    expect(recipes).not.toContain('llmdocs.suggest_workflow');
    expect(size(recipes)).toBeLessThanOrEqual(AGENT_GUIDE_RECIPES_MAX_BYTES);
  });

  it('keeps root router blocks thin', () => {
    const agentsBlock = managedBlock(renderAgentsRootDoc());
    const claudeBlock = managedBlock(renderClaudeRootDoc());

    expect(agentsBlock).toContain('use the `llm-docs` skill before guessing commands');
    expect(claudeBlock).toContain('use the `llm-docs` skill before guessing commands');
    expect(agentsBlock).not.toContain('references/recipes.md');
    expect(claudeBlock).not.toContain('references/recipes.md');
    expect(size(agentsBlock)).toBeLessThanOrEqual(AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES);
    expect(size(claudeBlock)).toBeLessThanOrEqual(AGENT_GUIDE_ROOT_ROUTER_MAX_BYTES);
  });
});
