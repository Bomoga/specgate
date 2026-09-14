-- GitHub repository to project mapping, for the OIDC path.
--
-- A runner inside GitHub Actions presents a token GitHub signed rather than a secret this
-- service issued, so there is no long lived credential in a repository setting to leak. What
-- this table answers is the only question that remains: which project is that repository
-- allowed to submit to.
--
-- Tenant scoped like everything else, and for a reason worth stating. A routing table keyed
-- by repository looks like infrastructure rather than customer data, which is the argument
-- for leaving it unprotected. It is customer data: it records which organization owns which
-- repository, and an unscoped read of it is a list of every customer and what they build.

CREATE TABLE github_repositories (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations (id),
  project_id       text NOT NULL REFERENCES projects (id),
  -- `owner/repo`, exactly as GitHub's `repository` claim spells it.
  repository       text NOT NULL,
  -- The installation this mapping came from. Whether one organization may span several is
  -- an open question in P3-identity.md, so this is recorded and not yet constrained.
  installation_id  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One repository maps to one project per organization. Deliberately not globally unique:
  -- constraining that would answer the open question above by accident.
  UNIQUE (organization_id, repository)
);

ALTER TABLE github_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY github_repositories_tenant ON github_repositories
  USING (organization_id = current_setting('specgate.organization_id'))
  WITH CHECK (organization_id = current_setting('specgate.organization_id'));

-- The grants in 0001 applied to the tables that existed then. A new table needs its own, and
-- forgetting this is caught by the tenancy test rather than at a later 2am.
GRANT SELECT, INSERT, UPDATE, DELETE ON github_repositories TO specgate_app;
