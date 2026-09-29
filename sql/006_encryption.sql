-- End-to-end encryption. The point of every column here is that the server can
-- hold it without being able to read anything.
--
-- The shape is the usual one for this: a random master key that never leaves the
-- browser, kept twice over in wrapped form —
--   once under a key derived from the password, so signing in unwraps it
--   once under a recovery key shown to the person exactly once
-- Changing a password re-wraps the master key; it does not change it, so nothing
-- has to be re-encrypted. Losing both the password and the recovery key means
-- the data is gone, and nobody — including whoever runs the server — can undo
-- that. That is the trade, and it is the whole point.

alter table users add column if not exists kdf_salt        text;
alter table users add column if not exists wrapped_by_password text;
alter table users add column if not exists wrapped_by_recovery text;
-- Lets the page tell "this account predates encryption" from "this account has
-- keys but you have not unlocked them yet".
alter table users add column if not exists encryption_version int not null default 0;

-- Ciphertext columns sit alongside the plaintext ones during the changeover, so
-- an account that has not been through it still works and nothing is destroyed
-- on the way. The plaintext columns go once every account has moved.
alter table tasks  add column if not exists title_cipher text;
alter table tasks  add column if not exists name_cipher  text;   -- the session name, for display
alter table tasks  add column if not exists match_hash   text;   -- keyed hash of the session name
alter table pages  add column if not exists name_cipher  text;
alter table states add column if not exists name_cipher  text;

create index if not exists tasks_match_hash on tasks(user_id, match_hash);

-- The names the board has been told about, once it can no longer read them: a
-- keyed hash to compare with, and the name itself sealed for the owner's eyes.
alter table seen_names add column if not exists match_hash  text;
alter table seen_names add column if not exists name_cipher text;
create index if not exists seen_names_hash on seen_names(user_id, match_hash);
