-- Tenancy, with row level security from the first migration.
--
-- Invariant I9: a tenant boundary is enforced by the database, not only by the application.
-- A product whose premise is that generated code silently omits authorization checks cannot
-- have its own isolation depend on the application layer being perfect.
--
-- Two details here decide whether the isolation is real, and both are easy to get wrong in a
-- way that makes the tenancy test pass for the wrong reason:
--
--   1. FORCE ROW LEVEL SECURITY. Plain ENABLE does not apply to the table owner, and in both
--      the compose service and the CI service container the application user owns these
--      tables. Without FORCE every policy below is inert and every query returns everything,
--      while a test that only ever connects as the owner reports success.
--
--   2. current_setting without the missing_ok argument. The two argument form returns NULL
--      when the variable is unset, which would make the predicate NULL and quietly return
--      zero rows. Zero rows is a safe answer but it is not the one the module asks for: a
--      query with no tenant context must error rather than look like an empty organization.

CREATE TABLE organizations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations (id),
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations (id),
  project_id       text NOT NULL REFERENCES projects (id),
  name             text NOT NULL,
  -- An environment holds one target, per the vocabulary.
  base_url         text,
  -- The disposability gate, carried across the plane boundary rather than re-decided.
  disposable       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runners (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations (id),
  project_id       text NOT NULL REFERENCES projects (id),
  name             text NOT NULL,
  -- A hash, never a token. No credential value is stored anywhere, under any framing.
  token_hash       text NOT NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations (id),
  -- "activity log", never "audit log". The forbidden term has no carve out, and a
  -- forbidden term with one exception stops being enforceable.
  action           text NOT NULL,
  subject          text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The session variable every policy reads. `withTenant` sets it and is the only way to
-- obtain a transaction, because an unscoped accessor that exists is one that gets used at
-- 2am.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant ON organizations
  USING (id = current_setting('specgate.organization_id'))
  WITH CHECK (id = current_setting('specgate.organization_id'));

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON projects
  USING (organization_id = current_setting('specgate.organization_id'))
  WITH CHECK (organization_id = current_setting('specgate.organization_id'));

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments FORCE ROW LEVEL SECURITY;
CREATE POLICY environments_tenant ON environments
  USING (organization_id = current_setting('specgate.organization_id'))
  WITH CHECK (organization_id = current_setting('specgate.organization_id'));

ALTER TABLE runners ENABLE ROW LEVEL SECURITY;
ALTER TABLE runners FORCE ROW LEVEL SECURITY;
CREATE POLICY runners_tenant ON runners
  USING (organization_id = current_setting('specgate.organization_id'))
  WITH CHECK (organization_id = current_setting('specgate.organization_id'));

ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_tenant ON activity
  USING (organization_id = current_setting('specgate.organization_id'))
  WITH CHECK (organization_id = current_setting('specgate.organization_id'));
