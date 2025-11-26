import { supabase, ensureSingleUserSession } from './supabaseClient'
import { readStoredHistory, pushAllHistoryToSupabase } from './sessionHistory'
import { readLocalRepeatingRules, pushRepeatingRulesToSupabase } from './repeatingSessions'
import { readStoredQuickList, type QuickItem } from './quickList'
import { ensureQuickListRemoteStructures, generateUuid } from './quickListRemote'
import {
  createTask,
  updateTaskNotes,
  setTaskDifficulty,
  setTaskPriorityAndResort,
  setTaskCompletedAndResort,
  upsertTaskSubtask,
} from './goalsApi'
import { readStoredLifeRoutines, pushLifeRoutinesToSupabase } from './lifeRoutines'
import { readStoredGoalsSnapshot, readGoalsSnapshotOwner, GOALS_GUEST_USER_ID } from './goalsSync'
import { QUICK_LIST_GOAL_NAME } from './quickListRemote'
import { ensureSurfaceStyle, DEFAULT_SURFACE_STYLE, ensureServerBucketStyle } from './surfaceStyles'

let bootstrapPromises = new Map<string, Promise<boolean>>()
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined | null): value is string => !!value && UUID_REGEX.test(value)
const ensureUuid = (value: string | undefined): string => (isUuid(value) ? value! : generateUuid())
const GOAL_SORT_STEP = 1024
const SUBTASK_SORT_STEP = 1024

const sanitizeGoalName = (value: string | undefined): string =>
  value && value.trim().length > 0 ? value.trim() : 'Personal Goal'

const sanitizeBucketName = (value: string | undefined): string =>
  value && value.trim().length > 0 ? value.trim() : 'Task List'

const sanitizeTaskText = (value: string | undefined): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeGradient = (value: string | undefined | null): string => {
  if (!value) {
    return 'linear-gradient(135deg, #FFF8BF 0%, #FFF8BF 100%)'
  }
  const trimmed = value.trim()
  if (trimmed.toLowerCase().startsWith('custom:linear-gradient(')) {
    return trimmed.slice(7)
  }
  if (trimmed.toLowerCase().startsWith('linear-gradient(')) {
    return trimmed
  }
  const hexMatch = trimmed.match(/^#?[0-9a-fA-F]{6}$/)
  if (hexMatch) {
    const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
    return `linear-gradient(135deg, ${hex} 0%, ${hex} 100%)`
  }
  return 'linear-gradient(135deg, #FFF8BF 0%, #FFF8BF 100%)'
}

const sanitizeDifficulty = (value: string | undefined): 'none' | 'green' | 'yellow' | 'red' => {
  if (value === 'green' || value === 'yellow' || value === 'red') {
    return value
  }
  return 'none'
}

const sortByIndex = (a: { sortIndex?: number }, b: { sortIndex?: number }) => {
  const left = typeof a.sortIndex === 'number' ? a.sortIndex : 0
  const right = typeof b.sortIndex === 'number' ? b.sortIndex : 0
  return left - right
}

const uploadQuickListItems = async (items: QuickItem[]): Promise<void> => {
  if (!supabase || items.length === 0) {
    return
  }
  const remote = await ensureQuickListRemoteStructures()
  if (!remote) {
    throw new Error('Quick List remote structures unavailable')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session for Quick List migration')
  }
  const { bucketId } = remote
  // Start from a clean slate so we don't duplicate default content
  const { error: deleteError } = await supabase
    .from('tasks')
    .delete()
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
  if (deleteError) {
    throw deleteError
  }

  const ordered = [
    ...items.filter((item) => !item.completed).sort(sortByIndex),
    ...items.filter((item) => item.completed).sort(sortByIndex),
  ]
  for (const item of ordered) {
    try {
      const baseText = item.text?.trim().length ? item.text.trim() : 'Quick task'
      const created = await createTask(bucketId, baseText)
      const taskId = created?.id
      if (!taskId) {
        throw new Error('Failed to create Quick List task during migration')
      }
      const subtasks = Array.isArray(item.subtasks) ? [...item.subtasks].sort(sortByIndex) : []
      for (let idx = 0; idx < subtasks.length; idx += 1) {
        const sub = subtasks[idx]
        const sortIndex = typeof sub.sortIndex === 'number' ? sub.sortIndex : idx
        await upsertTaskSubtask(taskId, {
          id: ensureUuid(sub.id),
          text: sub.text,
          completed: Boolean(sub.completed),
          sort_index: sortIndex,
          updated_at: sub.updatedAt,
        })
      }
      if (item.notes && item.notes.trim().length > 0) {
        await updateTaskNotes(taskId, item.notes)
      }
      if (item.difficulty && item.difficulty !== 'none') {
        await setTaskDifficulty(taskId, item.difficulty)
      }
      if (item.priority) {
        await setTaskPriorityAndResort(taskId, bucketId, false, true)
      }
      if (item.completed) {
        await setTaskCompletedAndResort(taskId, bucketId, true)
        if (item.priority) {
          await setTaskPriorityAndResort(taskId, bucketId, true, true)
        }
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to migrate Quick List task')
    }
  }
}

const migrateGoalsSnapshot = async (): Promise<void> => {
  const owner = readGoalsSnapshotOwner()
  if (owner && owner !== GOALS_GUEST_USER_ID) {
    return
  }
  const snapshot = readStoredGoalsSnapshot().filter(
    (goal) => goal.name?.trim() !== QUICK_LIST_GOAL_NAME,
  )
  if (snapshot.length === 0) {
    return
  }
  if (!supabase) {
    throw new Error('Supabase client unavailable for goals migration')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session for goals migration')
  }
  const userId = session.user.id
  const { data: existingGoals, error: existingError } = await supabase
    .from('goals')
    .select('id')
    .eq('user_id', userId)
    .limit(1)
  if (existingError) {
    throw existingError
  }
  if (existingGoals && existingGoals.length > 0) {
    return
  }

  const goalIdMap = new Map<string, string>()
  const bucketIdMap = new Map<string, string>()
  const taskIdMap = new Map<string, string>()
  const goalRows: Array<Record<string, any>> = []
  const bucketRows: Array<Record<string, any>> = []
  const taskRows: Array<Record<string, any>> = []
  const subtaskRows: Array<Record<string, any>> = []

  snapshot.forEach((goal, goalIndex) => {
    const goalId = (() => {
      if (goal.id && goalIdMap.has(goal.id)) {
        return goalIdMap.get(goal.id)!
      }
      const generated = ensureUuid(goal.id)
      if (goal.id) {
        goalIdMap.set(goal.id, generated)
      }
      return generated
    })()
    goalRows.push({
      id: goalId,
      user_id: userId,
      name: sanitizeGoalName(goal.name),
      goal_colour: normalizeGradient((goal as any).goalColour ?? (goal as any).goal_colour),
      sort_index: (goalIndex + 1) * GOAL_SORT_STEP,
      starred: Boolean(goal.starred),
      goal_archive: Boolean(goal.archived),
      milestones_shown: typeof (goal as any).milestonesShown === 'boolean' ? (goal as any).milestonesShown : null,
    })
    ;(goal.buckets ?? []).forEach((bucket, bucketIndex) => {
      const bucketId = (() => {
        if (bucket.id && bucketIdMap.has(bucket.id)) {
          return bucketIdMap.get(bucket.id)!
        }
        const generated = ensureUuid(bucket.id)
        if (bucket.id) {
          bucketIdMap.set(bucket.id, generated)
        }
        return generated
      })()
      const surfaceStyle = ensureServerBucketStyle(bucket.surfaceStyle, DEFAULT_SURFACE_STYLE)
      bucketRows.push({
        id: bucketId,
        user_id: userId,
        goal_id: goalId,
        name: sanitizeBucketName(bucket.name),
        favorite: Boolean(bucket.favorite),
        sort_index: (bucketIndex + 1) * GOAL_SORT_STEP,
        buckets_card_style: surfaceStyle,
        bucket_archive: Boolean(bucket.archived),
      })
      ;(bucket.tasks ?? []).forEach((task, taskIndex) => {
        const text = sanitizeTaskText(task.text)
        if (!text) {
          return
        }
        const taskId = (() => {
          if (task.id && taskIdMap.has(task.id)) {
            return taskIdMap.get(task.id)!
          }
          const generated = ensureUuid(task.id)
          if (task.id) {
            taskIdMap.set(task.id, generated)
          }
          return generated
        })()
        taskRows.push({
          id: taskId,
          user_id: userId,
          bucket_id: bucketId,
          text,
          completed: Boolean(task.completed),
          difficulty: sanitizeDifficulty(task.difficulty),
          priority: Boolean(task.priority),
          sort_index: (taskIndex + 1) * GOAL_SORT_STEP,
          notes: typeof task.notes === 'string' ? task.notes : '',
        })
        ;(task.subtasks ?? []).forEach((subtask, subIndex) => {
          const subText = sanitizeTaskText(subtask.text)
          if (!subText) {
            return
          }
          subtaskRows.push({
            id: ensureUuid(subtask.id),
            user_id: userId,
            task_id: taskId,
            text: subText,
            completed: Boolean(subtask.completed),
            sort_index:
              typeof subtask.sortIndex === 'number' ? subtask.sortIndex : (subIndex + 1) * SUBTASK_SORT_STEP,
          })
        })
      })
    })
  })

  if (goalRows.length > 0) {
    const { error } = await supabase.from('goals').insert(goalRows)
    if (error) {
      throw error
    }
  }
  if (bucketRows.length > 0) {
    const { error } = await supabase.from('buckets').insert(bucketRows)
    if (error) {
      const code = String((error as any)?.code || '')
      if (code === '23514') {
        // Retry with null surface styles to satisfy strict server checks
        const fallbackRows = bucketRows.map((row) => ({ ...row, buckets_card_style: null }))
        const { error: retryError } = await supabase.from('buckets').insert(fallbackRows)
        if (retryError) {
          throw retryError
        }
      } else {
        throw error
      }
    }
  }
  if (taskRows.length > 0) {
    const { error } = await supabase.from('tasks').insert(taskRows)
    if (error) {
      throw error
    }
  }
  if (subtaskRows.length > 0) {
    const { error } = await supabase.from('task_subtasks').insert(subtaskRows)
    if (error) {
      throw error
    }
  }
}

const migrateGuestData = async (): Promise<void> => {
  const rules = readLocalRepeatingRules()
  const ruleIdMap =
    rules.length > 0 ? await pushRepeatingRulesToSupabase(rules, { strict: true }) : ({} as Record<string, string>)

  await migrateGoalsSnapshot()

  const history = readStoredHistory()
  if (history.length > 0) {
    await pushAllHistoryToSupabase(ruleIdMap, undefined, { skipRemoteCheck: true, strict: true })
  }

  const routines = readStoredLifeRoutines()
  if (routines.length > 0) {
    await pushLifeRoutinesToSupabase(routines, { strict: true })
  }

  const quickItems = readStoredQuickList()
  if (quickItems.length > 0) {
    await uploadQuickListItems(quickItems)
  }
}

export const bootstrapGuestDataIfNeeded = async (userId: string | null | undefined): Promise<boolean> => {
  if (!userId || !supabase) {
    return false
  }
  if (bootstrapPromises.has(userId)) {
    return bootstrapPromises.get(userId) ?? false
  }
  const task = (async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('bootstrap_completed')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      throw error
    }
    if (data?.bootstrap_completed) {
      return false
    }
    await migrateGuestData()
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ bootstrap_completed: true })
      .eq('id', userId)
    if (updateError) {
      throw updateError
    }
    return true
  })()
  bootstrapPromises.set(userId, task)
  try {
    return await task
  } finally {
    bootstrapPromises.delete(userId)
  }
}
