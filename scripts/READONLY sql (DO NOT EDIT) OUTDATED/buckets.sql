create table public.buckets (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  goal_id uuid not null,
  name text not null,
  favorite boolean not null default false,
  sort_index integer not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  buckets_card_style text null default 'glass'::text,
  bucket_archive boolean null default false,
  constraint buckets_pkey primary key (id),
  constraint buckets_goal_id_fkey foreign KEY (goal_id) references goals (id) on delete CASCADE,
  constraint buckets_user_goal_fk foreign KEY (user_id, goal_id) references goals (user_id, id) on delete CASCADE,
  constraint buckets_card_style_check check (
    (
      (buckets_card_style is null)
      or (
        buckets_card_style = any (
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
  )
) TABLESPACE pg_default;

create index IF not exists buckets_user_goal_sort_idx on public.buckets using btree (user_id, goal_id, sort_index) TABLESPACE pg_default;

create unique INDEX IF not exists buckets_user_id_id_uidx on public.buckets using btree (user_id, id) TABLESPACE pg_default;

create trigger buckets_set_user_id BEFORE INSERT on buckets for EACH row
execute FUNCTION set_user_id ();

create trigger buckets_updated_at BEFORE
update on buckets for EACH row
execute FUNCTION set_updated_at ();