-- Which language this board speaks to its owner. English is the default: this
-- is meant to be handed to other people, and English is the one they are most
-- likely to share with it.
--
-- Stored on the account rather than only on the device so that the choice made
-- on a laptop is already in place on the phone. It is not encrypted — knowing
-- that someone reads Japanese is not the same as being able to read their
-- tasks, and the server has to consult this to word a refusal.
alter table users add column if not exists lang text not null default 'en';
