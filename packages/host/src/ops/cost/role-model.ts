// (1) per-role model selection hook (issue #56; §62 lever 1).
// Explicit selection beats the role default beats the catalog default.
// Selection is explicit + logged: the returned log line names the role,
// the origin, and the model — there is no hidden router. Consumes the
// per-role config (§63) and role defaults read-only via the caller-supplied
// table; this module never touches the resolver or model-select.
// Pure: no I/O, no network, faux-only.

export interface RoleModelRef {
  provider: string;
  id: string;
}

export type RoleModelTable = Record<string, RoleModelRef>;

export interface RoleModelSelection extends RoleModelRef {
  role: string;
  origin: 'explicit' | 'role-default' | 'catalog-default';
  log: string;
}

export class RoleModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleModelError';
  }
}

export function selectRoleModel(
  role: string,
  input: {
    roleTable: RoleModelTable;
    explicit?: RoleModelRef;
    catalogDefault?: RoleModelRef;
  },
): RoleModelSelection {
  if (input.explicit !== undefined) {
    return {
      role,
      provider: input.explicit.provider,
      id: input.explicit.id,
      origin: 'explicit',
      log: `role ${role}: explicit selection ${input.explicit.provider}/${input.explicit.id}`,
    };
  }
  const roleDefault = input.roleTable[role];
  if (roleDefault !== undefined) {
    return {
      role,
      provider: roleDefault.provider,
      id: roleDefault.id,
      origin: 'role-default',
      log: `role ${role}: role default ${roleDefault.provider}/${roleDefault.id}`,
    };
  }
  if (input.catalogDefault !== undefined) {
    return {
      role,
      provider: input.catalogDefault.provider,
      id: input.catalogDefault.id,
      origin: 'catalog-default',
      log: `role ${role}: catalog default ${input.catalogDefault.provider}/${input.catalogDefault.id}`,
    };
  }
  throw new RoleModelError(
    `unknown role '${role}': no role default and no catalog default — refusing to hidden-route`,
  );
}
