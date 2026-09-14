/**
 * Product authorization: who may do what inside an organization.
 *
 * **This is not the thing the product checks.** An access rule in a spec describes what the
 * customer's application should permit, and an actor is a configured identity used to
 * interact with a target. Neither word appears here. A person with a login is a `member`,
 * and what they may do is a `Capability`. The module file asks for this separation by name,
 * because a reviewer meeting "actor" in both senses will conflate them, and the two have
 * nothing to do with each other.
 *
 * **A closed set, deliberately.** Four roles and a small capability table, resolved by
 * lookup. No policy engine, no rule evaluation, no inheritance graph. The module says to
 * resist a general engine until a customer needs one, and the reason is that a policy engine
 * is indistinguishable from a correct table right up until it is the thing with the bug in
 * it.
 */

/** The four roles. Ordered most privileged first, which `atLeast` relies on. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

/**
 * What a role may do.
 *
 * Named for the plan's vocabulary rather than for HTTP verbs, so the table reads as the
 * product's own sentences: an organization holds projects, a project holds environments, an
 * environment holds one target, a submission delivers a run, and a waiver accepts a finding.
 */
export const CAPABILITIES = [
  /** Read runs, findings, and the delta. Every role has this. */
  'run:read',
  /** Register a runner and exchange its token. Runners themselves hold this, not people. */
  'runner:register',
  /** Revoke a runner credential. */
  'runner:revoke',
  /** Create, rename, or archive a project or environment. */
  'project:write',
  /** Accept a finding for a scoped, expiring period. Never a spec edit. */
  'waiver:write',
  /** Invite, remove, or change the role of a member. */
  'member:write',
  /** Transfer or delete the organization. Owner only, and irreversible. */
  'organization:write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The table. Every role's capabilities are listed in full rather than derived from the role
 * above it, because an inherited table is one where nobody can answer "what can a member do"
 * without running the code.
 */
const GRANTS: Readonly<Record<Role, readonly Capability[]>> = {
  owner: [
    'run:read',
    'runner:register',
    'runner:revoke',
    'project:write',
    'waiver:write',
    'member:write',
    'organization:write',
  ],
  admin: [
    'run:read',
    'runner:register',
    'runner:revoke',
    'project:write',
    'waiver:write',
    'member:write',
  ],
  member: ['run:read', 'runner:register', 'waiver:write'],
  viewer: ['run:read'],
};

/**
 * A person's role in an organization, with any per project overrides.
 *
 * The override is the whole reason this is not a single field. A contractor who administers
 * one project and cannot see the others is the case the hierarchy exists for, and modelling
 * it as a second membership row per project would make "what is this person's role" a query
 * rather than a value.
 */
export interface Membership {
  readonly organizationRole: Role;
  /** Project id to role. A project absent here takes the organization role. */
  readonly projectOverrides?: Readonly<Record<string, Role>>;
}

/** The role this membership carries for a given project, or organization wide without one. */
export function roleFor(membership: Membership, projectId?: string): Role {
  if (projectId === undefined) return membership.organizationRole;
  return membership.projectOverrides?.[projectId] ?? membership.organizationRole;
}

/**
 * Whether a membership may do something, in a project or organization wide.
 *
 * **An override replaces the organization role rather than adding to it.** A viewer override
 * on a project genuinely demotes an organization admin there, which is what makes the
 * override useful for excluding somebody from one sensitive project. Treating it as a floor
 * would make that impossible to express and is the reading a reviewer is likely to assume.
 */
export function can(membership: Membership, capability: Capability, projectId?: string): boolean {
  return GRANTS[roleFor(membership, projectId)].includes(capability);
}

/** Whether a role is at least as privileged as another. `ROLES` is ordered for this. */
export function atLeast(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) <= ROLES.indexOf(minimum);
}

/** Every capability a role holds, for a surface that renders what somebody may do. */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return GRANTS[role];
}

/** Narrows a value that arrived from outside. Roles cross the boundary as strings. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
