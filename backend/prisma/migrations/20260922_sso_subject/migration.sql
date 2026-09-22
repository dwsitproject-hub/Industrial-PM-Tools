-- Link local accounts to their DWS Hub identity (OIDC `sub`, stable per user).
ALTER TABLE "users" ADD COLUMN "sso_subject" TEXT;
CREATE UNIQUE INDEX "users_sso_subject_key" ON "users"("sso_subject");
