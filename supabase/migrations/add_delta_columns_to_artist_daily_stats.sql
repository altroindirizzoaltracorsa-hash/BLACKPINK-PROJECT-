-- Adds per-day delta columns for followers, monthly listeners, and world rank.
-- Run this once in the Supabase SQL editor after artist_streams_schema.sql.

alter table public.artist_daily_stats add column if not exists followers_delta         bigint;
alter table public.artist_daily_stats add column if not exists monthly_listeners_delta bigint;
alter table public.artist_daily_stats add column if not exists world_rank_delta        int;
