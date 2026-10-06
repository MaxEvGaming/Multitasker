-- Square numbers close up (T-514 / T-515 = A, Owner 2026-10-06: 『514：A』『515：A』).
--
-- Deleting a square, or filing it under another page, used to leave a hole in
-- the numbers of the page it left. A square with no title shows its number
-- ("Square 3"), so the hole showed as a missing number. The server now closes
-- the hole as it happens (`closeGaps` in src/board.js); this closes the holes
-- that are already there, once, on every page of every board.
--
-- The order on each page stays as it is; only the numbers change, to 0, 1, 2…
-- without a gap.
--
-- Positions are unique per page (`tasks_page_slot`), so the renumbering cannot
-- write straight over itself. Every square that has to move steps out to a
-- negative number first — a place no real square occupies — and then to where
-- it belongs. Squares already in the right place are not written at all, so a
-- second run changes nothing.

with ranked as (
  select id,
         slot,
         row_number() over (partition by page_id order by slot, id) - 1 as pos
    from tasks
)
update tasks t
   set slot = -1 - r.pos
  from ranked r
 where t.id = r.id
   and t.slot <> r.pos;

update tasks
   set slot = -1 - slot
 where slot < 0;
