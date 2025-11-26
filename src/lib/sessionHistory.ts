import { supabase, ensureSingleUserSession } from './supabaseClient'
import { readStoredLifeRoutines, LIFE_ROUTINE_UPDATE_EVENT } from './lifeRoutines'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  sanitizeSurfaceStyle,
  type SurfaceStyle,
} from './surfaceStyles'

export const HISTORY_STORAGE_KEY = 'nc-taskwatch-history'
export const HISTORY_EVENT_NAME = 'nc-taskwatch:history-update'
export const HISTORY_USER_KEY = 'nc-taskwatch-history-user'
export const HISTORY_GUEST_USER_ID = '__guest__'
export const HISTORY_USER_EVENT = 'nc-taskwatch-history-user-updated'
export const CURRENT_SESSION_STORAGE_KEY = 'nc-taskwatch-current-session'
export const CURRENT_SESSION_EVENT_NAME = 'nc-taskwatch:session-update'
export const HISTORY_LIMIT = 250
// Reduce remote fetch window to limit egress; adjust as needed
export const HISTORY_REMOTE_WINDOW_DAYS = 30
// Feature flags persisted locally to enable/disable optional server columns dynamically
const FEATURE_FLAGS_STORAGE_KEY = 'nc-taskwatch-flags'
type FeatureFlags = {
  repeatOriginal?: boolean
  historyNotes?: boolean
  historySubtasks?: boolean
  historyFutureSession?: boolean
}
const parseEnvToggle = (value: unknown): boolean | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return null
}
const ENV_ENABLE_HISTORY_NOTES = parseEnvToggle((import.meta as any)?.env?.VITE_ENABLE_HISTORY_NOTES)
const ENV_ENABLE_HISTORY_SUBTASKS = parseEnvToggle((import.meta as any)?.env?.VITE_ENABLE_HISTORY_SUBTASKS)
const ENV_ENABLE_REPEAT_ORIGINAL = parseEnvToggle((import.meta as any)?.env?.VITE_ENABLE_REPEAT_ORIGINAL)
const ENV_ENABLE_HISTORY_FUTURE_SESSION = parseEnvToggle(
  (import.meta as any)?.env?.VITE_ENABLE_HISTORY_FUTURE_SESSION,
)
const readFeatureFlags = (): FeatureFlags => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? (obj as FeatureFlags) : {}
  } catch {
    return {}
  }
}
const writeFeatureFlags = (flags: FeatureFlags) => {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(flags)) } catch {}
}
const envOverride = (flag: boolean | null): boolean | null => flag

const isRepeatOriginalEnabled = (): boolean => {
  const override = envOverride(ENV_ENABLE_REPEAT_ORIGINAL)
  if (override !== null) {
    return override
  }
  const flags = readFeatureFlags()
  return flags.repeatOriginal !== false
}
const disableRepeatOriginal = () => {
  const flags = readFeatureFlags()
  if (flags.repeatOriginal === false) return
  flags.repeatOriginal = false
  writeFeatureFlags(flags)
}
const isHistoryFutureSessionEnabled = (): boolean => {
  const override = envOverride(ENV_ENABLE_HISTORY_FUTURE_SESSION)
  if (override !== null) {
    return override
  }
  const flags = readFeatureFlags()
  return flags.historyFutureSession !== false
}
const disableHistoryFutureSession = () => {
  const flags = readFeatureFlags()
  if (flags.historyFutureSession === false) return
  flags.historyFutureSession = false
  writeFeatureFlags(flags)
}
const isHistoryNotesEnabled = (): boolean => {
  const override = envOverride(ENV_ENABLE_HISTORY_NOTES)
  if (override !== null) {
    return override
  }
  const flags = readFeatureFlags()
  return flags.historyNotes !== false
}
const disableHistoryNotes = () => {
  const flags = readFeatureFlags()
  if (flags.historyNotes === false) return
  flags.historyNotes = false
  writeFeatureFlags(flags)
}
const isHistorySubtasksEnabled = (): boolean => {
  const override = envOverride(ENV_ENABLE_HISTORY_SUBTASKS)
  if (override !== null) {
    return override
  }
  const flags = readFeatureFlags()
  return flags.historySubtasks !== false
}
const disableHistorySubtasks = () => {
  const flags = readFeatureFlags()
  if (flags.historySubtasks === false) return
  flags.historySubtasks = false
  writeFeatureFlags(flags)
}
const HISTORY_BASE_SELECT_COLUMNS =
  'id, task_name, elapsed_ms, started_at, ended_at, goal_name, bucket_name, goal_id, bucket_id, task_id, goal_surface, entry_colour, created_at, updated_at, future_session'

const buildHistorySelectColumns = (): string => {
  let columns = HISTORY_BASE_SELECT_COLUMNS
  if (isHistoryNotesEnabled()) {
    columns += ', notes'
  }
  if (isHistorySubtasksEnabled()) {
    columns += ', subtasks'
  }
  if (isRepeatOriginalEnabled()) {
    columns += ', repeating_session_id, original_time'
  }
  return columns
}
const getStoredHistoryUserId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(HISTORY_USER_KEY)
  } catch {
    return null
  }
}
export const readHistoryOwnerId = (): string | null => getStoredHistoryUserId()
const setStoredHistoryUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (!userId) {
      window.localStorage.removeItem(HISTORY_USER_KEY)
    } else {
      window.localStorage.setItem(HISTORY_USER_KEY, userId)
    }
    try {
      window.dispatchEvent(new Event(HISTORY_USER_EVENT))
    } catch {}
  } catch {}
}
const getErrorContext = (err: any): string => {
  if (!err) return ''
  const msg = (err.message || err.msg || err.error_description || '') as string
  const details = (err.details || err.hint || '') as string
  return `${msg} ${details}`.toLowerCase()
}
const isColumnMissingError = (err: any): boolean => {
  const combined = getErrorContext(err)
  return combined.includes('column') && combined.includes('does not exist')
}
const errorMentionsColumn = (err: any, column: string): boolean => {
  if (!err) return false
  const normalized = column.toLowerCase()
  const combined = getErrorContext(err)
  return combined.includes(normalized)
}

type HistoryPayload = Record<string, unknown>

const stripHistoryPayloadColumns = (
  payload: HistoryPayload,
  removal: {
    repeat?: boolean
    notes?: boolean
    subtasks?: boolean
    future?: boolean
    repeatingOnly?: boolean
  },
): HistoryPayload => {
  if (!removal.repeat && !removal.notes && !removal.subtasks && !removal.future && !removal.repeatingOnly) {
    return payload
  }
  const next = { ...payload }
  if (removal.repeat || removal.repeatingOnly) {
    delete (next as any).repeating_session_id
  }
  if (removal.repeat) {
    delete (next as any).original_time
  }
  if (removal.notes) {
    delete (next as any).notes
  }
  if (removal.subtasks) {
    delete (next as any).subtasks
  }
  if (removal.future) {
    delete (next as any).future_session
  }
  return next
}

const upsertHistoryPayloads = async (
  client: NonNullable<typeof supabase>,
  payloads: HistoryPayload[],
): Promise<{ resp: any; usedPayloads: HistoryPayload[] }> => {
  const attempt = async (pls: HistoryPayload[]) => client.from('session_history').upsert(pls, { onConflict: 'id' })
  let usedPayloads = payloads
  let resp = await attempt(usedPayloads)
  let attempts = 0
  while (resp.error && isColumnMissingError(resp.error) && attempts < 5) {
    const missingRepeatColumns =
      errorMentionsColumn(resp.error, 'repeating_session_id') || errorMentionsColumn(resp.error, 'original_time')
    const missingNotesColumn = errorMentionsColumn(resp.error, 'notes')
    const missingSubtasksColumn = errorMentionsColumn(resp.error, 'subtasks')
    const missingFutureColumn = errorMentionsColumn(resp.error, 'future_session')
    const removalNeeded = missingRepeatColumns || missingNotesColumn || missingSubtasksColumn || missingFutureColumn
    if (!removalNeeded) {
      break
    }
    if (missingRepeatColumns && isRepeatOriginalEnabled()) {
      disableRepeatOriginal()
    }
    if (missingNotesColumn && isHistoryNotesEnabled()) {
      disableHistoryNotes()
    }
    if (missingSubtasksColumn && isHistorySubtasksEnabled()) {
      disableHistorySubtasks()
    }
    if (missingFutureColumn && isHistoryFutureSessionEnabled()) {
      disableHistoryFutureSession()
    }
    usedPayloads = usedPayloads.map((payload) =>
      stripHistoryPayloadColumns(payload, {
        repeat: missingRepeatColumns,
        notes: missingNotesColumn,
        subtasks: missingSubtasksColumn,
        future: missingFutureColumn,
      }),
    )
    resp = await attempt(usedPayloads)
    attempts += 1
  }
  return { resp, usedPayloads }
}
const isConflictError = (err: any): boolean => {
  if (!err) return false
  const code = String(err.code ?? '').trim()
  if (code === '409' || code === '23505') {
    return true
  }
  const msg = String(err.message ?? '')
  const details = String(err.details ?? '')
  const combined = `${msg} ${details}`.toLowerCase()
  return combined.includes('duplicate key value') || combined.includes('already exists')
}

const toDbSurface = (value: SurfaceStyle | null | undefined): SurfaceStyle | null =>
  sanitizeSurfaceStyle(value) ?? null

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

export const gradientFromSurface = (surface: SurfaceStyle | null | undefined): string =>
  (surface && SURFACE_GRADIENTS[surface]) || 'linear-gradient(135deg, #FFF8BF 0%, #FFF8BF 100%)'

const LIFE_ROUTINES_NAME = 'Daily Life'
const LIFE_ROUTINES_GOAL_ID = 'life-routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'

const buildLifeRoutineSurfaceLookups = (): {
  idOrBucket: Map<string, SurfaceStyle>
  title: Map<string, SurfaceStyle>
} | null => {
  const routines = readStoredLifeRoutines()
  if (!Array.isArray(routines) || routines.length === 0) {
    return null
  }
  const idOrBucket = new Map<string, SurfaceStyle>()
  const title = new Map<string, SurfaceStyle>()
  routines.forEach((routine) => {
    if (!routine) {
      return
    }
    const surface = ensureSurfaceStyle(routine.surfaceStyle, DEFAULT_SURFACE_STYLE)
    const keys = new Set<string>()
    if (typeof routine.id === 'string' && routine.id.trim().length > 0) {
      keys.add(routine.id.trim())
    }
    if (typeof routine.bucketId === 'string' && routine.bucketId.trim().length > 0) {
      keys.add(routine.bucketId.trim())
    }
    keys.forEach((key) => {
      if (!idOrBucket.has(key)) {
        idOrBucket.set(key, surface)
      }
    })
    if (typeof routine.title === 'string' && routine.title.trim().length > 0) {
      title.set(routine.title.trim().toLowerCase(), surface)
    }
  })
  if (idOrBucket.size === 0 && title.size === 0) {
    return null
  }
  return { idOrBucket, title }
}

const applyLifeRoutineSurfaces = (
  records: HistoryRecord[],
): { records: HistoryRecord[]; changed: boolean } => {
  if (!records || records.length === 0) {
    return { records, changed: false }
  }
  const lookups = buildLifeRoutineSurfaceLookups()
  if (!lookups) {
    return { records, changed: false }
  }
  let changed = false
  const next = records.map((record) => {
    if (!record) {
      return record
    }
    const isDailyLifeRecord =
      record.goalId === LIFE_ROUTINES_GOAL_ID ||
      record.goalName === LIFE_ROUTINES_NAME ||
      (typeof record.bucketId === 'string' && record.bucketId.startsWith('life-'))
    if (!isDailyLifeRecord) {
      return record
    }
    const candidateKeys: string[] = []
    if (typeof record.bucketId === 'string' && record.bucketId.trim()) {
      candidateKeys.push(record.bucketId.trim())
    }
    if (typeof record.taskId === 'string' && record.taskId.trim()) {
      candidateKeys.push(record.taskId.trim())
    }
    let surface: SurfaceStyle | null = null
    for (const key of candidateKeys) {
      const match = lookups.idOrBucket.get(key)
      if (match) {
        surface = match
        break
      }
    }
    if (!surface && typeof record.bucketName === 'string' && record.bucketName.trim().length > 0) {
      const normalized = record.bucketName.trim().toLowerCase()
      surface = lookups.title.get(normalized) ?? null
    }
    if (!surface || record.bucketSurface === surface) {
      return record
    }
    changed = true
    const next: HistoryRecord = { ...record, bucketSurface: surface }
    if (record.goalId === LIFE_ROUTINES_GOAL_ID && record.goalSurface !== LIFE_ROUTINES_SURFACE) {
      next.goalSurface = LIFE_ROUTINES_SURFACE
    }
    return next
  })
  return { records: changed ? next : records, changed }
}

type HistoryPendingAction = 'upsert' | 'delete'

export type HistorySubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
}

export type HistoryEntry = {
  id: string
  taskName: string
  elapsed: number
  startedAt: number
  endedAt: number
  goalName: string | null
  bucketName: string | null
  goalId: string | null
  bucketId: string | null
  taskId: string | null
  goalSurface: SurfaceStyle
  bucketSurface: SurfaceStyle | null
  entryColor?: string
  notes: string
  subtasks: HistorySubtask[]
  // When true, this entry represents a planned future session rather than logged work
  futureSession?: boolean
  // Server-side deletion support:
  // repeatingSessionId: FK to repeating_sessions.id when a guide transforms (confirm/skip/reschedule)
  // originalTime: the scheduled timestamptz (in ms) of the guide occurrence that transformed
  repeatingSessionId?: string | null
  originalTime?: number | null
}

export type HistoryRecord = HistoryEntry & {
  createdAt: number
  updatedAt: number
  pendingAction: HistoryPendingAction | null
}

type HistoryCandidate = {
  id?: unknown
  taskName?: unknown
  elapsed?: unknown
  startedAt?: unknown
  endedAt?: unknown
  goalName?: unknown
  bucketName?: unknown
  goalId?: unknown
  bucketId?: unknown
  taskId?: unknown
  goalSurface?: unknown
  bucketSurface?: unknown
  entryColor?: unknown
  notes?: unknown
  subtasks?: unknown
  futureSession?: unknown
  repeatingSessionId?: unknown
  originalTime?: unknown
}

type HistoryRecordCandidate = HistoryCandidate & {
  createdAt?: unknown
  updatedAt?: unknown
  pendingAction?: unknown
}

const MINUTE_MS = 60 * 1000
export const SAMPLE_SLEEP_ROUTINE_ID = 'sample-sleep-rule'
const formatOccurrenceDate = (timestamp: number): string => {
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
const minuteVariance = (dayOffset: number, seed: number): number => {
  const base = (dayOffset * 37 + seed * 11) % 21
  return base - 10
}

export const createSampleHistoryRecords = (): HistoryRecord[] => {
  const anchor = new Date()
  anchor.setSeconds(0, 0)
  const getStart = (daysAgo: number, hour: number, minute: number): number => {
    const d = new Date(anchor.getTime())
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, minute, 0, 0)
    return d.getTime()
  }

  type SampleConfig = {
    taskName: string
    daysAgo: number
    startHour: number
    startMinute: number
    durationMinutes: number
    goalName: string | null
    bucketName: string | null
    goalId: string | null
    bucketId: string | null
    taskId: string | null
  goalSurface: SurfaceStyle
  bucketSurface?: SurfaceStyle | null
  notes?: string
  repeatingSessionId?: string | null
  includeOriginalTime?: boolean
  futureSession?: boolean
}

  const entries: HistoryEntry[] = []
  const addEntry = (config: SampleConfig) => {
    const startedAt = getStart(config.daysAgo, config.startHour, config.startMinute)
    const elapsed = Math.max(MINUTE_MS, config.durationMinutes * MINUTE_MS)
    const repeatingSessionId = config.repeatingSessionId ?? null
    const originalTime =
      repeatingSessionId && config.includeOriginalTime !== false ? startedAt : null
    const entryColor = gradientFromSurface(config.goalSurface)
    entries.push({
      id: `history-sample-${entries.length + 1}`,
      taskName: config.taskName,
      elapsed,
      startedAt,
      endedAt: startedAt + elapsed,
      goalName: config.goalName,
      bucketName: config.bucketName,
      goalId: config.goalId,
      bucketId: config.bucketId,
      taskId: config.taskId,
      goalSurface: config.goalSurface,
      bucketSurface: config.bucketSurface ?? null,
      entryColor,
      notes: config.notes ?? '',
      subtasks: [],
      repeatingSessionId,
      originalTime,
      futureSession: config.futureSession ?? false,
    })
  }

  const CANONICAL_SLEEP_DAY_OFFSET = 3

  const addSleepEntry = (dayOffset: number) => {
    let startMinute = Math.max(0, Math.min(59, minuteVariance(dayOffset, 4)))
    if (dayOffset === CANONICAL_SLEEP_DAY_OFFSET) {
      startMinute = 0
    }
    const durationMinutes = 8 * 60
    addEntry({
      taskName: 'Sleep',
      daysAgo: dayOffset,
      startHour: 23,
      startMinute,
      durationMinutes,
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Sleep',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-sleep',
      taskId: 'life-sleep',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'midnight',
      notes: 'Daily wind-down + sleep block.',
      repeatingSessionId: SAMPLE_SLEEP_ROUTINE_ID,
    })
  }

  type SessionPreset = Omit<SampleConfig, 'daysAgo' | 'startHour' | 'startMinute' | 'durationMinutes'>
  const sessionPresets: Record<string, SessionPreset> = {
    study: {
      taskName: 'Deep study block',
      goalName: 'Ace This Semester',
      bucketName: 'Lectures & Notes',
      goalId: 'g_demo',
      bucketId: 'b_demo_1',
      taskId: 't_demo_1',
      goalSurface: 'glass',
      bucketSurface: 'cool-blue',
      notes: 'Lecture review + flashcards.',
    },
    internship: {
      taskName: 'Internship sprint',
      goalName: 'Level Up at Work',
      bucketName: 'Deep Work Sprints',
      goalId: 'g2',
      bucketId: 'b4',
      taskId: 't19',
      goalSurface: 'glass',
      bucketSurface: 'charcoal',
      notes: 'Heads-down product work.',
    },
    creative: {
      taskName: 'Creative assignment burst',
      goalName: 'Ace This Semester',
      bucketName: 'Assignments',
      goalId: 'g_demo',
      bucketId: 'b_demo_2',
      taskId: 't_demo_4',
      goalSurface: 'glass',
      bucketSurface: 'midnight',
      notes: 'Essay outline + drafting.',
    },
    health: {
      taskName: 'Gym + movement',
      goalName: 'Healthy Work-Life Rhythm',
      bucketName: 'Movement',
      goalId: 'g3',
      bucketId: 'b7',
      taskId: 't14',
      goalSurface: 'glass',
      bucketSurface: 'fresh-teal',
      notes: 'Strength + stretch.',
    },
    social: {
      taskName: 'Social reset',
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Socials',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-socials',
      taskId: 'life-socials',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'soft-magenta',
      notes: 'Hangs / check-ins.',
    },
    admin: {
      taskName: 'Life admin sprint',
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Life Admin',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-admin',
      taskId: 'life-admin',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'neutral-grey-blue',
      notes: 'Inbox, bills, planning.',
    },
  }

  type DaySessionPlan = {
    preset: keyof typeof sessionPresets
    duration: number
    overrideName?: string
    notes?: string
  }

  const dayPlans: Array<{ dayOffset: number; sessions: DaySessionPlan[] }> = [
    { dayOffset: 1, sessions: [
      { preset: 'study', duration: 180, overrideName: 'Lecture review marathon' },
      { preset: 'internship', duration: 150, overrideName: 'Product sprint focus' },
      {
        preset: 'internship',
        duration: 240,
        overrideName: 'End Taskwatch Demo event',
        notes: 'Wrap up guest walkthrough and share highlights.',
      },
    ] },
    { dayOffset: 2, sessions: [
      { preset: 'internship', duration: 180, overrideName: 'Deep work sprints' },
      { preset: 'creative', duration: 150, overrideName: 'Studio critique prep' },
      { preset: 'social', duration: 120, overrideName: 'Dinner + hangout' },
    ] },
    { dayOffset: 3, sessions: [
      { preset: 'study', duration: 150, overrideName: 'Group study jam' },
      { preset: 'admin', duration: 90, overrideName: 'Life admin & groceries' },
      { preset: 'health', duration: 100, overrideName: 'Pilates + walk' },
    ] },
    { dayOffset: 4, sessions: [
      { preset: 'creative', duration: 180, overrideName: 'Essay drafting session' },
      { preset: 'study', duration: 150, overrideName: 'Lab prep & notes' },
      { preset: 'social', duration: 120, overrideName: 'Family FaceTime' },
    ] },
    { dayOffset: 5, sessions: [] },
  ]

  const dayClock = new Map<number, number>()
  const ensureDayClock = (dayOffset: number): number => {
    if (!dayClock.has(dayOffset)) {
      const base = 8 * 60 + minuteVariance(dayOffset, 33)
      dayClock.set(dayOffset, base)
    }
    return dayClock.get(dayOffset)!
  }

  const scheduleSession = (dayOffset: number, session: DaySessionPlan) => {
    const preset = sessionPresets[session.preset]
    const startMinutes = Math.max(6 * 60, ensureDayClock(dayOffset))
    const duration = Math.max(60, session.duration + minuteVariance(dayOffset, session.duration))
    const safeStartMinutes = Math.min(startMinutes, 21 * 60)
    const startHour = Math.floor(safeStartMinutes / 60)
    const startMinute = safeStartMinutes % 60
    addEntry({
      ...preset,
      taskName: session.overrideName ?? preset.taskName,
      notes: session.notes ?? preset.notes,
      daysAgo: dayOffset,
      startHour,
      startMinute,
      durationMinutes: duration,
    })
    const gap = Math.max(20, 30 + minuteVariance(dayOffset, duration))
    dayClock.set(dayOffset, safeStartMinutes + duration + gap)
  }

  dayPlans.forEach((plan) => {
    addSleepEntry(plan.dayOffset)
    dayClock.set(plan.dayOffset, 8 * 60 + minuteVariance(plan.dayOffset, 41))
    plan.sessions.forEach((session) => scheduleSession(plan.dayOffset, session))
  })

  addEntry({
    taskName: "X's Birthday",
    daysAgo: 3,
    startHour: 0,
    startMinute: 0,
    durationMinutes: 24 * 60,
    goalName: LIFE_ROUTINES_NAME,
    bucketName: 'Socials',
    goalId: LIFE_ROUTINES_GOAL_ID,
    bucketId: 'life-socials',
    taskId: 'life-socials-birthday',
    goalSurface: LIFE_ROUTINES_SURFACE,
    bucketSurface: 'sunset-orange',
    notes: 'All-day celebration for a close friend.',
  })

  addEntry({
    taskName: 'Snapback – Doomscrolling',
    daysAgo: 2,
    startHour: 22,
    startMinute: 0,
    durationMinutes: 45,
    goalName: 'Snapback',
    bucketName: 'Doomscrolling',
    goalId: 'snapback',
    bucketId: 'snapback-doomscrolling',
    taskId: 'snapback-doomscroll',
    goalSurface: 'charcoal',
    bucketSurface: 'charcoal',
    notes: 'Mindless scrolling that pulled me off track.',
  })

  const futureGuideBlocks: SampleConfig[] = [
    {
      taskName: 'Sleep',
      daysAgo: -1,
      startHour: 23,
      startMinute: 0,
      durationMinutes: 8 * 60,
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Sleep',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-sleep',
      taskId: 'life-sleep',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'midnight',
      repeatingSessionId: SAMPLE_SLEEP_ROUTINE_ID,
      futureSession: true,
      notes: 'Guide entry for tomorrow night.',
    },
    {
      taskName: 'Sleep',
      daysAgo: -2,
      startHour: 23,
      startMinute: 0,
      durationMinutes: 8 * 60,
      goalName: LIFE_ROUTINES_NAME,
      bucketName: 'Sleep',
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: 'life-sleep',
      taskId: 'life-sleep',
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: 'midnight',
      repeatingSessionId: SAMPLE_SLEEP_ROUTINE_ID,
      futureSession: true,
      notes: 'Guide entry for later this week.',
    },
  ]

  futureGuideBlocks.forEach(addEntry)

  return entries.map((entry, index) => ({
    ...entry,
    createdAt: entry.startedAt,
    updatedAt: entry.endedAt + index,
    pendingAction: null,
  }))
}
const sanitizeHistorySubtasks = (value: unknown): HistorySubtask[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        return null
      }
      const candidate = item as Record<string, unknown>
      const rawId = typeof candidate.id === 'string' ? candidate.id : null
      if (!rawId) {
        return null
      }
      const text = typeof candidate.text === 'string' ? candidate.text : ''
      const completed = Boolean(candidate.completed)
      const sortSource = candidate.sortIndex
      const sortIndex =
        typeof sortSource === 'number' && Number.isFinite(sortSource)
          ? sortSource
          : typeof sortSource === 'string'
            ? Number(sortSource)
            : index
      const normalizedSortIndex = Number.isFinite(sortIndex) ? sortIndex : index
      return {
        id: rawId,
        text,
        completed,
        sortIndex: normalizedSortIndex,
      }
    })
    .filter((subtask): subtask is HistorySubtask => Boolean(subtask))
    .sort((a, b) => a.sortIndex - b.sortIndex)
}

export const areHistorySubtasksEqual = (a: HistorySubtask[], b: HistorySubtask[]): boolean => {
  if (a === b) {
    return true
  }
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (
      left.id !== right.id ||
      left.text !== right.text ||
      left.completed !== right.completed ||
      left.sortIndex !== right.sortIndex
    ) {
      return false
    }
  }
  return true
}

const clampNumber = (value: unknown, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}
// Snap a timestamp to the nearest minute. If exactly halfway (30s), round up.
const snapToNearestMinute = (ms: number): number => {
  if (!Number.isFinite(ms)) return ms
  const MIN = 60_000
  const rem = ms % MIN
  if (rem === 0) return ms
  const posRem = rem < 0 ? rem + MIN : rem
  return posRem >= 30_000 ? ms + (MIN - posRem) : ms - posRem
}

const normalizeEntryTimes = (entry: HistoryEntry): HistoryEntry => {
  const started = snapToNearestMinute(entry.startedAt)
  const ended = snapToNearestMinute(entry.endedAt)
  const elapsed = Math.max(0, ended - started)
  if (started === entry.startedAt && ended === entry.endedAt && elapsed === entry.elapsed) return entry
  return { ...entry, startedAt: started, endedAt: ended, elapsed }
}


const parseTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

const sanitizeHistoryEntries = (value: unknown): HistoryEntry[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((rawEntry) => {
      if (typeof rawEntry !== 'object' || rawEntry === null) {
        return null
      }
      const candidate = rawEntry as HistoryCandidate
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const taskName = typeof candidate.taskName === 'string' ? candidate.taskName : null
      const elapsed = typeof candidate.elapsed === 'number' ? candidate.elapsed : null
      const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
      const endedAt = typeof candidate.endedAt === 'number' ? candidate.endedAt : null
      if (!id || taskName === null || elapsed === null || startedAt === null || endedAt === null) {
        return null
      }

      const goalNameRaw = typeof candidate.goalName === 'string' ? candidate.goalName : ''
      const bucketNameRaw = typeof candidate.bucketName === 'string' ? candidate.bucketName : ''
      const goalIdRaw = typeof candidate.goalId === 'string' ? candidate.goalId : null
      const bucketIdRaw = typeof candidate.bucketId === 'string' ? candidate.bucketId : null
      const taskIdRaw = typeof candidate.taskId === 'string' ? candidate.taskId : null
      const goalSurfaceRaw = sanitizeSurfaceStyle(candidate.goalSurface)
      const bucketSurfaceRaw = sanitizeSurfaceStyle(candidate.bucketSurface)
      const entryColorRaw = typeof (candidate as any).entryColor === 'string' ? ((candidate as any).entryColor as string) : null
      const notesRaw = typeof candidate.notes === 'string' ? candidate.notes : ''
      const subtasksRaw = sanitizeHistorySubtasks(candidate.subtasks)
      const futureSessionRaw = Boolean((candidate as any).futureSession)
      const repeatingSessionIdRaw: string | null =
        typeof (candidate as any).repeatingSessionId === 'string' ? ((candidate as any).repeatingSessionId as string) : null
      const originalTimeRaw: number | null =
        typeof (candidate as any).originalTime === 'number' && Number.isFinite((candidate as any).originalTime as number)
          ? ((candidate as any).originalTime as number)
          : null

      const normalizedGoalName = goalNameRaw.trim()
      const normalizedBucketName = bucketNameRaw.trim()

      let goalSurface = goalSurfaceRaw ?? null
      let bucketSurface = bucketSurfaceRaw ?? null
      let entryColor = typeof entryColorRaw === 'string' && entryColorRaw.trim().length > 0 ? entryColorRaw.trim() : null

      if (!goalSurface && normalizedGoalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
        goalSurface = LIFE_ROUTINES_SURFACE
      }

      // Do not re-derive color from bucket styles; rely on stored entryColour or fall back to goal surface/default.
      if (!entryColor || !entryColor.toLowerCase().includes('linear-gradient(')) {
        const surfaceForGradient = goalSurface ?? DEFAULT_SURFACE_STYLE
        entryColor = gradientFromSurface(surfaceForGradient)
      }

      const normalized: HistoryEntry = {
        id,
        taskName,
        elapsed,
        startedAt,
        endedAt,
        goalName: normalizedGoalName.length > 0 ? normalizedGoalName : null,
        bucketName: normalizedBucketName.length > 0 ? normalizedBucketName : null,
        goalId: goalIdRaw,
        bucketId: bucketIdRaw,
        taskId: taskIdRaw,
        goalSurface: ensureSurfaceStyle(goalSurface ?? DEFAULT_SURFACE_STYLE, DEFAULT_SURFACE_STYLE),
        bucketSurface: bucketSurface ? ensureSurfaceStyle(bucketSurface, DEFAULT_SURFACE_STYLE) : null,
        entryColor,
        notes: notesRaw,
        subtasks: subtasksRaw,
        futureSession: futureSessionRaw,
        repeatingSessionId: repeatingSessionIdRaw,
        originalTime: originalTimeRaw,
      }
      return normalized
    })
    .filter((entry): entry is HistoryEntry => Boolean(entry))
}

const sanitizeHistoryRecords = (value: unknown): HistoryRecord[] => {
  const entries = sanitizeHistoryEntries(value)
  const array = Array.isArray(value) ? (value as HistoryRecordCandidate[]) : []
  const now = Date.now()

  return entries.map((entry, index) => {
    const candidate = array[index] ?? {}
    const createdAt = parseTimestamp(candidate.createdAt, entry.startedAt ?? now)
    const updatedAt = parseTimestamp(candidate.updatedAt, Math.max(createdAt, entry.endedAt ?? createdAt))
    const rawPending = candidate.pendingAction
    const pendingAction =
      rawPending === 'upsert' || rawPending === 'delete' ? (rawPending as HistoryPendingAction) : null

    return {
      ...entry,
      createdAt,
      updatedAt,
      pendingAction,
    }
  })
}

const stripMetadata = (record: HistoryRecord): HistoryEntry => {
  const { createdAt: _c, updatedAt: _u, pendingAction: _p, ...entry } = record
  return entry
}

const recordsToActiveEntries = (records: HistoryRecord[]): HistoryEntry[] =>
  records
    .filter((record) => record.pendingAction !== 'delete')
    .sort((a, b) => (a.endedAt === b.endedAt ? b.startedAt - a.startedAt : b.endedAt - a.endedAt))
    .slice(0, HISTORY_LIMIT)
    .map(stripMetadata)

const readHistoryRecords = (): HistoryRecord[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    const currentUserId = getStoredHistoryUserId()
    const guestContext = !currentUserId || currentUserId === HISTORY_GUEST_USER_ID
    if (!raw) {
      if (guestContext) {
        const sampleRecords = createSampleHistoryRecords()
        writeHistoryRecords(sampleRecords)
        if (!currentUserId) {
          setStoredHistoryUserId(HISTORY_GUEST_USER_ID)
        }
        return sampleRecords
      }
      return []
    }
    const records = sanitizeHistoryRecords(JSON.parse(raw))
    return records
  } catch {
    return []
  }
}

export const purgeDeletedHistoryRecords = (): void => {
  const records = readHistoryRecords()
  if (!Array.isArray(records) || records.length === 0) {
    return
  }
  const filtered = records.filter((record) => record.pendingAction !== 'delete')
  if (filtered.length === records.length) {
    return
  }
  const sorted = sortRecordsForStorage(filtered)
  writeHistoryRecords(sorted)
  broadcastHistoryRecords(sorted)
}

const writeHistoryRecords = (records: HistoryRecord[]): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records))
  } catch {}
}

export const readStoredHistory = (): HistoryEntry[] => recordsToActiveEntries(readHistoryRecords())

const broadcastHistoryRecords = (records: HistoryRecord[]): void => {
  if (typeof window === 'undefined') {
    return
  }
  const dispatch = () => {
    try {
      const event = new CustomEvent<HistoryRecord[]>(HISTORY_EVENT_NAME, { detail: records })
      window.dispatchEvent(event)
    } catch {}
  }
  // Dispatch on a microtask to avoid triggering state updates in other components
  // while React is rendering this component (prevents cross-component setState warnings).
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(dispatch)
  } else {
    setTimeout(dispatch, 0)
  }
}

const sortRecordsForStorage = (records: HistoryRecord[]): HistoryRecord[] =>
  records
    .slice()
    .sort((a, b) => {
      if (a.endedAt === b.endedAt) {
        return b.startedAt - a.startedAt
      }
      return b.endedAt - a.endedAt
    })

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined | null): value is string => !!value && UUID_REGEX.test(value)
const generateUuid = (): string => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  return `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const recordEqualsEntry = (record: HistoryRecord, entry: HistoryEntry): boolean =>
  record.taskName === entry.taskName &&
  record.elapsed === entry.elapsed &&
  record.startedAt === entry.startedAt &&
  record.endedAt === entry.endedAt &&
  record.goalName === entry.goalName &&
  record.bucketName === entry.bucketName &&
  record.goalId === entry.goalId &&
  record.bucketId === entry.bucketId &&
  record.taskId === entry.taskId &&
  record.goalSurface === entry.goalSurface &&
  record.bucketSurface === entry.bucketSurface &&
  (record.entryColor ?? '') === (entry.entryColor ?? '') &&
  Boolean(record.futureSession) === Boolean(entry.futureSession) &&
  record.notes === entry.notes &&
  areHistorySubtasksEqual(record.subtasks, entry.subtasks)

const updateRecordWithEntry = (record: HistoryRecord, entry: HistoryEntry, timestamp: number): HistoryRecord => {
  if (recordEqualsEntry(record, entry) && record.pendingAction !== 'delete') {
    return record
  }
  return {
    ...record,
    ...entry,
    updatedAt: timestamp,
    pendingAction: 'upsert',
  }
}

const createRecordFromEntry = (entry: HistoryEntry, timestamp: number): HistoryRecord => ({
  ...entry,
  createdAt: timestamp,
  updatedAt: timestamp,
  pendingAction: 'upsert',
})

const markRecordPendingDelete = (record: HistoryRecord, timestamp: number): HistoryRecord => ({
  ...record,
  updatedAt: timestamp,
  pendingAction: 'delete',
})

const persistRecords = (records: HistoryRecord[]): HistoryEntry[] => {
  const sorted = sortRecordsForStorage(records)
  writeHistoryRecords(sorted)
  const activeEntries = recordsToActiveEntries(sorted)
  broadcastHistoryRecords(sorted)
  return activeEntries
}

export const ensureHistoryUser = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  const normalized =
    typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : HISTORY_GUEST_USER_ID
  const current = getStoredHistoryUserId()
  if (current === normalized) {
    return
  }
  const migratingFromGuest = current === HISTORY_GUEST_USER_ID && normalized !== HISTORY_GUEST_USER_ID
  setStoredHistoryUserId(normalized)
  try { window.dispatchEvent(new Event(HISTORY_USER_EVENT)) } catch {}
  if (normalized === HISTORY_GUEST_USER_ID) {
    if (current !== HISTORY_GUEST_USER_ID) {
      const samples = createSampleHistoryRecords()
      writeHistoryRecords(samples)
      broadcastHistoryRecords(samples)
    }
  } else if (!migratingFromGuest) {
    writeHistoryRecords([])
    broadcastHistoryRecords([])
  }
}

const realignHistoryWithLifeRoutineSurfaces = (): void => {
  const records = readHistoryRecords()
  if (!Array.isArray(records) || records.length === 0) {
    return
  }
  const { records: alignedRecords, changed } = applyLifeRoutineSurfaces(records)
  if (!changed) {
    return
  }
  persistRecords(alignedRecords)
}

const setupLifeRoutineSurfaceSync = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    realignHistoryWithLifeRoutineSurfaces()
  } catch {}
  const handleUpdate = () => {
    try {
      realignHistoryWithLifeRoutineSurfaces()
    } catch {}
  }
  window.addEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleUpdate)
}

setupLifeRoutineSurfaceSync()

export const persistHistorySnapshot = (nextEntries: HistoryEntry[]): HistoryEntry[] => {
  const sanitized = sanitizeHistoryEntries(nextEntries).map(normalizeEntryTimes)
  const existingRecords = readHistoryRecords()
  const recordsById = new Map<string, HistoryRecord>()
  existingRecords.forEach((record) => {
    recordsById.set(record.id, record)
  })

  const timestamp = Date.now()
  const activeIds = new Set<string>()

  sanitized.forEach((entry) => {
    activeIds.add(entry.id)
    const existing = recordsById.get(entry.id)
    if (existing) {
      recordsById.set(entry.id, updateRecordWithEntry(existing, entry, timestamp))
    } else {
      recordsById.set(entry.id, createRecordFromEntry(entry, timestamp))
    }
  })

  recordsById.forEach((record, id) => {
    if (!activeIds.has(id)) {
      recordsById.set(id, markRecordPendingDelete(record, timestamp))
    }
  })

  const nextRecords = Array.from(recordsById.values())
  const activeEntries = persistRecords(nextRecords)
  schedulePendingPush()
  return activeEntries
}

const payloadFromRecord = (
  record: HistoryRecord,
  userId: string,
  overrideUpdatedAt?: number,
): Record<string, unknown> => {
  const updatedAt = overrideUpdatedAt ?? record.updatedAt ?? Date.now()
  const createdAtSource =
    typeof record.createdAt === 'number'
      ? record.createdAt
      : typeof record.startedAt === 'number'
        ? record.startedAt
        : Date.now()
  const ENABLE_REPEAT_ORIGINAL = isRepeatOriginalEnabled()
  const INCLUDE_NOTES = isHistoryNotesEnabled()
  const INCLUDE_SUBTASKS = isHistorySubtasksEnabled()
  const validRepeatId = isUuid(record.repeatingSessionId)
  const includeRepeat = ENABLE_REPEAT_ORIGINAL && !!validRepeatId
  const includeOriginal = ENABLE_REPEAT_ORIGINAL && Number.isFinite(record.originalTime as number)
  const includeFuture = isHistoryFutureSessionEnabled() && typeof record.futureSession === 'boolean'
  const entryColor = record.entryColor ?? gradientFromSurface(record.goalSurface)
  return {
    id: record.id,
    user_id: userId,
    task_name: record.taskName,
    elapsed_ms: Math.max(0, Math.round(record.elapsed)),
    started_at: new Date(record.startedAt).toISOString(),
    ended_at: new Date(record.endedAt).toISOString(),
    goal_name: record.goalName,
    bucket_name: record.bucketName,
    entry_colour: entryColor,
    ...(INCLUDE_NOTES ? { notes: record.notes } : {}),
    ...(INCLUDE_SUBTASKS ? { subtasks: Array.isArray(record.subtasks) ? record.subtasks : [] } : {}),
    goal_id: isUuid(record.goalId) ? record.goalId : null,
    bucket_id: isUuid(record.bucketId) ? record.bucketId : null,
    task_id: isUuid(record.taskId) ? record.taskId : null,
    // Clamp surfaces to DB-allowed values to satisfy CHECK constraints server-side
    goal_surface: toDbSurface(record.goalSurface),
    created_at: new Date(createdAtSource).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
    ...(typeof record.futureSession === 'boolean' ? { future_session: record.futureSession } : {}),
    // Include server-side resolution metadata if enabled
    ...(includeRepeat ? { repeating_session_id: record.repeatingSessionId } : {}),
    ...(includeOriginal ? { original_time: new Date(record.originalTime as number).toISOString() } : {}),
    ...(includeFuture ? { future_session: record.futureSession } : {}),
  }
}

const mapDbRowToRecord = (row: Record<string, unknown>): HistoryRecord | null => {
  const id = typeof row.id === 'string' ? row.id : null
  if (!id) {
    return null
  }
  const taskName = typeof row.task_name === 'string' ? row.task_name : ''

  // Normalize remote timestamps to minute boundaries
  const rawStart = parseTimestamp(row.started_at, Date.now())
  const rawEnd = parseTimestamp(row.ended_at, rawStart)
  const startedAt = snapToNearestMinute(rawStart)
  const endedAt = snapToNearestMinute(rawEnd)
  const elapsed = clampNumber(row.elapsed_ms, Math.max(0, endedAt - startedAt))

  const candidate: HistoryCandidate = {
    id,
    taskName,
    elapsed,
    startedAt,
    endedAt,
    goalName: typeof row.goal_name === 'string' ? row.goal_name : null,
    bucketName: typeof row.bucket_name === 'string' ? row.bucket_name : null,
    goalId: typeof row.goal_id === 'string' ? row.goal_id : null,
    bucketId: typeof row.bucket_id === 'string' ? row.bucket_id : null,
    taskId: typeof row.task_id === 'string' ? row.task_id : null,
    goalSurface: typeof row.goal_surface === 'string' ? row.goal_surface : null,
    bucketSurface: null,
    entryColor: typeof (row as any).entry_colour === 'string' ? ((row as any).entry_colour as string) : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    subtasks: row.subtasks ?? null,
    futureSession: typeof (row as any).future_session === 'boolean' ? ((row as any).future_session as boolean) : null,
    repeatingSessionId: typeof (row as any).repeating_session_id === 'string' ? (row as any).repeating_session_id : null,
    originalTime: parseTimestamp((row as any).original_time, NaN),
  }

  const entry = sanitizeHistoryEntries([candidate])[0]
  if (!entry) {
    return null
  }

  const createdAt = parseTimestamp(row.created_at, startedAt)
  const updatedAt = parseTimestamp(row.updated_at, endedAt)
  return {
    ...entry,
    createdAt,
    updatedAt,
    pendingAction: null,
  }
}

let activeSyncPromise: Promise<HistoryEntry[] | null> | null = null
let pendingPushTimeout: number | null = null

const schedulePendingPush = (): void => {
  if (!supabase) {
    return
  }
  if (typeof window === 'undefined') {
    void pushPendingHistoryToSupabase()
    return
  }
  if (pendingPushTimeout !== null) {
    window.clearTimeout(pendingPushTimeout)
  }
  pendingPushTimeout = window.setTimeout(() => {
    pendingPushTimeout = null
    void pushPendingHistoryToSupabase()
  }, 25)
}

export const syncHistoryWithSupabase = async (): Promise<HistoryEntry[] | null> => {
  if (activeSyncPromise) {
    return activeSyncPromise
  }
  if (!supabase) {
    return null
  }

  activeSyncPromise = (async () => {
    const session = await ensureSingleUserSession()
    if (!session) {
      return null
    }

  const userId = session.user.id
  const lastUserId = getStoredHistoryUserId()
  const userChanged = lastUserId !== userId
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    let localRecords = readHistoryRecords()

    if (userChanged && localRecords.length > 0) {
      writeHistoryRecords([])
      localRecords = []
    }

    const recordsById = new Map<string, HistoryRecord>()
    if (!userChanged) {
      localRecords.forEach((record) => {
        recordsById.set(record.id, record)
      })
    }

    // Limit remote fetch to a recent window to reduce egress
    const sinceIso = new Date(now - HISTORY_REMOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    let remoteRows: any[] | null = null
    let fetchError: any = null
    let attempts = 0
    do {
      const selectColumns = buildHistorySelectColumns()
      const response = await supabase
        .from('session_history')
        .select((selectColumns as unknown) as any)
        .eq('user_id', userId)
        .gte('updated_at', sinceIso)
        .order('updated_at', { ascending: false })
      remoteRows = response.data as any
      fetchError = response.error as any
      if (!fetchError || !isColumnMissingError(fetchError)) {
        break
      }
      const missingRepeat =
        errorMentionsColumn(fetchError, 'repeating_session_id') || errorMentionsColumn(fetchError, 'original_time')
      const missingNotes = errorMentionsColumn(fetchError, 'notes')
      const missingSubtasks = errorMentionsColumn(fetchError, 'subtasks')
      let changed = false
      if (missingRepeat && isRepeatOriginalEnabled()) {
        disableRepeatOriginal()
        changed = true
      }
      if (missingNotes && isHistoryNotesEnabled()) {
        disableHistoryNotes()
        changed = true
      }
      if (missingSubtasks && isHistorySubtasksEnabled()) {
        disableHistorySubtasks()
        changed = true
      }
      if (!changed) {
        break
      }
      attempts += 1
    } while (attempts < 5)
    if (fetchError) {
      return null
    }

    const remoteMap = new Map<string, HistoryRecord>()
    ;((remoteRows as any[]) ?? []).forEach((row) => {
      const record = mapDbRowToRecord((row as unknown) as Record<string, unknown>)
      if (!record) {
        return
      }
      remoteMap.set(record.id, record)
      const local = recordsById.get(record.id)
      if (!local) {
        recordsById.set(record.id, record)
        return
      }
      const remoteTimestamp = record.updatedAt
      const localTimestamp = local.updatedAt
      if (remoteTimestamp > localTimestamp || (!local.pendingAction && remoteTimestamp === localTimestamp)) {
        // Preserve repeat-orig linkage if remote rows don't include these columns
        const repeatingSessionId = (record as any).repeatingSessionId ?? (local as any).repeatingSessionId ?? null
        const originalTime = Number.isFinite((record as any).originalTime)
          ? (record as any).originalTime
          : ((local as any).originalTime ?? null)
        recordsById.set(record.id, { ...record, repeatingSessionId, originalTime, pendingAction: null })
      }
    })

    // Remove records that were deleted remotely (not present in remoteMap and no local pending action)
    // Only apply delete within the remote window; keep older local records intact to avoid accidental purge.
    const sinceMs = now - HISTORY_REMOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    recordsById.forEach((record, id) => {
      if (!remoteMap.has(id) && !record.pendingAction) {
        if (record.updatedAt >= sinceMs) {
          recordsById.delete(id)
        }
      }
    })

    const pending = Array.from(recordsById.values()).filter((record) => record.pendingAction)
    const pendingUpserts = pending.filter((record) => record.pendingAction === 'upsert')
    const pendingDeletes = pending.filter((record) => record.pendingAction === 'delete')

    if (pendingUpserts.length > 0) {
      const client = supabase!
      const timestamp = Date.now()
      let payloads = pendingUpserts.map((record) => payloadFromRecord(record, userId, timestamp))
      let { resp: upsertResp, usedPayloads } = await upsertHistoryPayloads(client, payloads)
      if (upsertResp.error) {
        const code = String((upsertResp.error as any)?.code || '')
        const details =
          String((upsertResp.error as any)?.details || '') + ' ' + String((upsertResp.error as any)?.message || '')
        if (code === '23503' && details.toLowerCase().includes('repeating_sessions')) {
          const stripped = usedPayloads.map((payload) =>
            stripHistoryPayloadColumns(payload, { repeat: true, repeatingOnly: true }),
          )
          upsertResp = await client.from('session_history').upsert(stripped, { onConflict: 'id' })
          usedPayloads = stripped
        } else if (isConflictError(upsertResp.error)) {
          upsertResp = { ...upsertResp, error: null as any }
        }
      }
      if (!upsertResp.error) {
        pendingUpserts.forEach((record, index) => {
          const payload = usedPayloads[index]
          const updatedIso = typeof payload.updated_at === 'string' ? payload.updated_at : nowIso
          const updatedAt = Date.parse(updatedIso)
          record.pendingAction = null
          record.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
          recordsById.set(record.id, record)
        })
      }
    }

    if (pendingDeletes.length > 0) {
      const deleteIds = pendingDeletes.map((record) => record.id).filter((id) => isUuid(id))
      if (deleteIds.length > 0) {
        const { error: deleteError } = await supabase.from('session_history').delete().in('id', deleteIds)
        if (!deleteError) {
          deleteIds.forEach((id) => {
            recordsById.delete(id)
          })
        }
      }
      // Purge any non-UUID delete candidates locally since we can't delete them remotely
      pendingDeletes
        .filter((record) => !isUuid(record.id))
        .forEach((record) => {
          recordsById.delete(record.id)
        })
    }

    const recordList = Array.from(recordsById.values())
    const { records: enrichedRecords } = applyLifeRoutineSurfaces(recordList)
    const persisted = persistRecords(enrichedRecords)
  if (getStoredHistoryUserId() !== userId) {
    setStoredHistoryUserId(userId)
  }
    return persisted
  })()

  try {
    return await activeSyncPromise
  } finally {
    activeSyncPromise = null
  }
}

export const pushPendingHistoryToSupabase = async (): Promise<void> => {
  if (!supabase) {
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return
  }

  const userId = session.user.id
  const lastUserId = getStoredHistoryUserId()
  if (lastUserId !== null && lastUserId !== userId) {
    return
  }
  const records = readHistoryRecords()
  const pendingUpserts = records.filter((record) => record.pendingAction === 'upsert')
  const pendingDeletes = records.filter((record) => record.pendingAction === 'delete')
  if (pendingUpserts.length > 0) {
    const client = supabase!
    const timestamp = Date.now()
    let payloads = pendingUpserts.map((record) => payloadFromRecord(record, userId, timestamp))
    let { resp: upsertResp, usedPayloads } = await upsertHistoryPayloads(client, payloads)
    if (upsertResp.error) {
      const code = String((upsertResp.error as any)?.code || '')
      const details =
        String((upsertResp.error as any)?.details || '') + ' ' + String((upsertResp.error as any)?.message || '')
      if (code === '23503' && details.toLowerCase().includes('repeating_sessions')) {
        const stripped = usedPayloads.map((payload) => stripHistoryPayloadColumns(payload, { repeat: true }))
        upsertResp = await client.from('session_history').upsert(stripped, { onConflict: 'id' })
        usedPayloads = stripped
      } else if (isConflictError(upsertResp.error)) {
        upsertResp = { ...upsertResp, error: null as any }
      }
    }
    if (!upsertResp.error) {
      pendingUpserts.forEach((record, index) => {
        const payload = usedPayloads[index]
        const updatedIso = typeof payload.updated_at === 'string' ? payload.updated_at : new Date().toISOString()
        const updatedAt = Date.parse(updatedIso)
        record.pendingAction = null
        record.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
      })
    }
  }

  if (pendingDeletes.length > 0) {
    const uuidDeleteIds = pendingDeletes.map((record) => record.id).filter((id) => isUuid(id))
    if (uuidDeleteIds.length > 0) {
      const { error: deleteError } = await supabase.from('session_history').delete().in('id', uuidDeleteIds)
      if (!deleteError) {
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (uuidDeleteIds.includes(records[index].id)) {
            records.splice(index, 1)
          }
        }
      }
    }
    // Remove local-only ids that have no remote UUID equivalent.
    pendingDeletes
      .filter((record) => !isUuid(record.id))
      .forEach((record) => {
        const idx = records.findIndex((r) => r.id === record.id)
        if (idx !== -1) {
          records.splice(idx, 1)
        }
      })
  }

  persistRecords(records)
}

// Remove planned (futureSession) entries for a given rule that occur strictly AFTER the given local date (YYYY-MM-DD).
// Used when setting a repeating rule to "none" after a selected occurrence to avoid lingering planned rows.
export const pruneFuturePlannedForRuleAfter = async (ruleId: string, afterYmd: string): Promise<void> => {
  const records = readHistoryRecords()
  if (!Array.isArray(records) || records.length === 0) return
  const now = Date.now()
  let changed = false
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i] as any
    const rid = typeof r.repeatingSessionId === 'string' ? (r.repeatingSessionId as string) : null
    const ot = Number.isFinite(r.originalTime) ? Number(r.originalTime) : null
    const od = ot ? formatOccurrenceDate(ot) : null
    const isGuidePlaceholder = Boolean(r.futureSession) && rid && ot !== null
    if (isGuidePlaceholder && rid === ruleId && od && od >= afterYmd && (records[i] as any).pendingAction !== 'delete') {
      records[i] = { ...records[i], pendingAction: 'delete', updatedAt: now }
      changed = true
    }
  }
  if (changed) {
    persistRecords(records)
    schedulePendingPush()
  }
}

export const remapHistoryRoutineIds = async (mapping: Record<string, string>): Promise<void> => {
  if (!mapping || Object.keys(mapping).length === 0) {
    return
  }
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return

  let records = readHistoryRecords()
  const originalLength = records.length
  records = records.filter((record) => record.pendingAction !== 'delete')
  if (originalLength !== records.length) {
    writeHistoryRecords(records)
  }
  let changed = false
  records = records.map((record) => {
    if (record.repeatingSessionId && mapping[record.repeatingSessionId]) {
      changed = true
      return { ...record, repeatingSessionId: mapping[record.repeatingSessionId] }
    }
    return record
  })
  if (changed) {
    writeHistoryRecords(records)
  }
}

export const hasRemoteHistory = async (): Promise<boolean> => {
  if (!supabase) return true
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return true
  try {
    const { count, error } = await supabase
      .from('session_history')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
    if (error) {
      return true
    }
    return typeof count === 'number' && count > 0
  } catch {
    return true
  }
}

export const pushAllHistoryToSupabase = async (
  ruleIdMap?: Record<string, string>,
  seedTimestamp?: number,
  options?: { skipRemoteCheck?: boolean; strict?: boolean },
): Promise<void> => {
  const skipRemoteCheck = Boolean(options?.skipRemoteCheck)
  const strict = Boolean(options?.strict)
  const fail = (message: string, err?: unknown) => {
    if (strict) {
      throw err instanceof Error ? err : new Error(message)
    }
  }
  if (!supabase) {
    fail('Supabase client unavailable for history sync')
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    fail('No Supabase session for history sync')
    return
  }
  purgeDeletedHistoryRecords()
  if (!skipRemoteCheck) {
    const remoteExists = await hasRemoteHistory()
    if (remoteExists) {
      return
    }
  }
  let records = readHistoryRecords()
  if (!records || records.length === 0) {
    records = []
  }
  const uuidNormalized = records.map((record) => {
    if (isUuid(record.id)) {
      return record
    }
    const id = generateUuid()
    return { ...record, id }
  })
  if (uuidNormalized.some((record, index) => record.id !== records[index]?.id)) {
    records = uuidNormalized
    writeHistoryRecords(records)
  }
  const { records: lifeRoutineAligned, changed: alignedChanged } = applyLifeRoutineSurfaces(records)
  if (alignedChanged) {
    records = lifeRoutineAligned
    writeHistoryRecords(records)
  }
  const normalizedRecords = sortRecordsForStorage(records).map((record, index) => {
    let mappedRepeatingId = record.repeatingSessionId
    if (ruleIdMap && record.repeatingSessionId && ruleIdMap[record.repeatingSessionId]) {
      mappedRepeatingId = ruleIdMap[record.repeatingSessionId]
    }
    const createdAt =
      typeof record.createdAt === 'number'
        ? record.createdAt
        : typeof seedTimestamp === 'number'
          ? seedTimestamp + index
          : Date.now() + index
    return {
      ...record,
      createdAt,
      repeatingSessionId: mappedRepeatingId,
      pendingAction: null,
    }
  })
  const userId = session.user.id
  const payloads = normalizedRecords.map((record, index) =>
    payloadFromRecord(record, userId, seedTimestamp ? seedTimestamp + index : Date.now() + index),
  )
  const client = supabase!
  const { resp } = await upsertHistoryPayloads(client, payloads)
  if (resp?.error && !isConflictError(resp.error)) {
    fail('Failed to upsert session history', resp.error)
    return
  }
  persistRecords(normalizedRecords)
  setStoredHistoryUserId(session.user.id)
}
