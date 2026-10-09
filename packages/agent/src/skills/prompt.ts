// The skills block of the system prompt, and expanding a /skill invocation.
import type { LoadedSkill } from './types.js';

// Quotes escape too —
// a description carrying `"` or `'` must not break the block.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Pi-compatible prompt injection (agentskills.io shape): one <skill> block
// per model-visible skill. disableModelInvocation skills are never
// injected — they run only via explicit invokeSkill.
export function formatSkillsForSystemPrompt(skills: LoadedSkill[]): string {
  const blocks = skills
    .filter((skill) => skill.disableModelInvocation !== true)
    .map(
      (skill) =>
        `<skill>\n<name>${escapeXml(skill.name)}</name>\n` +
        `<description>${escapeXml(skill.description)}</description>\n` +
        `<filePath>${escapeXml(skill.filePath)}</filePath>\n</skill>`,
    );
  return `<skills>\n${blocks.join('\n')}\n</skills>`;
}

// Explicit call surface: the only way to run a disableModelInvocation
// skill. Unknown names throw — explicit calls are deliberate, never
// mid-task resolution (see resolveTaskSkillRefs).
export function invokeSkill(skills: LoadedSkill[], name: string): string {
  const hit = skills.find((skill) => skill.name === name);
  if (hit === undefined) throw new Error(`unknown skill '${name}'`);
  return hit.content;
}

// Explicit invocation expansion: a hidden skill runs
// by giving the model its content, with the operator's instructions
// appended — the turn prompt carries both, so the skill is reachable
// without ever entering the system prompt. Withheld skills are not in the
// input set (the caller passes the gated-visible skills), so invoking one
// reports the same unknown-skill refusal — existence never leaks.
export function expandSkillInvocation(
  skills: LoadedSkill[],
  name: string,
  instructions?: string,
): string {
  const content = invokeSkill(skills, name);
  const extra = instructions?.trim() ?? '';
  return extra === '' ? content : `${content}\n\n${extra}`;
}
