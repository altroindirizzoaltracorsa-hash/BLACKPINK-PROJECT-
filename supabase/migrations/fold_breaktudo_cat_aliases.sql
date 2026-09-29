-- Fold BreakTudo's alias category slugs onto one canonical key per category.
--
-- THE BUG, as reported from the live board: a blink's row showed Int. Music Video
-- twice — once as "Int. Music Video" and once as "Clipe Internacional Do Ano" —
-- with the votes split between them. They are one category. BreakTudo serves it
-- under more than one slug spelling, /api/vma-votes stored whatever slug the vote
-- arrived under, and the page drew one chip per stored key, title-casing the slug
-- when it didn't recognise it.
--
-- CANONICAL is the spelling the site actually serves: 'clipe-internacional-do-ano'.
-- The counter's own evidence agrees — probe-breaktudo.yml run 36260347844 walked 91
-- slugs across every edition and found 'clipe-*' throughout, never a 'videoclipe-*'
-- URL. An earlier build "corrected" clipe- to videoclipe- as a typo; that was
-- backwards, and this is where the two spellings meet.
--
-- The same shape applies to Int. Series, which has the alias pair
-- serie-internacional-do-ano / serie-internacional. It had not split in practice,
-- but it is the identical latent bug so it is folded here too.
--
-- SAFETY. This only ever MERGES keys within a row's own `cats` map:
--   * `votes` is never touched — it is the authoritative total and the thing the
--     board ranks by, so no position and no count can move.
--   * sum(cats) per row is preserved exactly (the assertion below proves it row by
--     row, not in aggregate, so two errors cannot cancel out).
--   * rows with no alias key are left byte-identical.
-- The invariant sum(cats) <= votes therefore still holds wherever it held before.
--
-- Run once. Safe to re-run: after the first pass no alias keys remain, so the
-- update matches nothing.

-- ── 1. what we are about to change ──────────────────────────────────────────
do $$
declare
  n_rows int;
  n_both int;
begin
  select count(*) into n_rows
  from breaktudo_user_votes
  where cats ?| array['videoclipe-internacional-do-ano', 'videoclipe-internacional',
                      'clipe-internacional', 'serie-internacional-do-ano'];

  -- rows carrying BOTH spellings of the same category: these are the ones the
  -- board was drawing twice.
  select count(*) into n_both
  from breaktudo_user_votes
  where (cats ? 'clipe-internacional-do-ano')
    and (cats ?| array['videoclipe-internacional-do-ano', 'videoclipe-internacional', 'clipe-internacional']);

  raise notice 'rows with an alias key: %, of which % carry both spellings of Int. Music Video', n_rows, n_both;
end $$;

-- Snapshot every row's attributed sum BEFORE touching anything, so section 3 can
-- prove preservation per row instead of asserting it in prose. Temp table: it
-- lives for this session only and needs no cleanup.
create temp table _bt_fold_before as
select app_user_id,
       day,
       coalesce((select sum((e.value)::numeric) from jsonb_each(cats) e), 0) as s
from breaktudo_user_votes;

-- ── 2. the fold ─────────────────────────────────────────────────────────────
with alias(from_key, to_key) as (
  values ('videoclipe-internacional-do-ano', 'clipe-internacional-do-ano'),
         ('videoclipe-internacional',        'clipe-internacional-do-ano'),
         ('clipe-internacional',             'clipe-internacional-do-ano'),
         ('serie-internacional-do-ano',      'serie-internacional')
),
-- Every (row, canonical key) pair with its summed value, aliases resolved.
folded as (
  select b.app_user_id,
         b.day,
         coalesce(a.to_key, e.key)      as k,
         sum((e.value)::numeric)        as v
  from breaktudo_user_votes b
  cross join lateral jsonb_each(b.cats) e
  left join alias a on a.from_key = e.key
  where b.cats ?| array['videoclipe-internacional-do-ano', 'videoclipe-internacional',
                        'clipe-internacional', 'serie-internacional-do-ano']
  group by b.app_user_id, b.day, coalesce(a.to_key, e.key)
),
rebuilt as (
  select app_user_id, day, jsonb_object_agg(k, v) as cats
  from folded
  group by app_user_id, day
)
update breaktudo_user_votes b
   set cats = r.cats
  from rebuilt r
 where b.app_user_id = r.app_user_id
   and b.day = r.day
   and b.cats is distinct from r.cats;

-- ── 3. prove it ─────────────────────────────────────────────────────────────
-- Checked per row rather than as a grand total: a grand total can be right while
-- individual rows are wrong in opposite directions.
do $$
declare
  n_alias_left int;
  n_bad_sum    int;
  n_over_total int;
  n_moved      int;
begin
  select count(*) into n_alias_left
  from breaktudo_user_votes
  where cats ?| array['videoclipe-internacional-do-ano', 'videoclipe-internacional',
                      'clipe-internacional', 'serie-internacional-do-ano'];
  if n_alias_left <> 0 then
    raise exception 'still % row(s) carrying an alias category key', n_alias_left;
  end if;

  -- The point of the whole migration: no row's attributed sum may have moved.
  select count(*) into n_moved
  from breaktudo_user_votes b
  join _bt_fold_before f on f.app_user_id = b.app_user_id and f.day = b.day
  where coalesce((select sum((e.value)::numeric) from jsonb_each(b.cats) e), 0) is distinct from f.s;
  if n_moved <> 0 then
    raise exception '% row(s) changed their attributed sum — the fold lost or invented votes', n_moved;
  end if;

  -- No row may now attribute more than its own authoritative total.
  select count(*) into n_over_total
  from breaktudo_user_votes b
  where (select coalesce(sum((e.value)::numeric), 0) from jsonb_each(b.cats) e) > b.votes;
  if n_over_total <> 0 then
    raise exception '% row(s) have sum(cats) > votes after folding', n_over_total;
  end if;

  -- And the shape constraint still holds everywhere.
  select count(*) into n_bad_sum
  from breaktudo_user_votes where not breaktudo_cats_valid(cats);
  if n_bad_sum <> 0 then
    raise exception '% row(s) failed breaktudo_cats_valid after folding', n_bad_sum;
  end if;

  raise notice 'fold complete: no alias keys left, every row''s attributed sum unchanged, every row still within its total.';
end $$;
