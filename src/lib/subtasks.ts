import { supabase, ensureSingleUserSession } from './supabaseClient'
import type { HistoryEntry, HistorySubtask } from './sessionHistory'

const isUuid = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const mapRowToSubtask = (row: any): HistorySubtask | null => {
  if (!row) return null
  const id = typeof row.id === 'string' ? row.id : null
  const text = typeof row.text === 'string' ? row.text : ''
  const completed = Boolean((row as any)?.completed)
  const sortIndexRaw = Number((row as any)?.sort_index)
  const sortIndex = Number.isFinite(sortIndexRaw) ? sortIndexRaw : 0
  if (!id) return null
  return { id, text, completed, sortIndex }
}

export const fetchSubtasksForEntry = async (entry: HistoryEntry): Promise<HistorySubtask[]> => {
  if (!supabase || !entry) return []
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return []
  const userId = session.user.id
  const parentTaskId = isUuid(entry.taskId) ? entry.taskId : null
  const parentSessionId = isUuid(entry.id) ? entry.id : null
  const parentColumn = parentTaskId ? 'task_id' : 'session_id'
  const parentValue = parentTaskId ?? parentSessionId
  if (!parentValue) return []
  const { data, error } = await supabase
    .from('task_subtasks')
    .select('id, text, completed, sort_index')
    .eq('user_id', userId)
    .eq(parentColumn, parentValue)
    .order('sort_index', { ascending: true })
  if (error) return []
  return (data ?? []).map(mapRowToSubtask).filter(Boolean) as HistorySubtask[]
}

type ParentSelector = { taskId?: string | null; sessionId?: string | null }

export const upsertSubtaskForParent = async (
  parent: ParentSelector,
  subtask: HistorySubtask,
): Promise<void> => {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const taskId = isUuid(parent.taskId ?? null) ? parent.taskId : null
  const sessionId = isUuid(parent.sessionId ?? null) ? parent.sessionId : null
  const parentColumn = taskId ? 'task_id' : sessionId ? 'session_id' : null
  const parentValue = taskId ?? sessionId
  if (!parentColumn || !parentValue) return
  const payload: Record<string, any> = {
    id: subtask.id,
    user_id: session.user.id,
    text: subtask.text,
    completed: Boolean(subtask.completed),
    sort_index: Number.isFinite(subtask.sortIndex) ? subtask.sortIndex : 0,
  }
  payload[parentColumn] = parentValue
  await supabase.from('task_subtasks').upsert(payload, { onConflict: 'id' })
}

export const deleteSubtaskForParent = async (
  parent: ParentSelector,
  subtaskId: string,
): Promise<void> => {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const taskId = isUuid(parent.taskId ?? null) ? parent.taskId : null
  const sessionId = isUuid(parent.sessionId ?? null) ? parent.sessionId : null
  const parentColumn = taskId ? 'task_id' : sessionId ? 'session_id' : null
  const parentValue = taskId ?? sessionId
  if (!parentColumn || !parentValue || !subtaskId) return
  await supabase
    .from('task_subtasks')
    .delete()
    .eq('id', subtaskId)
    .eq(parentColumn, parentValue)
    .eq('user_id', session.user.id)
}

export const migrateSessionSubtasksToTask = async (
  sessionId: string,
  taskId: string,
): Promise<void> => {
  if (!supabase || !isUuid(sessionId) || !isUuid(taskId)) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const userId = session.user.id
  const { data: existingRows, error: fetchErr } = await supabase
    .from('task_subtasks')
    .select('id, text, completed, sort_index')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('sort_index', { ascending: true })
  if (fetchErr || !Array.isArray(existingRows) || existingRows.length === 0) return
  const { data: maxRows } = await supabase
    .from('task_subtasks')
    .select('sort_index')
    .eq('user_id', userId)
    .eq('task_id', taskId)
    .order('sort_index', { ascending: false })
    .limit(1)
  const maxSort = Array.isArray(maxRows) && maxRows.length > 0 ? Number((maxRows[0] as any)?.sort_index ?? 0) : 0
  let nextSort = Number.isFinite(maxSort) ? maxSort + 1024 : 1024
  const updates = existingRows.map((row: any, index: number) => ({
    id: row.id,
    user_id: userId,
    task_id: taskId,
    session_id: null,
    text: typeof row.text === 'string' ? row.text : '',
    completed: Boolean(row.completed),
    sort_index: nextSort + index * 1024,
  }))
  await supabase.from('task_subtasks').upsert(updates, { onConflict: 'id' })
}
