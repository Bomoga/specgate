import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  ROLES,
  atLeast,
  can,
  capabilitiesOf,
  isRole,
  roleFor,
  type Membership,
  type Role,
} from './roles.ts';

describe('the role table', () => {
  it('grants every role the ability to read runs', () => {
    // The product is a report. A role that cannot read one has no reason to exist.
    for (const role of ROLES) {
      expect(capabilitiesOf(role)).toContain('run:read');
    }
  });

  it('gives a viewer nothing but reading', () => {
    expect(capabilitiesOf('viewer')).toStrictEqual(['run:read']);
  });

  it('reserves organization:write to the owner', () => {
    // Transfer and deletion are irreversible, so this is the one capability that does not
    // widen as roles do.
    for (const role of ROLES) {
      expect(capabilitiesOf(role).includes('organization:write')).toBe(role === 'owner');
    }
  });

  it('never grants a capability that is not in the closed set', () => {
    // Guards the table against a typo becoming a silently ungranted permission.
    for (const role of ROLES) {
      for (const capability of capabilitiesOf(role)) {
        expect(CAPABILITIES).toContain(capability);
      }
    }
  });

  it('widens monotonically from viewer to owner', () => {
    // Not an inheritance mechanism, an assertion about the table somebody hand wrote. A
    // member holding something an admin does not is a mistake rather than a design.
    const ordered = [...ROLES].reverse();
    for (let i = 1; i < ordered.length; i += 1) {
      const narrower = capabilitiesOf(ordered[i - 1] as Role);
      const wider = capabilitiesOf(ordered[i] as Role);
      for (const capability of narrower) {
        expect(wider).toContain(capability);
      }
    }
  });
});

describe('per project overrides', () => {
  const membership: Membership = {
    organizationRole: 'admin',
    projectOverrides: { 'PRJ-sensitive': 'viewer', 'PRJ-owned': 'owner' },
  };

  it('takes the organization role for a project with no override', () => {
    expect(roleFor(membership, 'PRJ-ordinary')).toBe('admin');
    expect(can(membership, 'project:write', 'PRJ-ordinary')).toBe(true);
  });

  it('demotes inside a project, which is the case overrides exist for', () => {
    // An override replaces rather than adds. A reviewer is likely to assume it is a floor,
    // and if it were, excluding an admin from one sensitive project could not be expressed.
    expect(roleFor(membership, 'PRJ-sensitive')).toBe('viewer');
    expect(can(membership, 'project:write', 'PRJ-sensitive')).toBe(false);
    expect(can(membership, 'waiver:write', 'PRJ-sensitive')).toBe(false);
    expect(can(membership, 'run:read', 'PRJ-sensitive')).toBe(true);
  });

  it('promotes inside a project too', () => {
    expect(can(membership, 'organization:write', 'PRJ-owned')).toBe(true);
  });

  it('ignores overrides when asked organization wide', () => {
    // "What may this person do in the organization" is a different question from "in this
    // project", and an override must not leak into the first.
    expect(roleFor(membership)).toBe('admin');
    expect(can(membership, 'organization:write')).toBe(false);
  });

  it('works for a membership carrying no overrides at all', () => {
    const plain: Membership = { organizationRole: 'member' };
    expect(roleFor(plain, 'PRJ-anything')).toBe('member');
    expect(can(plain, 'waiver:write', 'PRJ-anything')).toBe(true);
    expect(can(plain, 'member:write', 'PRJ-anything')).toBe(false);
  });
});

describe('narrowing and comparison', () => {
  it('accepts the four roles and rejects everything else', () => {
    // Roles arrive from outside as strings, so this is a boundary narrowing per rule R2.
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const value of ['admin ', 'Owner', 'root', '', null, undefined, 7, {}]) {
      expect(isRole(value)).toBe(false);
    }
  });

  it('orders roles from owner down', () => {
    expect(atLeast('owner', 'admin')).toBe(true);
    expect(atLeast('admin', 'admin')).toBe(true);
    expect(atLeast('member', 'admin')).toBe(false);
    expect(atLeast('viewer', 'member')).toBe(false);
  });
});
