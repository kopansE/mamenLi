-- ===========================================================================
-- A garment is worn by somebody, and that is a separate fact from the garment.
--
-- `garment` says what the thing is - a gown or a suit - and it has quietly
-- been carrying a second answer along with it: who it is cut for. That guess
-- is wrong often enough to matter. A woman wears a suit to her own wedding; a
-- man wears a long coat. The cut and the garment are two different facts, so
-- they get two columns.
--
-- The front end is why this cannot stay implied. Until a photograph is
-- uploaded the spots are drawn on a silhouette, and there is a different
-- silhouette placeholder for each combination of the two.
-- ===========================================================================

-- ------------------------------------------------------------ the column
-- It arrives nullable so the back-fill below can tell a row that predates the
-- question from one that has answered it. The default and the NOT NULL follow
-- once every row holds a value.
alter table listings add column if not exists wears text;

-- Everything created before this migration was described by its garment alone,
-- so read the answer off that: the suits were men's, the gowns were women's.
-- A second run matches nothing, which is the point - a publisher who has since
-- said "a suit, worn by a woman" keeps their answer.
update listings
   set wears = case when garment = 'suit' then 'male' else 'female' end
 where wears is null;

alter table listings alter column wears set default 'female';
alter table listings alter column wears set not null;

-- Postgres has no `add constraint if not exists`, so add it and forgive the
-- second run, the way this schema already adds a table to the realtime
-- publication twice.
do $$
begin
  alter table listings add constraint listings_wears_check check (wears in ('female','male'));
exception when duplicate_object then null; end $$;

comment on column listings.wears is
  'Who the garment is cut for. Separate from `garment` because a woman can wear a suit and a man can wear a long coat, and the page draws a silhouette from both.';
