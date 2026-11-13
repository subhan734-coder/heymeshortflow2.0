-- YouTube Shorts Automation - Supabase Schema
-- Run this entire script in the Supabase SQL Editor.
-- This creates all tables required by the Vercel Functions backend.
-- Single-owner application: no Supabase Auth users are created.

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. SETTINGS (encrypted integration credentials)
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key text primary key,
  value_encrypted text,
  value_plain text,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 2. VIDEOS (persistent source of truth)
-- ---------------------------------------------------------------------------
create table if not exists videos (
  id uuid default gen_random_uuid() primary key,
  filename text not null,
  storage_path text,
  size bigint,
  title text,
  description text,
  hashtags text[],
  category text,
  tags text[],
  status text default 'pending', -- pending, pending_approval, awaiting_schedule, scheduled, uploading, published, failed, cancelled
  scheduled_at timestamptz,
  youtube_id text,
  youtube_url text,
  published_at timestamptz,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_videos_status on videos(status);
create index if not exists idx_videos_scheduled_at on videos(scheduled_at);
create index if not exists idx_videos_created_at on videos(created_at desc);

-- ---------------------------------------------------------------------------
-- 3. PROCESSING JOBS (persistent job queue for 24/7 automation)
-- ---------------------------------------------------------------------------
create table if not exists processing_jobs (
  id uuid default gen_random_uuid() primary key,
  video_id uuid references videos(id) on delete cascade,
  job_type text, -- download, metadata, youtube_upload
  status text default 'queued', -- queued, processing, done, failed, scheduled
  progress int default 0,
  retry_count int default 0,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_jobs_video_id on processing_jobs(video_id);
create index if not exists idx_jobs_status on processing_jobs(status);

-- ---------------------------------------------------------------------------
-- 4. SESSIONS (owner access-key sessions)
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id text primary key,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- 5. RATE LIMITS (failed-attempt protection for access key)
-- ---------------------------------------------------------------------------
create table if not exists rate_limits (
  identifier text primary key,
  failures int default 0,
  blocked_until timestamptz,
  window_start timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 6. ACTIVITY LOGS (audit trail)
-- ---------------------------------------------------------------------------
create table if not exists activity_logs (
  id uuid default gen_random_uuid() primary key,
  level text default 'info',
  component text,
  message text,
  created_at timestamptz default now()
);

create index if not exists idx_activity_created_at on activity_logs(created_at desc);
create index if not exists idx_activity_component on activity_logs(component);

-- ---------------------------------------------------------------------------
-- 7. ERROR LOGS (persistent error logs for recovery)
-- ---------------------------------------------------------------------------
create table if not exists error_logs (
  id uuid default gen_random_uuid() primary key,
  component text,
  message text,
  meta jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_error_created_at on error_logs(created_at desc);

-- ---------------------------------------------------------------------------
-- 8. TELEGRAM UPDATES (webhook persistence / idempotency)
-- ---------------------------------------------------------------------------
create table if not exists telegram_updates (
  update_id bigint primary key,
  payload jsonb,
  received_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 9. OAUTH STATES (YouTube OAuth state validation / PKCE)
-- ---------------------------------------------------------------------------
create table if not exists oauth_states (
  state text primary key,
  code_verifier text,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 10. USER STATES (Telegram multi-step conversation state)
-- ---------------------------------------------------------------------------
create table if not exists user_states (
  chat_id text primary key,
  state_json text,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 11. YOUTUBE CHANNELS (connected channel + encrypted tokens)
-- ---------------------------------------------------------------------------
create table if not exists youtube_channels (
  id text primary key,
  title text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expiry timestamptz,
  connected_at timestamptz,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 12. STORAGE BUCKETS (Supabase Storage)
-- ---------------------------------------------------------------------------
-- Create buckets if the storage schema is accessible.
-- If these fail due to permissions, create them manually in the Supabase
-- Dashboard under Storage: original-videos, processed-videos, thumbnails, application-assets
do $$
begin
  insert into storage.buckets (id, name, public) values ('original-videos', 'original-videos', false)
  on conflict (id) do nothing;
  insert into storage.buckets (id, name, public) values ('processed-videos', 'processed-videos', false)
  on conflict (id) do nothing;
  insert into storage.buckets (id, name, public) values ('thumbnails', 'thumbnails', false)
  on conflict (id) do nothing;
  insert into storage.buckets (id, name, public) values ('application-assets', 'application-assets', false)
  on conflict (id) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS)
-- All backend calls use the Supabase Service Role Key, which bypasses RLS.
-- The frontend never calls Supabase directly. RLS is therefore not required,
-- but we leave tables open for the service role. No public/anon access is
-- exposed through these tables from the browser.
-- ---------------------------------------------------------------------------
alter table videos disable row level security;
alter table processing_jobs disable row level security;
alter table settings disable row level security;
alter table sessions disable row level security;
alter table rate_limits disable row level security;
alter table activity_logs disable row level security;
alter table error_logs disable row level security;
alter table telegram_updates disable row level security;
alter table oauth_states disable row level security;
alter table user_states disable row level security;
alter table youtube_channels disable row level security;

-- ---------------------------------------------------------------------------
-- Completion message
-- ---------------------------------------------------------------------------
select 'Supabase schema ready. Now configure Vercel env vars and Telegram webhook.' as status;
