-- Migration: add librefm, musicat, statsfm to linked_accounts source CHECK constraint
-- Run this in the Supabase SQL Editor for your project.

alter table linked_accounts drop constraint if exists linked_accounts_source_check;

alter table linked_accounts
  add constraint linked_accounts_source_check
  check (source in ('lastfm', 'listenbrainz', 'librefm', 'musicat', 'statsfm'));
