-- A second automatic destination, for the opposite direction. `auto_to` is where
-- a square goes when the session stops; `start_to` is where it goes when the
-- person sends the session an instruction.
alter table states add column if not exists start_to bigint references states(id) on delete set null;

-- 'start' joins the causes. It is deliberately not one of the causes that
-- notifies: the person who triggered it was typing at the time.
alter table moves drop constraint if exists moves_cause_check;
alter table moves add constraint moves_cause_check
  check (cause in ('manual', 'signal', 'timeout', 'start'));

-- Existing boards get nothing here on purpose.
--
-- The first version of this migration filled `start_to` in by looking for the
-- state that runs a countdown, on the reasoning that work goes wherever the
-- clock is. That was wrong: whether a state runs a countdown is the user's
-- choice and nobody else's business, and inferring one setting from another
-- makes the design quietly demand an arrangement it has no business demanding.
-- A board with no countdown anywhere is a perfectly good board.
--
-- So existing states keep a null arrow until their owner draws one. New
-- accounts still start with arrows already drawn, which is a starting point
-- rather than a requirement — every one of them is editable on the settings
-- screen.
