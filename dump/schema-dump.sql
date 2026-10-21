--
-- PostgreSQL database dump
--

\restrict hwTSbs3cNSCLIlcLAVxkAcSETHROQf3v9Tgn1dVDPAbrp2bbhAxl6kvzNOmyCZ2

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: beta_testers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beta_testers (
    id bigint NOT NULL,
    lfm_username text NOT NULL,
    twitter_handle text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: beta_testers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.beta_testers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: beta_testers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.beta_testers_id_seq OWNED BY public.beta_testers.id;


--
-- Name: chat_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_claims (
    username text NOT NULL,
    secret text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    username text NOT NULL,
    avatar text,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: global_stream_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_stream_snapshots (
    date date NOT NULL,
    jump_total bigint NOT NULL,
    shutdown_total bigint NOT NULL,
    ddududu_total bigint NOT NULL,
    jump_daily bigint,
    shutdown_daily bigint,
    ddududu_daily bigint,
    fetched_at timestamp with time zone DEFAULT now()
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id text NOT NULL,
    username text NOT NULL,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: stream_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    date date NOT NULL,
    jump integer DEFAULT 0,
    shutdown integer DEFAULT 0,
    ddududu integer DEFAULT 0,
    total integer GENERATED ALWAYS AS (((jump + shutdown) + ddududu)) STORED,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: leaderboard_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leaderboard_archive (
    id bigint NOT NULL,
    period text NOT NULL,
    period_key text NOT NULL,
    label text NOT NULL,
    users jsonb NOT NULL,
    archived_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: leaderboard_archive_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.leaderboard_archive ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.leaderboard_archive_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: spotify_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spotify_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    spotify_user_id text NOT NULL,
    display_name text,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_cursor bigint DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_stamps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_stamps (
    id bigint NOT NULL,
    lfm_username text NOT NULL,
    day_key text NOT NULL,
    stamps jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_stamps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_stamps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_stamps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_stamps_id_seq OWNED BY public.user_stamps.id;


--
-- Name: beta_testers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta_testers ALTER COLUMN id SET DEFAULT nextval('public.beta_testers_id_seq'::regclass);


--
-- Name: user_stamps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_stamps ALTER COLUMN id SET DEFAULT nextval('public.user_stamps_id_seq'::regclass);


--
-- Name: beta_testers beta_testers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta_testers
    ADD CONSTRAINT beta_testers_pkey PRIMARY KEY (id);


--
-- Name: chat_claims chat_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_claims
    ADD CONSTRAINT chat_claims_pkey PRIMARY KEY (username);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: global_stream_snapshots global_stream_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_stream_snapshots
    ADD CONSTRAINT global_stream_snapshots_pkey PRIMARY KEY (date);


--
-- Name: leaderboard_archive leaderboard_archive_period_period_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leaderboard_archive
    ADD CONSTRAINT leaderboard_archive_period_period_key_key UNIQUE (period, period_key);


--
-- Name: leaderboard_archive leaderboard_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leaderboard_archive
    ADD CONSTRAINT leaderboard_archive_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_username_key UNIQUE (username);


--
-- Name: spotify_accounts spotify_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spotify_accounts
    ADD CONSTRAINT spotify_accounts_pkey PRIMARY KEY (id);


--
-- Name: spotify_accounts spotify_accounts_user_id_spotify_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spotify_accounts
    ADD CONSTRAINT spotify_accounts_user_id_spotify_user_id_key UNIQUE (user_id, spotify_user_id);


--
-- Name: stream_counts stream_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_counts
    ADD CONSTRAINT stream_counts_pkey PRIMARY KEY (id);


--
-- Name: stream_counts stream_counts_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_counts
    ADD CONSTRAINT stream_counts_user_id_date_key UNIQUE (user_id, date);


--
-- Name: user_stamps user_stamps_lfm_username_day_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_stamps
    ADD CONSTRAINT user_stamps_lfm_username_day_key_key UNIQUE (lfm_username, day_key);


--
-- Name: user_stamps user_stamps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_stamps
    ADD CONSTRAINT user_stamps_pkey PRIMARY KEY (id);


--
-- Name: beta_testers_lfm_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX beta_testers_lfm_lower ON public.beta_testers USING btree (lower(lfm_username));


--
-- Name: spotify_accounts spotify_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spotify_accounts
    ADD CONSTRAINT spotify_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: stream_counts stream_counts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_counts
    ADD CONSTRAINT stream_counts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: global_stream_snapshots Global stream snapshots are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global stream snapshots are publicly readable" ON public.global_stream_snapshots FOR SELECT USING (true);


--
-- Name: profiles Profiles are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Profiles are publicly readable" ON public.profiles FOR SELECT USING (true);


--
-- Name: stream_counts Stream counts are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Stream counts are publicly readable" ON public.stream_counts FOR SELECT USING (true);


--
-- Name: beta_testers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.beta_testers ENABLE ROW LEVEL SECURITY;

--
-- Name: global_stream_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.global_stream_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: spotify_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spotify_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: stream_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stream_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: user_stamps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_stamps ENABLE ROW LEVEL SECURITY;

--
-- Name: TABLE beta_testers; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.beta_testers TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.beta_testers TO authenticated;
GRANT ALL ON TABLE public.beta_testers TO service_role;


--
-- Name: SEQUENCE beta_testers_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.beta_testers_id_seq TO service_role;


--
-- Name: TABLE chat_claims; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.chat_claims TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.chat_claims TO authenticated;
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE public.chat_claims TO service_role;


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.chat_messages TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.chat_messages TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.chat_messages TO service_role;


--
-- Name: SEQUENCE chat_messages_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.chat_messages_id_seq TO service_role;


--
-- Name: TABLE global_stream_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.global_stream_snapshots TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.global_stream_snapshots TO authenticated;
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE public.global_stream_snapshots TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.profiles TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE stream_counts; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.stream_counts TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.stream_counts TO authenticated;
GRANT ALL ON TABLE public.stream_counts TO service_role;


--
-- Name: TABLE leaderboard_archive; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.leaderboard_archive TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.leaderboard_archive TO authenticated;
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE public.leaderboard_archive TO service_role;


--
-- Name: SEQUENCE leaderboard_archive_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.leaderboard_archive_id_seq TO service_role;


--
-- Name: TABLE spotify_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.spotify_accounts TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.spotify_accounts TO authenticated;
GRANT ALL ON TABLE public.spotify_accounts TO service_role;


--
-- Name: TABLE user_stamps; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.user_stamps TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.user_stamps TO authenticated;
GRANT ALL ON TABLE public.user_stamps TO service_role;


--
-- Name: SEQUENCE user_stamps_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.user_stamps_id_seq TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict hwTSbs3cNSCLIlcLAVxkAcSETHROQf3v9Tgn1dVDPAbrp2bbhAxl6kvzNOmyCZ2

