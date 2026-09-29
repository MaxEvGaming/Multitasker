-- Squares that reach out of the board and press something on a PC.
--
-- Until now a square only ever recorded what a session was doing. This lets a
-- square carry an instruction — run a command, open a file, press a hotkey,
-- switch an OBS scene — that a small program on the PC picks up and carries
-- out. The board itself never learns what the instruction says: it is sealed
-- in the browser under the same key as the square's name, and only the PC,
-- which holds that key, can open it.

-- The PC that collects instructions. One row per account: the token is the
-- whole of the secret, exactly like the webhook's, and lives in the address the
-- PC connects to. Kept apart from the webhook token on purpose — the hook can
-- only write a report in, the agent can only read instructions out, and one
-- leaking must not hand over the other.
create table if not exists agents (
  token      text        primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  name       text        not null default '',
  created_at timestamptz not null default now(),
  last_seen  timestamptz
);
create index if not exists agents_user on agents(user_id);

-- One instruction, from the tap that made it to the PC's answer.
--
--   pending  sealed and waiting for the PC to collect it
--   taken    the PC has it and is carrying it out
--   done     the PC says it worked
--   failed   the PC says it did not, or took longer than a minute to say
--   expired  no PC came for it within five seconds, so it was thrown away
--
-- `sealed` is ciphertext the browser made; the server stores it and passes it
-- on and never has the key. The id is reserved a moment before the text is
-- sealed, because the text has to carry its own id (so the PC can tell a
-- replayed instruction from a fresh one), and that means the row has to exist
-- first. `created_at` is set again when the sealed text arrives: that is the
-- moment the five seconds start from.
create table if not exists jobs (
  id          bigserial   primary key,
  user_id     bigint      not null references users(id) on delete cascade,
  task_id     bigint      references tasks(id) on delete set null,
  sealed      text        not null default '',
  created_at  timestamptz not null default now(),
  status      text        not null default 'pending'
                          check (status in ('pending', 'taken', 'done', 'failed', 'expired')),
  taken_at    timestamptz,            -- when the PC acknowledged it; the minute runs from here
  result_ok   boolean,
  finished_at timestamptz
);
create index if not exists jobs_user_status on jobs(user_id, status);
create index if not exists jobs_task on jobs(task_id);

-- What a square does when it is pressed, and where it goes while doing it.
--
-- `command_sealed` holds {kind, args} sealed in the browser; null means the
-- square is an ordinary one and its taps follow the arrows as before. The
-- three state columns are where the square moves while the PC is working, when
-- it reports success, and when it reports failure (or nothing came for the
-- instruction). Null falls back to the board's own starting shape: the first
-- state's instruction arrow (処理中), that state's stop arrow (待機中), and the
-- first state's right-tap arrow (停止中). The settings screen fills the pickers
-- in from those same three so what is saved is what was shown.
alter table tasks add column if not exists command_sealed text;
alter table tasks add column if not exists run_state_id  bigint references states(id) on delete set null;
alter table tasks add column if not exists ok_state_id   bigint references states(id) on delete set null;
alter table tasks add column if not exists fail_state_id bigint references states(id) on delete set null;

-- Four more reasons a square can move. 'command' is the tap that sent the
-- instruction — the person's own doing, so it never rings. The other three are
-- the board hearing back, or not hearing back, which it did not do itself.
alter table moves drop constraint if exists moves_cause_check;
alter table moves add constraint moves_cause_check
  check (cause in ('manual', 'signal', 'timeout', 'start', 'command', 'done', 'failed', 'expired'));
