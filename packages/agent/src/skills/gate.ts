// Gating skills by role and by the tools the grant allows.
import { toolsForClasses } from '../permissions.js';
import type {
  GateContext,
  GatedSkills,
  LoadedSkill,
  WithheldSkill,
} from './types.js';

export function gateSkills(
  skills: LoadedSkill[],
  context: GateContext,
): GatedSkills {
  const allowed = new Set(toolsForClasses(context.classes));
  const visible: LoadedSkill[] = [];
  const withheld: WithheldSkill[] = [];
  for (const skill of skills) {
    // No role on the lane means no role scoping — the skill
    // is judged on capability alone.
    if (
      context.role !== undefined &&
      skill.roles !== undefined &&
      !skill.roles.includes(context.role)
    ) {
      const reason = `not visible to role '${context.role}'`;
      withheld.push({ name: skill.name, reason });
      context.log?.(`skill '${skill.name}' withheld: ${reason}`);
      continue;
    }
    const denied = skill.requiredTools?.find((tool) => !allowed.has(tool));
    if (denied !== undefined) {
      const reason = `needs tool '${denied}' denied by capability grant`;
      withheld.push({ name: skill.name, reason });
      context.log?.(`skill '${skill.name}' withheld: ${reason}`);
      continue;
    }
    visible.push(skill);
  }
  return { visible, withheld };
}
