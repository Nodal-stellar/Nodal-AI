-- 007_approval_identity.sql (Postgres)
--
-- Named approver identity and 2-of-N consensus for held approvals (#954); see
-- the SQLite migration of the same number.

ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS "decidedBy" TEXT;

CREATE TABLE IF NOT EXISTS approval_votes (
  "approvalId" TEXT   NOT NULL,
  approver      TEXT   NOT NULL,
  "decidedAt"   BIGINT NOT NULL,
  PRIMARY KEY ("approvalId", approver)
);
