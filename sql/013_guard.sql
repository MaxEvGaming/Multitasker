-- A sign-in from a device the account has not seen can cut every PC off
-- (T-073, Owner 2026-09-14), and the board's own emergency stop does the
-- same (T-077). Both leave the PC waiting for someone at that PC to press
-- 「再接続」 — nothing on the board brings it back.

-- Whether this PC asked for the cut. Set from the PC program only
-- (POST /agent/<token>/guard); the board's session cannot change it (T-075).
alter table agents add column if not exists guard boolean not null default false;

-- Set on every PC of the account when the cut happens; cleared by the PC
-- program alone (POST /agent/<token>/resume). While it is set the PC is not
-- handed instructions and its stream is refused with 403 `suspended`.
alter table agents add column if not exists suspended_at timestamptz;

-- The mark a browser is given at sign-in, so the next sign-in from it is from
-- a device the account knows. One random value per account, made on the first
-- sign-in after this migration; the browser keeps it in the `known_device`
-- cookie for a year, and signing out does not take it away.
alter table users add column if not exists device_secret text;
