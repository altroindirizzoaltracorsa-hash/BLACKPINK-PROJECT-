-- Adds streams gained/lost (from kworb's own "Streams+" column, which the
-- fetch script previously discarded) and support for distinguishing a true
-- chart debut (NEW) from a track that dropped off and came back (RE-ENTRY).
-- Run this once in the Supabase SQL editor after the earlier migrations.

alter table public.chart_positions add column if not exists streams_change bigint;
