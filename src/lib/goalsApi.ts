import { supabase, ensureSingleUserSession } from './supabaseClient'
import { QUICK_LIST_GOAL_NAME, generateUuid } from './quickListRemote'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, ensureServerBucketStyle } from './surfaceStyles'
// Surface styles are now neutralized for goals; keep import placeholder-free.

export const GOAL_COLOUR_PRESETS: Record<string, string> = {
  purple: 'linear-gradient(135deg, #5A00B8 0%, #C66BFF 100%)',
  green: 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  magenta: 'linear-gradient(-225deg, #A445B2 0%, #D41872 52%, #FF0066 100%)',
  blue: 'linear-gradient(135deg, #005bea 0%, #00c6fb 100%)',
  orange: 'linear-gradient(135deg, #ff5b14 0%, #ffc64d 100%)',
}
export const FALLBACK_GOAL_COLOR = GOAL_COLOUR_PRESETS['purple']

export const normalizeGoalColour = (
  value: string | null | undefined,
  fallback: string = FALLBACK_GOAL_COLOR,
): string => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) {
      const preset = GOAL_COLOUR_PRESETS[trimmed]
      if (preset) return preset
      if (trimmed.toLowerCase().includes('gradient(')) {
        return trimmed
      }
      const cssFunctionLike =
        trimmed.startsWith('var(') ||
        trimmed.startsWith('rgb(') ||
        trimmed.startsWith('rgba(') ||
        trimmed.startsWith('hsl(') ||
        trimmed.startsWith('hsla(')
      if (cssFunctionLike) {
        return trimmed
      }
      const hexMatch = trimmed.match(/^#?[0-9a-fA-F]{6}$/)
      if (hexMatch) {
        const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
        return `linear-gradient(135deg, ${hex} 0%, ${hex} 100%)`
      }
      return trimmed
    }
  }
  return fallback
}

const sanitizeBucketSurfaceStyle = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  return ensureServerBucketStyle(value, DEFAULT_SURFACE_STYLE)
}

export type DbGoal = {
  id: string
  name: string
  goal_colour: string
  sort_index: number
  card_surface?: string | null
  starred: boolean
  goal_archive?: boolean
  milestones_shown?: boolean
}
export type DbBucket = {
  id: string
  user_id: string
  goal_id: string
  name: string
  favorite: boolean
  sort_index: number
  buckets_card_style: string | null
  bucket_archive?: boolean
}
export type DbTask = {
  id: string
  user_id: string
  bucket_id: string
  text: string
  completed: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  priority: boolean
  sort_index: number
  // Notes can be large; avoid fetching by default in list APIs
  notes: string | null
}

export type DbTaskSubtask = {
  id: string
  user_id: string
  task_id: string
  text: string
  completed: boolean
  sort_index: number
}

// ---------- Milestones ----------
export type DbGoalMilestone = {
  id: string
  user_id: string
  goal_id: string
  name: string
  target_date: string // timestamptz ISO string
  completed: boolean
  role: 'start' | 'end' | 'normal'
  hidden?: boolean
}

export async function fetchGoalCreatedAt(goalId: string): Promise<string | null> {
  if (!supabase) return null
  const userId = await getActiveUserId()
  if (!userId) return null
  const { data, error } = await supabase
    .from('goals')
    .select('created_at')
    .eq('id', goalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    return null
  }
  const value = (data as any)?.created_at
  return typeof value === 'string' ? value : null
}

type TaskSubtaskSeed = {
  id?: string
  text: string
  completed?: boolean
  sortIndex?: number
}

type TaskSeed = {
  id?: string
  text: string
  completed?: boolean
  difficulty?: DbTask['difficulty']
  priority?: boolean
  notes?: string
  subtasks?: TaskSubtaskSeed[]
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined | null): value is string => !!value && UUID_REGEX.test(value)

type BucketSeed = {
  name: string
  favorite?: boolean
  archived?: boolean
  surfaceStyle?: string | null
  tasks?: TaskSeed[]
}

export type GoalSeed = {
  name: string
  goalColour?: string | null
  surfaceStyle?: string | null
  starred?: boolean
  archived?: boolean
  buckets?: BucketSeed[]
}

async function getActiveUserId(): Promise<string | null> {
  const session = await ensureSingleUserSession()
  return session?.user?.id ?? null
}

/** Fetch Goals → Buckets → Tasks for the current session user, ordered for UI. */
export async function fetchGoalsHierarchy(): Promise<
  | null
  | {
      goals: Array<{
        id: string
        name: string
        goalColour: string
        createdAt?: string
        surfaceStyle?: string | null
        starred?: boolean
        archived?: boolean
        milestonesShown?: boolean
        buckets: Array<{
          id: string
          name: string
          favorite: boolean
          archived?: boolean
          surfaceStyle?: string | null
          tasks: Array<{
            id: string
            text: string
            completed: boolean
            difficulty?: 'none' | 'green' | 'yellow' | 'red'
            priority?: boolean
            notes?: string | null
            subtasks?: Array<{
              id: string
              text: string
              completed: boolean
              sort_index?: number | null
            }>
          }>
        }>
      }>
    }
> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session) return null

  // Goals
  // Try selecting optional milestones_shown; if unsupported, retry without.
  // card_surface was removed from the schema, so we no longer select it here.
  let goals: any[] | null = null
  let gErr: any = null
  let includeMilestones = true
  {
    const { data, error } = await supabase
      .from('goals')
      .select('id, name, goal_colour, sort_index, starred, goal_archive, created_at, milestones_shown')
      .order('sort_index', { ascending: true })
    goals = data as any[] | null
    gErr = error
    const code = String((error as any)?.code || '')
    // Only fall back when the column truly does not exist (PG code 42703)
    if (gErr && code === '42703') {
      includeMilestones = false
      const retry = await supabase
        .from('goals')
        .select('id, name, goal_colour, sort_index, starred, goal_archive, created_at')
        .order('sort_index', { ascending: true })
      goals = retry.data as any[] | null
      gErr = retry.error
    }
  }
  if (gErr) {
    return null
  }
  if (!goals || goals.length === 0) return { goals: [] }
  goals = goals.filter((goal) => goal.name !== QUICK_LIST_GOAL_NAME)
  if (goals.length === 0) {
    return { goals: [] }
  }

  const goalIds = goals.map((g) => g.id)

  // Buckets
  const { data: buckets, error: bErr } = await supabase
    .from('buckets')
    .select('id, user_id, goal_id, name, favorite, sort_index, buckets_card_style, bucket_archive')
    .in('goal_id', goalIds)
    .order('sort_index', { ascending: true })
  if (bErr) return null

  const bucketIds = (buckets ?? []).map((b) => b.id)

  // Tasks (order by completed then sort_index so active first)
  const { data: tasks, error: tErr } = bucketIds.length
    ? await supabase
        .from('tasks')
        .select('id, user_id, bucket_id, text, completed, difficulty, priority, sort_index, notes, created_at')
        .in('bucket_id', bucketIds)
        .order('completed', { ascending: true })
        .order('priority', { ascending: false })
        .order('sort_index', { ascending: true })
    : { data: [], error: null as any }
  if (tErr) {
    return null
  }

  const taskIds = (tasks ?? []).map((task) => task.id)

  const { data: taskSubtasks, error: sErr } = taskIds.length
    ? await supabase
        .from('task_subtasks')
        .select('id, user_id, task_id, text, completed, sort_index, updated_at')
        .in('task_id', taskIds)
        .order('task_id', { ascending: true })
        .order('sort_index', { ascending: true })
    : { data: [], error: null as any }
  if (sErr) {
    return null
  }

  const subtasksByTaskId = new Map<string, DbTaskSubtask[]>()
  ;(taskSubtasks ?? []).forEach((subtask) => {
    const list = subtasksByTaskId.get(subtask.task_id) ?? []
    list.push(subtask as DbTaskSubtask)
    subtasksByTaskId.set(subtask.task_id, list)
  })

  // Build hierarchy
  const bucketsByGoal = new Map<string, Array<{ id: string; name: string; favorite: boolean; tasks: any[] }>>()
  const bucketMap = new Map<
    string,
    { id: string; name: string; favorite: boolean; archived: boolean; surfaceStyle: string; tasks: any[] }
  >()
  ;(buckets ?? []).forEach((b) => {
    const surfaceStyle = ensureSurfaceStyle((b as any).buckets_card_style, DEFAULT_SURFACE_STYLE)
    const node = {
      id: b.id,
      name: b.name,
      favorite: b.favorite,
      archived: Boolean((b as any).bucket_archive),
      surfaceStyle,
      tasks: [] as any[],
    }
    bucketMap.set(b.id, node)
    const list = bucketsByGoal.get(b.goal_id) ?? []
    list.push(node)
    bucketsByGoal.set(b.goal_id, list)
  })

  ;(tasks ?? []).forEach((t) => {
    const bucket = bucketMap.get(t.bucket_id)
    if (bucket) {
      const subtasks = subtasksByTaskId.get(t.id) ?? []
      bucket.tasks.push({
        id: t.id,
        text: t.text,
        completed: !!t.completed,
        difficulty: (t.difficulty as any) ?? 'none',
        priority: !!(t as any).priority,
        notes: typeof (t as any).notes === 'string' ? ((t as any).notes as string) : null,
        createdAt: typeof (t as any).created_at === 'string' ? ((t as any).created_at as string) : undefined,
        subtasks: subtasks.map((subtask) => ({
          id: subtask.id,
          text: subtask.text ?? '',
          completed: !!subtask.completed,
          sort_index: subtask.sort_index ?? 0,
          updated_at: (subtask as any).updated_at ?? null,
        })),
      })
    }
  })

  const tree = goals.map((g) => {
    const goalColor = (g as any).goal_colour ?? FALLBACK_GOAL_COLOR
    return {
      id: g.id,
      name: g.name,
      goalColour: goalColor,
      createdAt: typeof (g as any).created_at === 'string' ? ((g as any).created_at as string) : undefined,
      starred: Boolean((g as any).starred),
      archived: Boolean((g as any).goal_archive),
      milestonesShown: includeMilestones ? Boolean((g as any).milestones_shown) : undefined,
      buckets: (bucketsByGoal.get(g.id) ?? []).map((bucket) => ({
        ...bucket,
      })),
    }
  })

  return { goals: tree }
}

/** Fetch notes for a single task lazily to avoid large egress during list loads. */
export async function fetchTaskNotes(taskId: string): Promise<string> {
  if (!supabase) return ''
  const userId = await getActiveUserId()
  if (!userId) return ''
  const { data, error } = await supabase
    .from('tasks')
    .select('notes')
    .eq('id', taskId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    return ''
  }
  const raw = (data as any)?.notes
  return typeof raw === 'string' ? raw : ''
}

// ---------- Goal Milestones ----------
export async function fetchGoalMilestones(goalId: string): Promise<
  Array<{ id: string; name: string; date: string; completed: boolean; role: 'start' | 'end' | 'normal'; hidden?: boolean }>
> {
  if (!supabase) return []
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return []
  let data: any[] | null = null
  let error: any = null
  {
    const res = await supabase
      .from('goal_milestones')
      .select('id, name, target_date, completed, role, hidden')
      .eq('goal_id', goalId)
      .eq('user_id', session.user.id)
      .order('target_date', { ascending: true })
    data = (res.data as any[] | null) ?? null
    error = res.error
    const code = String((error as any)?.code || '')
    if (error && code === '42703') {
      // Column hidden missing — retry without it
      const retry = await supabase
        .from('goal_milestones')
        .select('id, name, target_date, completed, role')
        .eq('goal_id', goalId)
        .eq('user_id', session.user.id)
        .order('target_date', { ascending: true })
      data = (retry.data as any[] | null) ?? null
      error = retry.error
    }
  }
  if (error) {
    return []
  }
  const rows = Array.isArray(data) ? (data as any[]) : []
  return rows.map((row) => ({
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : '',
    date: typeof row.target_date === 'string' ? row.target_date : new Date().toISOString(),
    completed: Boolean(row.completed),
    role: row.role === 'start' || row.role === 'end' ? row.role : 'normal',
    hidden: typeof (row as any).hidden === 'boolean' ? Boolean((row as any).hidden) : undefined,
  }))
}

export async function upsertGoalMilestone(
  goalId: string,
  milestone: { id: string; name: string; date: string; completed: boolean; role: 'start' | 'end' | 'normal'; hidden?: boolean },
) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return
  }
  const payload: Record<string, any> = {
    id: milestone.id,
    user_id: session.user.id,
    goal_id: goalId,
    name: milestone.name,
    target_date: milestone.date,
    completed: milestone.completed,
    role: milestone.role,
  }
  if (typeof milestone.hidden === 'boolean') {
    payload.hidden = milestone.hidden
  }
  try {
    const { error } = await supabase.from('goal_milestones').upsert(payload, { onConflict: 'id' })
    if (error) {
      const msg = String(error.message || '')
      if (msg.toLowerCase().includes('column') && msg.toLowerCase().includes('hidden')) {
        // Retry without hidden
        delete payload.hidden
        const { error: retryErr } = await supabase.from('goal_milestones').upsert(payload, { onConflict: 'id' })
        if (retryErr) throw retryErr
        return
      }
      throw error
    }
  } catch (err) {
    throw err
  }
}

export async function deleteGoalMilestone(goalId: string, milestoneId: string) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const { error } = await supabase
    .from('goal_milestones')
    .delete()
    .eq('id', milestoneId)
    .eq('goal_id', goalId)
    .eq('user_id', session.user.id)
  if (error) throw error
}

// ---------- Helpers: sort index utilities ----------
const STEP = 1024
const mid = (a: number, b: number) => Math.floor((a + b) / 2)

async function nextSortIndex(table: 'goals' | 'buckets' | 'tasks', filters?: Record<string, any>) {
  if (!supabase) return STEP
  let query = supabase.from(table).select('sort_index').order('sort_index', { ascending: false }).limit(1)
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      // Cast to any to allow dynamic column filtering
      query = (query as any).eq(k, v)
    }
  }
  const { data } = await query
  const mx = data && data.length > 0 ? (data[0] as any).sort_index ?? 0 : 0
  return (mx || 0) + STEP
}

// Compute a sort index that will place a new row at the TOP of an ordered list
async function prependSortIndexForTasks(bucketId: string, completed: boolean) {
  if (!supabase) return STEP
  const { data } = await supabase
    .from('tasks')
    .select('sort_index')
    .eq('bucket_id', bucketId)
    .eq('completed', completed)
    .order('sort_index', { ascending: true })
    .limit(1)
  const minIdx = data && data.length > 0 ? (data[0] as any).sort_index ?? null : null
  if (minIdx === null || typeof minIdx !== 'number') return STEP
  return minIdx - STEP
}

async function updateTaskWithGuard(
  taskId: string,
  bucketId: string,
  updates: Partial<DbTask>,
  selectColumns?: string,
): Promise<any[]> {
  if (!supabase) {
    throw new Error('Supabase client unavailable')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return []
  }
  let guarded = supabase
    .from('tasks')
    .update(updates)
    .eq('id', taskId)
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
  let data: any[] | null = null
  let error: any = null
  if (selectColumns) {
    const { data: withSelect, error: withSelectError } = await guarded.select(selectColumns)
    data = withSelect as any[] | null
    error = withSelectError
  } else {
    const { error: updateError } = await guarded
    error = updateError
  }
  if (error) {
    throw error
  }
  if (data && Array.isArray(data) && data.length > 0) {
    return data as any[]
  }
  // Fallback path for legacy rows that may not have a user_id populated.
  const fallback = supabase.from('tasks').update(updates).eq('id', taskId).eq('bucket_id', bucketId)
  if (selectColumns) {
    const { data: fallbackData, error: fallbackError } = await fallback.select(selectColumns)
    if (fallbackError) {
      throw fallbackError
    }
    if (!fallbackData || !Array.isArray(fallbackData) || fallbackData.length === 0) {
      throw new Error('Task not found during update')
    }
    return fallbackData as any[]
  }
  const { error: fallbackError } = await fallback
  if (fallbackError) {
    throw fallbackError
  }
  return []
}

// ---------- Goals ----------
export async function createGoal(name: string, color: string) {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return null
  }
  const sort_index = await nextSortIndex('goals')
  const safeColour = normalizeGoalColour(color, FALLBACK_GOAL_COLOR)
  const payload = {
    user_id: session.user.id,
    name,
    goal_colour: safeColour,
    sort_index,
    starred: false,
    goal_archive: false,
  }
  let created: any | null = null
  {
    const { data, error } = await supabase
      .from('goals')
      .insert([payload])
      .select('id, name, goal_colour, sort_index, starred, goal_archive')
      .single()
    if (!error) {
      created = data
    }
  }
  const base = (created ?? null) as DbGoal | null
  if (!base) {
    return null
  }
  return { ...base }
}

export async function setGoalColor(goalId: string, color: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  const primary = normalizeGoalColour(color, FALLBACK_GOAL_COLOR)
  let { error } = await supabase
    .from('goals')
    .update({ goal_colour: primary })
    .eq('id', goalId)
    .eq('user_id', userId)
  if (error && String((error as any)?.code || '') === '23514') {
    // Constraint failure; fall back to the first allowed option
    const fallback = FALLBACK_GOAL_COLOR
    const retry = await supabase
      .from('goals')
      .update({ goal_colour: fallback })
      .eq('id', goalId)
      .eq('user_id', userId)
    error = retry.error
  }
  if (error) {
    throw error
  }
}

export async function setGoalSurface(goalId: string, surface: string | null) {
  void goalId
  void surface
}

export async function setGoalStarred(goalId: string, starred: boolean) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('goals').update({ starred }).eq('id', goalId).eq('user_id', userId)
}

export async function setGoalArchived(goalId: string, archived: boolean) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('goals').update({ goal_archive: archived }).eq('id', goalId).eq('user_id', userId)
}

export async function renameGoal(goalId: string, name: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('goals').update({ name }).eq('id', goalId).eq('user_id', userId)
}

/** Toggle the visibility of the milestones layer for a goal (server-backed when supported) */
export async function setGoalMilestonesShown(goalId: string, shown: boolean) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  try {
    const { error } = await supabase.from('goals').update({ milestones_shown: shown }).eq('id', goalId).eq('user_id', userId)
    if (error) {
      const msg = String(error.message || '').toLowerCase()
      if (msg.includes('column') && msg.includes('milestones_shown')) {
        return
      }
      throw error
    }
  } catch {}
}

export async function deleteGoalById(goalId: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  // Collect bucket ids under this goal
  const { data: buckets } = await supabase
    .from('buckets')
    .select('id')
    .eq('goal_id', goalId)
    .eq('user_id', userId)
  const bucketIds = (buckets ?? []).map((b: any) => b.id as string)
  if (bucketIds.length > 0) {
    // Delete tasks in those buckets
    await supabase.from('tasks').delete().in('bucket_id', bucketIds)
    // Delete the buckets
    await supabase.from('buckets').delete().in('id', bucketIds)
  }
  // Finally delete the goal
  await supabase.from('goals').delete().eq('id', goalId).eq('user_id', userId)
}

export async function setGoalSortIndex(goalId: string, toIndex: number) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  // Load ordered goals
  const { data: rows } = await supabase
    .from('goals')
    .select('id, sort_index')
    .eq('user_id', userId)
    .order('sort_index', { ascending: true })
  if (!rows || rows.length === 0) return
  const ids = rows.map((r: any) => r.id as string)
  const prevId = toIndex <= 0 ? null : ids[toIndex - 1] ?? null
  const nextId = toIndex >= ids.length ? null : ids[toIndex] ?? null
  let newSort: number
  if (!prevId && nextId) {
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = Math.floor((next.sort_index || STEP) / 2) || STEP
  } else if (prevId && !nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    newSort = (prev.sort_index || 0) + STEP
  } else if (prevId && nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = mid(prev.sort_index || 0, next.sort_index || STEP)
    if (newSort === prev.sort_index || newSort === next.sort_index) {
      newSort = (prev.sort_index || 0) + Math.ceil(STEP / 2)
    }
  } else {
    newSort = STEP
  }
  await supabase.from('goals').update({ sort_index: newSort }).eq('id', goalId).eq('user_id', userId)
}

// ---------- Buckets ----------
export async function createBucket(goalId: string, name: string, surface: string = 'glass') {
  if (!supabase) return null
  const client = supabase
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return null
  }
  const normalizedSurface = sanitizeBucketSurfaceStyle(surface) ?? DEFAULT_SURFACE_STYLE
  const sort_index = await nextSortIndex('buckets', { goal_id: goalId })
  const payload = {
    user_id: session.user.id,
    goal_id: goalId,
    name,
    favorite: false,
    bucket_archive: false,
    sort_index,
    buckets_card_style: normalizedSurface,
  }
  const attemptInsert = async (style: string | null) => {
    const base = { ...payload, buckets_card_style: style }
    return client
      .from('buckets')
      .insert([base])
      .select('id, name, favorite, bucket_archive, sort_index, buckets_card_style')
      .single()
  }
  let { data, error } = await attemptInsert(normalizedSurface)
  if (error && String((error as any)?.code || '') === '23514') {
    const retry = await attemptInsert(null)
    data = retry.data
    error = retry.error
  }
  if (error) return null
  return data as { id: string; name: string; favorite: boolean; bucket_archive?: boolean; sort_index: number }
}

export async function setBucketSurface(bucketId: string, surface: string | null) {
  if (!supabase) return
  const client = supabase
  const userId = await getActiveUserId()
  if (!userId) return
  const normalizedSurface =
    surface === null ? null : sanitizeBucketSurfaceStyle(surface) ?? DEFAULT_SURFACE_STYLE
  let { error } = await client
    .from('buckets')
    .update({ buckets_card_style: normalizedSurface })
    .eq('id', bucketId)
    .eq('user_id', userId)
  if (error && String((error as any)?.code || '') === '23514') {
    const retry = await client
      .from('buckets')
      .update({ buckets_card_style: null })
      .eq('id', bucketId)
      .eq('user_id', userId)
    error = retry.error
  }
  if (error) {
    throw error
  }
}

export async function renameBucket(bucketId: string, name: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('buckets').update({ name }).eq('id', bucketId).eq('user_id', userId)
}

export async function setBucketFavorite(bucketId: string, favorite: boolean) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('buckets').update({ favorite }).eq('id', bucketId).eq('user_id', userId)
}

export async function setBucketArchived(bucketId: string, archived: boolean) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('buckets').update({ bucket_archive: archived }).eq('id', bucketId).eq('user_id', userId)
}

export async function deleteBucketById(bucketId: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('buckets').delete().eq('id', bucketId).eq('user_id', userId)
}

export async function setBucketSortIndex(goalId: string, bucketId: string, toIndex: number) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  const { data: rows } = await supabase
    .from('buckets')
    .select('id, sort_index')
    .eq('user_id', userId)
    .eq('goal_id', goalId)
    .order('sort_index', { ascending: true })
  if (!rows || rows.length === 0) return
  const ids = rows.map((r: any) => r.id as string)
  const prevId = toIndex <= 0 ? null : ids[toIndex - 1] ?? null
  const nextId = toIndex >= ids.length ? null : ids[toIndex] ?? null
  let newSort: number
  if (!prevId && nextId) {
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = Math.floor((next.sort_index || STEP) / 2) || STEP
  } else if (prevId && !nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    newSort = (prev.sort_index || 0) + STEP
  } else if (prevId && nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = mid(prev.sort_index || 0, next.sort_index || STEP)
    if (newSort === prev.sort_index || newSort === next.sort_index) {
      newSort = (prev.sort_index || 0) + Math.ceil(STEP / 2)
    }
  } else {
    newSort = STEP
  }
  await supabase.from('buckets').update({ sort_index: newSort }).eq('id', bucketId).eq('user_id', userId)
}

export async function deleteCompletedTasksInBucket(bucketId: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  await supabase.from('tasks').delete().eq('bucket_id', bucketId).eq('completed', true).eq('user_id', userId)
}

export async function deleteTaskById(taskId: string, bucketId: string) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return
  }
  await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
}

// ---------- Tasks ----------
export async function createTask(
  bucketId: string,
  text: string,
  options?: { clientId?: string; insertAtTop?: boolean },
) {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return null
  }
  const insertAtTop = Boolean(options?.insertAtTop)
  const sort_index = insertAtTop
    ? await prependSortIndexForTasks(bucketId, false)
    : await nextSortIndex('tasks', { bucket_id: bucketId, completed: false })
  const { data, error } = await supabase
    .from('tasks')
    .insert([
      {
        ...(options?.clientId ? { id: options.clientId } : null),
        user_id: session.user.id,
        bucket_id: bucketId,
        text,
        completed: false,
        difficulty: 'none',
        priority: false,
        sort_index,
        notes: '',
      },
    ])
    .select('id, text, completed, difficulty, priority, sort_index, notes')
    .single()
  if (error || !data) {
    throw error ?? new Error('Failed to create task')
  }
  return data as {
    id: string
    text: string
    completed: boolean
    difficulty: DbTask['difficulty']
    priority: boolean
    sort_index: number
    notes: string | null
  }
}

export async function updateTaskText(taskId: string, text: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  const { error } = await supabase.from('tasks').update({ text }).eq('id', taskId).eq('user_id', userId)
  if (error) {
    throw error
  }
}

export async function updateTaskNotes(taskId: string, notes: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  const { error } = await supabase.from('tasks').update({ notes }).eq('id', taskId).eq('user_id', userId)
  if (error) {
    throw error
  }
}

export async function setTaskDifficulty(taskId: string, difficulty: DbTask['difficulty']) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  const { error } = await supabase.from('tasks').update({ difficulty }).eq('id', taskId).eq('user_id', userId)
  if (error) {
    throw error
  }
}

/** Toggle priority and reassign sort_index to position the task at the top of its section when enabling,
 * or as the first non-priority when disabling. */
export async function setTaskPriorityAndResort(
  taskId: string,
  bucketId: string,
  completed: boolean,
  priority: boolean,
) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  if (priority) {
    // Enabling priority: place at the top of its section
    const sort_index = await prependSortIndexForTasks(bucketId, completed)
  await updateTaskWithGuard(taskId, bucketId, { priority: true, sort_index }, 'id')
    return
  }
  // Disabling priority: place at the first non-priority position
  const { data } = await supabase
    .from('tasks')
    .select('sort_index')
    .eq('bucket_id', bucketId)
    .eq('completed', completed)
    .eq('priority', false)
    .eq('user_id', userId)
    .order('sort_index', { ascending: true })
    .limit(1)
  let sort_index: number
  if (data && data.length > 0) {
    const minIdx = (data[0] as any).sort_index ?? 0
    sort_index = Math.floor(minIdx) - STEP
  } else {
    sort_index = await nextSortIndex('tasks', { bucket_id: bucketId, completed, priority: false })
  }
  await updateTaskWithGuard(taskId, bucketId, { priority: false, sort_index }, 'id')
}

const parseBooleanish = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 't' || normalized === '1') {
      return true
    }
    if (normalized === 'false' || normalized === 'f' || normalized === '0') {
      return false
    }
  }
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  return null
}

export async function setTaskCompletedAndResort(
  taskId: string,
  bucketId: string,
  completed: boolean,
): Promise<DbTask | null> {
  if (!supabase) return null
  const userId = await getActiveUserId()
  if (!userId) return null

  const sort_index = await nextSortIndex('tasks', { bucket_id: bucketId, completed })
  const updates: Partial<DbTask> = { completed, sort_index }

  const completionRows = await updateTaskWithGuard(taskId, bucketId, updates, 'id, completed')
  const persisted = completionRows[0]
  if (!persisted) {
    throw new Error(`[goalsApi] Task ${taskId} not found for completion toggle`)
  }
  const persistedCompleted = parseBooleanish((persisted as any).completed)
  if (persistedCompleted !== completed) {
    const { data: refetch, error } = await supabase
      .from('tasks')
      .select('id, completed')
      .eq('id', taskId)
      .eq('bucket_id', bucketId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      throw error
    }
    const finalCompleted = parseBooleanish(refetch?.completed)
    if (finalCompleted !== completed) {
      throw new Error(
        `[goalsApi] Completion update mismatch for task ${taskId}: expected ${completed} but received ${refetch?.completed}`,
      )
    }
    const normalized = {
      ...(refetch as DbTask),
      completed: finalCompleted ?? completed,
    }
    return normalized
  }
  const normalizedPersisted: DbTask = {
    ...(persisted as DbTask),
    completed: persistedCompleted ?? completed,
  }
  return normalizedPersisted
}

export async function setTaskSortIndex(bucketId: string, section: 'active' | 'completed', toIndex: number, taskId: string) {
  if (!supabase) return
  const userId = await getActiveUserId()
  if (!userId) return
  const { data: rows } = await supabase
    .from('tasks')
    .select('id, sort_index')
    .eq('bucket_id', bucketId)
    .eq('completed', section === 'completed')
    .eq('user_id', userId)
    .order('sort_index', { ascending: true })
  if (!rows) return
  const ids = rows.map((r: any) => r.id as string)
  const prevId = toIndex <= 0 ? null : ids[toIndex - 1] ?? null
  const nextId = toIndex >= ids.length ? null : ids[toIndex] ?? null
  let newSort: number
  if (!prevId && nextId) {
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = Math.floor((next.sort_index || STEP) / 2) || STEP
  } else if (prevId && !nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    newSort = (prev.sort_index || 0) + STEP
  } else if (prevId && nextId) {
    const prev = rows.find((r: any) => r.id === prevId) as any
    const next = rows.find((r: any) => r.id === nextId) as any
    newSort = mid(prev.sort_index || 0, next.sort_index || STEP)
    if (newSort === prev.sort_index || newSort === next.sort_index) {
      newSort = (prev.sort_index || 0) + Math.ceil(STEP / 2)
    }
  } else {
    newSort = STEP
  }
  await updateTaskWithGuard(taskId, bucketId, { sort_index: newSort }, 'id')
}

/** Sort all tasks in a bucket by created_at date (oldest first) and update their sort_index values.
 * This sorts ALL tasks (both priority and non-priority) so that when tasks move between
 * priority/non-priority status, they slot into the correct position.
 * Returns the updated task IDs with their new sort_index values, or null on failure. */
export async function sortBucketTasksByDate(bucketId: string, direction: 'oldest' | 'newest' = 'oldest'): Promise<{ id: string; sort_index: number }[] | null> {
  if (!supabase) return null
  const userId = await getActiveUserId()
  if (!userId) return null
  
  const STEP = 1024
  
  // Fetch all tasks in the bucket with their created_at and priority
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, created_at, priority')
    .eq('bucket_id', bucketId)
    .eq('user_id', userId)
  
  if (error || !tasks || tasks.length === 0) return null
  
  // Separate priority and non-priority tasks
  const priorityTasks = tasks.filter(t => t.priority)
  const nonPriorityTasks = tasks.filter(t => !t.priority)
  
  // Sort each group by created_at
  const sortByDate = (a: typeof tasks[0], b: typeof tasks[0]) => {
    const dateA = new Date(a.created_at || 0).getTime()
    const dateB = new Date(b.created_at || 0).getTime()
    return direction === 'oldest' ? dateA - dateB : dateB - dateA
  }
  
  priorityTasks.sort(sortByDate)
  nonPriorityTasks.sort(sortByDate)
  
  // Combine: priority tasks first, then non-priority
  const sorted = [...priorityTasks, ...nonPriorityTasks]
  
  // Build batch updates with new sort_index values
  const updates = sorted.map((task, index) => ({
    id: task.id,
    sort_index: (index + 1) * STEP,
  }))
  
  // Update each task's sort_index
  // Using individual updates since Supabase doesn't support batch updates with different values per row
  await Promise.all(
    updates.map(({ id, sort_index }) =>
      supabase!
        .from('tasks')
        .update({ sort_index })
        .eq('id', id)
        .eq('user_id', userId)
    )
  )
  
  return updates
}

/** Sort all tasks in a bucket by priority (priority first) then by difficulty (green > yellow > red > none).
 * Tasks with the same priority+difficulty combination maintain their relative order (stable sort).
 * Returns the updated task IDs with their new sort_index values, or null on failure. */
export async function sortBucketTasksByPriority(bucketId: string): Promise<{ id: string; sort_index: number }[] | null> {
  if (!supabase) return null
  const userId = await getActiveUserId()
  if (!userId) return null
  
  const STEP = 1024
  
  // Fetch all tasks in the bucket with their priority, difficulty, and sort_index
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, priority, difficulty, sort_index')
    .eq('bucket_id', bucketId)
    .eq('user_id', userId)
    .order('sort_index', { ascending: true }) // Preserve relative order for stable sort
  
  if (error || !tasks || tasks.length === 0) return null
  
  // Difficulty weight: green=0, yellow=1, red=2, none/null=3
  const difficultyWeight = (diff: string | null | undefined): number => {
    if (diff === 'green') return 0
    if (diff === 'yellow') return 1
    if (diff === 'red') return 2
    return 3 // 'none' or null
  }
  
  // Stable sort: priority first (true before false), then difficulty
  const sorted = [...tasks].sort((a, b) => {
    // Priority: true (1) should come before false (0), so we want descending
    const priorityA = a.priority ? 0 : 1
    const priorityB = b.priority ? 0 : 1
    if (priorityA !== priorityB) return priorityA - priorityB
    
    // Difficulty: green < yellow < red < none
    const diffA = difficultyWeight(a.difficulty)
    const diffB = difficultyWeight(b.difficulty)
    if (diffA !== diffB) return diffA - diffB
    
    // Same priority+difficulty: keep original order (already sorted by sort_index)
    return 0
  })
  
  // Build batch updates with new sort_index values
  const updates = sorted.map((task, index) => ({
    id: task.id,
    sort_index: (index + 1) * STEP,
  }))
  
  // Update each task's sort_index
  await Promise.all(
    updates.map(({ id, sort_index }) =>
      supabase!
        .from('tasks')
        .update({ sort_index })
        .eq('id', id)
        .eq('user_id', userId)
    )
  )
  
  return updates
}

/** Move a task to a different bucket while preserving completion/priority and assigning a sensible sort_index.
 * Priority tasks are placed at the top of their new section; non-priority tasks are appended to the end. */
export async function moveTaskToBucket(taskId: string, fromBucketId: string, toBucketId: string) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return
  }
  if (fromBucketId === toBucketId) return
  // Fetch current flags to compute section placement
  const { data: taskRow, error } = await supabase
    .from('tasks')
    .select('id, completed, priority')
    .eq('id', taskId)
    .eq('bucket_id', fromBucketId)
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (error) throw error
  const completed = Boolean((taskRow as any)?.completed)
  const priority = Boolean((taskRow as any)?.priority)
  // Compute new sort index in destination bucket
  let sort_index: number
  if (priority) {
    sort_index = await prependSortIndexForTasks(toBucketId, completed)
  } else {
    sort_index = await nextSortIndex('tasks', { bucket_id: toBucketId, completed })
  }
  // Guarded update that ensures the row still belongs to the expected source bucket
  await updateTaskWithGuard(taskId, fromBucketId, { bucket_id: toBucketId, sort_index }, 'id, bucket_id, sort_index')
}

export async function upsertTaskSubtask(
  taskId: string,
  subtask: { id: string; text: string; completed: boolean; sort_index: number; updated_at?: string },
) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return
  }
  const userId = session.user.id
  const payload = {
    id: subtask.id,
    task_id: taskId,
    user_id: userId,
    text: subtask.text,
    completed: subtask.completed,
    sort_index: subtask.sort_index,
    // Prefer provided updated_at; else stamp here so merges can use recency.
    updated_at: subtask.updated_at ?? new Date().toISOString(),
  }
  const { error } = await supabase.from('task_subtasks').upsert(payload, { onConflict: 'id' })
  if (!error) {
    return
  }
  const isSortConflict =
    error?.code === '23505' && typeof error?.message === 'string' && error.message.includes('task_subtasks_task_sort_idx')
  if (!isSortConflict) {
    throw error
  }
  // Resolve unique (task_id, sort_index) collisions by rebasing all subtasks for this task with fresh gaps.
  const { data: existing, error: fetchError } = await supabase
    .from('task_subtasks')
    .select('id, text, completed, sort_index, updated_at')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .order('sort_index', { ascending: true })
  if (fetchError) {
    throw fetchError
  }
  const rows = Array.isArray(existing) ? existing : []
  const merged = [...rows]
  const incomingIndex = merged.findIndex((row) => row?.id === payload.id)
  if (incomingIndex >= 0) {
    merged[incomingIndex] = { ...merged[incomingIndex], ...payload }
  } else {
    merged.push(payload)
  }
  merged.sort((a, b) => (Number(a?.sort_index ?? 0) - Number(b?.sort_index ?? 0)))
  const STEP = 1024
  const normalized = merged.map((row, index) => ({
    id: row?.id as string,
    task_id: taskId,
    user_id: userId,
    text: typeof row?.text === 'string' ? row.text : '',
    completed: Boolean((row as any)?.completed),
    sort_index: (index + 1) * STEP,
    updated_at: typeof row?.updated_at === 'string' ? row.updated_at : payload.updated_at,
  }))
  const { error: rebalanceError } = await supabase.from('task_subtasks').upsert(normalized, { onConflict: 'id' })
  if (rebalanceError) {
    throw rebalanceError
  }
}

export async function replaceTaskSubtasks(
  taskId: string,
  subtasks: Array<{ id: string; text: string; completed: boolean; sortIndex: number; updatedAt?: string }>,
) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return
  }
  const userId = session.user.id
  const STEP = 1024
  const now = new Date().toISOString()
  const ordered = Array.isArray(subtasks)
    ? [...subtasks].sort((a, b) => Number(a?.sortIndex ?? 0) - Number(b?.sortIndex ?? 0))
    : []
  const payload = ordered.map((subtask, index) => ({
    id: subtask.id,
    task_id: taskId,
    user_id: userId,
    text: typeof subtask.text === 'string' ? subtask.text : '',
    completed: Boolean(subtask.completed),
    sort_index: (index + 1) * STEP,
    updated_at: subtask.updatedAt ?? now,
  }))
  const { error: deleteError } = await supabase.from('task_subtasks').delete().eq('task_id', taskId).eq('user_id', userId)
  if (deleteError) {
    throw deleteError
  }
  if (payload.length === 0) {
    return
  }
  const { error: insertError } = await supabase.from('task_subtasks').upsert(payload, { onConflict: 'id' })
  if (insertError) {
    throw insertError
  }
}

export async function deleteTaskSubtask(taskId: string, subtaskId: string) {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return
  }
  const { error } = await supabase
    .from('task_subtasks')
    .delete()
    .eq('id', subtaskId)
    .eq('task_id', taskId)
    .eq('user_id', session.user.id)
  if (error) {
    throw error
  }
}

export async function seedGoalsIfEmpty(seeds: GoalSeed[]): Promise<boolean> {
  if (!supabase) return false
  if (!seeds || seeds.length === 0) return false
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return false
  }
  const userId = session.user.id
  try {
    const { data: existing, error: existingError } = await supabase
      .from('goals')
      .select('id')
      .eq('user_id', userId)
      .neq('name', QUICK_LIST_GOAL_NAME)
      .limit(1)
    if (existingError) {
      return false
    }
    if (existing && existing.length > 0) {
      return false
    }

    const goalInserts = seeds.map((goal, index) => ({
      user_id: userId,
      name: goal.name,
      goal_colour: normalizeGoalColour(goal.goalColour) ?? FALLBACK_GOAL_COLOR,
      sort_index: (index + 1) * STEP,
      starred: Boolean(goal.starred),
      goal_archive: Boolean(goal.archived),
      // milestones_shown intentionally omitted to avoid errors if column not present
    }))

    const { data: insertedGoals, error: goalsError } = await supabase
      .from('goals')
      .insert(goalInserts)
      .select('id')
    if (goalsError || !insertedGoals) {
      return false
    }

    const goalIdBySeedIndex = insertedGoals.map((row) => row.id as string)

    const bucketInserts: Array<{
      user_id: string
      goal_id: string
      name: string
      favorite: boolean
      bucket_archive: boolean
      sort_index: number
      buckets_card_style: string | null
    }> = []

    seeds.forEach((goal, goalIndex) => {
      const goalId = goalIdBySeedIndex[goalIndex]
      if (!goalId) return
      goal.buckets?.forEach((bucket, bucketIndex) => {
        bucketInserts.push({
          user_id: userId,
          goal_id: goalId,
          name: bucket.name,
          favorite: Boolean(bucket.favorite),
          bucket_archive: Boolean(bucket.archived),
          sort_index: (bucketIndex + 1) * STEP,
          buckets_card_style: (bucket as any).surfaceStyle ?? null,
        })
      })
    })

    const insertedBuckets =
      bucketInserts.length > 0
        ? await supabase
            .from('buckets')
            .insert(bucketInserts)
            .select('id')
        : { data: [] as any[], error: null as any }

    if (insertedBuckets.error) {
      return false
    }

    const bucketIdByMetaIndex = (insertedBuckets.data ?? []).map((row) => row.id as string)
    let bucketCursor = 0
    const taskInserts: Array<{
      id: string
      user_id: string
      bucket_id: string
      text: string
      completed: boolean
      difficulty: DbTask['difficulty']
      priority: boolean
      sort_index: number
      notes: string
    }> = []
    const taskSubtaskInserts: Array<{
      id: string
      user_id: string
      task_id: string
      text: string
      completed: boolean
      sort_index: number
      created_at: string
      updated_at: string
    }> = []
    const nowIso = new Date().toISOString()
    const fallbackSubtaskSortStep = 100

    seeds.forEach((goal) => {
      goal.buckets?.forEach((bucket) => {
        const bucketId = bucketIdByMetaIndex[bucketCursor]
        bucketCursor += 1
        if (!bucketId) return
        const active = (bucket.tasks ?? []).filter((task) => !task.completed)
        const completed = (bucket.tasks ?? []).filter((task) => !!task.completed)
        const ordered = [...active, ...completed]
        ordered.forEach((task, taskIndex) => {
          const taskId = isUuid(task.id) ? task.id : generateUuid()
          task.id = taskId
          taskInserts.push({
            id: taskId,
            user_id: userId,
            bucket_id: bucketId,
            text: task.text,
            completed: Boolean(task.completed),
            difficulty: task.difficulty ?? 'none',
            priority: Boolean(task.priority),
            sort_index: (taskIndex + 1) * STEP,
            notes: task.notes ?? '',
          })
          ;(task.subtasks ?? []).forEach((subtask, subIndex) => {
            const subtaskId = isUuid(subtask.id) ? subtask.id : generateUuid()
            const sortIndex =
              typeof subtask.sortIndex === 'number' && Number.isFinite(subtask.sortIndex)
                ? subtask.sortIndex
                : (subIndex + 1) * fallbackSubtaskSortStep
            taskSubtaskInserts.push({
              id: subtaskId,
              user_id: userId,
              task_id: taskId,
              text: subtask.text,
              completed: Boolean(subtask.completed),
              sort_index: sortIndex,
              created_at: nowIso,
              updated_at: nowIso,
            })
          })
        })
      })
    })

    if (taskInserts.length > 0) {
      const { error: tasksError } = await supabase.from('tasks').insert(taskInserts)
      if (tasksError) {
        return false
      }
      if (taskSubtaskInserts.length > 0) {
        const { error: subtaskError } = await supabase.from('task_subtasks').insert(taskSubtaskInserts)
        if (subtaskError) {
          return false
        }
      }
    }

    return true
  } catch {
    return false
  }
}
