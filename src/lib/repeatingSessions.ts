import { supabase, ensureSingleUserSession } from './supabaseClient'
import type { HistoryEntry } from './sessionHistory'
import { readStoredHistory, pruneFuturePlannedForRuleAfter, SAMPLE_SLEEP_ROUTINE_ID } from './sessionHistory'
import { readRepeatingExceptions } from './repeatingExceptions'

export type RepeatingSessionRule = {
  id: string
  isActive: boolean
  frequency: 'daily' | 'weekly' | 'monthly' | 'annually'
  // Array of JS weekdays: 0=Sun .. 6=Sat (required for weekly; supports multi-day)
  dayOfWeek: number[] | null
  // Minutes from midnight 0..1439
  timeOfDayMinutes: number
  // Default to 60 if not provided
  durationMinutes: number
  // Optional labeling/context
  taskName: string
  goalName: string | null
  bucketName: string | null
  timezone: string | null
  // Client activation boundary: only render guides for days strictly AFTER this local day start
  // Used to suppress the creation day when creating from an existing entry.
  createdAtMs?: number
  // Server-defined start/end boundaries (mapped from start_date/end_date). Used to bound
  // guide synthesis window. These are interpreted in local time (best-effort) unless
  // explicit timezone handling is added later.
  startAtMs?: number
  endAtMs?: number
}

export const REPEATING_RULES_STORAGE_KEY = 'nc-taskwatch-repeating-rules'
export const REPEATING_RULES_ACTIVATION_KEY = 'nc-taskwatch-repeating-activation-map'
// We also persist a local end-boundary override to ensure offline correctness.
export const REPEATING_RULES_END_KEY = 'nc-taskwatch-repeating-end-map'
const REPEATING_RULES_USER_KEY = 'nc-taskwatch-repeating-user'
const REPEATING_RULES_GUEST_USER_ID = '__guest__'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isRepeatingRuleId = (value: string | undefined | null): value is string =>
  typeof value === 'string' && UUID_REGEX.test(value)

const randomRuleId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {}
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const toJsWeekday = (val: number): number | null => {
  if (!Number.isFinite(val)) return null
  const n = Math.round(val)
  // Accept both JS (0-6) and DB (1-7, Sunday=1) encodings; normalize to JS 0-6.
  if (n >= 0 && n <= 6) return n
  if (n >= 1 && n <= 7) return (n + 6) % 7
  return null
}

const normalizeWeekdays = (value: unknown): number[] | null => {
  if (value === null || value === undefined) return null
  const arr = Array.isArray(value)
    ? value
    : value instanceof Set
      ? Array.from(value)
      : [value]
  const normalized = arr
    .map((v) => toJsWeekday(Number(v)))
    .filter((v): v is number => typeof v === 'number' && v >= 0 && v <= 6)
  if (normalized.length === 0) return []
  const uniq = Array.from(new Set(normalized))
  return uniq.sort((a, b) => a - b)
}

const toDbWeekdays = (days: number[] | null | undefined): number[] | null => {
  if (!Array.isArray(days)) return null
  const norm = days
    .map((d) => (Number.isFinite(d) ? Math.round(d) : NaN))
    .filter((d) => d >= 0 && d <= 6)
    .map((d) => d + 1) // DB stores 1-7 with Sunday=1
  if (norm.length === 0) return null
  const uniq = Array.from(new Set(norm))
  return uniq.sort((a, b) => a - b)
}

const ruleIncludesWeekday = (rule: RepeatingSessionRule, jsDow: number): boolean =>
  Array.isArray(rule.dayOfWeek) && rule.dayOfWeek.includes(jsDow)

const deriveRuleTaskNameFromParts = (
  taskName?: string | null,
  bucketName?: string | null,
  goalName?: string | null,
): string => {
  const task = typeof taskName === 'string' ? taskName.trim() : ''
  if (task.length > 0) return task
  const bucket = typeof bucketName === 'string' ? bucketName.trim() : ''
  if (bucket.length > 0) return bucket
  const goal = typeof goalName === 'string' ? goalName.trim() : ''
  if (goal.length > 0) return goal
  return 'Session'
}

const deriveRuleTaskNameFromEntry = (entry: HistoryEntry): string =>
  deriveRuleTaskNameFromParts(entry.taskName, entry.bucketName, entry.goalName)

const getSampleRepeatingRules = (): RepeatingSessionRule[] => {
  const now = new Date()
  now.setSeconds(0, 0)
  now.setMilliseconds(0)
  const anchor = new Date(now.getTime())
  anchor.setDate(anchor.getDate() - 3)
  anchor.setHours(23, 0, 0, 0)
  const activationStartMs = anchor.getTime()
  const timeOfDayMinutes = 23 * 60
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  return [
    {
      id: SAMPLE_SLEEP_ROUTINE_ID,
      isActive: true,
      frequency: 'daily',
      dayOfWeek: null,
      timeOfDayMinutes,
      durationMinutes: 8 * 60,
      taskName: 'Sleep',
      goalName: 'Daily Life',
      bucketName: 'Sleep',
      timezone,
      createdAtMs: activationStartMs,
      startAtMs: activationStartMs,
      endAtMs: undefined,
    },
  ]
}

export const readLocalRepeatingRules = (): RepeatingSessionRule[] => {
  if (typeof window === 'undefined') return getSampleRepeatingRules()
  try {
    const raw = window.localStorage.getItem(REPEATING_RULES_STORAGE_KEY)
    if (!raw) {
      const sample = getSampleRepeatingRules()
      writeLocalRules(sample)
      return sample
    }
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const mapped = arr
      .map((row) => mapRowToRule(row))
      .filter(Boolean) as RepeatingSessionRule[]
    if (mapped.length === 0) {
      const sample = getSampleRepeatingRules()
      writeLocalRules(sample)
      return sample
    }
    return mapped
  } catch {
    const sample = getSampleRepeatingRules()
    writeLocalRules(sample)
    return sample
  }
}

const writeLocalRules = (rules: RepeatingSessionRule[]) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(REPEATING_RULES_STORAGE_KEY, JSON.stringify(rules))
  } catch {}
}
export const storeRepeatingRulesLocal = (rules: RepeatingSessionRule[]): void => {
  writeLocalRules(rules)
}

type ActivationMap = Record<string, number>
const readActivationMap = (): ActivationMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(REPEATING_RULES_ACTIVATION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as ActivationMap : {}
  } catch {
    return {}
  }
}
const writeActivationMap = (map: ActivationMap) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(REPEATING_RULES_ACTIVATION_KEY, JSON.stringify(map))
  } catch {}
}

type EndMap = Record<string, number>
const readEndMap = (): EndMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(REPEATING_RULES_END_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? (parsed as EndMap) : {}
  } catch {
    return {}
  }
}
const writeEndMap = (map: EndMap) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(REPEATING_RULES_END_KEY, JSON.stringify(map))
  } catch {}
}

export const pushRepeatingRulesToSupabase = async (
  rules: RepeatingSessionRule[],
  options?: { strict?: boolean },
): Promise<Record<string, string>> => {
  const strict = Boolean(options?.strict)
  const fail = (message: string, err?: unknown): Record<string, string> => {
    if (strict) {
      throw err instanceof Error ? err : new Error(message)
    }
    return {}
  }
  if (!supabase) return fail('Supabase client unavailable for repeating rules')
  if (!rules || rules.length === 0) return {}
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return fail('No Supabase session for repeating rules sync')
  const idMap: Record<string, string> = {}
  const normalizedRules = rules.map((rule) => {
    const safeTaskName = deriveRuleTaskNameFromParts(rule.taskName, rule.bucketName, rule.goalName)
    const baseRule = { ...rule, taskName: safeTaskName, dayOfWeek: normalizeWeekdays(rule.dayOfWeek) }
    const incomingId = typeof rule.id === 'string' ? rule.id : null
    if (!isRepeatingRuleId(incomingId)) {
      const newId = randomRuleId()
      if (incomingId) {
        idMap[incomingId] = newId
      }
      return { ...baseRule, id: newId }
    }
    return baseRule
  })
  if (Object.keys(idMap).length > 0) {
    try {
      writeLocalRules(normalizedRules)
    } catch {
      // ignore local write issues
    }
  }
  const payloads = normalizedRules.map((rule) => {
    const dbDayOfWeek = toDbWeekdays(rule.dayOfWeek)
    const startIso =
      typeof rule.startAtMs === 'number'
        ? new Date(rule.startAtMs).toISOString()
        : typeof rule.createdAtMs === 'number'
          ? new Date(rule.createdAtMs).toISOString()
          : new Date().toISOString()
    const endIso = typeof rule.endAtMs === 'number' ? new Date(rule.endAtMs).toISOString() : null
    return {
      id: rule.id,
      user_id: session.user.id,
      is_active: rule.isActive,
      frequency: rule.frequency,
      day_of_week: dbDayOfWeek,
      time_of_day_minutes: rule.timeOfDayMinutes,
      duration_minutes: rule.durationMinutes,
      task_name: rule.taskName,
      goal_name: rule.goalName,
      bucket_name: rule.bucketName,
      timezone: rule.timezone,
      start_date: startIso,
      end_date: endIso,
      created_at: startIso,
      updated_at: new Date().toISOString(),
    }
  })
  const { error } = await supabase.from('repeating_sessions').upsert(payloads, { onConflict: 'id' })
  if (error) {
    return fail('Failed to upsert repeating rules', error)
  }
  return idMap
}

const readStoredRepeatingRuleUserId = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(REPEATING_RULES_USER_KEY)
    return raw && raw.trim().length > 0 ? raw.trim() : null
  } catch {
    return null
  }
}

const setStoredRepeatingRuleUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    if (!userId) {
      window.localStorage.removeItem(REPEATING_RULES_USER_KEY)
    } else {
      window.localStorage.setItem(REPEATING_RULES_USER_KEY, userId)
    }
  } catch {}
}

const normalizeRepeatingRuleUserId = (userId: string | null | undefined): string =>
  typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : REPEATING_RULES_GUEST_USER_ID

export const ensureRepeatingRulesUser = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  const normalized = normalizeRepeatingRuleUserId(userId)
  const current = readStoredRepeatingRuleUserId()
  if (current === normalized) {
    return
  }
  setStoredRepeatingRuleUserId(normalized)
  if (normalized === REPEATING_RULES_GUEST_USER_ID) {
    writeLocalRules(getSampleRepeatingRules())
  } else {
    writeLocalRules([])
    writeActivationMap({})
    writeEndMap({})
  }
}

const mapRowToRule = (row: any): RepeatingSessionRule | null => {
  if (!row) return null
  const id = typeof row.id === 'string' ? row.id : null
  if (!id) return null
  const frequency =
    row.frequency === 'daily' || row.frequency === 'weekly' || row.frequency === 'monthly' || row.frequency === 'annually'
      ? row.frequency
      : 'daily'
  // Accept both snake_case (DB) and camelCase (local fallback) shapes
  const dayOfWeek = normalizeWeekdays(
    Array.isArray(row.day_of_week) || typeof row.day_of_week === 'number'
      ? row.day_of_week
      : (Array.isArray(row.dayOfWeek) || typeof row.dayOfWeek === 'number' ? row.dayOfWeek : null),
  )
  const timeOfDayMinutes = Number.isFinite(row.time_of_day_minutes)
    ? Number(row.time_of_day_minutes)
    : (Number.isFinite(row.timeOfDayMinutes) ? Number(row.timeOfDayMinutes) : 0)
  const durationMinutes = Number.isFinite(row.duration_minutes)
    ? Math.max(1, Number(row.duration_minutes))
    : (Number.isFinite(row.durationMinutes) ? Math.max(1, Number(row.durationMinutes)) : 60)
  const isActive = typeof row.is_active === 'boolean' ? row.is_active : (row.isActive !== false)
  const goalName = typeof row.goal_name === 'string' ? row.goal_name : (typeof row.goalName === 'string' ? row.goalName : null)
  const bucketName = typeof row.bucket_name === 'string' ? row.bucket_name : (typeof row.bucketName === 'string' ? row.bucketName : null)
  const rawTaskName = typeof row.task_name === 'string' ? row.task_name : (typeof row.taskName === 'string' ? row.taskName : '')
  const taskName = deriveRuleTaskNameFromParts(rawTaskName, bucketName, goalName)
  const timezone = typeof row.timezone === 'string' ? row.timezone : (typeof row.timeZone === 'string' ? row.timeZone : null)
  // DB created_at is ISO string; local fallback may store createdAtMs
  let createdAtMs: number | undefined
  if (typeof row.createdAtMs === 'number' && Number.isFinite(row.createdAtMs)) {
    createdAtMs = Math.max(0, row.createdAtMs)
  } else if (typeof row.created_at === 'string') {
    const t = Date.parse(row.created_at)
    if (Number.isFinite(t)) {
      createdAtMs = t
    }
  }
  // Optional start_date / end_date from DB
  let startAtMs: number | undefined
  let endAtMs: number | undefined
  if (typeof row.startAtMs === 'number' && Number.isFinite(row.startAtMs)) {
    startAtMs = Math.max(0, row.startAtMs)
  } else if (typeof row.start_date === 'string') {
    const t = Date.parse(row.start_date)
    if (Number.isFinite(t)) startAtMs = t
  }
  if (typeof row.endAtMs === 'number' && Number.isFinite(row.endAtMs)) {
    endAtMs = Math.max(0, row.endAtMs)
  } else if (typeof row.end_date === 'string') {
    const t = Date.parse(row.end_date)
    if (Number.isFinite(t)) endAtMs = t
  }
  return {
    id,
    isActive,
    frequency,
    dayOfWeek,
    timeOfDayMinutes,
    durationMinutes,
    taskName,
    goalName,
    bucketName,
    timezone,
    createdAtMs,
    startAtMs,
    endAtMs,
  }
}

export async function fetchRepeatingSessionRules(): Promise<RepeatingSessionRule[]> {
  if (!supabase) return readLocalRepeatingRules()
  const session = await ensureSingleUserSession()
  if (!session) return readLocalRepeatingRules()
  const { data, error } = await supabase
    .from('repeating_sessions')
    .select(
      'id, is_active, frequency, day_of_week, time_of_day_minutes, duration_minutes, task_name, goal_name, bucket_name, timezone, start_date, end_date, created_at, updated_at',
    )
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: true })
  if (error) {
    return readLocalRepeatingRules()
  }
  let remote = (data ?? []).map(mapRowToRule).filter(Boolean) as RepeatingSessionRule[]
  // Merge persisted activation boundaries by rule id (client-side sticky value)
  const act = readActivationMap()
  if (act && typeof act === 'object') {
    remote = remote.map((r) => (act[r.id] ? { ...r, createdAtMs: Math.max(0, Number(act[r.id])) } : r))
  }
  // Merge locally persisted end boundaries
  const endMap = readEndMap()
  if (endMap && typeof endMap === 'object') {
    remote = remote.map((r) => (endMap[r.id] ? { ...r, endAtMs: Math.max(0, Number(endMap[r.id])) } : r))
  }
  return remote
}

export async function createRepeatingRuleForEntry(
  entry: HistoryEntry,
  frequency: 'daily' | 'weekly' | 'monthly' | 'annually',
  options?: { weeklyDays?: number[] | Set<number> },
): Promise<RepeatingSessionRule | null> {
  const startLocal = new Date(entry.startedAt)
  const hours = startLocal.getHours()
  const minutes = startLocal.getMinutes()
  const timeOfDayMinutes = hours * 60 + minutes
  const durationMs = Math.max(1, entry.endedAt - entry.startedAt)
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000))
  const weeklyDaysNormalized = frequency === 'weekly'
    ? (() => {
        const normalized = normalizeWeekdays(options?.weeklyDays ?? [startLocal.getDay()]) ?? []
        return normalized.length > 0 ? normalized : [startLocal.getDay()]
      })()
    : null
  const dayOfWeek = frequency === 'weekly' ? weeklyDaysNormalized : null
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null
  // Canonicalize series start to the scheduled minute (truncate seconds/ms) so it matches
  // guide occurrence timestamps exactly. This avoids start/end millisecond mismatches later.
  const dayStart = (() => { const d = new Date(entry.startedAt); d.setHours(0,0,0,0); return d.getTime() })()
  const ruleStartMs = dayStart + timeOfDayMinutes * 60000
  // To avoid creating a guide on top of the source entry, start the series at the
  // NEXT occurrence after this entry (next day for daily, next same weekday for weekly).
  const nextStartMs = (() => {
    const DAY_MS = 24 * 60 * 60 * 1000
    if (frequency === 'daily') return ruleStartMs + DAY_MS
    if (frequency === 'weekly') {
      const days = Array.isArray(weeklyDaysNormalized) && weeklyDaysNormalized.length > 0
        ? weeklyDaysNormalized
        : [startLocal.getDay()]
      for (let offset = 1; offset <= 7; offset += 1) {
        const candidate = ruleStartMs + offset * DAY_MS
        if (days.includes(new Date(candidate).getDay())) return candidate
      }
      return ruleStartMs + 7 * DAY_MS
    }
    if (frequency === 'monthly') return addMonthsClamped(ruleStartMs, 1)
    // annually: same month/day next year at same time
    const base = new Date(ruleStartMs)
    base.setFullYear(base.getFullYear() + 1)
    return base.getTime()
  })()

  // Try Supabase; if not available, persist locally
  const ruleTaskName = deriveRuleTaskNameFromEntry(entry)

  if (!supabase) {
    const localRule: RepeatingSessionRule = {
      id: randomRuleId(),
      isActive: true,
      frequency,
      dayOfWeek,
      timeOfDayMinutes,
      durationMinutes,
      taskName: ruleTaskName,
      goalName: entry.goalName ?? null,
      bucketName: entry.bucketName ?? null,
      timezone: tz,
      createdAtMs: Math.max(0, entry.startedAt),
      startAtMs: Math.max(0, nextStartMs),
    }
    const current = readLocalRepeatingRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    const localRule: RepeatingSessionRule = {
      id: randomRuleId(),
      isActive: true,
      frequency,
      dayOfWeek,
      timeOfDayMinutes,
      durationMinutes,
      taskName: ruleTaskName,
      goalName: entry.goalName ?? null,
      bucketName: entry.bucketName ?? null,
      timezone: tz,
      createdAtMs: Math.max(0, entry.startedAt),
      startAtMs: Math.max(0, nextStartMs),
    }
    const current = readLocalRepeatingRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  const dbDayOfWeek = toDbWeekdays(dayOfWeek)
  const payload = {
    user_id: session.user.id,
    is_active: true,
    frequency,
    day_of_week: dbDayOfWeek,
    time_of_day_minutes: timeOfDayMinutes,
    duration_minutes: durationMinutes,
    task_name: ruleTaskName,
    goal_name: entry.goalName,
    bucket_name: entry.bucketName,
    timezone: tz,
    start_date: new Date(nextStartMs).toISOString(),
  }
  const { data, error } = await supabase
    .from('repeating_sessions')
    .insert(payload)
    .select('id, is_active, frequency, day_of_week, time_of_day_minutes, duration_minutes, task_name, goal_name, bucket_name, timezone, start_date, end_date, created_at')
    .single()
  if (error) {
    // Fallback: store locally so user still sees guides
    const localRule: RepeatingSessionRule = {
      id: randomRuleId(),
      isActive: true,
      frequency,
      dayOfWeek,
      timeOfDayMinutes,
      durationMinutes,
      taskName: ruleTaskName,
      goalName: entry.goalName ?? null,
      bucketName: entry.bucketName ?? null,
      timezone: tz,
      createdAtMs: Math.max(0, entry.startedAt),
      startAtMs: Math.max(0, nextStartMs),
    }
    const current = readLocalRepeatingRules()
    const next = [...current, localRule]
    writeLocalRules(next)
    return localRule
  }
  // Attach activation boundary to the returned rule and persist the mapping by id
  const rule = mapRowToRule(data as any)
  if (rule) {
    const activationMs = Math.max(0, entry.startedAt)
    const merged: RepeatingSessionRule = { ...rule, createdAtMs: activationMs, startAtMs: rule.startAtMs ?? activationMs }
    const act = readActivationMap()
    act[merged.id] = activationMs
    writeActivationMap(act)
    return merged
  }
  return rule
}

export async function deactivateRepeatingRule(id: string): Promise<boolean> {
  if (!supabase) return false
  const session = await ensureSingleUserSession()
  if (!session) return false
  const { error } = await supabase
    .from('repeating_sessions')
    .update({ is_active: false })
    .eq('id', id)
    .eq('user_id', session.user.id)
  if (error) {
    return false
  }
  return true
}

// Deactivate all rules that match the given entry's labeling, time of day, duration,
// and (for weekly) the same day-of-week. Returns the list of rule ids deactivated.
export async function deactivateMatchingRulesForEntry(entry: HistoryEntry): Promise<string[]> {
  const startLocal = new Date(entry.startedAt)
  const minutes = startLocal.getHours() * 60 + startLocal.getMinutes()
  const durationMs = Math.max(1, entry.endedAt - entry.startedAt)
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000))
  const dow = startLocal.getDay()
  const dbDowArray = toDbWeekdays([dow])
  const monthDay = monthDayKey(startLocal.getTime())
  const dayOfMonthVal = startLocal.getDate()
  const task = entry.taskName ?? ''
  const goal = entry.goalName ?? null
  const bucket = entry.bucketName ?? null

  // Local fallback path: mark matching rules inactive and persist
  const deactivateLocal = (): string[] => {
    const rules = readLocalRepeatingRules()
    const ids: string[] = []
    const next = rules.map((r) => {
      const labelMatch = (r.taskName ?? '') === task && (r.goalName ?? null) === goal && (r.bucketName ?? null) === bucket
      const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durationMinutes
      const freqMatch =
        r.frequency === 'daily' ||
        (r.frequency === 'weekly' && ruleIncludesWeekday(r, dow)) ||
        (r.frequency === 'monthly' && getRuleDayOfMonth(r) === dayOfMonthVal) ||
        (r.frequency === 'annually' && getRuleMonthDayKey(r) === monthDay)
      if (r.isActive && labelMatch && timeMatch && freqMatch) {
        ids.push(r.id)
        return { ...r, isActive: false }
      }
      return r
    })
    writeLocalRules(next)
    return ids
  }

  if (!supabase) {
    return deactivateLocal()
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return deactivateLocal()
  }

  const ids: string[] = []
  // Daily
  const { data: dailyRows, error: dailyErr } = await supabase
    .from('repeating_sessions')
    .update({ is_active: false })
    .eq('user_id', session.user.id)
    .eq('frequency', 'daily')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
    .select('id')
  if (!dailyErr && Array.isArray(dailyRows)) {
    ids.push(...dailyRows.map((r: any) => String(r.id)))
  }

  // Weekly (same dow)
  if (dbDowArray && dbDowArray.length > 0) {
    const { data: weeklyRows, error: weeklyErr } = await supabase
      .from('repeating_sessions')
      .update({ is_active: false })
      .eq('user_id', session.user.id)
      .eq('frequency', 'weekly')
      .contains('day_of_week', dbDowArray)
      .eq('time_of_day_minutes', minutes)
      .eq('duration_minutes', durationMinutes)
      .eq('task_name', task)
      .eq('goal_name', goal)
      .eq('bucket_name', bucket)
      .select('id')
    if (!weeklyErr && Array.isArray(weeklyRows)) {
      ids.push(...weeklyRows.map((r: any) => String(r.id)))
    }
  }

  // Monthly (same day of month)
  const { data: monthlyRows } = await supabase
    .from('repeating_sessions')
    .select('id, start_date')
    .eq('user_id', session.user.id)
    .eq('frequency', 'monthly')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
  const monthlyIds =
    Array.isArray(monthlyRows) && monthlyRows.length > 0
      ? monthlyRows
          .filter((row: any) => {
            const start = typeof row.start_date === 'string' ? Date.parse(row.start_date) : NaN
            if (!Number.isFinite(start)) return false
            return new Date(start).getDate() === dayOfMonthVal
          })
          .map((r: any) => String(r.id))
      : []
  if (monthlyIds.length > 0) {
    const { error: monthlyUpdateErr } = await supabase
      .from('repeating_sessions')
      .update({ is_active: false })
      .eq('user_id', session.user.id)
      .in('id', monthlyIds)
    if (!monthlyUpdateErr) {
      ids.push(...monthlyIds)
    }
  }

  // Annually (same month/day)
  const { data: annualRows } = await supabase
    .from('repeating_sessions')
    .select('id, start_date')
    .eq('user_id', session.user.id)
    .eq('frequency', 'annually')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
  const annualIds =
    Array.isArray(annualRows) && annualRows.length > 0
      ? annualRows
          .filter((row: any) => {
            const start = typeof row.start_date === 'string' ? Date.parse(row.start_date) : NaN
            if (!Number.isFinite(start)) return false
            return monthDayKey(start) === monthDay
          })
          .map((r: any) => String(r.id))
      : []
  if (annualIds.length > 0) {
    const { error: annualUpdateErr } = await supabase
      .from('repeating_sessions')
      .update({ is_active: false })
      .eq('user_id', session.user.id)
      .in('id', annualIds)
    if (!annualUpdateErr) {
      ids.push(...annualIds)
    }
  }

  return ids
}

// Delete all rules that match the given entry (label/time/duration and weekly dow when applicable).
// Returns the list of deleted rule ids. Local fallback removes from local cache.
export async function deleteMatchingRulesForEntry(entry: HistoryEntry): Promise<string[]> {
  const startLocal = new Date(entry.startedAt)
  const minutes = startLocal.getHours() * 60 + startLocal.getMinutes()
  const durationMs = Math.max(1, entry.endedAt - entry.startedAt)
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000))
  const dow = startLocal.getDay()
  const dbDowArray = toDbWeekdays([dow])
  const monthDay = monthDayKey(startLocal.getTime())
  const dayOfMonthVal = startLocal.getDate()
  const task = entry.taskName ?? ''
  const goal = entry.goalName ?? null
  const bucket = entry.bucketName ?? null

  const deleteLocal = (): string[] => {
    const rules = readLocalRepeatingRules()
    const ids: string[] = []
    const next = rules.filter((r) => {
      const labelMatch = (r.taskName ?? '') === task && (r.goalName ?? null) === goal && (r.bucketName ?? null) === bucket
      const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durationMinutes
      const freqMatch =
        r.frequency === 'daily' ||
        (r.frequency === 'weekly' && ruleIncludesWeekday(r, dow)) ||
        (r.frequency === 'monthly' && getRuleDayOfMonth(r) === dayOfMonthVal) ||
        (r.frequency === 'annually' && getRuleMonthDayKey(r) === monthDay)
      const match = labelMatch && timeMatch && freqMatch
      if (match) ids.push(r.id)
      return !match
    })
    writeLocalRules(next)
    return ids
  }

  if (!supabase) {
    return deleteLocal()
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return deleteLocal()
  }

  const ids: string[] = []
  // Daily
  const { data: dailyRows, error: dailyErr } = await supabase
    .from('repeating_sessions')
    .delete()
    .eq('user_id', session.user.id)
    .eq('frequency', 'daily')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
    .select('id')
  if (!dailyErr && Array.isArray(dailyRows)) {
    ids.push(...dailyRows.map((r: any) => String(r.id)))
  }

  // Weekly (same dow)
  if (dbDowArray && dbDowArray.length > 0) {
    const { data: weeklyRows, error: weeklyErr } = await supabase
      .from('repeating_sessions')
      .delete()
      .eq('user_id', session.user.id)
      .eq('frequency', 'weekly')
      .contains('day_of_week', dbDowArray)
      .eq('time_of_day_minutes', minutes)
      .eq('duration_minutes', durationMinutes)
      .eq('task_name', task)
      .eq('goal_name', goal)
      .eq('bucket_name', bucket)
      .select('id')
    if (!weeklyErr && Array.isArray(weeklyRows)) {
      ids.push(...weeklyRows.map((r: any) => String(r.id)))
    }
  }

  // Monthly (same day of month)
  const { data: monthlyRows } = await supabase
    .from('repeating_sessions')
    .select('id, start_date')
    .eq('user_id', session.user.id)
    .eq('frequency', 'monthly')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
  const monthlyIds =
    Array.isArray(monthlyRows) && monthlyRows.length > 0
      ? monthlyRows
          .filter((row: any) => {
            const start = typeof row.start_date === 'string' ? Date.parse(row.start_date) : NaN
            if (!Number.isFinite(start)) return false
            return new Date(start).getDate() === dayOfMonthVal
          })
          .map((r: any) => String(r.id))
      : []
  if (monthlyIds.length > 0) {
    const { error: monthlyDeleteErr } = await supabase
      .from('repeating_sessions')
      .delete()
      .eq('user_id', session.user.id)
      .in('id', monthlyIds)
      .select('id')
    if (!monthlyDeleteErr) {
      ids.push(...monthlyIds)
    }
  }

  // Annually (same month/day)
  const { data: annualRows } = await supabase
    .from('repeating_sessions')
    .select('id, start_date')
    .eq('user_id', session.user.id)
    .eq('frequency', 'annually')
    .eq('time_of_day_minutes', minutes)
    .eq('duration_minutes', durationMinutes)
    .eq('task_name', task)
    .eq('goal_name', goal)
    .eq('bucket_name', bucket)
  const annualIds =
    Array.isArray(annualRows) && annualRows.length > 0
      ? annualRows
          .filter((row: any) => {
            const start = typeof row.start_date === 'string' ? Date.parse(row.start_date) : NaN
            if (!Number.isFinite(start)) return false
            return monthDayKey(start) === monthDay
          })
          .map((r: any) => String(r.id))
      : []
  if (annualIds.length > 0) {
    const { error: annualDeleteErr } = await supabase
      .from('repeating_sessions')
      .delete()
      .eq('user_id', session.user.id)
      .in('id', annualIds)
      .select('id')
    if (!annualDeleteErr) {
      ids.push(...annualIds)
    }
  }

  return ids
}

// --- Utilities for date math (local) ---
const DAY_MS = 24 * 60 * 60 * 1000
const toLocalDayStart = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const monthDayKey = (ms: number): string => {
  const d = new Date(ms)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${m}-${day}`
}
const dayOfMonth = (ms: number): number => {
  const d = new Date(ms)
  return d.getDate()
}
const getRuleAnchorTimestamp = (rule: RepeatingSessionRule): number | null => {
  const source =
    Number.isFinite((rule as any).startAtMs as number)
      ? ((rule as any).startAtMs as number)
      : Number.isFinite((rule as any).createdAtMs as number)
        ? ((rule as any).createdAtMs as number)
        : null
  return Number.isFinite(source as number) ? (source as number) : null
}
const parseLocalYmd = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map((t) => Number(t))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN
  const dt = new Date(y, (m - 1), d)
  dt.setHours(0, 0, 0, 0)
  return dt.getTime()
}
const formatLocalYmd = (ms: number): string => {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const getRuleMonthDayKey = (rule: RepeatingSessionRule): string | null => {
  const anchor = getRuleAnchorTimestamp(rule)
  if (!Number.isFinite(anchor as number)) return null
  return monthDayKey(anchor as number)
}
const getRuleDayOfMonth = (rule: RepeatingSessionRule): number | null => {
  const anchor = getRuleAnchorTimestamp(rule)
  if (!Number.isFinite(anchor as number)) return null
  return dayOfMonth(anchor as number)
}
const addMonthsClamped = (ms: number, months: number, anchorDay?: number): number => {
  const base = new Date(ms)
  const dayAnchor = Number.isFinite(anchorDay as number) ? (anchorDay as number) : base.getDate()
  const next = new Date(base.getTime())
  next.setDate(1)
  next.setMonth(next.getMonth() + months)
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(dayAnchor, lastDay))
  return next.getTime()
}

// Update the end boundary for a rule by id. Persists locally and remotely when possible.
export async function updateRepeatingRuleEndDate(ruleId: string, endAtMs: number): Promise<boolean> {
  // Persist local end map for offline correctness
  const endMap = readEndMap()
  endMap[ruleId] = Math.max(0, endAtMs)
  writeEndMap(endMap)
  // Also update the cached local rules blob if present
  const local = readLocalRepeatingRules()
  const idx = local.findIndex((r) => r.id === ruleId)
  if (idx >= 0) {
    local[idx] = { ...local[idx], endAtMs: Math.max(0, endAtMs) }
    writeLocalRules(local)
  }
  if (!supabase) return true
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return true // local-only fallback ok
  const { error } = await supabase
    .from('repeating_sessions')
    .update({ end_date: new Date(endAtMs).toISOString() })
    .eq('id', ruleId)
    .eq('user_id', session.user.id)
  if (error) {
    return false
  }
  // After updating, fetch start_date and end_date. If equal, delete the row since nothing repeats.
  const { data: row, error: fetchErr } = await supabase
    .from('repeating_sessions')
    .select('id, start_date, end_date')
    .eq('id', ruleId)
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (!fetchErr && row) {
    const s = typeof (row as any).start_date === 'string' ? Date.parse((row as any).start_date) : NaN
    const e = typeof (row as any).end_date === 'string' ? Date.parse((row as any).end_date) : NaN
    if (Number.isFinite(s) && Number.isFinite(e) && s === e) {
      // Clean up local caches first
      const current = readLocalRepeatingRules()
      const filtered = current.filter((r) => r.id !== ruleId)
      if (filtered.length !== current.length) writeLocalRules(filtered)
      const act = readActivationMap()
      if (ruleId in act) { delete act[ruleId]; writeActivationMap(act) }
      const em = readEndMap()
      if (ruleId in em) { delete em[ruleId]; writeEndMap(em) }
      // Delete remotely
      await supabase.from('repeating_sessions').delete().eq('id', ruleId).eq('user_id', session.user.id)
    }
  }
  return true
}

// Delete a single repeating rule by id on server; remove from local cache too.
export async function deleteRepeatingRuleById(ruleId: string): Promise<boolean> {
  // Local remove first
  const local = readLocalRepeatingRules()
  const next = local.filter((r) => r.id !== ruleId)
  if (next.length !== local.length) writeLocalRules(next)
  const act = readActivationMap()
  if (ruleId in act) {
    delete act[ruleId]
    writeActivationMap(act)
  }
  const endMap = readEndMap()
  if (ruleId in endMap) {
    delete endMap[ruleId]
    writeEndMap(endMap)
  }
  if (!supabase) return true
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return true
  const { error } = await supabase
    .from('repeating_sessions')
    .delete()
    .eq('id', ruleId)
    .eq('user_id', session.user.id)
  if (error) {
    return false
  }
  return true
}

// Determine whether all occurrences within a rule's bounded window are resolved (confirmed or excepted).
export function isRuleWindowFullyResolved(
  rule: RepeatingSessionRule,
  options: { history: Array<{ routineId?: string | null; occurrenceDate?: string | null }>; exceptions: Array<{ routineId: string; occurrenceDate: string }> },
): boolean {
  // Require an end boundary to consider retirement
  if (!Number.isFinite(rule.endAtMs as number)) return false
  const endDay = toLocalDayStart(rule.endAtMs as number)
  // Window start: prefer explicit startAtMs; else use createdAtMs but skip activation day
  let startDay = Number.isFinite(rule.startAtMs as number) ? toLocalDayStart(rule.startAtMs as number) : undefined
  if (startDay === undefined || !Number.isFinite(startDay)) {
    if (Number.isFinite(rule.createdAtMs as number)) {
      startDay = toLocalDayStart(rule.createdAtMs as number) + DAY_MS // skip activation day
    }
  }
  if (!Number.isFinite(startDay as number)) return false
  const start = startDay as number
  const confirmed = new Set<string>()
  options.history.forEach((h) => {
    if (h.routineId && h.occurrenceDate) confirmed.add(`${h.routineId}:${h.occurrenceDate}`)
  })
  const excepted = new Set<string>()
  options.exceptions.forEach((e) => excepted.add(`${e.routineId}:${e.occurrenceDate}`))

  const makeKey = (ruleId: string, dayMs: number) => {
    const d = new Date(dayMs)
    const y = d.getFullYear()
    const m = (d.getMonth() + 1).toString().padStart(2, '0')
    const dd = d.getDate().toString().padStart(2, '0')
    return `${ruleId}:${y}-${m}-${dd}`
  }

  if (rule.frequency === 'daily') {
    for (let day = start; day <= endDay; day += DAY_MS) {
      const key = makeKey(rule.id, day)
      if (!confirmed.has(key) && !excepted.has(key)) return false
    }
    return true
  }
  if (rule.frequency === 'monthly') {
    const anchorDay = getRuleDayOfMonth(rule) ?? new Date(start).getDate()
    let day = start
    while (day <= endDay) {
      const key = makeKey(rule.id, day)
      if (!confirmed.has(key) && !excepted.has(key)) return false
      const next = addMonthsClamped(day, 1, anchorDay)
      if (next === day) break
      day = toLocalDayStart(next)
    }
    return true
  }
  if (rule.frequency === 'annually') {
    let day = start
    const anchorMonthDay = monthDayKey(start)
    while (day <= endDay) {
      if (monthDayKey(day) === anchorMonthDay) {
        const key = makeKey(rule.id, day)
        if (!confirmed.has(key) && !excepted.has(key)) return false
      }
      const next = new Date(day)
      next.setFullYear(next.getFullYear() + 1)
      day = next.getTime()
    }
    return true
  }
  // weekly
  const dows = Array.isArray(rule.dayOfWeek) ? rule.dayOfWeek : []
  if (dows.length === 0) return true
  for (let day = start; day <= endDay; day += DAY_MS) {
    const dow = new Date(day).getDay()
    if (!dows.includes(dow)) continue
    const key = makeKey(rule.id, day)
    if (!confirmed.has(key) && !excepted.has(key)) return false
  }
  return true
}

// Set repeat to none for all future occurrences after the selected occurrence date (YYYY-MM-DD, local).
// This updates the rule's end boundary to the start of the NEXT local day so the selected occurrence remains.
export async function setRepeatToNoneAfterOccurrence(
  ruleId: string,
  occurrenceDateYmd: string,
  prunePlanned: (ruleId: string, afterYmd: string) => Promise<void> | void,
): Promise<boolean> {
  const occStart = parseLocalYmd(occurrenceDateYmd)
  if (!Number.isFinite(occStart)) return false
  const DAY_MS = 24 * 60 * 60 * 1000
  // Set boundary to the start of the next local day so the selected occurrence is still included
  const ok = await updateRepeatingRuleEndDate(ruleId, occStart + DAY_MS)
  try {
    await prunePlanned(ruleId, occurrenceDateYmd)
  } catch {}
  return ok
}

// Convenience wrapper that uses the built-in planned-entry pruner
export async function setRepeatToNoneAfterOccurrenceDefault(ruleId: string, occurrenceDateYmd: string): Promise<boolean> {
  return await setRepeatToNoneAfterOccurrence(ruleId, occurrenceDateYmd, pruneFuturePlannedForRuleAfter)
}

// Variant that uses a precise selected startedAt timestamp (ms). end_date is set to this timestamp,
// and planned entries after the selected LOCAL day are pruned. Boundary is nudged forward so the
// selected occurrence remains visible, but subsequent ones are suppressed.
export async function setRepeatToNoneAfterTimestamp(ruleId: string, selectedStartMs: number): Promise<boolean> {
  const ymd = formatLocalYmd(selectedStartMs)
  const ok = await updateRepeatingRuleEndDate(ruleId, Math.max(0, selectedStartMs) + 1)
  try {
    await pruneFuturePlannedForRuleAfter(ruleId, ymd)
  } catch {}
  return ok
}

// Evaluate a single rule by id and delete it if it has an end boundary and all occurrences in the
// bounded window are resolved (confirmed/skipped/rescheduled). Returns true if deleted.
export async function evaluateAndMaybeRetireRule(ruleId: string): Promise<boolean> {
  const rules = await fetchRepeatingSessionRules()
  const rule = rules.find((r) => r.id === ruleId)
  if (!rule) return false
  if (!Number.isFinite(rule.endAtMs as number)) return false
  const history = readStoredHistory()
  const exceptions = readRepeatingExceptions()
  const resolved = isRuleWindowFullyResolved(rule, {
    history: history.map((h) => {
      const rid = (h as any).repeatingSessionId ?? null
      const ot = (h as any).originalTime as number | undefined | null
      const occ = rid && Number.isFinite(ot as number) ? formatLocalYmd(ot as number) : null
      return { routineId: rid, occurrenceDate: occ }
    }),
    exceptions: exceptions.map((e) => ({ routineId: e.routineId, occurrenceDate: e.occurrenceDate })),
  })
  if (!resolved) return false
  return await deleteRepeatingRuleById(ruleId)
}
