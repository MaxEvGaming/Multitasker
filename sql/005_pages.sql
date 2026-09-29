-- Squares now live on pages, and a page holds as many as its owner wants.
--
-- Two limits go: nine squares, and one board per person. Both were arbitrary —
-- nine was the shape of the first sketch, not a property of the problem.

create table if not exists pages (
  id         bigserial   primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  name       text        not null,
  sort_order int         not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists pages_user on pages(user_id, sort_order, id);

alter table tasks add column if not exists page_id bigint references pages(id) on delete cascade;

-- Everyone who already has squares gets a page to keep them on, so nothing has
-- to be rebuilt by hand.
insert into pages (user_id, name, sort_order)
select distinct t.user_id, 'ページ 1', 0
  from tasks t
 where t.page_id is null
   and not exists (select 1 from pages p where p.user_id = t.user_id);

update tasks t
   set page_id = (select p.id from pages p
                   where p.user_id = t.user_id
                order by p.sort_order, p.id limit 1)
 where t.page_id is null;

-- The slot number is a position on a page now, not a position in a person's
-- single board, and it is no longer capped.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
     where conrelid = 'tasks'::regclass
       and contype in ('u', 'c')
       and pg_get_constraintdef(oid) ~ 'slot'
  loop
    execute format('alter table tasks drop constraint %I', constraint_name);
  end loop;
end $$;

alter table tasks alter column page_id set not null;
create unique index if not exists tasks_page_slot on tasks(page_id, slot);
create index if not exists tasks_page on tasks(page_id, slot);
