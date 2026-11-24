-- 007_approval_identity.sql (SQLite)
--
-- Named approver identity and 2-of-N consensus for held approvals (#954).
--
--   decidedBy       the approver name (from APPROVER_TOKENS) or "admin" when
--                   decided with the single ADMIN_API_TOKEN credential.
--   approval_votes  one row per distinct approver who has voted "approve" on
--                   a pending_approval, for amounts above
--                   APPROVAL_MULTI_APPROVER_THRESHOLD. The approval only
--                   executes once APPROVAL_MIN_APPROVERS distinct rows exist
--                   for it; the PRIMARY KEY stops the same approver voting twice.

ALTER TABLE pending_approvals ADD COLUMN decidedBy TEXT;

CREATE TABLE IF NOT EXISTS approval_votes (
  approvalId TEXT    NOT NULL,
  approver   TEXT    NOT NULL,
  decidedAt  INTEGER NOT NULL,
  PRIMARY KEY (approvalId, approver)
);
