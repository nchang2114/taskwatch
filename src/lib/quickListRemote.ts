import { ensureSingleUserSession, supabase } from './supabaseClient'
import { ensureServerBucketStyle, DEFAULT_SURFACE_STYLE } from './surfaceStyles'
import type { QuickItem, QuickSubtask } from './quickList'
import { writeStoredQuickList } from './quickList'

export const QUICK_LIST_GOAL_NAME = 'Quick List (Hidden)'
const QUICK_LIST_BUCKET_NAME = 'Quick List'
const QUICK_LIST_GOAL_COLOUR = 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)'

let ensurePromise: Promise<{ goalId: string; bucketId: string } | null> | null = null

export const generateUuid = (): string => {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    try {
      return cryptoRef.randomUUID()
    } catch {
      // ignore runtime crypto failures and fall back to manual UUID generation
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const r = (Math.random() * 16) | 0
    const v = char === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const normalizeDifficulty = (
  difficulty: unknown,
): QuickItem['difficulty'] => {
  if (difficulty === 'green' || difficulty === 'yellow' || difficulty === 'red') {
    return difficulty
  }
  return 'none'
}

const mapTasksToQuickItems = (tasks: any[], subtasksByTaskId: Map<string, QuickSubtask[]>): QuickItem[] => {
  return tasks.map((task, index) => {
    const subs = subtasksByTaskId.get(task.id) ?? []
    return {
      id: task.id,
      text: typeof task.text === 'string' ? task.text : '',
      completed: Boolean(task.completed),
      difficulty: normalizeDifficulty(task.difficulty),
      priority: Boolean(task.priority),
      sortIndex: index,
      updatedAt: typeof task.updated_at === 'string' ? task.updated_at : new Date().toISOString(),
      notes: typeof task.notes === 'string' ? task.notes : '',
      subtasks: subs,
      expanded: false,
      subtasksCollapsed: subs.length === 0,
      notesCollapsed: !(typeof task.notes === 'string' && task.notes.trim().length > 0),
    }
  })
}

const normalizeQuickListGoalColour = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return QUICK_LIST_GOAL_COLOUR
  }
  const trimmed = value.trim()
  if (trimmed.toLowerCase().startsWith('linear-gradient(')) {
    return trimmed
  }
  return QUICK_LIST_GOAL_COLOUR
}

export async function ensureQuickListRemoteStructures(): Promise<{ goalId: string; bucketId: string } | null> {
  if (!supabase) return null
  if (ensurePromise) {
    return ensurePromise
  }
  ensurePromise = (async () => {
    const session = await ensureSingleUserSession()
    if (!session?.user?.id) {
      return null
    }
    const userId = session.user.id
    try {
      const { data: existingGoal, error: goalLookupError } = await supabase
        .from('goals')
        .select('id, goal_colour')
        .eq('user_id', userId)
        .eq('name', QUICK_LIST_GOAL_NAME)
        .limit(1)
        .maybeSingle()
      if (goalLookupError) {
        return null
      }
      const goalId =
        typeof existingGoal?.id === 'string' && existingGoal.id.trim().length > 0
          ? existingGoal.id
          : generateUuid()
      if (!existingGoal?.id) {
        const goal_colour = normalizeQuickListGoalColour((existingGoal as any)?.goal_colour)
        const goalPayload = {
          id: goalId,
          user_id: userId,
          name: QUICK_LIST_GOAL_NAME,
          goal_colour,
          sort_index: 10_000_000,
          starred: false,
          goal_archive: true,
          milestones_shown: false,
        }
        const { error: goalInsertError } = await supabase.from('goals').insert(goalPayload)
        if (goalInsertError) {
          return null
        }
      } else {
        const normalized = normalizeQuickListGoalColour((existingGoal as any)?.goal_colour)
        if (normalized !== (existingGoal as any)?.goal_colour) {
          await supabase.from('goals').update({ goal_colour: normalized }).eq('id', goalId).eq('user_id', userId)
        }
      }
      const { data: existingBucket, error: bucketLookupError } = await supabase
        .from('buckets')
        .select('id')
        .eq('user_id', userId)
        .eq('goal_id', goalId)
        .eq('name', QUICK_LIST_BUCKET_NAME)
        .limit(1)
        .maybeSingle()
      if (bucketLookupError) {
        return null
      }
      const bucketId =
        typeof existingBucket?.id === 'string' && existingBucket.id.trim().length > 0
          ? existingBucket.id
          : generateUuid()
      if (!existingBucket?.id) {
        const surface = ensureServerBucketStyle(DEFAULT_SURFACE_STYLE)
        const bucketPayload = {
          id: bucketId,
          user_id: userId,
          goal_id: goalId,
          name: QUICK_LIST_BUCKET_NAME,
          favorite: false,
          sort_index: 10_000_000,
          bucket_archive: true,
          buckets_card_style: surface,
        }
        const { error: bucketInsertError } = await supabase.from('buckets').insert(bucketPayload)
        if (bucketInsertError) {
          const code = String((bucketInsertError as any)?.code || '')
          if (code === '23514') {
            const { error: retryError } = await supabase
              .from('buckets')
              .insert({ ...bucketPayload, buckets_card_style: null })
            if (retryError) {
              return null
            }
          } else {
            return null
          }
        }
      }
      return { goalId, bucketId }
    } catch {
      return null
    }
  })()
  ensurePromise
    ?.catch(() => {
      // errors are handled inside the async function; this prevents unhandled rejection noise
    })
    .finally(() => {
      ensurePromise = null
    })
  return ensurePromise
}

export async function fetchQuickListRemoteItems(): Promise<{
  goalId: string
  bucketId: string
  items: QuickItem[]
} | null> {
  if (!supabase) return null
  const ids = (await ensureQuickListRemoteStructures()) ?? null
  if (!ids) {
    return null
  }
  const { bucketId, goalId } = ids
  try {
    const { data: tasks, error: taskError } = await supabase
      .from('tasks')
      .select('id, text, completed, difficulty, priority, sort_index, notes, updated_at')
      .eq('bucket_id', bucketId)
      .order('completed', { ascending: true })
      .order('priority', { ascending: false })
      .order('sort_index', { ascending: true })
    if (taskError) {
      return null
    }
    const taskRows = Array.isArray(tasks) ? tasks : []
    const taskIds = taskRows.map((task) => task.id)
    let subtasks: any[] = []
    if (taskIds.length) {
      const { data } = await supabase
        .from('task_subtasks')
        .select('id, task_id, text, completed, sort_index, updated_at')
        .in('task_id', taskIds)
        .order('sort_index', { ascending: true })
      if (Array.isArray(data)) {
        subtasks = data
      }
    }
    const subtasksByTaskId = new Map<string, QuickSubtask[]>()
    subtasks.forEach((subtask) => {
      const list = subtasksByTaskId.get(subtask.task_id) ?? []
      list.push({
        id: subtask.id,
        text: typeof subtask.text === 'string' ? subtask.text : '',
        completed: Boolean(subtask.completed),
        sortIndex: typeof subtask.sort_index === 'number' ? subtask.sort_index : 0,
        updatedAt: typeof subtask.updated_at === 'string' ? subtask.updated_at : undefined,
      })
      subtasksByTaskId.set(subtask.task_id, list)
    })
    const items = mapTasksToQuickItems(taskRows, subtasksByTaskId)
    return { goalId, bucketId, items }
  } catch {
    return null
  }
}

/**
 * Syncs quick list from Supabase to localStorage.
 * Called during bootstrap to populate the user's quick list after sign-in.
 */
export async function syncQuickListFromSupabase(): Promise<QuickItem[] | null> {
  // Use authenticated session directly (localStorage may be stale during bootstrap)
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return null
  }
  
  const remote = await fetchQuickListRemoteItems()
  if (!remote?.items) {
    return null
  }
  
  // Write to localStorage and broadcast update
  const stored = writeStoredQuickList(remote.items)
  console.log('[quickListRemote] Synced', stored.length, 'quick list items from Supabase')
  return stored
}
