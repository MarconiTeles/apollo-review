-- Supabase schema for the Apollo review tool.
-- Mirrors src/contract/model.ts. Run in the Supabase SQL editor (or via the
-- Supabase CLI as a migration). Media itself is NOT stored here in V1 — only
-- review results. The asset lives as a ClickUp attachment.

-- ── Enums ────────────────────────────────────────────────────────────────
do $$ begin
  create type media_kind   as enum ('video', 'image', 'document', 'audio');
exception when duplicate_object then null; end $$;

do $$ begin
  create type review_status as enum ('in_review', 'changes_requested', 'approved');
exception when duplicate_object then null; end $$;

-- ── review_sessions ──────────────────────────────────────────────────────
create table if not exists review_sessions (
  id                     uuid primary key default gen_random_uuid(),
  clickup_task_id        text        not null,
  clickup_list_id        text,
  clickup_attachment_id  text        not null,
  uploader_clickup_id    bigint,                       -- who to notify
  created_by_clickup_id  bigint      not null,
  status                 review_status not null default 'in_review',
  current_version_id     uuid,                         -- FK added after versions table
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- one review session per attachment (resume instead of duplicating)
  unique (clickup_attachment_id)
);

create index if not exists idx_sessions_task on review_sessions (clickup_task_id);
create index if not exists idx_sessions_uploader on review_sessions (uploader_clickup_id);

-- ── review_versions ──────────────────────────────────────────────────────
create table if not exists review_versions (
  id                     uuid primary key default gen_random_uuid(),
  review_id              uuid not null references review_sessions (id) on delete cascade,
  label                  text not null,                -- "V1", "V2", ...
  media_url              text not null,                -- ClickUp attachment URL in V1
  media_title            text not null,
  media_kind             media_kind not null,
  fps                    real,                         -- video only
  duration_ms            integer,
  width                  integer,
  height                 integer,
  page_count             integer,                      -- document only
  created_by_clickup_id  bigint not null,
  created_at             timestamptz not null default now()
);

create index if not exists idx_versions_review on review_versions (review_id);

-- now wire the session's current_version_id FK
do $$ begin
  alter table review_sessions
    add constraint fk_sessions_current_version
    foreign key (current_version_id) references review_versions (id) on delete set null;
exception when duplicate_object then null; end $$;

-- ── review_comments ──────────────────────────────────────────────────────
create table if not exists review_comments (
  id                  uuid primary key default gen_random_uuid(),
  review_id           uuid not null references review_sessions (id) on delete cascade,
  version_id          uuid not null references review_versions (id) on delete cascade,
  author_clickup_id   bigint not null,
  author_name         text   not null,
  body                text   not null default '',
  anchor              jsonb  not null,                 -- Anchor (discriminated by .kind)
  parent_id           uuid references review_comments (id) on delete cascade,
  resolved            boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_comments_review  on review_comments (review_id);
create index if not exists idx_comments_version on review_comments (version_id);
create index if not exists idx_comments_parent  on review_comments (parent_id);

-- ── review_annotations ───────────────────────────────────────────────────
-- Vector markup tied to a comment. Coords normalized [0..1]. See model.ts.
create table if not exists review_annotations (
  id           uuid primary key default gen_random_uuid(),
  comment_id   uuid not null references review_comments (id) on delete cascade,
  color        text not null default '#C7321B',
  stroke_width real not null default 0.004,
  geom         jsonb not null,                         -- AnnotationGeom (by .shape)
  created_at   timestamptz not null default now()
);

create index if not exists idx_annotations_comment on review_annotations (comment_id);

-- ── updated_at touch trigger ─────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

do $$ begin
  create trigger trg_sessions_touch before update on review_sessions
    for each row execute function touch_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger trg_comments_touch before update on review_comments
    for each row execute function touch_updated_at();
exception when duplicate_object then null; end $$;

-- ── Realtime ─────────────────────────────────────────────────────────────
-- Apollo subscribes to changes so the condensed panel + notification update
-- live. Add the result tables to the realtime publication.
do $$ begin
  alter publication supabase_realtime add table review_sessions;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table review_comments;
exception when duplicate_object then null; end $$;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- TODO(auth): identity is ClickUp's, not Supabase Auth. Until we bridge it
-- (e.g. signed JWT carrying the ClickUp user id, or an edge function), keep
-- RLS DISABLED and gate writes behind the app. Do NOT ship to external
-- clients before policies exist.
alter table review_sessions    disable row level security;
alter table review_versions    disable row level security;
alter table review_comments    disable row level security;
alter table review_annotations disable row level security;
