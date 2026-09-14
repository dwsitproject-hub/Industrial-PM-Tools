-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('MANAGER', 'ADMIN', 'SITE_ADMIN', 'ESTIMATOR');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('NEW', 'IN_PROGRESS_ESTIMATION', 'IN_PROGRESS_TENDER', 'DONE', 'HOLD');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('URGENT', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "work_type" AS ENUM ('PROJECT_TENDER', 'OPS_TENDER', 'SITE_INSTRUCTION', 'BUDGETING_INTERNAL');

-- CreateEnum
CREATE TYPE "request_source" AS ENUM ('WHATSAPP', 'EMAIL', 'VERBAL');

-- CreateEnum
CREATE TYPE "kpi_entry_type" AS ENUM ('OPENING', 'AUTO', 'MANUAL', 'REVERSAL');

-- CreateEnum
CREATE TYPE "tender_status" AS ENUM ('SUBMITTED', 'WON', 'LOST', 'CANCELLED');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company" TEXT NOT NULL,
    "subtitle" TEXT,
    "ticket_prefix" TEXT NOT NULL DEFAULT 'EST',
    "ticket_seq" BIGINT NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" INTEGER NOT NULL DEFAULT 3,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "site_id" UUID,
    "avatar_color" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "legacy_ticket_no" TEXT,
    "name" TEXT NOT NULL,
    "type" "work_type" NOT NULL,
    "priority" "ticket_priority" NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'NEW',
    "requestor" TEXT,
    "source" "request_source",
    "description" TEXT,
    "deadline" DATE NOT NULL,
    "assignee_id" UUID,
    "site_id" UUID,
    "submitted_by_id" UUID,
    "tender_status" "tender_status",
    "tender_value" DECIMAL(18,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "author_id" UUID,
    "author_label" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status_at_time" "ticket_status" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_settings" (
    "workspace_id" UUID NOT NULL,
    "point_opening" INTEGER NOT NULL DEFAULT 10,
    "point_on_target" INTEGER NOT NULL DEFAULT 3,
    "point_miss_target" INTEGER NOT NULL DEFAULT -2,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "kpi_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "type" "kpi_entry_type" NOT NULL,
    "description" TEXT,
    "ticket_id" UUID,
    "ticket_no" TEXT,
    "created_by_id" UUID,
    "created_by" TEXT NOT NULL DEFAULT 'System',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sites_workspace_id_name_key" ON "sites"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "users_workspace_id_username_key" ON "users"("workspace_id", "username");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_status_idx" ON "tickets"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_assignee_id_idx" ON "tickets"("workspace_id", "assignee_id");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_site_id_idx" ON "tickets"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_deadline_idx" ON "tickets"("workspace_id", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_workspace_id_ticket_no_key" ON "tickets"("workspace_id", "ticket_no");

-- CreateIndex
CREATE INDEX "ticket_notes_ticket_id_created_at_idx" ON "ticket_notes"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "kpi_entries_workspace_id_year_month_idx" ON "kpi_entries"("workspace_id", "year", "month");

-- CreateIndex
CREATE INDEX "kpi_entries_user_id_year_idx" ON "kpi_entries"("user_id", "year");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens"("token_hash");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_settings" ADD CONSTRAINT "kpi_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_entries" ADD CONSTRAINT "kpi_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_entries" ADD CONSTRAINT "kpi_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_entries" ADD CONSTRAINT "kpi_entries_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_entries" ADD CONSTRAINT "kpi_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== EngPro custom engine-level guarantees (Tech Doc 4.1 / 4.3 / 3.3) =====
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pgcrypto for gen_random_uuid on older setups (pg16 has it built in; harmless)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- one AUTO award per ticket, enforced by the engine (closes DATA-4)
CREATE UNIQUE INDEX "ux_kpi_auto_once" ON "kpi_entries" ("ticket_id") WHERE type = 'AUTO';

-- one OPENING allowance per member per month
CREATE UNIQUE INDEX "ux_kpi_opening" ON "kpi_entries" ("user_id", "year", "month") WHERE type = 'OPENING';

-- data-quality CHECKs
ALTER TABLE "tickets" ADD CONSTRAINT "ck_ticket_name_len"
  CHECK (char_length(name) BETWEEN 3 AND 200);
ALTER TABLE "tickets" ADD CONSTRAINT "ck_ticket_desc_len"
  CHECK (description IS NULL OR char_length(description) <= 5000);
ALTER TABLE "tickets" ADD CONSTRAINT "ck_tender_value_pos"
  CHECK (tender_value IS NULL OR tender_value >= 0);
ALTER TABLE "tickets" ADD CONSTRAINT "ck_tender_status_type"
  CHECK (tender_status IS NULL OR type IN ('PROJECT_TENDER','OPS_TENDER'));
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ck_note_len"
  CHECK (char_length(content) BETWEEN 1 AND 2000);
ALTER TABLE "kpi_entries" ADD CONSTRAINT "ck_kpi_month" CHECK (month BETWEEN 1 AND 12);
ALTER TABLE "kpi_entries" ADD CONSTRAINT "ck_kpi_year" CHECK (year BETWEEN 2020 AND 2100);
ALTER TABLE "users" ADD CONSTRAINT "ck_siteadmin_site"
  CHECK (role <> 'SITE_ADMIN' OR site_id IS NOT NULL);

-- trigram search over ticket names (GAP-1)
CREATE INDEX "ix_tickets_name_trgm" ON "tickets" USING gin (name gin_trgm_ops);
