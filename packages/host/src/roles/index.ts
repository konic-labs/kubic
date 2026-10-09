// Roles: the built-in presets, layered role documents and their resolution,
// role prompts, permission classes and model scopes.
export type {
  ResolvedRole,
  RoleLayerInput,
  RoleLayerSpec,
} from './resolver.js';
export {
  effectiveRoleClasses,
  roleModelAllowed,
  roleModelEntry,
} from './resolver.js';
export type { SelectedRole } from './roles-boot.js';
export { rolePromptFor, rolesDoctorProbe, selectRole } from './roles-boot.js';
