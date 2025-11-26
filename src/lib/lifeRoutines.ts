import { supabase, ensureSingleUserSession } from './supabaseClient'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'

export type LifeRoutineConfig = {
  id: string
  bucketId: string
  title: string
  blurb: string
  surfaceStyle: SurfaceStyle
  surfaceColor?: string | null
  sortIndex: number
}

const SURFACE_GRADIENTS: Record<SurfaceStyle, string> = {
  glass: 'linear-gradient(135deg, #313c67 0%, #1f2952 45%, #121830 100%)',
  midnight: 'linear-gradient(135deg, #8e9bff 0%, #6c86ff 45%, #3f51b5 100%)',
  slate: 'linear-gradient(135deg, #97e3ff 0%, #5ec0ff 45%, #1f7adb 100%)',
  charcoal: 'linear-gradient(135deg, #ffb8d5 0%, #f472b6 45%, #be3a84 100%)',
  linen: 'linear-gradient(135deg, #ffd4aa 0%, #f9a84f 45%, #d97706 100%)',
  frost: 'linear-gradient(135deg, #aee9ff 0%, #6dd3ff 45%, #1d9bf0 100%)',
  grove: 'linear-gradient(135deg, #baf5d8 0%, #4ade80 45%, #15803d 100%)',
  lagoon: 'linear-gradient(135deg, #a7dcff 0%, #60a5fa 45%, #2563eb 100%)',
  ember: 'linear-gradient(135deg, #ffd5b5 0%, #fb923c 45%, #c2410c 100%)',
  'deep-indigo': 'linear-gradient(135deg, #b4b8ff 0%, #6a6ee8 45%, #2c2f7a 100%)',
  'warm-amber': 'linear-gradient(135deg, #ffe6b3 0%, #fbbf24 45%, #b45309 100%)',
  'fresh-teal': 'linear-gradient(135deg, #99f6e4 0%, #2dd4bf 45%, #0f766e 100%)',
  'sunset-orange': 'linear-gradient(135deg, #ffc6b3 0%, #fb8a72 45%, #e1532e 100%)',
  'cool-blue': 'linear-gradient(135deg, #cfe8ff 0%, #60a5fa 45%, #1e40af 100%)',
  'soft-magenta': 'linear-gradient(135deg, #ffd1f4 0%, #f472b6 45%, #a21caf 100%)',
  'muted-lavender': 'linear-gradient(135deg, #e9e1ff 0%, #c4b5fd 45%, #6d28d9 100%)',
  'neutral-grey-blue': 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 45%, #475569 100%)',
  leaf: 'linear-gradient(135deg, #a4eec4 0%, #4ade80 45%, #15803d 100%)',
  sprout: 'linear-gradient(135deg, #bdf7d3 0%, #22c55e 45%, #166534 100%)',
  fern: 'linear-gradient(135deg, #c8f7da 0%, #16a34a 45%, #14532d 100%)',
  sage: 'linear-gradient(135deg, #d6f4e0 0%, #84cc16 45%, #4d7c0f 100%)',
  meadow: 'linear-gradient(135deg, #e0f7d6 0%, #65a30d 45%, #3f6212 100%)',
  willow: 'linear-gradient(135deg, #e5f6e0 0%, #22c55e 45%, #15803d 100%)',
  pine: 'linear-gradient(135deg, #d9f5e6 0%, #15803d 45%, #0f3d23 100%)',
  basil: 'linear-gradient(135deg, #e3f8e7 0%, #16a34a 45%, #166534 100%)',
  mint: 'linear-gradient(135deg, #d5f7ef 0%, #22c55e 45%, #0f766e 100%)',
  coral: 'linear-gradient(135deg, #ffd6c9 0%, #fb8a72 45%, #e1532e 100%)',
  peach: 'linear-gradient(135deg, #ffe1c7 0%, #fbbf24 45%, #d97706 100%)',
  apricot: 'linear-gradient(135deg, #ffe5cf 0%, #f59e0b 45%, #b45309 100%)',
  salmon: 'linear-gradient(135deg, #ffd1c7 0%, #fb8a72 45%, #e1532e 100%)',
  tangerine: 'linear-gradient(135deg, #ffe0c2 0%, #f97316 45%, #c2410c 100%)',
  papaya: 'linear-gradient(135deg, #ffe7d0 0%, #fb923c 45%, #c2410c 100%)',
}

const gradientFromSurface = (surface: SurfaceStyle | null | undefined): string =>
  (surface && SURFACE_GRADIENTS[surface]) || 'linear-gradient(135deg, #FFF8BF 0%, #FFF8BF 100%)'

export const LIFE_ROUTINE_STORAGE_KEY = 'nc-taskwatch-life-routines-v1'
export const LIFE_ROUTINE_UPDATE_EVENT = 'nc-life-routines:updated'
export const LIFE_ROUTINE_USER_STORAGE_KEY = 'nc-taskwatch-life-routines-user'
export const LIFE_ROUTINE_GUEST_USER_ID = '__guest__'
export const LIFE_ROUTINE_USER_EVENT = 'nc-life-routines:user-updated'

const cloneRoutine = (routine: LifeRoutineConfig): LifeRoutineConfig => ({ ...routine })

const LIFE_ROUTINE_DEFAULTS: LifeRoutineConfig[] = [
  {
    id: 'life-sleep',
    bucketId: 'life-sleep',
    title: 'Sleep',
    blurb: 'Wind-down rituals, lights-out target, and no-screens buffer.',
    surfaceStyle: 'midnight',
    sortIndex: 0,
  },
  {
    id: 'life-cook',
    bucketId: 'life-cook',
    title: 'Cook/Eat',
    blurb: 'Prep staples, plan groceries, and keep easy meals ready.',
    surfaceStyle: 'grove',
    sortIndex: 1,
  },
  {
    id: 'life-travel',
    bucketId: 'life-travel',
    title: 'Travel',
    blurb: 'Commutes, drives, and any time you’re physically getting from A to B.',
    surfaceStyle: 'cool-blue',
    sortIndex: 2,
  },
  {
    id: 'life-mindfulness',
    bucketId: 'life-mindfulness',
    title: 'Mindfulness',
    blurb: 'Breathwork, journaling prompts, and quick resets.',
    surfaceStyle: 'muted-lavender',
    sortIndex: 3,
  },
  {
    id: 'life-admin',
    bucketId: 'life-admin',
    title: 'Life Admin',
    blurb: 'Inbox zero, bills, and those small adulting loops.',
    surfaceStyle: 'neutral-grey-blue',
    sortIndex: 4,
  },
  {
    id: 'life-nature',
    bucketId: 'life-nature',
    title: 'Nature',
    blurb: 'Walks outside, sunlight breaks, or a weekend trail plan.',
    surfaceStyle: 'fresh-teal',
    sortIndex: 5,
  },
  {
    id: 'life-socials',
    bucketId: 'life-socials',
    title: 'Socials',
    blurb: 'Reach out to friends, plan hangs, and reply to messages.',
    surfaceStyle: 'sunset-orange',
    sortIndex: 6,
  },
  {
    id: 'life-relationships',
    bucketId: 'life-relationships',
    title: 'Relationships',
    blurb: 'Date nights, check-ins, and celebrate the small stuff.',
    surfaceStyle: 'soft-magenta',
    sortIndex: 7,
  },
  {
    id: 'life-chill',
    bucketId: 'life-chill',
    title: 'Chill',
    blurb: 'Reading sessions, board games, or general downtime.',
    surfaceStyle: 'deep-indigo',
    sortIndex: 8,
  },
]

export const getDefaultLifeRoutines = (): LifeRoutineConfig[] =>
  LIFE_ROUTINE_DEFAULTS.map((routine, index) =>
    cloneRoutine({
      ...routine,
      sortIndex: index,
    }),
  )

const sanitizeLifeRoutine = (value: unknown): LifeRoutineConfig | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) {
    return null
  }
  const bucketIdRaw = typeof record.bucketId === 'string' ? record.bucketId.trim() : ''
  const titleRaw = typeof record.title === 'string' ? record.title.trim() : ''
  const blurbRaw = typeof record.blurb === 'string' ? record.blurb.trim() : ''
  const surfaceStyle = ensureSurfaceStyle(record.surfaceStyle, DEFAULT_SURFACE_STYLE)
  const sortIndex = typeof record.sortIndex === 'number' && Number.isFinite(record.sortIndex) ? record.sortIndex : 0

  return {
    id,
    bucketId: bucketIdRaw || id,
    title: titleRaw || 'Routine',
    blurb: blurbRaw || '',
    surfaceStyle,
    sortIndex,
  }
}

export const sanitizeLifeRoutineList = (value: unknown): LifeRoutineConfig[] => {
  // If nothing stored or provided, return an empty list; seeding is handled explicitly elsewhere.
  if (!Array.isArray(value)) {
    return []
  }
  // Otherwise, respect the user’s customized list exactly (including empty = user removed all)
  const seen = new Set<string>()
  const result: LifeRoutineConfig[] = []
  for (const entry of value) {
    const routine = sanitizeLifeRoutine(entry)
    if (!routine) continue
    if (seen.has(routine.id)) continue
    seen.add(routine.id)
    result.push(cloneRoutine(routine))
  }
  // Preserve empty if user intentionally removed all
  return result.map((routine, index) => {
    const normalized = cloneRoutine(routine)
    const bucketId =
      typeof normalized.bucketId === 'string' && normalized.bucketId.trim().length > 0
        ? normalized.bucketId.trim()
        : normalized.id
    return {
      ...normalized,
      bucketId,
      sortIndex: index,
    }
  })
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ensureRoutineId = (id: string | undefined | null): string => {
  if (id && UUID_REGEX.test(id)) {
    return id
  }
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  return `routine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

type LifeRoutineDbRow = {
  id: string
  title?: string | null
  blurb?: string | null
  surface_style?: string | null
  sort_index?: number | null
}

const storeLifeRoutinesLocal = (routines: LifeRoutineConfig[]): LifeRoutineConfig[] => {
  const clones = routines.map(cloneRoutine)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LIFE_ROUTINE_STORAGE_KEY, JSON.stringify(clones))
      window.dispatchEvent(new CustomEvent(LIFE_ROUTINE_UPDATE_EVENT, { detail: clones }))
    } catch {
      // ignore storage errors
    }
  }
  return clones
}

const readStoredLifeRoutineUserId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LIFE_ROUTINE_USER_STORAGE_KEY)
    if (!raw) return null
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

const setStoredLifeRoutineUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (!userId) {
      window.localStorage.removeItem(LIFE_ROUTINE_USER_STORAGE_KEY)
    } else {
      window.localStorage.setItem(LIFE_ROUTINE_USER_STORAGE_KEY, userId)
    }
    try {
      window.dispatchEvent(new Event(LIFE_ROUTINE_USER_EVENT))
    } catch {}
  } catch {}
}

const normalizeLifeRoutineUserId = (userId: string | null | undefined): string =>
  typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : LIFE_ROUTINE_GUEST_USER_ID

const isGuestLifeRoutineUser = (userId: string | null): boolean =>
  !userId || userId === LIFE_ROUTINE_GUEST_USER_ID

export const readLifeRoutineOwnerId = (): string | null => readStoredLifeRoutineUserId()

// Read raw local value without default seeding; returns null when key is absent
const readRawLifeRoutinesLocal = (): unknown | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LIFE_ROUTINE_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const mapDbRowToRoutine = (row: LifeRoutineDbRow): LifeRoutineConfig | null => {
  const id = typeof row.id === 'string' ? row.id : null
  const title = typeof row.title === 'string' ? row.title : null
  if (!id || !title) {
    return null
  }
  const blurb = typeof row.blurb === 'string' ? row.blurb : ''
  const surfaceColor = typeof (row as any).surface_colour === 'string' ? ((row as any).surface_colour as string) : null
  // Surface style is legacy; keep visuals consistent by defaulting to the app default.
  const surfaceStyle = DEFAULT_SURFACE_STYLE
  const sortIndex = typeof row.sort_index === 'number' && Number.isFinite(row.sort_index) ? row.sort_index : 0
  return {
    id,
    bucketId: id,
    title,
    blurb,
    surfaceStyle,
    surfaceColor,
    sortIndex,
  }
}

export const pushLifeRoutinesToSupabase = async (
  routines: LifeRoutineConfig[],
  options?: { strict?: boolean },
): Promise<void> => {
  const strict = Boolean(options?.strict)
  const fail = (message: string, err?: unknown) => {
    if (strict) {
      throw err instanceof Error ? err : new Error(message)
    }
  }
  if (!supabase) {
    fail('Supabase client unavailable')
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    fail('No Supabase session for life routines sync')
    return
  }

  const normalized = sanitizeLifeRoutineList(routines).map((routine) => ({
    ...routine,
    id: ensureRoutineId(routine.id),
  }))

  const rows = normalized.map((routine, index) => ({
    id: routine.id,
    user_id: session.user.id,
    title: routine.title,
    blurb: routine.blurb,
    surface_style: routine.surfaceStyle,
    surface_colour: gradientFromSurface(routine.surfaceStyle),
    sort_index: index,
  }))

  const { data: remoteIdsData, error: remoteIdsError } = await supabase
    .from('life_routines')
    .select('id')
    .eq('user_id', session.user.id)

  if (remoteIdsError) {
    fail('Failed to load remote life routines', remoteIdsError)
    return
  }

  if (rows.length > 0) {
    const tryUpsert = async (payload: typeof rows) =>
      supabase!.from('life_routines').upsert(payload, { onConflict: 'id' })

    const { error: upsertError } = await tryUpsert(rows)
    if (upsertError) {
      const details = (upsertError as any).details || ''
      const msg = `${upsertError.message} ${details}`.toLowerCase()
      // If the backend uses a Postgres ENUM or CHECK constraint for surface_style
      // and it hasn't been updated to include new themes, a 400 error will occur.
      const looksLikeSurfaceStyleConstraint =
        msg.includes('surface_style') || msg.includes('enum') || msg.includes('invalid input value')

      if (looksLikeSurfaceStyleConstraint) {
        // Retry once with a safe fallback so sync doesn’t block other fields.
        const fallback = DEFAULT_SURFACE_STYLE
        const fallbackRows = rows.map((r) => ({ ...r, surface_style: fallback }))
        const { error: retryError } = await tryUpsert(fallbackRows)
        if (retryError) {
          fail('Failed to upsert life routines with fallback surface', retryError)
          return
        }
      } else {
        fail('Failed to upsert life routines', upsertError)
        return
      }
    }
  }

  const remoteIds = new Set((remoteIdsData ?? []).map((row) => row.id))
  const localIds = new Set(rows.map((row) => row.id))
  const idsToDelete: string[] = []
  remoteIds.forEach((id) => {
    if (!localIds.has(id)) {
      idsToDelete.push(id)
    }
  })
  if (idsToDelete.length > 0) {
    const { error: deleteError } = await supabase.from('life_routines').delete().in('id', idsToDelete)
    if (deleteError) {
      fail('Failed to prune remote life routines', deleteError)
    }
  }
}

export const readStoredLifeRoutines = (): LifeRoutineConfig[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(LIFE_ROUTINE_STORAGE_KEY)
    const currentUser = readStoredLifeRoutineUserId()
    const guestContext = isGuestLifeRoutineUser(currentUser)
    if (!raw) {
      if (guestContext) {
        const defaults = getDefaultLifeRoutines()
        storeLifeRoutinesLocal(defaults)
        if (!currentUser) {
          setStoredLifeRoutineUserId(LIFE_ROUTINE_GUEST_USER_ID)
        }
        return defaults
      }
      return []
    }
    const parsed = JSON.parse(raw)
    const sanitized = sanitizeLifeRoutineList(parsed)
    if (sanitized.length > 0) {
      return sanitized
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      return []
    }
    if (guestContext) {
      const defaults = getDefaultLifeRoutines()
      storeLifeRoutinesLocal(defaults)
      return defaults
    }
    return []
  } catch {
    return []
  }
}

export const writeStoredLifeRoutines = (
  routines: LifeRoutineConfig[],
  options?: { sync?: boolean },
): LifeRoutineConfig[] => {
  const { sync = true } = options ?? {}
  const sanitized = sanitizeLifeRoutineList(routines)
  const stored = storeLifeRoutinesLocal(sanitized)
  if (sync) {
    void pushLifeRoutinesToSupabase(stored)
  }
  return stored
}

export const ensureLifeRoutineUser = (
  userId: string | null,
  options?: { suppressGuestDefaults?: boolean },
): void => {
  if (typeof window === 'undefined') return
  const normalized = normalizeLifeRoutineUserId(userId)
  const current = readStoredLifeRoutineUserId()
  if (current === normalized) {
    return
  }
  const migratingFromGuest = current === LIFE_ROUTINE_GUEST_USER_ID && normalized !== LIFE_ROUTINE_GUEST_USER_ID
  setStoredLifeRoutineUserId(normalized)
  if (normalized === LIFE_ROUTINE_GUEST_USER_ID) {
    if (current !== LIFE_ROUTINE_GUEST_USER_ID && !options?.suppressGuestDefaults) {
      storeLifeRoutinesLocal(getDefaultLifeRoutines())
    }
  } else if (!migratingFromGuest) {
    storeLifeRoutinesLocal([])
  }
}

export const syncLifeRoutinesWithSupabase = async (): Promise<LifeRoutineConfig[] | null> => {
  if (!supabase) {
    return []
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return null
  }
  // Default to preferring the remote snapshot. You can opt out by setting
  // VITE_PREFER_REMOTE_LIFE_ROUTINES=false in .env.local.
  const preferRemoteEnv = String((import.meta as any)?.env?.VITE_PREFER_REMOTE_LIFE_ROUTINES ?? 'true')
    .trim()
    .toLowerCase()
  const PREFER_REMOTE = preferRemoteEnv === 'true' || preferRemoteEnv === '1' || preferRemoteEnv === 'yes'
  // Fetch remote snapshot
  const { data, error } = await supabase
    .from('life_routines')
    .select('id, title, blurb, surface_style, sort_index')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })

  if (error) {
    return null
  }

  const remoteRows = data ?? []
  const localRaw = readRawLifeRoutinesLocal()
  const localSanitized = sanitizeLifeRoutineList(Array.isArray(localRaw) ? localRaw : [])

  // Prefer local if the user already has any routines configured locally.
  // This avoids surprising "random" routines appearing from a stale server snapshot
  // (e.g., defaults or data from another device) overriding local choices.
  if (!PREFER_REMOTE && localSanitized.length > 0) {
    const stored = storeLifeRoutinesLocal(localSanitized)
    // Best-effort push so other devices converge to local
    void pushLifeRoutinesToSupabase(stored)
    return stored
  }

  // Remote wins only when it actually has data; otherwise hold onto local snapshot.
  if (remoteRows.length > 0) {
    const mapped = remoteRows
      .map((row) => mapDbRowToRoutine(row as LifeRoutineDbRow))
      .filter((routine): routine is LifeRoutineConfig => Boolean(routine))
    const sanitized = sanitizeLifeRoutineList(mapped)
    return storeLifeRoutinesLocal(sanitized)
  }

  if (localSanitized.length > 0) {
    return storeLifeRoutinesLocal(localSanitized)
  }

  // Both empty: persist empty locally
  return storeLifeRoutinesLocal([])
}
