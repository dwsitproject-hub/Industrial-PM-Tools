-- Configurable role permissions (Settings -> Roles)
CREATE TYPE "ticket_scope" AS ENUM ('ALL', 'OWN');

CREATE TABLE "role_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "role" "user_role" NOT NULL,
    "ticket_scope" "ticket_scope" NOT NULL DEFAULT 'ALL',
    "permissions" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_configs_workspace_id_role_key" ON "role_configs"("workspace_id", "role");

ALTER TABLE "role_configs" ADD CONSTRAINT "role_configs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
