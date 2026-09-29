-- Several PCs on one account, each switched on or off on its own, and a square
-- that can name which one it runs on.
--
-- Until now `POST /api/agent/register` deleted the account's row before adding
-- the new one, so registering a second PC quietly unregistered the first. The
-- table already held `token` as its key and `user_id` as an ordinary column, so
-- more than one row has always fitted; only the registering had to stop
-- deleting. What is added here is the three things that could not be said
-- before: which row this is, whether it is switched on, and which row a square
-- is for.

-- A number for the PC that the browser is allowed to see. The token cannot be
-- it: the token is the whole of the secret, it is shown once at registration
-- and never again, and a square that named a PC by its token would put every
-- token on the settings screen.
alter table agents add column if not exists id bigserial;
create unique index if not exists agents_id on agents(id);

-- Switched off means the board does not send to it. It is not unregistered and
-- its stream is not closed — it stays connected and is passed over, and comes
-- back into use the moment it is switched on again.
alter table agents add column if not exists enabled boolean not null default true;

-- Which PC this square's instruction goes to. Null is every PC that is switched
-- on, which is what every square made before today means and what a new one
-- means until someone chooses otherwise.
--
-- Not a foreign key on purpose. A square goes on naming a PC that has been
-- unregistered, and pressing it then fails the way it fails when nobody comes
-- for the instruction. Cascading the reference away would turn that square into
-- one that sends to every PC instead — quietly, and on the day the PC was
-- removed rather than on the day anyone asked for it.
alter table tasks add column if not exists agent_id bigint;

-- Where this instruction was aimed when it was sent, so that a PC connecting
-- afterwards is handed the ones that were meant for it and no others. Taken
-- from the square at the moment of the press: what the square is set to
-- half a minute later is a different question from where this one was going.
alter table jobs add column if not exists agent_id bigint;
