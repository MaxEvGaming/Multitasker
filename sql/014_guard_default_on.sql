-- The guard is on unless a PC switches it off (T-082, Owner 2026-09-14:
-- 『デフォルトで ON にして』). 013 made the column with `default false` and
-- is applied in production, so the default is changed here rather than
-- there; and every PC already registered is switched on too — nobody has
-- chosen otherwise yet, and there is no backward compatibility to keep
-- (T-078). The PC program's own copy of the switch (agent/src/Settings.cs)
-- starts as true from 0.3.1 for the same reason.
alter table agents alter column guard set default true;
update agents set guard = true;
