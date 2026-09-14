-- Actor credential references, and the health signal for one that cannot be resolved.
--
-- "Actor" here is the engine's meaning and the only one: a configured identity used to
-- interact with a target. A person who logs in to the control plane is a principal and is
-- not this.
--
-- **This table holds references and never values.** An actor record names where a credential
-- lives, an environment variable, a Vault path, a secrets manager ARN, and the runner
-- resolves it locally inside the customer boundary. The control plane never sees the value,
-- which is invariant I8 applied to the one kind of data most tempting to make an exception
-- for.

CREATE TABLE environment_actors (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations (id),
  environment_id   text NOT NULL REFERENCES environments (id),
  -- The actor id as the spec and config spell it, for example `owner` or `outsider`.
  actor_id         text NOT NULL,
  -- 'env', 'vault', or 'aws-secret'. Constrained in the application rather than by an enum
  -- type, so adding a broker is a migration that adds a row shape and not one that rewrites
  -- a type every table depends on.
  ref_kind         text NOT NULL,
  -- The reference itself. A variable name, a path, an ARN. Never a secret.
  ref              text NOT NULL,

  -- The health signal. Written from what a run reported, not guessed at here: an actor the
  -- runner could not resolve silently reduces coverage, and the capability report is the
  -- only place that surfaces today.
  last_resolved_at timestamptz,
  last_failure     text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment_id, actor_id)
);

ALTER TABLE environment_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_actors FORCE ROW LEVEL SECURITY;
CREATE POLICY environment_actors_tenant ON environment_actors
  USING (organization_id = current_setting('specgate.organization_id'))
  WITH CHECK (organization_id = current_setting('specgate.organization_id'));

GRANT SELECT, INSERT, UPDATE, DELETE ON environment_actors TO specgate_app;
