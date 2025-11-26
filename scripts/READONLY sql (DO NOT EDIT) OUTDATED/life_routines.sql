create table public.life_routines (
  id text not null,
  user_id uuid not null,
  title text not null,
  blurb text not null,
  surface_style text not null,
  sort_index integer not null default 0,
  created_at timestamp with time zone not null default timezone ('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone ('utc'::text, now()),
  constraint life_routines_pkey primary key (id),
  constraint life_routines_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE,
  constraint life_routines_surface_style_check check (
    (
      surface_style = any (
        array[
          'midnight'::text,
          'grove'::text,
          'slate'::text,
          'ember'::text,
          'glass'::text,
          'linen'::text,
          'charcoal'::text,
          'cool-blue'::text,
          'soft-magenta'::text,
          'muted-lavender'::text,
          'neutral-grey-blue'::text,
          'fresh-teal'::text,
          'deep-indigo'::text,
          'warm-amber'::text,
          'sunset-orange'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists life_routines_user_sort_idx on public.life_routines using btree (user_id, sort_index) TABLESPACE pg_default;

create trigger life_routines_set_timestamp BEFORE INSERT
or
update on life_routines for EACH row
execute FUNCTION life_routines_set_timestamp ();