import type { Goal } from '../pages/GoalsPage'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'
import { DEMO_GOALS } from './demoGoals'
import { fetchGoalsHierarchy } from './goalsApi'

const STORAGE_KEY = 'nc-taskwatch-goals-snapshot'
export const GOALS_SNAPSHOT_STORAGE_KEY = STORAGE_KEY
const EVENT_NAME = 'nc-taskwatch:goals-update'
export const GOALS_SNAPSHOT_REQUEST_EVENT = 'nc-taskwatch:goals-snapshot-request'
export const GOALS_SNAPSHOT_USER_KEY = 'nc-taskwatch-goals-user'
export const GOALS_GUEST_USER_ID = '__guest__'

export type GoalTaskSubtaskSnapshot = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
}

export type GoalTaskSnapshot = {
  id: string
  text: string
  completed: boolean
  priority: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  // Notes are optional to distinguish "unknown/not loaded" from empty string
  notes?: string
  subtasks: GoalTaskSubtaskSnapshot[]
}

export type GoalBucketSnapshot = {
  id: string
  name: string
  favorite: boolean
  archived: boolean
  surfaceStyle: SurfaceStyle
  tasks: GoalTaskSnapshot[]
}

export type GoalSnapshot = {
  id: string
  name: string
  goalColour?: string
  surfaceStyle: SurfaceStyle
  starred: boolean
  archived: boolean
  milestonesShown?: boolean
  buckets: GoalBucketSnapshot[]
}

const ensureDifficulty = (value: unknown): GoalTaskSnapshot['difficulty'] => {
  if (value === 'green' || value === 'yellow' || value === 'red') {
    return value
  }
  return 'none'
}

const coerceTaskSubtasks = (value: unknown): GoalTaskSubtaskSnapshot[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((subtask) => {
      if (typeof subtask !== 'object' || subtask === null) {
        return null
      }
      const candidate = subtask as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const text = typeof candidate.text === 'string' ? candidate.text : ''
      if (!id) {
        return null
      }
      const completed = Boolean(candidate.completed)
      const sortIndex =
        typeof candidate.sortIndex === 'number'
          ? candidate.sortIndex
          : typeof (candidate as any).sort_index === 'number'
            ? ((candidate as any).sort_index as number)
            : 0
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        // Drop empty subtasks to avoid publishing placeholders to the snapshot
        return null
      }
      return { id, text: trimmed, completed, sortIndex }
    })
    .filter((subtask): subtask is GoalTaskSubtaskSnapshot => Boolean(subtask))
}

const coerceTasks = (value: unknown): GoalTaskSnapshot[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((task) => {
      if (typeof task !== 'object' || task === null) {
        return null
      }
      const candidate = task as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const text = typeof candidate.text === 'string' ? candidate.text : null
      if (!id || text === null) {
        return null
      }
      const completed = Boolean(candidate.completed)
      const priority = Boolean(candidate.priority)
      const difficulty = ensureDifficulty(candidate.difficulty)
      const rawNotes = typeof candidate.notes === 'string' ? candidate.notes : undefined
      const subtasks = coerceTaskSubtasks(candidate.subtasks)
      const out: GoalTaskSnapshot = {
        id,
        text,
        completed,
        priority,
        difficulty,
        subtasks,
      }
      if (typeof rawNotes === 'string') {
        out.notes = rawNotes
      }
      return out
    })
    .filter((task): task is GoalTaskSnapshot => Boolean(task))
}

const coerceBuckets = (value: unknown): GoalBucketSnapshot[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((bucket) => {
      if (typeof bucket !== 'object' || bucket === null) {
        return null
      }
      const candidate = bucket as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      const name = typeof candidate.name === 'string' ? candidate.name : null
      if (!id || name === null) {
        return null
      }
      const favorite = Boolean(candidate.favorite)
      const surfaceStyle = ensureSurfaceStyle(candidate.surfaceStyle, DEFAULT_SURFACE_STYLE)
      const archived = Boolean(candidate.archived)
      const tasks = coerceTasks(candidate.tasks)
      return { id, name, favorite, archived, surfaceStyle, tasks }
    })
    .filter((bucket): bucket is GoalBucketSnapshot => Boolean(bucket))
}

export const createGoalsSnapshot = (goals: Goal[] | unknown): GoalSnapshot[] => {
  if (!Array.isArray(goals)) {
    return []
  }
  const snapshot: GoalSnapshot[] = []
  goals.forEach((goal) => {
    if (typeof goal !== 'object' || goal === null) {
      return
    }
    const candidate = goal as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id : null
    const name = typeof candidate.name === 'string' ? candidate.name : null
    if (!id || name === null) {
      return
    }
    const goalColour =
      typeof (candidate as any).goalColour === 'string'
        ? ((candidate as any).goalColour as string)
        : typeof (candidate as any).goal_colour === 'string'
          ? ((candidate as any).goal_colour as string)
          : undefined
    // Force goal surface to default; goal card styling no longer depends on persisted surface styles.
    const surfaceStyle = DEFAULT_SURFACE_STYLE
    const starred = Boolean(candidate.starred)
    const archived = Boolean(candidate.archived)
    const milestonesShown = typeof (candidate as any).milestonesShown === 'boolean' ? ((candidate as any).milestonesShown as boolean) : undefined
    const buckets = coerceBuckets(candidate.buckets)
    snapshot.push({ id, name, goalColour, surfaceStyle, starred, archived, milestonesShown, buckets })
  })
  return snapshot
}

export const publishGoalsSnapshot = (snapshot: GoalSnapshot[]) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Ignore storage errors (e.g., quota exceeded, restricted environments)
  }
  const dispatch = () => {
    try {
      const event = new CustomEvent<GoalSnapshot[]>(EVENT_NAME, { detail: snapshot })
      window.dispatchEvent(event)
    } catch {
      // CustomEvent may fail in very old browsers; ignore silently
    }
  }
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(dispatch)
  } else {
    setTimeout(dispatch, 0)
  }
}

export const readStoredGoalsSnapshot = (): GoalSnapshot[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return createGoalsSnapshot(parsed)
  } catch {
    return []
  }
}

// Listen for storage events from other tabs to sync goals
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      try {
        const newValue = event.newValue
        if (!newValue) return
        const parsed = JSON.parse(newValue)
        if (Array.isArray(parsed)) {
          const snapshot = createGoalsSnapshot(parsed)
          // Dispatch custom event to notify same-tab listeners
          const customEvent = new CustomEvent<GoalSnapshot[]>(EVENT_NAME, { detail: snapshot })
          window.dispatchEvent(customEvent)
        }
      } catch {}
    }
  })
}

export const subscribeToGoalsSnapshot = (
  callback: (snapshot: GoalSnapshot[]) => void,
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {}
  }
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<GoalSnapshot[]>
    const detail = Array.isArray(customEvent.detail) ? customEvent.detail : []
    callback(detail)
  }
  window.addEventListener(EVENT_NAME, handler as EventListener)
  return () => {
    window.removeEventListener(EVENT_NAME, handler as EventListener)
  }
}

const readStoredGoalsSnapshotUserId = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(GOALS_SNAPSHOT_USER_KEY)
    if (!raw) {
      return null
    }
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

const setStoredGoalsSnapshotUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    if (!userId) {
      window.localStorage.removeItem(GOALS_SNAPSHOT_USER_KEY)
    } else {
      window.localStorage.setItem(GOALS_SNAPSHOT_USER_KEY, userId)
    }
  } catch {
    // ignore storage failures
  }
}

const getGuestSnapshot = (): GoalSnapshot[] => {
  try {
    return createGoalsSnapshot(DEMO_GOALS as unknown as Goal[])
  } catch {
    return []
  }
}

export const ensureGoalsUser = (
  userId: string | null,
  options?: { suppressGuestSnapshot?: boolean },
): void => {
  if (typeof window === 'undefined') {
    return
  }
  const normalized =
    typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : GOALS_GUEST_USER_ID
  const current = readStoredGoalsSnapshotUserId()
  if (current === normalized) {
    return
  }
  const migratingFromGuest = current === GOALS_GUEST_USER_ID && normalized !== GOALS_GUEST_USER_ID
  setStoredGoalsSnapshotUserId(normalized)
  if (normalized === GOALS_GUEST_USER_ID) {
    if (current !== GOALS_GUEST_USER_ID && !options?.suppressGuestSnapshot) {
      const snapshot = getGuestSnapshot()
      publishGoalsSnapshot(snapshot)
    }
  } else if (!migratingFromGuest) {
    try {
      window.localStorage.removeItem(GOALS_SNAPSHOT_STORAGE_KEY)
    } catch {}
    try {
      const event = new CustomEvent<GoalSnapshot[]>(EVENT_NAME, { detail: [] })
      window.dispatchEvent(event)
    } catch {}
  }
}

export const readGoalsSnapshotOwner = (): string | null => readStoredGoalsSnapshotUserId()

/**
 * Fetches goals from Supabase and publishes the snapshot.
 * This allows pages like ReflectionPage to get fresh goals data
 * without waiting for GoalsPage to load.
 * Returns the snapshot if successful, or null if failed/guest user.
 */
export const syncGoalsSnapshotFromSupabase = async (): Promise<GoalSnapshot[] | null> => {
  const owner = readStoredGoalsSnapshotUserId()
  if (!owner || owner === GOALS_GUEST_USER_ID) {
    // Guest users don't sync from Supabase
    return null
  }
  try {
    const result = await fetchGoalsHierarchy()
    if (!result?.goals || result.goals.length === 0) {
      return null
    }
    // Convert the fetched goals to snapshot format
    const snapshot = createGoalsSnapshot(result.goals)
    if (snapshot.length > 0) {
      // Always publish - force update even if signature matches
      // This ensures components get the latest data after bootstrap
      publishGoalsSnapshot(snapshot)
    }
    return snapshot
  } catch {
    return null
  }
}
