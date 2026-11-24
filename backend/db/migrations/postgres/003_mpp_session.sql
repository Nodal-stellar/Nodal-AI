-- 003_mpp_session.sql (PostgreSQL)
--
-- MPP Session: streaming micropayments via channel-backed off-chain commits.
-- Persists channel state, balances, and the latest signed commitment for
-- dispute resolution and recovery after restart.

CREATE TABLE IF NOT EXISTS mpp_sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  participant TEXT NOT NULL,
  asset TEXT NOT NULL,
  total_amount TEXT NOT NULL,
  agent_balance TEXT NOT NULL,
  participant_balance TEXT NOT NULL,
  nonce INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Active', 'Closed', 'Disputed')),
  opened_at TIMESTAMP WITH TIME ZONE NOT NULL,
  timeout_at TIMESTAMP WITH TIME ZONE NOT NULL,
  closed_at TIMESTAMP WITH TIME ZONE,
  latest_commitment TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mpp_sessions_agent ON mpp_sessions(agent);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_status ON mpp_sessions(status);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_timeout ON mpp_sessions(timeout_at);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_participant ON mpp_sessions(participant);
