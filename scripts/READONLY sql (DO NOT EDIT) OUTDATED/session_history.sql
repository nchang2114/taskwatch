create table public.session_history (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  task_name text not null,
  elapsed_ms integer null,
  started_at timestamp with time zone not null,
  ended_at timestamp with time zone not null,
  goal_name text null,
  bucket_name text null,
  goal_id text null,
  bucket_id text null,
  task_id text null,
  goal_surface text not null default 'glass'::text,
  bucket_surface text null,
  created_at timestamp with time zone not null default timezone ('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone ('utc'::text, now()),
  future_session boolean null default false,
  repeating_session_id uuid null,
  original_time timestamp with time zone null,
  notes text null default ''::text,
  subtasks jsonb null default '[]'::jsonb,
  constraint session_history_pkey primary key (id),
  constraint session_history_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE,
  constraint session_history_repeating_session_id_fkey foreign KEY (repeating_session_id) references repeating_sessions (id) on delete set null,
  constraint session_history_goal_surface_check check (
    (
      (goal_surface is null)
      or (
        goal_surface = any (
          array[
            'glass'::text,
            'midnight'::text,
            'slate'::text,
            'charcoal'::text,
            'linen'::text,
            'frost'::text,
            'grove'::text,
            'lagoon'::text,
            'ember'::text,
            'deep-indigo'::text,
            'warm-amber'::text,
            'fresh-teal'::text,
            'sunset-orange'::text,
            'cool-blue'::text,
            'soft-magenta'::text,
            'muted-lavender'::text,
            'neutral-grey-blue'::text,
            'leaf'::text,
            'sprout'::text,
            'fern'::text,
            'sage'::text,
            'meadow'::text,
            'willow'::text,
            'pine'::text,
            'basil'::text,
            'mint'::text,
            'coral'::text,
            'peach'::text,
            'apricot'::text,
            'salmon'::text,
            'tangerine'::text,
            'papaya'::text
          ]
        )
      )
    )
  ),
  constraint session_history_check check ((ended_at >= started_at)),
  constraint session_history_bucket_surface_check check (
    (
      (bucket_surface is null)
      or (
        bucket_surface = any (
          array[
            'glass'::text,
            'midnight'::text,
            'slate'::text,
            'charcoal'::text,
            'linen'::text,
            'frost'::text,
            'grove'::text,
            'lagoon'::text,
            'ember'::text,
            'deep-indigo'::text,
            'warm-amber'::text,
            'fresh-teal'::text,
            'sunset-orange'::text,
            'cool-blue'::text,
            'soft-magenta'::text,
            'muted-lavender'::text,
            'neutral-grey-blue'::text,
            'leaf'::text,
            'sprout'::text,
            'fern'::text,
            'sage'::text,
            'meadow'::text,
            'willow'::text,
            'pine'::text,
            'basil'::text,
            'mint'::text,
            'coral'::text,
            'peach'::text,
            'apricot'::text,
            'salmon'::text,
            'tangerine'::text,
            'papaya'::text
          ]
        )
      )
    )
  ),
  constraint session_history_subtasks_array_check check (
    (
      (subtasks is null)
      or (jsonb_typeof(subtasks) = 'array'::text)
    )
  ),
  constraint session_history_elapsed_ms_check check ((elapsed_ms >= 0))
) TABLESPACE pg_default;

create index IF not exists session_history_user_updated_idx on public.session_history using btree (user_id, updated_at desc) TABLESPACE pg_default;

create unique INDEX IF not exists session_history_user_id_id_key on public.session_history using btree (user_id, id) TABLESPACE pg_default;

create trigger session_history_set_timestamps BEFORE INSERT
or
update on session_history for EACH row
execute FUNCTION session_history_set_timestamps ();