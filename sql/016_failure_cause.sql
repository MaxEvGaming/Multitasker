-- A stop that ended on an error (T-513 = A, Owner 2026-10-06: 『513A』).
--
-- The PC says "event": "failure" in the clear when Claude Code's turn ended on
-- an API error — a usage limit, an overloaded server. The square goes where any
-- stop goes (`auto_to`); the move is recorded as 'failure' rather than
-- 'signal' so the phone can say "Claude stopped on an error". The board learns
-- that much and nothing more: not which error, not which session.
--
-- Additive only: every cause already allowed stays allowed.
alter table moves drop constraint if exists moves_cause_check;
alter table moves add constraint moves_cause_check
  check (cause in ('manual', 'signal', 'timeout', 'start', 'command', 'done', 'failed', 'expired', 'failure'));
