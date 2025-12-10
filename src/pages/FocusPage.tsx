import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './FocusPage.css'
import './GoalsPage.css'
import {
  fetchGoalsHierarchy,
  setTaskCompletedAndResort,
  setTaskDifficulty,
  setTaskPriorityAndResort,
  updateTaskNotes as apiUpdateTaskNotes,
  upsertTaskSubtask as apiUpsertTaskSubtask,
  deleteTaskSubtask as apiDeleteTaskSubtask,
} from '../lib/goalsApi'
// Repeating rules fetch not needed for selector coloring; omit imports to avoid unused warnings
// import { readRepeatingExceptions } from '../lib/repeatingExceptions'
import { FOCUS_EVENT_TYPE, PAUSE_FOCUS_EVENT_TYPE, type FocusBroadcastDetail, type FocusBroadcastEvent } from '../lib/focusChannel'
import {
  createGoalsSnapshot,
  publishGoalsSnapshot,
  readStoredGoalsSnapshot,
  subscribeToGoalsSnapshot,
  type GoalSnapshot,
  type GoalTaskSnapshot,
  GOALS_SNAPSHOT_USER_KEY,
  GOALS_GUEST_USER_ID,
} from '../lib/goalsSync'
import {
  DEFAULT_SURFACE_STYLE,
  type SurfaceStyle,
} from '../lib/surfaceStyles'
import {
  fetchRepeatingSessionRules,
  readLocalRepeatingRules,
  storeRepeatingRulesLocal,
  isRepeatingRuleId,
  type RepeatingSessionRule,
} from '../lib/repeatingSessions'
import {
  readRepeatingExceptions,
  subscribeRepeatingExceptions,
  type RepeatingException,
  upsertRepeatingException,
} from '../lib/repeatingExceptions'
import {
  LIFE_ROUTINE_STORAGE_KEY,
  LIFE_ROUTINE_UPDATE_EVENT,
  readStoredLifeRoutines,
  readLifeRoutineOwnerId,
  sanitizeLifeRoutineList,
  syncLifeRoutinesWithSupabase,
  LIFE_ROUTINE_USER_STORAGE_KEY,
  LIFE_ROUTINE_GUEST_USER_ID,
  LIFE_ROUTINE_USER_EVENT,
  type LifeRoutineConfig,
} from '../lib/lifeRoutines'
import {
  readStoredQuickList,
  subscribeQuickList,
  writeStoredQuickList,
  readQuickListOwnerId,
  QUICK_LIST_USER_STORAGE_KEY,
  QUICK_LIST_GUEST_USER_ID,
  QUICK_LIST_USER_EVENT,
  type QuickItem,
  type QuickSubtask,
} from '../lib/quickList'
import { fetchQuickListRemoteItems } from '../lib/quickListRemote'
import {
  CURRENT_SESSION_EVENT_NAME,
  CURRENT_SESSION_STORAGE_KEY,
  HISTORY_EVENT_NAME,
  HISTORY_GUEST_USER_ID,
  HISTORY_LIMIT,
  HISTORY_STORAGE_KEY,
  HISTORY_USER_EVENT,
  HISTORY_USER_KEY,
  persistHistorySnapshot,
  readHistoryOwnerId,
  readStoredHistory as readPersistedHistory,
  syncHistoryWithSupabase,
  type HistoryEntry,
  areHistorySubtasksEqual,
  getCurrentTimezone,
} from '../lib/sessionHistory'
import { logDebug, logWarn } from '../lib/logging'
import { isRecentlyFullSynced } from '../lib/bootstrap'

// Minimal sync instrumentation disabled by default
const DEBUG_SYNC = false

type FocusCandidate = {
  goalId: string
  goalName: string
  bucketId: string
  bucketName: string
  taskId: string
  taskName: string
  completed: boolean
  priority: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  entryColor?: string | null
  notes: string
  subtasks: NotebookSubtask[]
  repeatingRuleId: string | null
  repeatingOccurrenceDate: string | null
  repeatingOriginalTime: number | null
}

type FocusSource = {
  goalId: string | null
  bucketId: string | null
  goalName: string
  bucketName: string
  taskId: string | null
  taskDifficulty: FocusCandidate['difficulty'] | null
  priority: boolean | null
  notes?: string | null
  subtasks?: NotebookSubtask[]
  repeatingRuleId?: string | null
  repeatingOccurrenceDate?: string | null
  repeatingOriginalTime?: number | null
}

type SessionMetadata = {
  goalId: string | null
  bucketId: string | null
  taskId: string | null
  goalName: string | null
  bucketName: string | null
  sessionKey: string | null
  taskLabel: string
  repeatingRuleId: string | null
  repeatingOccurrenceDate: string | null
  repeatingOriginalTime: number | null
}

type TimeMode = 'focus' | 'break'
type ModeSnapshot = {
  taskName: string
  source: FocusSource | null
  customTaskDraft: string
  elapsed: number
  sessionStart: number | null
  isRunning: boolean
  sessionMeta: SessionMetadata
  currentSessionKey: string | null
  lastLoggedSessionKey: string | null
  lastTick: number | null
  lastCommittedElapsed: number
}

const getNextDifficulty = (value: FocusCandidate['difficulty'] | null): FocusCandidate['difficulty'] => {
  switch (value) {
    case 'green':
      return 'yellow'
    case 'yellow':
      return 'red'
    case 'red':
      return 'none'
    case 'none':
    default:
      return 'green'
  }
}

const CURRENT_TASK_STORAGE_KEY = 'nc-taskwatch-current-task'
const CURRENT_TASK_SOURCE_KEY = 'nc-taskwatch-current-task-source'
const NOTEBOOK_STORAGE_KEY = 'nc-taskwatch-notebook'
const MAX_TASK_STORAGE_LENGTH = 256
const FOCUS_COMPLETION_RESET_DELAY_MS = 800
const PRIORITY_HOLD_MS = 300
const STOPWATCH_STORAGE_KEY = 'nc-taskwatch-stopwatch-v1'
const STOPWATCH_SAVE_INTERVAL_MS = 15_000
const DEBUG_STOPWATCH = false

const SNAPBACK_REASONS = [
  { id: 'insta' as const, label: 'Scrolling Insta' },
  { id: 'youtube-scroll' as const, label: 'Scrolling Youtube' },
  { id: 'youtube-random' as const, label: 'Watching Random Youtube videos' },
  { id: 'tv' as const, label: 'Watching TV' },
]

const SNAPBACK_DURATIONS = [
  { id: 5 as const, label: '5m' },
  { id: 30 as const, label: '30m' },
  { id: 60 as const, label: '1h' },
]

const SNAPBACK_ACTIONS = [
  { id: 'breather' as const, label: '15 min breather' },
  { id: 'resume' as const, label: 'Resume this focus' },
  { id: 'switch' as const, label: 'Switch tasks' },
]

type SnapbackReasonId = (typeof SNAPBACK_REASONS)[number]['id']
type SnapbackActionId = (typeof SNAPBACK_ACTIONS)[number]['id']

const LIFE_ROUTINES_NAME = 'Daily Life'
const LIFE_ROUTINES_GOAL_ID = 'life-routines'
const QUICK_LIST_NAME = 'Quick List'
const QUICK_LIST_GOAL_ID = 'quick-list'
const QUICK_LIST_BUCKET_ID = 'quick-list-bucket'
const NEUTRAL_SURFACE: SurfaceStyle = DEFAULT_SURFACE_STYLE
const NEUTRAL_ENTRY_GRADIENT = 'linear-gradient(135deg, #FFF8BF 0%, #FFF8BF 100%)'
// Placeholder duration for new session entries (1 minute) - updated when session ends
const SESSION_PLACEHOLDER_DURATION_MS = 60_000
const formatLocalYmd = (ms: number): string => {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const makeOccurrenceKey = (ruleId: string | null | undefined, originalTime: number | null | undefined): string | null => {
  if (!ruleId) return null
  if (typeof originalTime !== 'number' || !Number.isFinite(originalTime)) return null
  return `${ruleId}:${formatLocalYmd(originalTime)}`
}
const makeSessionKey = (goalId: string | null, bucketId: string | null, taskId: string | null) =>
  goalId && bucketId ? `${goalId}::${bucketId}::${taskId ?? ''}` : null

const makeSessionInstanceKey = (goalId: string | null, bucketId: string | null, taskId: string | null) => {
  const scope = `${goalId ?? 'no-goal'}::${bucketId ?? 'no-bucket'}::${taskId ?? 'no-task'}`
  let unique = ''
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      unique = globalThis.crypto.randomUUID()
    }
  } catch {}
  if (!unique) {
    unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
  return `session::${scope}::${unique}`
}

const classNames = (...values: Array<string | false | null | undefined>): string =>
  values.filter(Boolean).join(' ')

const sanitizeDomIdSegment = (value: string): string => value.replace(/[^a-z0-9]/gi, '-')

const makeNotebookSubtaskInputId = (entryKey: string, subtaskId: string): string =>
  `taskwatch-subtask-${sanitizeDomIdSegment(entryKey)}-${sanitizeDomIdSegment(subtaskId)}`

const shouldDebugStopwatch = (): boolean => {
  if (DEBUG_STOPWATCH) return true
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('nc-debug-stopwatch') === '1'
  } catch {
    return false
  }
}

const debugStopwatch = (...args: unknown[]) => {
  if (!shouldDebugStopwatch()) return
  try {
    // eslint-disable-next-line no-console
    console.log('[Stopwatch]', ...args)
  } catch {}
}

// Auto-size a textarea to fit its content without requiring focus
const autosizeTextArea = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  try {
    el.style.height = 'auto'
    const next = `${el.scrollHeight}px`
    el.style.height = next
  } catch {}
}

// removed unused helper

// (hook moved into FocusPage component body)

const createEmptySessionMetadata = (taskLabel: string): SessionMetadata => ({
  goalId: LIFE_ROUTINES_GOAL_ID,
  bucketId: null,
  taskId: null,
  goalName: LIFE_ROUTINES_NAME,
  bucketName: null,
  sessionKey: null,
  taskLabel,
  repeatingRuleId: null,
  repeatingOccurrenceDate: null,
  repeatingOriginalTime: null,
})

declare global {
  interface Window {
    __ncSetElapsed?: (ms: number) => void
  }
}

const makeHistoryId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (error) {
    logWarn('Failed to generate UUID, falling back to timestamp-based id', error)
  }

  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

type NotebookSubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
  updatedAt?: string
}

type NotebookEntry = {
  notes: string
  subtasks: NotebookSubtask[]
}

type NotebookState = Record<string, NotebookEntry>

const createNotebookEntry = (overrides?: Partial<NotebookEntry>): NotebookEntry => ({
  notes: '',
  subtasks: [],
  ...overrides,
})

const NOTEBOOK_SUBTASK_SORT_STEP = 1024

const sanitizeNotebookSubtasks = (value: unknown): NotebookSubtask[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        return null
      }
      const candidate = item as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id : null
      if (!id) {
        return null
      }
      const text = typeof candidate.text === 'string' ? candidate.text : ''
      const completed = Boolean(candidate.completed)
      const rawSort =
        typeof candidate.sortIndex === 'number'
          ? candidate.sortIndex
          : typeof (candidate as any).sort_index === 'number'
            ? ((candidate as any).sort_index as number)
            : (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP
      const sortIndex = Number.isFinite(rawSort) ? (rawSort as number) : (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP
      return { id, text, completed, sortIndex }
    })
    .filter((item): item is NotebookSubtask => Boolean(item))
}

const cloneNotebookSubtasks = (subtasks: NotebookSubtask[]): NotebookSubtask[] =>
  subtasks.map((subtask) => ({ ...subtask }))

const cloneNotebookEntry = (entry: NotebookEntry): NotebookEntry => ({
  notes: entry.notes,
  subtasks: cloneNotebookSubtasks(entry.subtasks),
})

const sanitizeNotebookEntry = (value: unknown): NotebookEntry => {
  if (typeof value !== 'object' || value === null) {
    return createNotebookEntry()
  }
  const candidate = value as Record<string, unknown>
  const notes = typeof candidate.notes === 'string' ? candidate.notes : ''
  const subtasks = sanitizeNotebookSubtasks(candidate.subtasks)
  return { notes, subtasks }
}

const sanitizeNotebookState = (value: unknown): NotebookState => {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const next: NotebookState = {}
  entries.forEach(([key, entry]) => {
    if (typeof key !== 'string') {
      return
    }
    next[key] = sanitizeNotebookEntry(entry)
  })
  return next
}

const shouldPersistNotebookEntry = (entry: NotebookEntry): boolean =>
  entry.notes.trim().length > 0 || entry.subtasks.length > 0

const createNotebookSubtaskId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    // ignore
  }
  return `notebook-subtask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const createNotebookEmptySubtask = (sortIndex: number): NotebookSubtask => ({
  id: createNotebookSubtaskId(),
  text: '',
  completed: false,
  sortIndex,
})

// removed: append-oriented sort index helper (we now prepend)

const computeNotebookKey = (focusSource: FocusSource | null, taskName: string): string => {
  if (focusSource?.taskId) {
    return `task:${focusSource.taskId}`
  }
  const trimmed = taskName.trim()
  if (focusSource?.goalId) {
    const goalPart = focusSource.goalId
    const bucketPart = focusSource.bucketId ?? 'none'
    if (trimmed.length > 0) {
      return `source:${goalPart}:${bucketPart}:${trimmed.toLowerCase()}`
    }
    return `source:${goalPart}:${bucketPart}:scratch`
  }
  if (trimmed.length > 0) {
    return `custom:${trimmed.toLowerCase()}`
  }
  return 'scratchpad'
}

const historiesAreEqual = (a: HistoryEntry[], b: HistoryEntry[]): boolean => {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (
      left.id !== right.id ||
      left.taskName !== right.taskName ||
      left.elapsed !== right.elapsed ||
      left.startedAt !== right.startedAt ||
      left.endedAt !== right.endedAt ||
      left.goalName !== right.goalName ||
      left.bucketName !== right.bucketName ||
      left.goalId !== right.goalId ||
      left.bucketId !== right.bucketId ||
      left.taskId !== right.taskId ||
      left.notes !== right.notes ||
      !areHistorySubtasksEqual(left.subtasks, right.subtasks) ||
      (left.repeatingSessionId ?? null) !== (right.repeatingSessionId ?? null) ||
      (left.originalTime ?? null) !== (right.originalTime ?? null)
    ) {
      return false
    }
  }
  return true
}

const getStoredTaskName = (): string => {
  if (typeof window === 'undefined') {
    return ''
  }

  const stored = window.localStorage.getItem(CURRENT_TASK_STORAGE_KEY)
  if (!stored) {
    return ''
  }

  const trimmed = stored.trim()
  if (trimmed.length === 0) {
    return ''
  }
  return trimmed.slice(0, MAX_TASK_STORAGE_LENGTH)
}

const readStoredFocusSource = (): FocusSource | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(CURRENT_TASK_SOURCE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const candidate = parsed as Record<string, unknown>
    const goalId = typeof candidate.goalId === 'string' ? candidate.goalId : null
    const bucketId = typeof candidate.bucketId === 'string' ? candidate.bucketId : null
    const goalName =
      typeof candidate.goalName === 'string' && candidate.goalName.trim().length > 0
        ? candidate.goalName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
        : ''
    const bucketName =
      typeof candidate.bucketName === 'string' && candidate.bucketName.trim().length > 0
        ? candidate.bucketName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
        : ''
    if (!goalName || !bucketName) {
      return null
    }
    const taskId = typeof candidate.taskId === 'string' ? candidate.taskId : null
    const rawDifficulty = typeof candidate.taskDifficulty === 'string' ? candidate.taskDifficulty : null
    const taskDifficulty =
      rawDifficulty === 'green' || rawDifficulty === 'yellow' || rawDifficulty === 'red' || rawDifficulty === 'none'
        ? rawDifficulty
        : null
    const priority =
      typeof candidate.priority === 'boolean'
        ? candidate.priority
        : typeof candidate.priority === 'string'
          ? candidate.priority === 'true'
          : null
    const notes = typeof candidate.notes === 'string' ? candidate.notes : ''
    const subtasks = sanitizeNotebookSubtasks(candidate.subtasks)
    const repeatingRuleId =
      typeof candidate.repeatingRuleId === 'string' && candidate.repeatingRuleId.trim().length > 0
        ? candidate.repeatingRuleId.trim()
        : null
    const repeatingOccurrenceDate =
      typeof candidate.repeatingOccurrenceDate === 'string' && candidate.repeatingOccurrenceDate.trim().length > 0
        ? candidate.repeatingOccurrenceDate.trim()
        : null
    const repeatingOriginalTimeRaw = Number(candidate.repeatingOriginalTime)
    const repeatingOriginalTime =
      Number.isFinite(repeatingOriginalTimeRaw) && repeatingOriginalTimeRaw > 0 ? repeatingOriginalTimeRaw : null
    return {
      goalId,
      bucketId,
      goalName,
      bucketName,
      taskId,
      taskDifficulty,
      priority,
      notes,
      subtasks,
      repeatingRuleId: repeatingRuleId ?? null,
      repeatingOccurrenceDate: repeatingOccurrenceDate ?? null,
      repeatingOriginalTime,
    }
  } catch {
    return null
  }
}

const sanitizeStoredFocusSourceValue = (value: unknown): FocusSource | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const goalId = typeof candidate.goalId === 'string' ? candidate.goalId : null
  const bucketId = typeof candidate.bucketId === 'string' ? candidate.bucketId : null
  const goalName =
    typeof candidate.goalName === 'string' && candidate.goalName.trim().length > 0
      ? candidate.goalName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
      : ''
  const bucketName =
    typeof candidate.bucketName === 'string' && candidate.bucketName.trim().length > 0
      ? candidate.bucketName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
      : ''
  if (!goalName || !bucketName) {
    return null
  }
  const taskId = typeof candidate.taskId === 'string' ? candidate.taskId : null
  const rawDifficulty = typeof candidate.taskDifficulty === 'string' ? candidate.taskDifficulty : null
  const taskDifficulty =
    rawDifficulty === 'green' || rawDifficulty === 'yellow' || rawDifficulty === 'red' || rawDifficulty === 'none'
      ? rawDifficulty
      : null
  const priority =
    typeof candidate.priority === 'boolean'
      ? candidate.priority
      : typeof candidate.priority === 'string'
        ? candidate.priority === 'true'
        : null
  const notes = typeof candidate.notes === 'string' ? candidate.notes : ''
  const subtasks = sanitizeNotebookSubtasks(candidate.subtasks)
  const repeatingRuleId =
    typeof candidate.repeatingRuleId === 'string' && candidate.repeatingRuleId.trim().length > 0
      ? candidate.repeatingRuleId.trim()
      : null
  const repeatingOccurrenceDate =
    typeof candidate.repeatingOccurrenceDate === 'string' && candidate.repeatingOccurrenceDate.trim().length > 0
      ? candidate.repeatingOccurrenceDate.trim()
      : null
  const repeatingOriginalTimeRaw = Number(candidate.repeatingOriginalTime)
  const repeatingOriginalTime =
    Number.isFinite(repeatingOriginalTimeRaw) && repeatingOriginalTimeRaw > 0 ? repeatingOriginalTimeRaw : null

  return {
    goalId,
    bucketId,
    goalName,
    bucketName,
    taskId,
    taskDifficulty,
    priority,
    notes,
    subtasks,
    repeatingRuleId: repeatingRuleId ?? null,
    repeatingOccurrenceDate: repeatingOccurrenceDate ?? null,
    repeatingOriginalTime,
  }
}

const clampElapsed = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0
  }
  return numeric
}

const sanitizeStoredSessionMeta = (value: unknown, fallbackTaskLabel: string): SessionMetadata => {
  if (typeof value !== 'object' || value === null) {
    return createEmptySessionMetadata(fallbackTaskLabel)
  }
  const candidate = value as Record<string, unknown>
  const goalId = typeof candidate.goalId === 'string' ? candidate.goalId : null
  const bucketId = typeof candidate.bucketId === 'string' ? candidate.bucketId : null
  const taskId = typeof candidate.taskId === 'string' ? candidate.taskId : null
  const goalName = typeof candidate.goalName === 'string' ? candidate.goalName : null
  const bucketName = typeof candidate.bucketName === 'string' ? candidate.bucketName : null
  const sessionKey = typeof candidate.sessionKey === 'string' ? candidate.sessionKey : null
  const repeatingRuleId = typeof candidate.repeatingRuleId === 'string' ? candidate.repeatingRuleId : null
  const repeatingOccurrenceDate =
    typeof candidate.repeatingOccurrenceDate === 'string' ? candidate.repeatingOccurrenceDate : null
  const repeatingOriginalTimeRaw = Number(candidate.repeatingOriginalTime)
  const repeatingOriginalTime =
    Number.isFinite(repeatingOriginalTimeRaw) && repeatingOriginalTimeRaw > 0 ? repeatingOriginalTimeRaw : null
  const taskLabel =
    typeof candidate.taskLabel === 'string' && candidate.taskLabel.trim().length > 0
      ? candidate.taskLabel.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
      : fallbackTaskLabel

  return {
    goalId,
    bucketId,
    taskId,
    goalName,
    bucketName,
    sessionKey,
    taskLabel,
    repeatingRuleId,
    repeatingOccurrenceDate,
    repeatingOriginalTime,
  }
}

const sanitizeStoredModeSnapshot = (
  value: unknown,
  fallbackTaskName: string,
  fallbackTaskLabel: string,
): ModeSnapshot | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const taskName =
    typeof candidate.taskName === 'string' && candidate.taskName.trim().length > 0
      ? candidate.taskName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
      : fallbackTaskName
  const customTaskDraft =
    typeof candidate.customTaskDraft === 'string' && candidate.customTaskDraft.trim().length > 0
      ? candidate.customTaskDraft.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
      : taskName
  const elapsed = clampElapsed(candidate.elapsed)
  const sessionStartRaw = Number(candidate.sessionStart)
  const sessionStart = Number.isFinite(sessionStartRaw) && sessionStartRaw > 0 ? sessionStartRaw : null
  const isRunning = Boolean(candidate.isRunning) && sessionStart !== null
  const sessionMeta = sanitizeStoredSessionMeta(candidate.sessionMeta, fallbackTaskLabel || taskName)
  const currentSessionKey = typeof candidate.currentSessionKey === 'string' ? candidate.currentSessionKey : null
  const lastLoggedSessionKey = typeof candidate.lastLoggedSessionKey === 'string' ? candidate.lastLoggedSessionKey : null
  const lastTickRaw = Number(candidate.lastTick)
  const lastTick = Number.isFinite(lastTickRaw) && lastTickRaw > 0 ? lastTickRaw : null
  const lastCommittedElapsed = clampElapsed(candidate.lastCommittedElapsed)
  const source = sanitizeStoredFocusSourceValue(candidate.source)

  return {
    taskName,
    customTaskDraft,
    source,
    elapsed,
    sessionStart,
    isRunning,
    sessionMeta,
    currentSessionKey,
    lastLoggedSessionKey,
    lastTick,
    lastCommittedElapsed,
  }
}

const formatTime = (milliseconds: number, showMs: boolean = true) => {
  const totalMs = Math.max(0, Math.floor(milliseconds))
  const days = Math.floor(totalMs / 86_400_000)
  const hours = Math.floor((totalMs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1_000)
  const centiseconds = Math.floor((totalMs % 1_000) / 10)

  const segments: string[] = []

  if (days > 0) {
    segments.push(`${days}D`)
    segments.push(hours.toString().padStart(2, '0'))
  } else if (hours > 0) {
    segments.push(hours.toString().padStart(2, '0'))
  }

  segments.push(minutes.toString().padStart(2, '0'))
  segments.push(seconds.toString().padStart(2, '0'))

  const timeCore = segments.join(':')
  
  if (showMs) {
    const fraction = centiseconds.toString().padStart(2, '0')
    return `${timeCore}.${fraction}`
  }
  
  return timeCore
}

const formatClockTime = (timestamp: number, use24Hour: boolean = false) => {
  const date = new Date(timestamp)
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')

  if (use24Hour) {
    return `${hours24.toString().padStart(2, '0')}:${minutes}:${seconds}`
  }

  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return `${hours12.toString().padStart(2, '0')}:${minutes}:${seconds} ${period}`
}

// (removed: snapback reason parser; panel mirrors Overview triggers instead)

export type FocusPageProps = {
  viewportWidth: number
  showMilliseconds?: boolean
  use24HourTime?: boolean
}

export function FocusPage({ viewportWidth: _viewportWidth, showMilliseconds = true, use24HourTime = false }: FocusPageProps) {
  // Re-autosize notebook subtask inputs on viewport resize so wrapping updates container height
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handle = () => {
      try {
        const host = document.querySelector('.taskwatch-notes') || document.body
        host
          .querySelectorAll<HTMLTextAreaElement>('.goal-task-details__subtask-input')
          .forEach((el) => {
            el.style.height = 'auto'
            el.style.height = `${el.scrollHeight}px`
          })
      } catch {}
    }
    // Initial run
    handle()
    // Keep sizes correct when viewport changes or when returning to the tab/page
    window.addEventListener('resize', handle)
    window.addEventListener('visibilitychange', handle)
    window.addEventListener('pageshow', handle)
    return () => {
      window.removeEventListener('resize', handle)
      window.removeEventListener('visibilitychange', handle)
      window.removeEventListener('pageshow', handle)
    }
  }, [])
  const initialTaskName = useMemo(() => getStoredTaskName(), [])
  const [elapsed, setElapsed] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [isTimeHidden, setIsTimeHidden] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>(() => readPersistedHistory())
  const latestHistoryRef = useRef(history)
  const applyLocalHistoryChange = useCallback(
    (updater: (current: HistoryEntry[]) => HistoryEntry[]) => {
      setHistory((current) => {
        const next = updater(current)
        if (historiesAreEqual(current, next)) {
          return current
        }
        return persistHistorySnapshot(next)
      })
    },
    [],
  )
  
  const [isSnapbackOpen, setIsSnapbackOpen] = useState(false)
  const [snapbackDurationMin, setSnapbackDurationMin] = useState<number>(5)
  const [snapbackDurationMode, setSnapbackDurationMode] = useState<'preset' | 'custom'>('preset')
  const [snapbackReason, setSnapbackReason] = useState<SnapbackReasonId>('insta')
  const [snapbackReasonMode, setSnapbackReasonMode] = useState<'preset' | 'custom'>('preset')
  const [snapbackNextAction, setSnapbackNextAction] = useState<SnapbackActionId>('resume')
  const [, setSnapbackNote] = useState('')
  const [snapbackCustomReason, setSnapbackCustomReason] = useState('')
  const [snapbackCustomDuration, setSnapbackCustomDuration] = useState<string>('')
  const [snapbackReasonSelect, setSnapbackReasonSelect] = useState('')
  const SNAPBACK_CUSTOM_TRIGGERS_KEY = 'nc-taskwatch-snapback-custom-triggers'
  const SNAPBACK_OVERVIEW_TRIGGERS_KEY = 'nc-taskwatch-overview-triggers'
  const [overviewTriggersVersion, setOverviewTriggersVersion] = useState(0)
  const [timeMode, setTimeMode] = useState<TimeMode>('focus')

  useEffect(() => {
    if (isSnapbackOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
      document.body.style.overflow = 'hidden'
      document.body.style.paddingRight = `${scrollbarWidth}px`
    } else {
      document.body.style.overflow = ''
      document.body.style.paddingRight = ''
    }
    return () => {
      document.body.style.overflow = ''
      document.body.style.paddingRight = ''
    }
  }, [isSnapbackOpen])

  const [currentTaskName, setCurrentTaskName] = useState<string>(initialTaskName)
  const [customTaskDraft, setCustomTaskDraft] = useState<string>(initialTaskName)
  const [sessionStart, setSessionStart] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [notebookState, setNotebookState] = useState<NotebookState>(() => {
    if (typeof window === 'undefined') {
      return {}
    }
    try {
      const raw = window.localStorage.getItem(NOTEBOOK_STORAGE_KEY)
      if (!raw) {
        return {}
      }
      const parsed = JSON.parse(raw)
      return sanitizeNotebookState(parsed)
    } catch {
      return {}
    }
  })
  const notebookPersistTimerRef = useRef<number | null>(null)
  const [, setNotebookSubtasksCollapsed] = useState(false)
  const frameRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)
  const timeDisplayRef = useRef<HTMLSpanElement | null>(null)
  const activeTimeModeRef = useRef<TimeMode>('focus')
  const selectorButtonRef = useRef<HTMLButtonElement | null>(null)
  const selectorPopoverRef = useRef<HTMLDivElement | null>(null)
  const focusTaskContainerRef = useRef<HTMLDivElement | null>(null)
  const focusCompleteButtonRef = useRef<HTMLButtonElement | null>(null)
  const focusCompletionTimeoutRef = useRef<number | null>(null)
  const focusPriorityHoldTimerRef = useRef<number | null>(null)
  const focusPriorityHoldTriggeredRef = useRef(false)
  const snapbackDialogRef = useRef<HTMLDivElement | null>(null)
  const customDurationInputRef = useRef<HTMLInputElement | null>(null)
  const focusContextRef = useRef<{
    goalId: string | null
    bucketId: string | null
    taskId: string | null
    sessionKey: string | null
    goalName: string | null
    bucketName: string | null
    repeatingRuleId: string | null
    repeatingOccurrenceDate: string | null
    repeatingOriginalTime: number | null
  }>({
    goalId: null,
    bucketId: null,
    taskId: null,
    sessionKey: null,
    goalName: null,
    bucketName: null,
    repeatingRuleId: null,
    repeatingOccurrenceDate: null,
    repeatingOriginalTime: null,
  })
  // Keep the DOM stopwatch display in sync without waiting for React re-renders
  const updateTimeDisplay = useCallback(
    (elapsedMs: number) => {
      if (!timeDisplayRef.current) return
      const text = formatTime(elapsedMs, showMilliseconds)
      const isLong = elapsedMs >= 3_600_000
      const charCount = text.length
      let lenClass = ''
      if (charCount >= 15) lenClass = 'time-length-xxs'
      else if (charCount >= 13) lenClass = 'time-length-xs'
      else if (charCount >= 11) lenClass = 'time-length-sm'
      const hiddenClass = isTimeHidden ? 'time-value--hidden' : ''
      const longClass = isLong ? 'time-value--long' : ''
      timeDisplayRef.current.textContent = text
      timeDisplayRef.current.className = `time-value ${longClass} ${lenClass} ${hiddenClass}`
    },
    [isTimeHidden, showMilliseconds],
  )

  const resetStopwatchDisplay = useCallback(() => {
    updateTimeDisplay(0)
  }, [updateTimeDisplay])
  const currentSessionKeyRef = useRef<string | null>(null)
  const lastLoggedSessionKeyRef = useRef<string | null>(null)
  const lastCommittedElapsedRef = useRef(0)
  // Track the history entry ID for the current active session (created on start with 1-min placeholder)
  const activeSessionEntryIdRef = useRef<string | null>(null)
  const modeStateRef = useRef<Record<TimeMode, ModeSnapshot>>({
    focus: {
      taskName: initialTaskName,
      source: null,
      customTaskDraft,
      elapsed: 0,
      sessionStart: null,
      isRunning: false,
      sessionMeta: createEmptySessionMetadata(initialTaskName || 'Click to choose a focus task…'),
      currentSessionKey: null,
      lastLoggedSessionKey: null,
      lastTick: null,
      lastCommittedElapsed: 0,
    },
    break: {
      taskName: '',
      source: null,
      customTaskDraft: '',
      elapsed: 0,
      sessionStart: null,
      isRunning: false,
      sessionMeta: createEmptySessionMetadata('Click to choose a break task…'),
      currentSessionKey: null,
      lastLoggedSessionKey: null,
      lastTick: null,
      lastCommittedElapsed: 0,
    },
  })
  const hasHydratedStopwatchRef = useRef(false)
  const skipNextPersistRef = useRef(false)
  const [isSelectorOpen, setIsSelectorOpen] = useState(false)
  const goalsSnapshotSignatureRef = useRef<string | null>(null)
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => {
    const stored = readStoredGoalsSnapshot()
    goalsSnapshotSignatureRef.current = JSON.stringify(stored)
    return stored
  })
  const activeGoalSnapshots = useMemo(
    () => goalsSnapshot.filter((goal) => !goal.archived),
    [goalsSnapshot],
  )
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(() => new Set())
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(() => new Set())
  const [lifeRoutinesExpanded, setLifeRoutinesExpanded] = useState(false)
  const [lifeRoutineTasks, setLifeRoutineTasks] = useState<LifeRoutineConfig[]>(() => readStoredLifeRoutines())
  const [lifeRoutineOwnerSignal, setLifeRoutineOwnerSignal] = useState(0)
  const initialLifeRoutineCountRef = useRef(lifeRoutineTasks.length)
  const lifeRoutineBucketIds = useMemo(
    () => new Set(lifeRoutineTasks.map((task) => task.bucketId)),
    [lifeRoutineTasks],
  )
  const [quickListItems, setQuickListItems] = useState<QuickItem[]>(() => readStoredQuickList())
  const [quickListOwnerSignal, setQuickListOwnerSignal] = useState(0)
  const [quickListExpanded, setQuickListExpanded] = useState(false)
  const [quickListRemoteIds, setQuickListRemoteIds] = useState<{ goalId: string; bucketId: string } | null>(null)
  const quickListRefreshInFlightRef = useRef(false)
  const quickListRefreshPendingRef = useRef(false)
  const [historyOwnerSignal, setHistoryOwnerSignal] = useState(0)
  const shouldSkipGoalsRemote = useCallback(() => {
    if (typeof window === 'undefined') {
      return false
    }
    try {
      const owner = window.localStorage.getItem(GOALS_SNAPSHOT_USER_KEY)
      return !owner || owner === GOALS_GUEST_USER_ID
    } catch {
      return false
    }
  }, [])
  const goalGradientById = useMemo(() => {
    const map = new Map<string, string>()
    goalsSnapshot.forEach((goal) => {
      if (goal?.id && typeof (goal as any).goalColour === 'string' && (goal as any).goalColour.trim().length > 0) {
        map.set(goal.id, (goal as any).goalColour.trim())
      }
    })
    return map
  }, [goalsSnapshot])
  const lifeRoutineColorByBucket = useMemo(() => {
    const map = new Map<string, string>()
    lifeRoutineTasks.forEach((r) => {
      if (r.bucketId && typeof r.surfaceColor === 'string' && r.surfaceColor.trim().length > 0) {
        map.set(r.bucketId, r.surfaceColor.trim())
      }
    })
    return map
  }, [lifeRoutineTasks])
  useEffect(() => {
    const unsubscribe = subscribeQuickList((items) => setQuickListItems(items))
    return () => {
      try {
        unsubscribe()
      } catch {}
    }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const bump = () => setQuickListOwnerSignal((value) => value + 1)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === QUICK_LIST_USER_STORAGE_KEY) {
        bump()
      }
    }
    window.addEventListener(QUICK_LIST_USER_EVENT, bump as EventListener)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(QUICK_LIST_USER_EVENT, bump as EventListener)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const bump = () => {
      setHistoryOwnerSignal((current) => current + 1)
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === HISTORY_USER_KEY) {
        bump()
      }
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(HISTORY_USER_EVENT, bump)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(HISTORY_USER_EVENT, bump)
    }
  }, [])
  useEffect(() => {
    goalsSnapshotSignatureRef.current = JSON.stringify(goalsSnapshot)
  }, [goalsSnapshot])
  const goalsSnapshotRefreshInFlightRef = useRef(false)
  const goalsSnapshotRefreshPendingRef = useRef(false)
  const refreshGoalsSnapshotFromSupabase = useCallback(
    (reason?: string) => {
      if (shouldSkipGoalsRemote()) {
        return
      }
      if (goalsSnapshotRefreshInFlightRef.current) {
        goalsSnapshotRefreshPendingRef.current = true
        return
      }
      goalsSnapshotRefreshInFlightRef.current = true
      ;(async () => {
        try {
          const result = await fetchGoalsHierarchy()
          if (Array.isArray(result?.goals) && result.goals.length > 0) {
            const snapshot = createGoalsSnapshot(result.goals)
            const signature = JSON.stringify(snapshot)
            if (signature !== goalsSnapshotSignatureRef.current) {
              goalsSnapshotSignatureRef.current = signature
              setGoalsSnapshot(snapshot)
              publishGoalsSnapshot(snapshot)
            }
          }
        } catch (error) {
          logWarn(
            `[Focus] Failed to refresh goals from Supabase${reason ? ` (${reason})` : ''}:`,
            error,
          )
        } finally {
          goalsSnapshotRefreshInFlightRef.current = false
          if (goalsSnapshotRefreshPendingRef.current) {
            goalsSnapshotRefreshPendingRef.current = false
            refreshGoalsSnapshotFromSupabase(reason)
          }
        }
      })()
    },
    [setGoalsSnapshot, shouldSkipGoalsRemote],
  )
  const refreshQuickListFromSupabase = useCallback(
    (reason?: string) => {
      if (quickListRefreshInFlightRef.current) {
        quickListRefreshPendingRef.current = true
        return
      }
      quickListRefreshInFlightRef.current = true
      ;(async () => {
        try {
          const remote = await fetchQuickListRemoteItems()
          if (remote?.goalId && remote?.bucketId) {
            setQuickListRemoteIds({ goalId: remote.goalId, bucketId: remote.bucketId })
          }
          if (remote?.items) {
            const stored = writeStoredQuickList(remote.items)
            setQuickListItems(stored)
          }
        } catch (error) {
          logWarn(
            `[Focus] Failed to refresh Quick List from Supabase${reason ? ` (${reason})` : ''}:`,
            error,
          )
        } finally {
          quickListRefreshInFlightRef.current = false
          if (quickListRefreshPendingRef.current) {
            quickListRefreshPendingRef.current = false
            refreshQuickListFromSupabase(reason)
          }
        }
      })()
    },
    [],
  )
  useEffect(() => {
    if (quickListOwnerSignal === 0) {
      return
    }
    try {
      setQuickListItems(readStoredQuickList())
    } catch {}
    const ownerId = readQuickListOwnerId()
    if (!ownerId || ownerId === QUICK_LIST_GUEST_USER_ID) {
      return
    }
    refreshQuickListFromSupabase('owner-change')
  }, [quickListOwnerSignal, refreshQuickListFromSupabase])
  const [focusSource, setFocusSource] = useState<FocusSource | null>(() => readStoredFocusSource())
  const [isCompletingFocus, setIsCompletingFocus] = useState(false)
  void _viewportWidth
  // Track repeating exceptions so guide suppression follows skips/reschedules immediately
  const [repeatingExceptions, setRepeatingExceptions] = useState<RepeatingException[]>(() => {
    try { return readRepeatingExceptions() } catch { return [] }
  })
  useEffect(() => {
    const unsub = subscribeRepeatingExceptions((rows) => setRepeatingExceptions(rows))
    return () => { try { unsub?.() } catch {} }
  }, [])

  useEffect(() => {
    // Skip fetch if we just did a full sync (e.g. after auth callback)
    if (isRecentlyFullSynced()) {
      return
    }
    let cancelled = false
    void (async () => {
      const synced = await syncLifeRoutinesWithSupabase()
      if (!cancelled && synced) {
        if (synced.length === 0 && initialLifeRoutineCountRef.current > 0) {
          return
        }
        setLifeRoutineTasks((current) =>
          JSON.stringify(current) === JSON.stringify(synced) ? current : synced,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const bump = () => setLifeRoutineOwnerSignal((value) => value + 1)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LIFE_ROUTINE_USER_STORAGE_KEY) {
        bump()
      }
    }
    window.addEventListener(LIFE_ROUTINE_USER_EVENT, bump as EventListener)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(LIFE_ROUTINE_USER_EVENT, bump as EventListener)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])
  useEffect(() => {
    if (lifeRoutineOwnerSignal === 0) {
      return
    }
    try {
      setLifeRoutineTasks(readStoredLifeRoutines())
    } catch {}
    const ownerId = readLifeRoutineOwnerId()
    if (!ownerId || ownerId === LIFE_ROUTINE_GUEST_USER_ID) {
      return
    }
    let cancelled = false
    void (async () => {
      const synced = await syncLifeRoutinesWithSupabase()
      if (!cancelled && synced) {
        setLifeRoutineTasks((current) =>
          JSON.stringify(current) === JSON.stringify(synced) ? current : synced,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [lifeRoutineOwnerSignal])

useEffect(() => {
  if (shouldSkipGoalsRemote()) {
    return
  }
  refreshGoalsSnapshotFromSupabase('initial-load')
}, [refreshGoalsSnapshotFromSupabase, shouldSkipGoalsRemote])
useEffect(() => {
  if (typeof window !== 'undefined') {
    const quickUser = window.localStorage.getItem('nc-taskwatch-quick-list-user')
    if (!quickUser || quickUser === '__guest__') {
      return
    }
  }
  refreshQuickListFromSupabase('initial-load')
}, [refreshQuickListFromSupabase])

  useEffect(() => {
    setCurrentTime(Date.now())
    if (typeof window === 'undefined') return

    const intervalId = window.setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  // Compute most common Snapback reasons from history and include any saved custom triggers
  const snapbackReasonStats = useMemo(() => {
    const labels: string[] = (() => {
      if (typeof window === 'undefined') return []
      try {
        const raw = window.localStorage.getItem(SNAPBACK_OVERVIEW_TRIGGERS_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? (parsed as string[]).filter((s) => typeof s === 'string' && s.trim().length > 0) : []
      } catch { return [] }
    })()
    const ordered = labels.map((s) => s.trim())
    const topTwo = ordered.slice(0, 2)
    const others = ordered.slice(2)
    return { topTwo, others, all: ordered }
  }, [overviewTriggersVersion])

  // Keep panel in sync with overview changes via storage events
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (e: StorageEvent) => {
      if (e.key === SNAPBACK_OVERVIEW_TRIGGERS_KEY) {
        setOverviewTriggersVersion((v) => v + 1)
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LIFE_ROUTINE_STORAGE_KEY) {
        setLifeRoutineTasks(readStoredLifeRoutines())
      }
    }
    const handleUpdate = (event: Event) => {
      if (event instanceof CustomEvent) {
        setLifeRoutineTasks(sanitizeLifeRoutineList(event.detail))
      }
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleUpdate as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(LIFE_ROUTINE_UPDATE_EVENT, handleUpdate as EventListener)
    }
  }, [])

  useEffect(() => {
    latestHistoryRef.current = history
  }, [history])

  useEffect(() => {
    const owner = readHistoryOwnerId()
    if (!owner || owner === HISTORY_GUEST_USER_ID) {
      return
    }
    // Skip fetch if we just did a full sync (e.g. after auth callback)
    if (isRecentlyFullSynced()) {
      return
    }
    let cancelled = false
    void (async () => {
      const synced = await syncHistoryWithSupabase()
      if (cancelled || !synced) {
        return
      }
      setHistory((current) => (historiesAreEqual(current, synced) ? current : synced))
    })()
    return () => {
      cancelled = true
    }
  }, [historyOwnerSignal])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const applyIncomingHistory = (incoming: HistoryEntry[]) => {
      const next = incoming.slice(0, HISTORY_LIMIT)
      if (!historiesAreEqual(latestHistoryRef.current, next)) {
        setHistory(next)
      }
    }

    const handleStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith(HISTORY_STORAGE_KEY)) {
        return
      }
      try {
        const next = readPersistedHistory()
        applyIncomingHistory(next)
      } catch (error) {
        logWarn('Failed to sync stopwatch history from storage', error)
      }
    }

    const handleHistoryBroadcast = () => {
      const next = readPersistedHistory()
      applyIncomingHistory(next)
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    // Debounce notebook persistence to avoid blocking on rapid adds/edits
    if (notebookPersistTimerRef.current !== null) {
      window.clearTimeout(notebookPersistTimerRef.current)
    }
    const handle = window.setTimeout(() => {
      try {
        window.localStorage.setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify(notebookState))
      } catch (error) {
        logWarn('Failed to persist Focus notebook state', error)
      }
      notebookPersistTimerRef.current = null
    }, 300)
    notebookPersistTimerRef.current = handle
    return () => {
      if (notebookPersistTimerRef.current !== null) {
        window.clearTimeout(notebookPersistTimerRef.current)
        notebookPersistTimerRef.current = null
      }
    }
  }, [notebookState])
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined') {
        notebookNotesSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
        notebookSubtaskSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
        if (notebookPersistTimerRef.current !== null) {
          window.clearTimeout(notebookPersistTimerRef.current)
          notebookPersistTimerRef.current = null
        }
      }
      notebookNotesSaveTimersRef.current.clear()
      notebookSubtaskSaveTimersRef.current.clear()
      // Flush latest notebook state to storage
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify(notebookState))
        }
      } catch (error) {
        logWarn('Failed to persist Focus notebook state on unload', error)
      }
      notebookNotesLatestRef.current.forEach((notes, taskId) => {
        void apiUpdateTaskNotes(taskId, notes).catch((error) =>
          logWarn('[Focus] Failed to flush pending notes on unload:', error),
        )
      })
      notebookNotesLatestRef.current.clear()
      notebookSubtaskLatestRef.current.forEach((subtask, compositeKey) => {
        const [taskId] = compositeKey.split(':')
        if (!taskId || subtask.text.trim().length === 0) {
          return
        }
        void apiUpsertTaskSubtask(taskId, {
          id: subtask.id,
          text: subtask.text,
          completed: subtask.completed,
          sort_index: subtask.sortIndex,
          updated_at: subtask.updatedAt ?? new Date().toISOString(),
        }).catch((error) => logWarn('[Focus] Failed to flush pending subtask on unload:', error))
      })
      notebookSubtaskLatestRef.current.clear()
    }
  }, [apiUpdateTaskNotes, apiUpsertTaskSubtask])

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Only persist task name for focus mode - break mode has its own separate state
    if (timeMode !== 'focus') return

    const trimmed = currentTaskName.trim()
    const value = trimmed.length > 0 ? trimmed : ''

    try {
      window.localStorage.setItem(CURRENT_TASK_STORAGE_KEY, value)
    } catch (error) {
      logWarn('Failed to persist current task name', error)
    }
  }, [currentTaskName, timeMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Only persist focus source for focus mode
    if (timeMode !== 'focus') return
    try {
      if (focusSource) {
        window.localStorage.setItem(CURRENT_TASK_SOURCE_KEY, JSON.stringify(focusSource))
      } else {
        window.localStorage.removeItem(CURRENT_TASK_SOURCE_KEY)
      }
    } catch (error) {
      logWarn('Failed to persist current task source', error)
    }
  }, [focusSource, timeMode])

  useEffect(() => {
    activeTimeModeRef.current = timeMode
  }, [timeMode])

  useEffect(() => {
    if (!isRunning) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      lastTickRef.current = null
      return
    }

    const update = () => {
      if (activeTimeModeRef.current !== timeMode) {
        return
      }
      if (sessionStart === null) return
      const now = Date.now()
      const currentElapsed = now - sessionStart
      updateTimeDisplay(currentElapsed)
      frameRef.current = requestAnimationFrame(update)
    }

    frameRef.current = requestAnimationFrame(update)

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [isRunning, sessionStart, timeMode, updateTimeDisplay])

  // Keep the displayed time in sync when idle or when switching modes to prevent stale flashes
  useEffect(() => {
    if (!isRunning) {
      updateTimeDisplay(elapsed)
    }
  }, [elapsed, isRunning, updateTimeDisplay])

  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return

    window.__ncSetElapsed = (ms: number) => {
      setIsRunning(false)
      const safeElapsed = Math.max(0, Math.floor(ms))
      setElapsed(safeElapsed)
      const now = Date.now()
      setSessionStart(now - safeElapsed)
      lastTickRef.current = null
    }

    return () => {
      delete window.__ncSetElapsed
    }
  }, [])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (focusCompletionTimeoutRef.current !== null) {
        window.clearTimeout(focusCompletionTimeoutRef.current)
        focusCompletionTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToGoalsSnapshot((snapshot) => {
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] snapshot received', { goals: snapshot.length })
        } catch {}
      }
      setGoalsSnapshot(snapshot)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    const handleFocus = () => {
      if (!document.hidden) {
        refreshGoalsSnapshotFromSupabase('window-focus')
        const quickUser = typeof window !== 'undefined' ? window.localStorage.getItem('nc-taskwatch-quick-list-user') : null
        if (quickUser && quickUser !== '__guest__') {
          refreshQuickListFromSupabase('window-focus')
        }
      }
    }
    const handleVisibility = () => {
      if (!document.hidden) {
        refreshGoalsSnapshotFromSupabase('document-visible')
        const quickUser = typeof window !== 'undefined' ? window.localStorage.getItem('nc-taskwatch-quick-list-user') : null
        if (quickUser && quickUser !== '__guest__') {
          refreshQuickListFromSupabase('document-visible')
        }
      }
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refreshGoalsSnapshotFromSupabase, refreshQuickListFromSupabase])


  useEffect(() => {
    if (!isSelectorOpen || typeof window === 'undefined') {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const withinFocusTask = focusTaskContainerRef.current?.contains(target) ?? false
      const withinPopover = selectorPopoverRef.current?.contains(target) ?? false
      if (withinFocusTask || withinPopover) {
        return
      }
      setIsSelectorOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsSelectorOpen(false)
        selectorButtonRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSelectorOpen])

  const normalizedCurrentTask = useMemo(() => currentTaskName.trim(), [currentTaskName])
  const defaultTaskName = timeMode === 'focus' ? 'Click to choose a focus task…' : 'Click to choose a break task…'
  const safeTaskName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : defaultTaskName
  const sessionMetadataRef = useRef<SessionMetadata>(createEmptySessionMetadata(safeTaskName))
  const elapsedSeconds = Math.floor(elapsed / 1000)
  const computeCurrentElapsed = useCallback(
    () => (isRunning && sessionStart !== null ? (Date.now() - sessionStart) : elapsed),
    [elapsed, isRunning, sessionStart],
  )

  const buildModeSnapshotForPersistence = useCallback(
    (mode: TimeMode): ModeSnapshot => {
      if (mode === timeMode) {
        const totalElapsed = computeCurrentElapsed()
        return {
          ...modeStateRef.current[mode],
          taskName: currentTaskName,
          customTaskDraft,
          source: focusSource,
          elapsed: totalElapsed,
          sessionStart,
          isRunning: isRunning && sessionStart !== null,
          sessionMeta: { ...sessionMetadataRef.current },
          currentSessionKey: currentSessionKeyRef.current,
          lastLoggedSessionKey: lastLoggedSessionKeyRef.current,
          lastTick: lastTickRef.current,
          lastCommittedElapsed: lastCommittedElapsedRef.current,
        }
      }
      const snapshot = modeStateRef.current[mode]
      return {
        ...snapshot,
        isRunning: Boolean(snapshot.isRunning && snapshot.sessionStart !== null),
      }
    },
    [
      computeCurrentElapsed,
      currentTaskName,
      customTaskDraft,
      focusSource,
      isRunning,
      sessionStart,
      timeMode,
    ],
  )

  const persistStopwatchState = useCallback(() => {
    if (!hasHydratedStopwatchRef.current || typeof window === 'undefined') {
      return
    }

    try {
      const normalizeSnapshot = (snapshot: ModeSnapshot, fallbackTaskName: string) =>
        sanitizeStoredModeSnapshot(
          snapshot,
          fallbackTaskName,
          snapshot.sessionMeta?.taskLabel ?? fallbackTaskName,
        ) ?? snapshot

      // Build snapshots - for the active mode, use current state; for inactive mode, use stored snapshot
      // This ensures modes don't cross-contaminate each other
      const focusSnapshot = timeMode === 'focus'
        ? normalizeSnapshot(buildModeSnapshotForPersistence('focus'), currentTaskName || '')
        : modeStateRef.current.focus  // Keep the stored focus snapshot unchanged when in break mode
      const breakSnapshot = timeMode === 'break'
        ? normalizeSnapshot(buildModeSnapshotForPersistence('break'), currentTaskName || '')
        : modeStateRef.current.break  // Keep the stored break snapshot unchanged when in focus mode

      modeStateRef.current = {
        focus: focusSnapshot,
        break: breakSnapshot,
      }

      const payload = {
        activeMode: timeMode,
        modes: {
          focus: focusSnapshot,
          break: breakSnapshot,
        },
        updatedAt: Date.now(),
      }

      window.localStorage.setItem(STOPWATCH_STORAGE_KEY, JSON.stringify(payload))
      debugStopwatch('persist', payload)
    } catch (error) {
      logWarn('Failed to persist stopwatch state', error)
      debugStopwatch('persist: failed', error)
    }
  }, [buildModeSnapshotForPersistence, currentTaskName, timeMode])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      const raw = window.localStorage.getItem(STOPWATCH_STORAGE_KEY)
      if (!raw) {
        debugStopwatch('hydrate: no stored stopwatch state')
        // Sync modeStateRef.current.focus with the initial focusSource state
        // This ensures the focus snapshot has the correct source from the start
        const initialSource = readStoredFocusSource()
        if (initialSource) {
          modeStateRef.current.focus = {
            ...modeStateRef.current.focus,
            source: initialSource,
          }
        }
        hasHydratedStopwatchRef.current = true
        return
      }
      debugStopwatch('hydrate: raw payload', raw)
      const parsed = JSON.parse(raw)
      const fallbackFocus = initialTaskName || ''
      const focusSnapshot =
        sanitizeStoredModeSnapshot(parsed?.modes?.focus, fallbackFocus, fallbackFocus) ??
        modeStateRef.current.focus
      const breakSnapshot =
        sanitizeStoredModeSnapshot(parsed?.modes?.break, '', '') ?? modeStateRef.current.break
      modeStateRef.current = {
        focus: focusSnapshot,
        break: breakSnapshot,
      }
      const activeMode: TimeMode = parsed?.activeMode === 'break' ? 'break' : 'focus'
      const activeSnapshot = activeMode === 'break' ? breakSnapshot : focusSnapshot
      const now = Date.now()
      const effectiveElapsed =
        activeSnapshot.isRunning && activeSnapshot.sessionStart !== null
          ? Math.max(0, now - activeSnapshot.sessionStart)
          : activeSnapshot.elapsed

      debugStopwatch('hydrate: restored', {
        activeMode,
        effectiveElapsed,
        sessionStart: activeSnapshot.sessionStart,
        isRunning: activeSnapshot.isRunning,
        focusElapsed: focusSnapshot.elapsed,
        breakElapsed: breakSnapshot.elapsed,
      })

      setTimeMode(activeMode)
      setCurrentTaskName(activeSnapshot.taskName)
      setCustomTaskDraft(activeSnapshot.customTaskDraft)
      setFocusSource(activeSnapshot.source)
      setElapsed(effectiveElapsed)
      if (activeSnapshot.isRunning && activeSnapshot.sessionStart !== null) {
        setSessionStart(activeSnapshot.sessionStart)
        setIsRunning(true)
      } else {
        setSessionStart(null)
        setIsRunning(false)
      }
      sessionMetadataRef.current = { ...activeSnapshot.sessionMeta }
      currentSessionKeyRef.current = activeSnapshot.currentSessionKey
      lastLoggedSessionKeyRef.current = activeSnapshot.lastLoggedSessionKey
      lastCommittedElapsedRef.current = activeSnapshot.lastCommittedElapsed
      lastTickRef.current = activeSnapshot.lastTick
      updateTimeDisplay(effectiveElapsed)
      skipNextPersistRef.current = true
    } catch (error) {
      logWarn('Failed to hydrate stopwatch state', error)
      debugStopwatch('hydrate: failed', error)
    } finally {
      hasHydratedStopwatchRef.current = true
    }
  }, [initialTaskName, updateTimeDisplay])

  useEffect(() => {
    if (!hasHydratedStopwatchRef.current) {
      return
    }
    if (skipNextPersistRef.current) {
      debugStopwatch('persist effect: skip post-hydrate')
      skipNextPersistRef.current = false
      return
    }
    persistStopwatchState()
    debugStopwatch('persist effect: change', {
      isRunning,
      elapsed,
      timeMode,
      sessionStart,
    })
  }, [
    currentTaskName,
    customTaskDraft,
    elapsed,
    focusSource,
    isRunning,
    persistStopwatchState,
    sessionStart,
    timeMode,
  ])

  useEffect(() => {
    if (typeof window === 'undefined' || !isRunning) {
      return
    }
    const handle = window.setInterval(() => {
      persistStopwatchState()
      debugStopwatch('persist interval tick', { isRunning: true })
    }, STOPWATCH_SAVE_INTERVAL_MS)
    return () => {
      window.clearInterval(handle)
    }
  }, [isRunning, persistStopwatchState])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handle = () => {
      persistStopwatchState()
      debugStopwatch('persist on visibility/pagehide')
    }
    window.addEventListener('visibilitychange', handle)
    window.addEventListener('pagehide', handle)
    return () => {
      window.removeEventListener('visibilitychange', handle)
      window.removeEventListener('pagehide', handle)
    }
  }, [persistStopwatchState])

  useEffect(() => {
    if (!isRunning) {
      sessionMetadataRef.current = {
        ...sessionMetadataRef.current,
        taskLabel: safeTaskName,
      }
    }
  }, [isRunning, safeTaskName])

  const focusCandidates = useMemo<FocusCandidate[]>(() => {
    const candidates: FocusCandidate[] = []
    activeGoalSnapshots.forEach((goal) => {
      const goalGradient =
        typeof (goal as any).goalColour === 'string' && (goal as any).goalColour.trim().length > 0
          ? (goal as any).goalColour.trim()
          : null
      goal.buckets
        .filter((bucket) => !bucket.archived)
        .forEach((bucket) => {
          bucket.tasks.forEach((task) => {
            const candidateSubtasks =
              Array.isArray(task.subtasks)
                ? task.subtasks.map((subtask) => ({
                    id: subtask.id,
                    text: subtask.text,
                    completed: subtask.completed,
                    sortIndex:
                      typeof subtask.sortIndex === 'number'
                        ? subtask.sortIndex
                        : NOTEBOOK_SUBTASK_SORT_STEP,
                  }))
                : []
            candidates.push({
              goalId: goal.id,
              goalName: goal.name,
              bucketId: bucket.id,
              bucketName: bucket.name,
              taskId: task.id,
              taskName: task.text,
              completed: task.completed,
              priority: task.priority,
              difficulty: task.difficulty,
              entryColor: goalGradient,
              notes: typeof task.notes === 'string' ? task.notes : '',
              subtasks: candidateSubtasks,
              repeatingRuleId: null,
              repeatingOccurrenceDate: null,
              repeatingOriginalTime: null,
            })
          })
        })
    })
    return candidates
  }, [activeGoalSnapshots])
  const quickListFocusCandidates = useMemo<FocusCandidate[]>(() => {
    if (quickListItems.length === 0) {
      return []
    }
    const goalId = quickListRemoteIds?.goalId ?? QUICK_LIST_GOAL_ID
    const bucketId = quickListRemoteIds?.bucketId ?? QUICK_LIST_BUCKET_ID
    const quickGradient = goalGradientById.get(goalId) ?? null
    return quickListItems.map((item) => ({
      goalId,
      goalName: QUICK_LIST_NAME,
      bucketId,
      bucketName: QUICK_LIST_NAME,
      taskId: item.id,
      taskName: item.text,
      completed: Boolean(item.completed),
      priority: Boolean(item.priority),
      difficulty: item.difficulty ?? 'none',
      entryColor: quickGradient,
      notes: typeof item.notes === 'string' ? item.notes : '',
      subtasks: Array.isArray(item.subtasks)
        ? item.subtasks.map((subtask, index) => ({
            id: subtask.id,
            text: subtask.text,
            completed: Boolean(subtask.completed),
            sortIndex:
              typeof subtask.sortIndex === 'number'
                ? subtask.sortIndex
                : (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP,
          }))
        : [],
      repeatingRuleId: null,
      repeatingOccurrenceDate: null,
      repeatingOriginalTime: null,
    }))
  }, [goalGradientById, quickListItems, quickListRemoteIds])
  const quickListActiveCandidates = useMemo(
    () => quickListFocusCandidates.filter((candidate) => !candidate.completed),
    [quickListFocusCandidates],
  )
  const quickListPriorityCandidates = useMemo(
    () => quickListFocusCandidates.filter((candidate) => candidate.priority && !candidate.completed),
    [quickListFocusCandidates],
  )
  const isQuickListGoal = useCallback(
    (goalId: string | null | undefined) => {
      if (!goalId) {
        return false
      }
      if (goalId === QUICK_LIST_GOAL_ID) {
        return true
      }
      if (quickListRemoteIds?.goalId) {
        return goalId === quickListRemoteIds.goalId
      }
      return false
    },
    [quickListRemoteIds],
  )

  const priorityTasks = useMemo(
    () => [
      ...focusCandidates.filter((candidate) => candidate.priority && !candidate.completed),
      ...quickListPriorityCandidates,
    ],
    [focusCandidates, quickListPriorityCandidates],
  )

  // Promote scheduled (planned) sessions that overlap 'now' to the top of the selector
  // Check if entry is all-day (prefer isAllDay flag, fallback to timestamp detection)
  const isAllDayEntry = (entry: HistoryEntry): boolean => {
    if (typeof entry.isAllDay === 'boolean') return entry.isAllDay
    // Fallback: detect by timestamp pattern (for entries without flag)
    const DAY_MS = 24 * 60 * 60 * 1000
    const startMid = new Date(entry.startedAt)
    startMid.setHours(0, 0, 0, 0)
    const endMid = new Date(entry.endedAt)
    endMid.setHours(0, 0, 0, 0)
    const startsAtMidnight = Math.abs(entry.startedAt - startMid.getTime()) <= 60_000
    const endsAtMidnight = Math.abs(entry.endedAt - endMid.getTime()) <= 60_000
    const span = entry.endedAt - entry.startedAt
    return startsAtMidnight && endsAtMidnight && span >= DAY_MS - 5 * 60 * 1000
  }

  type ScheduledSuggestion = FocusCandidate & { startedAt: number; endedAt: number; isGuide?: boolean }
  const scheduledNowSuggestions = useMemo<ScheduledSuggestion[]>(() => {
    const now = Date.now()
    const TOL = 60 * 1000
    // Any entries overlapping now (real or planned)
    const overlapping = history.filter(
      (h) => h.startedAt <= (now + TOL) && h.endedAt >= (now - TOL) && !isAllDayEntry(h),
    )
    const suggestions: ScheduledSuggestion[] = []
      overlapping.forEach((entry) => {
        const entryOriginalTime =
          typeof entry.originalTime === 'number' && Number.isFinite(entry.originalTime) ? entry.originalTime : null
        const entryOccurrenceDate = entryOriginalTime !== null ? formatLocalYmd(entryOriginalTime) : null
        // Try to enrich from goals snapshot by id first, else by names
        let match: FocusCandidate | null = null
        if (entry.taskId) {
        outer: for (let gi = 0; gi < activeGoalSnapshots.length; gi += 1) {
          const goal = activeGoalSnapshots[gi]
          for (let bi = 0; bi < goal.buckets.length; bi += 1) {
            const bucket = goal.buckets[bi]
            const task = bucket.tasks.find((t) => t.id === entry.taskId)
          if (task) {
            match = {
              goalId: goal.id,
              goalName: goal.name,
              bucketId: bucket.id,
              bucketName: bucket.name,
                    taskId: task.id,
                    taskName: task.text,
                    completed: task.completed,
                    priority: !!task.priority,
                    difficulty: (task.difficulty as any) ?? 'none',
                    notes: typeof task.notes === 'string' ? task.notes : '',
                    subtasks: Array.isArray(task.subtasks)
                      ? task.subtasks.map((s, idx) => ({
                          id: s.id,
                          text: s.text,
                      completed: s.completed,
                      sortIndex: typeof s.sortIndex === 'number' ? s.sortIndex : (idx + 1) * NOTEBOOK_SUBTASK_SORT_STEP,
                    }))
                  : [],
                repeatingRuleId: entry.repeatingSessionId ?? null,
                repeatingOccurrenceDate: entryOccurrenceDate,
                repeatingOriginalTime: entryOriginalTime,
              }
              break outer
            }
          }
        }
      }
      if (!match) {
        // Fallback: match by labels
        outer2: for (let gi = 0; gi < activeGoalSnapshots.length; gi += 1) {
          const goal = activeGoalSnapshots[gi]
          if ((entry.goalName ?? '').trim() && goal.name.trim() !== (entry.goalName ?? '').trim()) continue
          for (let bi = 0; bi < goal.buckets.length; bi += 1) {
            const bucket = goal.buckets[bi]
            if ((entry.bucketName ?? '').trim() && bucket.name.trim() !== (entry.bucketName ?? '').trim()) continue
            const task = bucket.tasks.find((t) => t.text.trim().toLowerCase() === (entry.taskName ?? '').trim().toLowerCase())
            if (task) {
              match = {
                goalId: goal.id,
                goalName: goal.name,
                bucketId: bucket.id,
                bucketName: bucket.name,
                taskId: task.id,
                taskName: task.text,
                completed: task.completed,
                priority: !!task.priority,
                difficulty: (task.difficulty as any) ?? 'none',
                notes: typeof task.notes === 'string' ? task.notes : '',
                subtasks: Array.isArray(task.subtasks)
                  ? task.subtasks.map((s, idx) => ({
                      id: s.id,
                      text: s.text,
                      completed: s.completed,
                      sortIndex: typeof s.sortIndex === 'number' ? s.sortIndex : (idx + 1) * NOTEBOOK_SUBTASK_SORT_STEP,
                    }))
                  : [],
                repeatingRuleId: entry.repeatingSessionId ?? null,
                repeatingOccurrenceDate: entryOccurrenceDate,
                repeatingOriginalTime: entryOriginalTime,
              }
              break outer2
            }
          }
        }
      }
      // Ensure we have a concrete candidate object (assign fallback when no match found)
      const candidate: FocusCandidate = match ?? {
        goalId: '',
        goalName: entry.goalName ?? '',
        bucketId: '',
        bucketName: entry.bucketName ?? '',
        taskId: '',
        taskName: entry.taskName,
        completed: false,
        priority: false,
        difficulty: 'none',
        entryColor: entry.entryColor ?? null,
        notes: entry.notes ?? '',
        subtasks: [],
        repeatingRuleId: entry.repeatingSessionId ?? null,
        repeatingOccurrenceDate: entryOccurrenceDate,
        repeatingOriginalTime: entryOriginalTime,
      }
      // Life routine color restoration: prefer gradient from routine config
      if ((entry.goalName ?? '').trim().toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()) {
        const lrColor = candidate.bucketId ? lifeRoutineColorByBucket.get(candidate.bucketId) : null
        if (lrColor) {
          candidate.entryColor = lrColor
        }
      }
      if (!candidate.entryColor) {
        const goalGradient = goalGradientById.get(candidate.goalId)
        candidate.entryColor = goalGradient ?? entry.entryColor ?? null
      }
      suggestions.push({ ...candidate, startedAt: entry.startedAt, endedAt: entry.endedAt, isGuide: false })
    })
    // Also include the active (running) session overlay from CURRENT_SESSION_STORAGE_KEY if present
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)
        if (raw) {
          const s = JSON.parse(raw) as any
          const baseElapsed = Math.max(0, Number(s?.baseElapsed) || 0)
          const updatedAt = Number(s?.updatedAt) || now
          const startedAtStored = Number(s?.startedAt)
          const startedAt = Number.isFinite(startedAtStored) ? startedAtStored : (updatedAt - baseElapsed)
          const isRunningFlag = Boolean(s?.isRunning)
          const endedAt = isRunningFlag ? now : startedAt + baseElapsed
          if (Number.isFinite(startedAt) && startedAt <= (now + TOL) && endedAt >= (now - TOL)) {
            // Build candidate
            const goalName = typeof s?.goalName === 'string' ? s.goalName : ''
            const bucketName = typeof s?.bucketName === 'string' ? s.bucketName : ''
            const taskName = typeof s?.taskName === 'string' ? s.taskName : (bucketName || goalName || 'Session')
            // Try enrich from snapshots by ids first
            let candidate: FocusCandidate | null = null
            const goalId = typeof s?.goalId === 'string' ? s.goalId : ''
            const bucketId = typeof s?.bucketId === 'string' ? s.bucketId : ''
            const taskId = typeof s?.taskId === 'string' ? s.taskId : ''
            if (goalId && bucketId && taskId) {
              outer: for (let gi = 0; gi < activeGoalSnapshots.length; gi += 1) {
                const goal = activeGoalSnapshots[gi]
                if (goal.id !== goalId) continue
                for (let bi = 0; bi < goal.buckets.length; bi += 1) {
                  const bucket = goal.buckets[bi]
                  if (bucket.id !== bucketId) continue
                  const task = bucket.tasks.find((t) => t.id === taskId)
                  if (task) {
                    candidate = {
                      goalId: goal.id,
                      goalName: goal.name,
                      bucketId: bucket.id,
                      bucketName: bucket.name,
                    taskId: task.id,
                    taskName: task.text,
                    completed: task.completed,
                    priority: !!task.priority,
                    difficulty: (task.difficulty as any) ?? 'none',
                    notes: typeof task.notes === 'string' ? task.notes : '',
                    subtasks: Array.isArray(task.subtasks)
                      ? task.subtasks.map((sub, idx) => ({ id: sub.id, text: sub.text, completed: sub.completed, sortIndex: typeof sub.sortIndex === 'number' ? sub.sortIndex : (idx + 1) * NOTEBOOK_SUBTASK_SORT_STEP }))
                      : [],
                    repeatingRuleId: null,
                      repeatingOccurrenceDate: null,
                      repeatingOriginalTime: null,
                    }
                    break outer
                  }
                }
              }
            }
            if (!candidate) {
              // Fallback: match by labels or build minimal
              const goalLower = (goalName || '').trim().toLowerCase()
              const bucketLower = (bucketName || '').trim().toLowerCase()
              const taskLower = (taskName || '').trim().toLowerCase()
              outer2: for (let gi = 0; gi < activeGoalSnapshots.length; gi += 1) {
                const goal = activeGoalSnapshots[gi]
                if (goalLower && goal.name.trim().toLowerCase() !== goalLower) continue
                for (let bi = 0; bi < goal.buckets.length; bi += 1) {
                  const bucket = goal.buckets[bi]
                  if (bucketLower && bucket.name.trim().toLowerCase() !== bucketLower) continue
                  const task = bucket.tasks.find((t) => t.text.trim().toLowerCase() === taskLower)
                  if (task) {
                    candidate = {
                      goalId: goal.id,
                      goalName: goal.name,
                      bucketId: bucket.id,
                      bucketName: bucket.name,
                    taskId: task.id,
                    taskName: task.text,
                    completed: task.completed,
                    priority: !!task.priority,
                    difficulty: (task.difficulty as any) ?? 'none',
                    notes: typeof task.notes === 'string' ? task.notes : '',
                    subtasks: Array.isArray(task.subtasks)
                      ? task.subtasks.map((sub, idx) => ({ id: sub.id, text: sub.text, completed: sub.completed, sortIndex: typeof sub.sortIndex === 'number' ? sub.sortIndex : (idx + 1) * NOTEBOOK_SUBTASK_SORT_STEP }))
                      : [],
                    repeatingRuleId: null,
                      repeatingOccurrenceDate: null,
                      repeatingOriginalTime: null,
                    }
                    break outer2
                  }
                }
              }
            }
            if (!candidate) {
              candidate = {
                goalId: '',
                goalName: goalName ?? '',
                bucketId: '',
                bucketName: bucketName ?? '',
                taskId: '',
                taskName: taskName ?? 'Session',
                completed: false,
                priority: false,
                difficulty: 'none',
                notes: '',
                subtasks: [],
                repeatingRuleId: null,
                repeatingOccurrenceDate: null,
                repeatingOriginalTime: null,
              }
            }
            suggestions.push({ ...candidate, startedAt, endedAt, isGuide: false })
          }
        }
      } catch {}
    }

    // De-duplicate suggestions by name tuple to avoid duplicates when active overlay mirrors history
    const seen = new Set<string>()
    const norm = (s?: string | null) => (s ?? '').trim().toLowerCase()
    const unique: ScheduledSuggestion[] = []
    for (const s of suggestions) {
      const key = `${norm(s.goalName)}|${norm(s.bucketName)}|${norm(s.taskName)}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(s)
    }
    return unique
  }, [activeGoalSnapshots, currentTime, goalGradientById, history, lifeRoutineColorByBucket])

  // Fetch repeating rules to surface guide tasks that overlap 'now'
  const [repeatingRules, setRepeatingRules] = useState<RepeatingSessionRule[]>(() => readLocalRepeatingRules())
  useEffect(() => {
    let cancelled = false
    const hydrateRepeatingRules = async () => {
      const ownerId = readHistoryOwnerId()
      const isGuestOwner = !ownerId || ownerId === HISTORY_GUEST_USER_ID
      try {
        const localRules = readLocalRepeatingRules()
        if (!cancelled) {
          const sanitized = isGuestOwner ? localRules : localRules.filter((rule) => isRepeatingRuleId(rule.id))
          setRepeatingRules(sanitized)
        }
      } catch {}
      if (isGuestOwner) {
        return
      }
      // Skip fetch if we just did a full sync (e.g. after auth callback)
      if (isRecentlyFullSynced()) {
        return
      }
      try {
        const rules = await fetchRepeatingSessionRules()
        if (!cancelled && Array.isArray(rules)) {
          setRepeatingRules(rules)
          storeRepeatingRulesLocal(rules)
        }
      } catch {}
    }
    void hydrateRepeatingRules()
    return () => {
      cancelled = true
    }
  }, [historyOwnerSignal])

  const guideNowSuggestions = useMemo<ScheduledSuggestion[]>(() => {
    if (repeatingRules.length === 0) return []
    const MINUTE_MS = 60 * 1000
    const monthDayKey = (ms: number): string => {
      const d = new Date(ms)
      return `${d.getMonth() + 1}-${d.getDate()}`
    }
    const ruleDayOfMonth = (rule: RepeatingSessionRule): number | null => {
      const source =
        Number.isFinite((rule as any).startAtMs as number)
          ? ((rule as any).startAtMs as number)
          : Number.isFinite((rule as any).createdAtMs as number)
            ? ((rule as any).createdAtMs as number)
            : null
      if (!Number.isFinite(source as number)) return null
      return new Date(source as number).getDate()
    }
    const ruleMonthDayKey = (rule: RepeatingSessionRule): string | null => {
      const source =
        Number.isFinite((rule as any).startAtMs as number)
          ? ((rule as any).startAtMs as number)
          : Number.isFinite((rule as any).createdAtMs as number)
            ? ((rule as any).createdAtMs as number)
            : null
      if (!Number.isFinite(source as number)) return null
      return monthDayKey(source as number)
    }
    const ruleMonthlyPattern = (rule: RepeatingSessionRule): 'day' | 'first' | 'last' =>
      (rule as any).monthlyPattern === 'first' || (rule as any).monthlyPattern === 'last'
        ? ((rule as any).monthlyPattern as 'first' | 'last')
        : 'day'
    const ruleMonthlyWeekday = (rule: RepeatingSessionRule): number | null => {
      const days = Array.isArray((rule as any).dayOfWeek) ? (rule as any).dayOfWeek : []
      if (days.length > 0 && Number.isFinite(days[0])) {
        const v = Math.round(days[0])
        if (v >= 0 && v <= 6) return v
      }
      const source =
        Number.isFinite((rule as any).startAtMs as number)
          ? ((rule as any).startAtMs as number)
          : Number.isFinite((rule as any).createdAtMs as number)
            ? ((rule as any).createdAtMs as number)
            : null
      if (!Number.isFinite(source as number)) return null
      return new Date(source as number).getDay()
    }
    const matchesMonthlyDay = (rule: RepeatingSessionRule, dayStart: number): boolean => {
      const d = new Date(dayStart)
      const pattern = ruleMonthlyPattern(rule)
      if (pattern === 'day') {
        const anchorDay = ruleDayOfMonth(rule)
        if (!Number.isFinite(anchorDay as number)) return false
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
        const expectedDay = Math.min(anchorDay as number, lastDay)
        return d.getDate() === expectedDay
      }
      const weekday = ruleMonthlyWeekday(rule)
      if (!Number.isFinite(weekday as number)) return false
      if (pattern === 'first') {
        const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1)
        const offset = ((weekday as number) - firstOfMonth.getDay() + 7) % 7
        const firstOccurrence = 1 + offset
        return d.getDate() === firstOccurrence
      }
      const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      const offset = (lastOfMonth.getDay() - (weekday as number) + 7) % 7
      const lastOccurrence = lastOfMonth.getDate() - offset
      return d.getDate() === lastOccurrence
    }
    const now = Date.now()
    const toDayStart = (t: number) => { const x = new Date(t); x.setHours(0,0,0,0); return x.getTime() }
    const todayStart = toDayStart(now)
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
    const formatYmd = (ms: number) => { const d = new Date(ms); const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const da = String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${da}` }
    // Use subscribed exceptions to avoid stale reads
    const exc = repeatingExceptions
    const skippedSet = new Set<string>()
    exc.forEach((e) => {
      const key = `${e.routineId}:${e.occurrenceDate}`
      if (e.action === 'skipped') skippedSet.add(key)
    })
    // Also suppress guides that have transformed (confirmed/rescheduled) by checking history linkage
    const coveredOriginalSet = (() => {
      const set = new Set<string>()
      history.forEach((h) => {
        const rid = (h as any).repeatingSessionId as string | undefined | null
        const ot = (h as any).originalTime as number | undefined | null
        if (rid && Number.isFinite(ot as number)) set.add(`${rid}:${ot as number}`)
      })
      return set
    })()
    const coveredOccurrenceSet = (() => {
      const set = new Set<string>()
      history.forEach((h) => {
        const key = makeOccurrenceKey(
          (h as any).repeatingSessionId as string | undefined | null,
          (h as any).originalTime as number | undefined | null,
        )
        if (key) set.add(key)
      })
      return set
    })()

    const list: ScheduledSuggestion[] = []
    const pushCandidate = (task: FocusCandidate, start: number, end: number) => {
      list.push({ ...task, startedAt: start, endedAt: end, isGuide: true })
    }
    const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
    const getAnchorDayStart = (rule: RepeatingSessionRule): number | null => {
      const startAt = (rule as any).startAtMs as number | undefined
      const createdAt = (rule as any).createdAtMs as number | undefined
      const anchor = Number.isFinite(startAt as number) ? (startAt as number) : (Number.isFinite(createdAt as number) ? (createdAt as number) : null)
      if (!Number.isFinite(anchor as number)) return null
      const d = new Date(anchor as number)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    const intervalAllowsDay = (rule: RepeatingSessionRule, dayStart: number): boolean => {
      const interval = Math.max(1, Number.isFinite((rule as any).repeatEvery as number) ? Math.floor((rule as any).repeatEvery as number) : 1)
      if (interval === 1) return true
      const anchor = getAnchorDayStart(rule)
      if (!Number.isFinite(anchor as number)) return true
      const DAY_MS = 24 * 60 * 60 * 1000
      const diffDays = Math.floor((dayStart - (anchor as number)) / DAY_MS)
      if (diffDays < 0) return false
      if (rule.frequency === 'daily') return diffDays % interval === 0
      if (rule.frequency === 'weekly') {
        const diffWeeks = Math.floor(diffDays / 7)
        return diffWeeks % interval === 0
      }
      if (rule.frequency === 'monthly') {
        const a = new Date(anchor as number)
        const b = new Date(dayStart)
        const aIndex = a.getFullYear() * 12 + a.getMonth()
        const bIndex = b.getFullYear() * 12 + b.getMonth()
        const diffMonths = bIndex - aIndex
        if (diffMonths < 0) return false
        return diffMonths % interval === 0
      }
      if (rule.frequency === 'annually') {
        const a = new Date(anchor as number)
        const b = new Date(dayStart)
        const diffYears = b.getFullYear() - a.getFullYear()
        if (diffYears < 0) return false
        return diffYears % interval === 0
      }
      return true
    }
      const considerOccurrence = (rule: RepeatingSessionRule, baseStart: number) => {
        // Frequency filters
        if (rule.frequency === 'weekly') {
          const d = new Date(baseStart)
          if (!Array.isArray(rule.dayOfWeek) || rule.dayOfWeek.length === 0) return
          if (!rule.dayOfWeek.includes(d.getDay())) return
        } else if (rule.frequency === 'monthly') {
          if (!matchesMonthlyDay(rule, baseStart)) return
        } else if (rule.frequency === 'annually') {
          const dayKey = monthDayKey(baseStart)
          const ruleKey = ruleMonthDayKey(rule)
          if (!ruleKey || ruleKey !== dayKey) return
        }
      if (!intervalAllowsDay(rule, baseStart)) return
      // Boundaries based on scheduled start time
      const tMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
      const startedAt = baseStart + tMin * MINUTE_MS
      const durationMs = Math.max(1, (rule.durationMinutes ?? 60) * MINUTE_MS)
      const endedAt = startedAt + durationMs
      const startAtMs = (rule as any).startAtMs as number | undefined
      const createdAtMs = (rule as any).createdAtMs as number | undefined
      const endAtMs = (rule as any).endAtMs as number | undefined
      if (Number.isFinite(startAtMs as number) && startedAt < (startAtMs as number)) return
      if (!Number.isFinite(startAtMs as number) && Number.isFinite(createdAtMs as number) && startedAt <= (createdAtMs as number)) return
      if (Number.isFinite(endAtMs as number) && startedAt > (endAtMs as number)) return
      // Skip if explicitly skipped or already transformed/confirmed
      const occKey = `${rule.id}:${formatYmd(baseStart)}`
      if (skippedSet.has(occKey) || coveredOriginalSet.has(`${rule.id}:${startedAt}`) || coveredOccurrenceSet.has(occKey)) return
      // Overlap check with tolerance for minute rounding/DST
      const TOL = MINUTE_MS
      if (now < startedAt - TOL || now > endedAt + TOL) return

      // Try to match to current goals snapshot to enrich surfaces and ids
      const goalNameLower = lower(rule.goalName)
      const bucketNameLower = lower(rule.bucketName)
      const taskNameLower = lower(rule.taskName)
      let candidate: FocusCandidate | null = null
      outer: for (let gi = 0; gi < activeGoalSnapshots.length; gi += 1) {
        const goal = activeGoalSnapshots[gi]
        if (goalNameLower && goal.name.trim().toLowerCase() !== goalNameLower) continue
        for (let bi = 0; bi < goal.buckets.length; bi += 1) {
          const bucket = goal.buckets[bi]
          if (bucketNameLower && bucket.name.trim().toLowerCase() !== bucketNameLower) continue
          const task = bucket.tasks.find((t) => t.text.trim().toLowerCase() === taskNameLower)
          if (task) {
            candidate = {
              goalId: goal.id,
              goalName: goal.name,
              bucketId: bucket.id,
              bucketName: bucket.name,
              taskId: task.id,
              taskName: task.text,
              completed: task.completed,
              priority: !!task.priority,
              difficulty: (task.difficulty as any) ?? 'none',
              entryColor: goalGradientById.get(goal.id) ?? null,
              notes: typeof task.notes === 'string' ? task.notes : '',
              subtasks: Array.isArray(task.subtasks)
                ? task.subtasks.map((s, idx) => ({ id: s.id, text: s.text, completed: s.completed, sortIndex: typeof s.sortIndex === 'number' ? s.sortIndex : (idx + 1) * NOTEBOOK_SUBTASK_SORT_STEP }))
                : [],
              repeatingRuleId: rule.id,
              repeatingOccurrenceDate: formatYmd(baseStart),
              repeatingOriginalTime: startedAt,
            }
            break outer
          }
        }
      }
      if (!candidate) {
        candidate = {
          goalId: '',
          goalName: rule.goalName ?? '',
          bucketId: '',
          bucketName: rule.bucketName ?? '',
          taskId: '',
          taskName: rule.taskName,
          completed: false,
          priority: false,
          difficulty: 'none',
          notes: '',
          subtasks: [],
          repeatingRuleId: rule.id,
          repeatingOccurrenceDate: formatYmd(baseStart),
          repeatingOriginalTime: startedAt,
        }
      }
      // Suppress if an identical real entry already exists at this timing (±1m), even without linkage
      const duplicateReal = history.some((h) => {
        const sameLabel = (h.taskName?.trim() || 'Session') === (candidate!.taskName?.trim() || 'Session') && (h.goalName ?? null) === (candidate!.goalName ?? null) && (h.bucketName ?? null) === (candidate!.bucketName ?? null)
        const TOL = MINUTE_MS
        const startMatch = Math.abs(h.startedAt - startedAt) <= TOL
        const endMatch = Math.abs(h.endedAt - endedAt) <= TOL
        return sameLabel && startMatch && endMatch
      })
      if (duplicateReal) return

      pushCandidate(candidate, startedAt, endedAt)
    }

    repeatingRules.forEach((rule) => {
      if (!rule.isActive) return
      // Consider both today and yesterday to account for guides that cross midnight
      considerOccurrence(rule, todayStart)
      considerOccurrence(rule, yesterdayStart)
    })
    return list
  }, [activeGoalSnapshots, currentTime, goalGradientById, history, repeatingExceptions, repeatingRules])

  // Combine planned and guide suggestions for the "now" section, de-duplicated by names
  const combinedNowSuggestions = useMemo<ScheduledSuggestion[]>(() => {
    if (scheduledNowSuggestions.length === 0 && guideNowSuggestions.length === 0) return []
    // Guides (from repeating rules/exceptions) first, then union with history/planned
    const merged = [...guideNowSuggestions, ...scheduledNowSuggestions]
    const seen = new Set<string>()
    const norm = (s?: string | null) => (s ?? '').trim().toLowerCase()
    return merged.filter((t) => {
      const key = `${norm(t.goalName)}|${norm(t.bucketName)}|${norm(t.taskName)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [scheduledNowSuggestions, guideNowSuggestions, currentTime])
  const makeScheduledSuggestionKey = useCallback((task: ScheduledSuggestion) => {
    const parts = [
      task.taskId,
      task.goalId ?? task.goalName,
      task.bucketId ?? task.bucketName,
      task.repeatingRuleId,
      task.repeatingOccurrenceDate,
      task.repeatingOriginalTime,
      task.taskName,
    ]
      .map((part) => (part === null || part === undefined ? '' : `${part}`.trim()))
      .filter(Boolean)
      .join('|')
    return `sched-${parts.length > 0 ? parts : 'task'}`
  }, [])

  const activeFocusCandidate = useMemo(() => {
    if (!focusSource) {
      return null
    }
    // Search both goals candidates and quick list candidates
    const allCandidates = [...focusCandidates, ...quickListFocusCandidates]
    if (focusSource.taskId) {
      const byId = allCandidates.find((candidate) => candidate.taskId === focusSource.taskId)
      if (byId) {
        return byId
      }
    }
    if (focusSource.goalId && focusSource.bucketId) {
      const lower = normalizedCurrentTask.toLocaleLowerCase()
      const byMatch = allCandidates.find(
        (candidate) =>
          candidate.goalId === focusSource.goalId &&
          candidate.bucketId === focusSource.bucketId &&
          candidate.taskName.trim().toLocaleLowerCase() === lower,
      )
      if (byMatch) {
        return byMatch
      }
    }
    return null
  }, [focusCandidates, focusSource, normalizedCurrentTask, quickListFocusCandidates])

  const currentSessionMeta = sessionMetadataRef.current
  const sessionGoalName =
    isRunning || elapsed > 0
      ? currentSessionMeta.goalName
      : focusSource?.goalName?.trim() || null
  const sessionBucketName =
    isRunning || elapsed > 0
      ? currentSessionMeta.bucketName
      : focusSource?.bucketName?.trim() || null
  const sessionTaskLabel =
    normalizedCurrentTask.length > 0
      ? normalizedCurrentTask
      : sessionGoalName
        ? sessionGoalName
        : ''
  const sessionGoalId =
    isRunning || elapsed > 0
      ? currentSessionMeta.goalId
      : focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
  const sessionBucketId =
    isRunning || elapsed > 0
      ? currentSessionMeta.bucketId
      : focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
  const sessionTaskId =
    isRunning || elapsed > 0
      ? currentSessionMeta.taskId
      : focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
  const deriveSessionMetadata = useCallback((): SessionMetadata => {
    const goalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const bucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
    const taskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
    const goalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
    const bucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
    const sessionKey = makeSessionInstanceKey(goalId, bucketId, taskId)
    const repeatingRuleId = focusSource?.repeatingRuleId ?? activeFocusCandidate?.repeatingRuleId ?? null
    const repeatingOccurrenceDate =
      focusSource?.repeatingOccurrenceDate ?? activeFocusCandidate?.repeatingOccurrenceDate ?? null
    const repeatingOriginalTime =
      focusSource?.repeatingOriginalTime ?? activeFocusCandidate?.repeatingOriginalTime ?? null
    return {
      goalId,
      bucketId,
      taskId,
      goalName,
      bucketName,
      sessionKey,
      taskLabel: safeTaskName,
      repeatingRuleId,
      repeatingOccurrenceDate,
      repeatingOriginalTime,
    }
  }, [activeFocusCandidate, focusSource, safeTaskName])

  const effectiveGoalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
  const effectiveBucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
  const focusSurfaceClasses = useMemo(() => [], [])
  const focusInlineStyle: React.CSSProperties | undefined = undefined
  const notebookKey = useMemo(
    () => computeNotebookKey(focusSource, normalizedCurrentTask),
    [focusSource, normalizedCurrentTask],
  )
  useEffect(() => {
    setNotebookSubtasksCollapsed(false)
  }, [notebookKey])
  const areNotebookSubtasksEqual = useCallback((a: NotebookSubtask[], b: NotebookSubtask[]) => {
    if (a.length !== b.length) {
      return false
    }
    for (let index = 0; index < a.length; index += 1) {
      const left = a[index]
      const right = b[index]
      if (
        !right ||
        left.id !== right.id ||
        left.text !== right.text ||
        left.completed !== right.completed ||
        left.sortIndex !== right.sortIndex
      ) {
        return false
      }
    }
    return true
  }, [])
  const areNotebookEntriesEqual = useCallback(
    (a: NotebookEntry, b: NotebookEntry) => a.notes === b.notes && areNotebookSubtasksEqual(a.subtasks, b.subtasks),
    [areNotebookSubtasksEqual],
  )

  // getStableLinkedTaskId is defined after activeTaskId to avoid TDZ issues.
  type NotebookUpdateResult = { entry: NotebookEntry; entryExists: boolean; changed: boolean }
  const updateNotebookForKey = useCallback(
    (key: string, updater: (entry: NotebookEntry) => NotebookEntry): NotebookUpdateResult | null => {
      let outcome: NotebookUpdateResult | null = null
      setNotebookState((current) => {
        const existing = current[key]
        const previous = existing ?? createNotebookEntry()
        const updated = sanitizeNotebookEntry(updater(previous))
        if (!shouldPersistNotebookEntry(updated)) {
          if (!existing) {
            if (areNotebookEntriesEqual(previous, updated)) {
              return current
            }
            outcome = { entry: updated, entryExists: false, changed: true }
            return current
          }
          if (areNotebookEntriesEqual(existing, updated)) {
            outcome = null
            return current
          }
          const { [key]: _removed, ...rest } = current
          outcome = { entry: updated, entryExists: false, changed: true }
          return rest
        }
        if (existing && areNotebookEntriesEqual(existing, updated)) {
          outcome = null
          return current
        }
        outcome = { entry: updated, entryExists: true, changed: true }
        return { ...current, [key]: updated }
      })
      return outcome
    },
    [areNotebookEntriesEqual],
  )
  const activeTaskId = useMemo(() => {
    if (!focusSource?.taskId || focusSource.goalId === LIFE_ROUTINES_GOAL_ID) {
      return null
    }
    const sourceKey = computeNotebookKey(focusSource, normalizedCurrentTask)
    return sourceKey === notebookKey ? focusSource.taskId : null
  }, [focusSource, normalizedCurrentTask, notebookKey])

  // Prefer a non-empty task id from focusSource, then focusContext, then activeTaskId.
  const getStableLinkedTaskId = useCallback((): string | null => {
    const cand1 = typeof focusSource?.taskId === 'string' ? focusSource.taskId : null
    const cand2 = typeof focusContextRef.current.taskId === 'string' ? focusContextRef.current.taskId : null
    const cand3 = typeof activeTaskId === 'string' ? activeTaskId : null
    const pick = (id: string | null) => (id && id.trim().length > 0 ? id : null)
    return pick(cand1) ?? pick(cand2) ?? pick(cand3)
  }, [focusSource, activeTaskId])

  
  const notebookNotesSaveTimersRef = useRef<Map<string, number>>(new Map())
  const notebookNotesLatestRef = useRef<Map<string, string>>(new Map())
  const notebookSubtaskSaveTimersRef = useRef<Map<string, number>>(new Map())
  const notebookSubtaskLatestRef = useRef<Map<string, NotebookSubtask>>(new Map())
  const lastPersistedNotebookRef = useRef<{ taskId: string; entry: NotebookEntry } | null>(null)
  const notebookHydrationBlockRef = useRef(0)
  // Mark when notebook changes originate from snapshot hydration, so we don't persist them back
  const notebookChangeFromSnapshotRef = useRef(false)
  const blockNotebookHydration = useCallback((durationMs = 4000) => {
    notebookHydrationBlockRef.current = Date.now() + durationMs
  }, [])
  const scrollFocusToTop = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      window.scrollTo(0, 0)
    }
  }, [])
  const scheduleNotebookNotesPersist = useCallback(
    (taskId: string, notes: string) => {
      if (!taskId) {
        return
      }
      notebookNotesLatestRef.current.set(taskId, notes)
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus][Notes] schedule persist', { taskId, len: notes.length })
        } catch {}
      }
      if (typeof window === 'undefined') {
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus][Notes] flush (immediate, no-window)', { taskId })
          } catch {}
        }
        void apiUpdateTaskNotes(taskId, notes).catch((error) =>
          logWarn('[Focus] Failed to persist notes for task:', error),
        )
        return
      }
      const timers = notebookNotesSaveTimersRef.current
      const pending = timers.get(taskId)
      if (pending) {
        window.clearTimeout(pending)
      }
      const handle = window.setTimeout(() => {
        timers.delete(taskId)
        const latest = notebookNotesLatestRef.current.get(taskId) ?? ''
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus][Notes] flush (timer)', { taskId, len: latest.length })
          } catch {}
        }
        void apiUpdateTaskNotes(taskId, latest).catch((error) =>
          logWarn('[Focus] Failed to persist notes for task:', error),
        )
      }, 500)
      timers.set(taskId, handle)
    },
    [apiUpdateTaskNotes, refreshGoalsSnapshotFromSupabase],
  )
  const cancelNotebookSubtaskPersist = useCallback((taskId: string, subtaskId: string) => {
    const key = `${taskId}:${subtaskId}`
    if (typeof window !== 'undefined') {
      const timers = notebookSubtaskSaveTimersRef.current
      const pending = timers.get(key)
      if (pending) {
        window.clearTimeout(pending)
        timers.delete(key)
      }
    }
    notebookSubtaskLatestRef.current.delete(key)
  }, [])
  const scheduleNotebookSubtaskPersist = useCallback(
    (taskId: string, subtask: NotebookSubtask) => {
      if (!taskId) {
        return
      }
      if (subtask.text.trim().length === 0) {
        cancelNotebookSubtaskPersist(taskId, subtask.id)
        return
      }
      const key = `${taskId}:${subtask.id}`
      const stamped: NotebookSubtask = { ...subtask, updatedAt: subtask.updatedAt ?? new Date().toISOString() }
      notebookSubtaskLatestRef.current.set(key, stamped)
      if (typeof window === 'undefined') {
        void apiUpsertTaskSubtask(taskId, {
          id: stamped.id,
          text: stamped.text,
          completed: stamped.completed,
          sort_index: stamped.sortIndex,
          updated_at: stamped.updatedAt,
        }).catch((error) => logWarn('[Focus] Failed to persist subtask:', error))
        return
      }
      const timers = notebookSubtaskSaveTimersRef.current
      const pending = timers.get(key)
      if (pending) {
        window.clearTimeout(pending)
      }
      const handle = window.setTimeout(() => {
        timers.delete(key)
        const latest = notebookSubtaskLatestRef.current.get(key)
        if (!latest || latest.text.trim().length === 0) {
          return
        }
        void apiUpsertTaskSubtask(taskId, {
          id: latest.id,
          text: latest.text,
          completed: latest.completed,
          sort_index: latest.sortIndex,
          updated_at: latest.updatedAt ?? new Date().toISOString(),
        }).catch((error) => logWarn('[Focus] Failed to persist subtask:', error))
      }, 400)
      timers.set(key, handle)
    },
    [apiUpsertTaskSubtask, cancelNotebookSubtaskPersist, refreshGoalsSnapshotFromSupabase],
  )
  const flushNotebookSubtaskPersist = useCallback(
    (taskId: string, subtask: NotebookSubtask) => {
      if (!taskId) return
      cancelNotebookSubtaskPersist(taskId, subtask.id)
      if (subtask.text.trim().length === 0) return
      const payload = {
        id: subtask.id,
        text: subtask.text,
        completed: subtask.completed,
        sort_index: subtask.sortIndex,
        updated_at: subtask.updatedAt ?? new Date().toISOString(),
      }
      void apiUpsertTaskSubtask(taskId, payload).catch((error) =>
        logWarn('[Focus] Failed to flush subtask on blur:', error),
      )
    },
    [apiUpsertTaskSubtask, cancelNotebookSubtaskPersist],
  )
  const notebookSubtasksToSnapshot = useCallback(
    (subtasks: NotebookSubtask[]): GoalTaskSnapshot['subtasks'] =>
      subtasks
        .filter((s) => s.text.trim().length > 0)
        .map((subtask, index) => ({
          id: subtask.id,
          text: subtask.text,
          completed: subtask.completed,
          sortIndex:
            typeof subtask.sortIndex === 'number' ? subtask.sortIndex : (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP,
        })),
    [],
  )
  const snapshotSubtasksToNotebook = useCallback(
    (subtasks: GoalTaskSnapshot['subtasks']): NotebookSubtask[] =>
      subtasks.map((subtask, index) => ({
        id: subtask.id,
        text: subtask.text,
        completed: subtask.completed,
        sortIndex:
          typeof subtask.sortIndex === 'number' ? subtask.sortIndex : (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP,
      })),
    [],
  )
  const areSnapshotSubtasksEqual = useCallback(
    (snapshot: GoalTaskSnapshot['subtasks'], notebook: NotebookSubtask[]) => {
      if (snapshot.length !== notebook.length) {
        return false
      }
      for (let index = 0; index < snapshot.length; index += 1) {
        const left = snapshot[index]
        const right = notebook[index]
        if (
          !right ||
          left.id !== right.id ||
          left.text !== right.text ||
          left.completed !== right.completed ||
          (left.sortIndex ?? (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP) !== right.sortIndex
        ) {
          return false
        }
      }
      return true
    },
    [],
  )
  const updateGoalSnapshotTask = useCallback(
    (taskId: string, entry: NotebookEntry, force: boolean = false) => {
      setGoalsSnapshot((current) => {
        let mutated = false
        const next = current.map((goal) => {
          let goalMutated = false
          const nextBuckets = goal.buckets.map((bucket) => {
            const index = bucket.tasks.findIndex((task) => task.id === taskId)
            if (index === -1) {
              return bucket
            }
            const originalTask = bucket.tasks[index]
            const sameNotes = originalTask.notes === entry.notes
            const sameSubtasks = areSnapshotSubtasksEqual(originalTask.subtasks ?? [], entry.subtasks)
            if (!force && sameNotes && sameSubtasks) {
              return bucket
            }
            goalMutated = true
            mutated = true
            const updatedTask: GoalTaskSnapshot = {
              ...originalTask,
              notes: entry.notes,
              subtasks: notebookSubtasksToSnapshot(entry.subtasks),
            }
            const nextTasks = [...bucket.tasks]
            nextTasks[index] = updatedTask
            return { ...bucket, tasks: nextTasks }
          })
          if (!goalMutated) {
            return goal
          }
          return { ...goal, buckets: nextBuckets }
        })
        if (!mutated) {
          return current
        }
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] publish snapshot', {
              taskId,
              subtasks: entry.subtasks.length,
              notesLen: typeof entry.notes === 'string' ? entry.notes.length : 0,
            })
          } catch {}
        }
        publishGoalsSnapshot(next)
        return next
      })
    },
    [areSnapshotSubtasksEqual, notebookSubtasksToSnapshot],
  )

  // Helper: does a given task id exist in a snapshot tree?
  const taskExistsIn = useCallback((snapshot: GoalSnapshot[], taskId: string): boolean => {
    for (let gi = 0; gi < snapshot.length; gi += 1) {
      const goal = snapshot[gi]
      for (let bi = 0; bi < goal.buckets.length; bi += 1) {
        const bucket = goal.buckets[bi]
        if (bucket.tasks.some((t) => t.id === taskId)) return true
      }
    }
    return false
  }, [])

  // Helper: update Quick List item notes and subtasks, then sync to localStorage
  const updateQuickListItemEntry = useCallback(
    (taskId: string, entry: NotebookEntry) => {
      setQuickListItems((current) => {
        const index = current.findIndex((item) => item.id === taskId)
        if (index === -1) {
          return current
        }
        const item = current[index]
        // Convert NotebookSubtask[] to QuickSubtask[]
        const quickSubtasks: QuickSubtask[] = entry.subtasks.map((subtask) => ({
          id: subtask.id,
          text: subtask.text,
          completed: subtask.completed,
          sortIndex: subtask.sortIndex,
          updatedAt: subtask.updatedAt ?? new Date().toISOString(),
        }))
        const updated: QuickItem = {
          ...item,
          notes: entry.notes,
          subtasks: quickSubtasks,
          updatedAt: new Date().toISOString(),
        }
        const next = [...current]
        next[index] = updated
        writeStoredQuickList(next)
        return next
      })
    },
    [],
  )

  // Publish with fallback: if the task isn't in our current snapshot, refresh
  // from Supabase and retry once the next snapshot arrives.
  // For Quick List tasks, update quickListItems instead of goalsSnapshot.
  const publishTaskEntry = useCallback(
    (taskId: string, entry: NotebookEntry, reason?: string) => {
      if (!taskId) return
      // Check if this is a Quick List task
      const goalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
      if (isQuickListGoal(goalId)) {
        updateQuickListItemEntry(taskId, entry)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] publish to Quick List', { taskId, reason })
          } catch {}
        }
        return
      }
      if (taskExistsIn(goalsSnapshot, taskId)) {
        updateGoalSnapshotTask(taskId, entry, true)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] publish (in-memory snapshot)', { taskId, reason })
          } catch {}
        }
        return
      }
      // Fallback path: refresh then retry publish once.
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] publish fallback: refresh+subscribe', { taskId, reason })
        } catch {}
      }
      try {
        refreshGoalsSnapshotFromSupabase(reason || 'publish-fallback')
      } catch {}
      let unsub: (() => void) | null = null
      const tryUnsub = () => {
        if (unsub) {
          unsub()
          unsub = null
        }
      }
      unsub = subscribeToGoalsSnapshot((snap) => {
        if (taskExistsIn(snap, taskId)) {
          updateGoalSnapshotTask(taskId, entry, true)
          if (DEBUG_SYNC) {
            try {
              logDebug('[Sync][Focus] publish (after refresh)', { taskId, reason })
            } catch {}
          }
          tryUnsub()
        }
      })
      // Safety timeout in case nothing arrives
      if (typeof window !== 'undefined') {
        const handle = window.setTimeout(tryUnsub, 1500)
        // No clean-up needed beyond unsub; timer fires once
        void handle
      }
    },
    [activeFocusCandidate, focusSource, goalsSnapshot, isQuickListGoal, refreshGoalsSnapshotFromSupabase, taskExistsIn, updateGoalSnapshotTask, updateQuickListItemEntry],
  )
  const updateFocusSourceFromEntry = useCallback(
    (entry: NotebookEntry) => {
      setFocusSource((current) => {
        if (!current || !current.taskId) {
          return current
        }
        const currentKey = computeNotebookKey(current, normalizedCurrentTask)
        if (currentKey !== notebookKey) {
          return current
        }
        const existingNotes = typeof current.notes === 'string' ? current.notes : ''
        const existingSubtasks = Array.isArray(current.subtasks) ? current.subtasks : []
        if (existingNotes === entry.notes && areNotebookSubtasksEqual(existingSubtasks, entry.subtasks)) {
          return current
        }
        return { ...current, notes: entry.notes, subtasks: entry.subtasks }
      })
    },
    [areNotebookSubtasksEqual, notebookKey, normalizedCurrentTask],
  )
  // Debounced snapshot publish for notes (to avoid per-keystroke lag)
  const notebookNotesPublishTimersRef = useRef<Map<string, number>>(new Map())
  const notebookNotesLatestEntryRef = useRef<Map<string, NotebookEntry>>(new Map())
  const scheduleNotebookNotesSnapshotPublish = useCallback(
    (taskId: string, entry: NotebookEntry, reason: string = 'notes-debounce') => {
      if (!taskId) return
      notebookNotesLatestEntryRef.current.set(taskId, entry)
      if (typeof window === 'undefined') {
        publishTaskEntry(taskId, entry, reason)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus][Notes] snapshot publish (immediate)', { taskId, len: entry.notes.length, reason })
          } catch {}
        }
        return
      }
      const timers = notebookNotesPublishTimersRef.current
      const pending = timers.get(taskId)
      if (pending) {
        window.clearTimeout(pending)
      }
      const handle = window.setTimeout(() => {
        timers.delete(taskId)
        const latest = notebookNotesLatestEntryRef.current.get(taskId) ?? entry
        publishTaskEntry(taskId, latest, reason)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus][Notes] snapshot publish (timer)', { taskId, len: latest.notes.length, reason })
          } catch {}
        }
      }, 200)
      timers.set(taskId, handle)
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus][Notes] snapshot schedule', { taskId, len: entry.notes.length, reason })
        } catch {}
      }
    },
    [publishTaskEntry],
  )
  const flushNotebookNotesSnapshotPublish = useCallback(
    (taskId: string, entry: NotebookEntry | null, reason: string = 'notes-blur') => {
      if (!taskId) return
      const timers = notebookNotesPublishTimersRef.current
      const pending = timers.get(taskId)
      if (typeof window !== 'undefined' && pending) {
        window.clearTimeout(pending)
        timers.delete(taskId)
      }
      const latest = entry ?? notebookNotesLatestEntryRef.current.get(taskId)
      if (latest) {
        publishTaskEntry(taskId, latest, reason)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus][Notes] snapshot publish (flush)', { taskId, len: latest.notes.length, reason })
          } catch {}
        }
      }
    },
    [publishTaskEntry],
  )
  // --- Batched subtask deletes (per task) ---------------------------------
  const deleteQueueRef = useRef<Map<string, Set<string>>>(new Map())
  const deleteTimersRef = useRef<Map<string, number>>(new Map())

  const buildNextEntryForTask = useCallback(
    (taskId: string, idsToRemove: Set<string>): NotebookEntry | null => {
      // If we're working on the active task, prefer the latest UI state for this notebook key
      if (activeTaskId === taskId) {
        const entry = (notebookState[notebookKey] ?? createNotebookEntry()) as NotebookEntry
        const filtered = entry.subtasks.filter((s) => !idsToRemove.has(s.id))
        return { notes: entry.notes, subtasks: filtered }
      }
      // Otherwise, derive entry from the in-memory goals snapshot
      let snapshotTask: GoalTaskSnapshot | null = null
      outer: for (let gi = 0; gi < goalsSnapshot.length; gi += 1) {
        const goal = goalsSnapshot[gi]
        for (let bi = 0; bi < goal.buckets.length; bi += 1) {
          const bucket = goal.buckets[bi]
          const found = bucket.tasks.find((t) => t.id === taskId)
          if (found) {
            snapshotTask = found
            break outer
          }
        }
      }
      if (!snapshotTask) {
        return null
      }
      const baseSubs = (snapshotTask.subtasks ?? []).map((subtask, index) => ({
        id: subtask.id,
        text: subtask.text,
        completed: subtask.completed,
        sortIndex:
          typeof subtask.sortIndex === 'number' ? subtask.sortIndex : (index + 1) * NOTEBOOK_SUBTASK_SORT_STEP,
      }))
      const filtered = baseSubs.filter((s) => !idsToRemove.has(s.id))
      return { notes: snapshotTask.notes ?? '', subtasks: filtered }
    },
    [activeTaskId, goalsSnapshot, notebookKey, notebookState],
  )

  const flushDeleteQueueFor = useCallback(
    async (taskId: string) => {
      const queue = deleteQueueRef.current.get(taskId)
      if (!queue || queue.size === 0) return
      const ids = Array.from(queue)
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask delete batch flush begin', { taskId, count: ids.length })
        } catch {}
      }
      // Fire API deletes in parallel; tolerate partial failures
      await Promise.allSettled(
        ids.map((id) => apiDeleteTaskSubtask(taskId, id).catch((err) => {
          logWarn('[Focus] Failed batched subtask delete:', err)
        })),
      )
      // Compute authoritative next entry and publish once
      const idsSet = new Set(ids)
      const nextEntry = buildNextEntryForTask(taskId, idsSet)
      if (nextEntry) {
        publishTaskEntry(taskId, nextEntry, 'subtask-delete-batch')
        updateFocusSourceFromEntry(nextEntry)
        // Keep the keyed map in sync too
        updateNotebookForKey(notebookKey, () => nextEntry)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] subtask delete batch publish', { taskId, count: ids.length })
          } catch {}
        }
      }
      // Clear queue and timer for this task
      deleteQueueRef.current.delete(taskId)
      const t = deleteTimersRef.current.get(taskId)
      if (t && typeof window !== 'undefined') {
        window.clearTimeout(t)
      }
      deleteTimersRef.current.delete(taskId)
    },
    [buildNextEntryForTask, notebookKey, publishTaskEntry, updateFocusSourceFromEntry, updateNotebookForKey, apiDeleteTaskSubtask],
  )

  const queueSubtaskDelete = useCallback(
    (taskId: string, subtaskId: string) => {
      if (!taskId || !subtaskId) return
      const map = deleteQueueRef.current
      const set = map.get(taskId) ?? new Set<string>()
      set.add(subtaskId)
      map.set(taskId, set)
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask delete queued', { taskId, subtaskId, queuedCount: set.size })
        } catch {}
      }
      // Debounce per task
      if (typeof window === 'undefined') {
        void flushDeleteQueueFor(taskId)
        return
      }
      const timers = deleteTimersRef.current
      const pending = timers.get(taskId)
      if (pending) {
        window.clearTimeout(pending)
      }
      const handle = window.setTimeout(() => {
        timers.delete(taskId)
        void flushDeleteQueueFor(taskId)
      }, 200)
      timers.set(taskId, handle)
    },
    [flushDeleteQueueFor],
  )
  useEffect(() => {
    if (!focusSource || !focusSource.taskId) {
      return
    }
    const targetKey = computeNotebookKey(focusSource, normalizedCurrentTask)
    const sourceNotes = typeof focusSource.notes === 'string' ? focusSource.notes : ''
    const sourceSubtasks = Array.isArray(focusSource.subtasks) ? focusSource.subtasks : []
    if (sourceNotes.trim().length === 0 && sourceSubtasks.length === 0) {
      return
    }
    updateNotebookForKey(targetKey, (entry) => {
      if (areNotebookEntriesEqual(entry, { notes: sourceNotes, subtasks: sourceSubtasks })) {
        return entry
      }
      return {
        notes: sourceNotes,
        subtasks: sourceSubtasks,
      }
    })
  }, [areNotebookEntriesEqual, focusSource, normalizedCurrentTask, updateNotebookForKey])
  const activeNotebookEntry = useMemo(
    () => notebookState[notebookKey] ?? createNotebookEntry(),
    [notebookState, notebookKey],
  )
  useEffect(() => {
    if (!activeTaskId) {
      lastPersistedNotebookRef.current = null
      return
    }
    const previous = lastPersistedNotebookRef.current
    if (!previous || previous.taskId !== activeTaskId) {
      lastPersistedNotebookRef.current = {
        taskId: activeTaskId,
        entry: cloneNotebookEntry(activeNotebookEntry),
      }
      return
    }
    if (areNotebookEntriesEqual(previous.entry, activeNotebookEntry)) {
      return
    }
    // If this change was from snapshot hydration, skip persisting NOTES, but continue subtask processing
    const skipNotesPersist = notebookChangeFromSnapshotRef.current
    if (!skipNotesPersist && previous.entry.notes !== activeNotebookEntry.notes) {
      scheduleNotebookNotesPersist(activeTaskId, activeNotebookEntry.notes)
      const linkedTaskId = getStableLinkedTaskId()
      if (linkedTaskId) {
        // Schedule via the same debounced publisher to avoid duplicates
        scheduleNotebookNotesSnapshotPublish(linkedTaskId, activeNotebookEntry, 'notes-effect')
      }
    }
    const prevSubtasks = previous.entry.subtasks
    const nextSubtasks = activeNotebookEntry.subtasks
    nextSubtasks.forEach((subtask) => {
      const prevMatch = prevSubtasks.find((item) => item.id === subtask.id)
      const changed =
        !prevMatch ||
        prevMatch.text !== subtask.text ||
        prevMatch.completed !== subtask.completed ||
        prevMatch.sortIndex !== subtask.sortIndex
      if (!changed) {
        return
      }
      if (subtask.text.trim().length === 0) {
        cancelNotebookSubtaskPersist(activeTaskId, subtask.id)
        return
      }
      scheduleNotebookSubtaskPersist(activeTaskId, subtask)
    })
    prevSubtasks.forEach((subtask) => {
      if (!nextSubtasks.some((item) => item.id === subtask.id)) {
        const linkedTaskId = getStableLinkedTaskId()
        if (linkedTaskId) {
          // If this id is being batched, skip immediate delete to avoid double-work
          const queued = deleteQueueRef.current.get(linkedTaskId)
          if (queued && queued.has(subtask.id)) {
            if (DEBUG_SYNC) {
              try {
                logDebug('[Sync][Focus] subtask delete skip immediate (queued)', {
                  taskId: linkedTaskId,
                  subtaskId: subtask.id,
                })
              } catch {}
            }
            return
          }
          cancelNotebookSubtaskPersist(linkedTaskId, subtask.id)
          void apiDeleteTaskSubtask(linkedTaskId, subtask.id).catch((error) =>
            logWarn('[Focus] Failed to remove subtask during sync:', error),
          )
        }
      }
    })
    lastPersistedNotebookRef.current = {
      taskId: activeTaskId,
      entry: cloneNotebookEntry(activeNotebookEntry),
    }
  }, [
    activeNotebookEntry,
    activeTaskId,
    apiDeleteTaskSubtask,
    refreshGoalsSnapshotFromSupabase,
    areNotebookEntriesEqual,
    cancelNotebookSubtaskPersist,
    scheduleNotebookNotesPersist,
    scheduleNotebookNotesSnapshotPublish,
    getStableLinkedTaskId,
    scheduleNotebookSubtaskPersist,
  ])
  useEffect(() => {
    if (!activeTaskId) {
      return
    }
    // Check if this is a Quick List task
    const goalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const isQuickList = isQuickListGoal(goalId)

    let entryNotes: string = ''
    let entrySubtasks: NotebookSubtask[] = []
    let foundTask = false

    if (isQuickList) {
      // Look for the task in quickListItems
      const quickItem = quickListItems.find((item) => item.id === activeTaskId)
      if (quickItem) {
        foundTask = true
        entryNotes = quickItem.notes ?? ''
        entrySubtasks = (quickItem.subtasks ?? []).map((subtask) => ({
          id: subtask.id,
          text: subtask.text,
          completed: subtask.completed,
          sortIndex: subtask.sortIndex,
          updatedAt: subtask.updatedAt,
        }))
      }
    } else {
      // Look for the task in goalsSnapshot
      let snapshotTask: GoalTaskSnapshot | null = null
      outer: for (let goalIndex = 0; goalIndex < goalsSnapshot.length; goalIndex += 1) {
        const goal = goalsSnapshot[goalIndex]
        for (let bucketIndex = 0; bucketIndex < goal.buckets.length; bucketIndex += 1) {
          const bucket = goal.buckets[bucketIndex]
          const found = bucket.tasks.find((task) => task.id === activeTaskId)
          if (found) {
            snapshotTask = found
            break outer
          }
        }
      }
      if (snapshotTask) {
        foundTask = true
        entryNotes = snapshotTask.notes ?? ''
        entrySubtasks = snapshotSubtasksToNotebook(snapshotTask.subtasks ?? [])
      }
    }

    if (!foundTask) {
      return
    }
    const localEntry = notebookState[notebookKey] ?? createNotebookEntry()
    // Respect hydration block unless the snapshot reflects deletions of non-empty local subtasks
    if (notebookHydrationBlockRef.current > Date.now()) {
      try {
        const snapIds = new Set(entrySubtasks.map((s) => s.id))
        let hasMeaningfulDeletion = false
        for (const s of localEntry.subtasks) {
          if (!snapIds.has(s.id) && s.text.trim().length > 0) {
            hasMeaningfulDeletion = true
            break
          }
        }
        if (!hasMeaningfulDeletion) {
          return
        }
      } catch {
        return
      }
    }
    // Mirror snapshot notes and subtasks so other tabs (Reflection/Goals) stay in sync.
    const entryFromSnapshot: NotebookEntry = { notes: entryNotes, subtasks: entrySubtasks }
    notebookChangeFromSnapshotRef.current = true
    const result = updateNotebookForKey(notebookKey, (entry) =>
      areNotebookEntriesEqual(entry, entryFromSnapshot) ? entry : entryFromSnapshot,
    )
    // Reset the flag on the next tick
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        notebookChangeFromSnapshotRef.current = false
      }, 0)
    } else {
      notebookChangeFromSnapshotRef.current = false
    }
    if (result && result.changed) {
      updateFocusSourceFromEntry(result.entry)
    }
  }, [
    activeTaskId,
    activeFocusCandidate,
    areNotebookEntriesEqual,
    focusSource,
    goalsSnapshot,
    isQuickListGoal,
    notebookKey,
    quickListItems,
    snapshotSubtasksToNotebook,
    updateFocusSourceFromEntry,
    updateNotebookForKey,
  ])
  const notebookNotes = activeNotebookEntry.notes
  const notebookSubtasks = activeNotebookEntry.subtasks
  // Ensure existing multi-line subtasks render at full height (without requiring focus).
  // Run immediately and again on the next frames to catch late layout/font paints.
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const run = () => {
      try {
        const host = document.querySelector('.taskwatch-notes') || document.body
        host
          .querySelectorAll<HTMLTextAreaElement>('.goal-task-details__subtask-input')
          .forEach((el) => {
            el.style.height = 'auto'
            el.style.height = `${el.scrollHeight}px`
          })
      } catch {}
    }
    run()
    const id1 = window.requestAnimationFrame(run)
    const id2 = window.requestAnimationFrame(() => run())
    const t = window.setTimeout(run, 0)
    return () => {
      window.cancelAnimationFrame(id1)
      window.cancelAnimationFrame(id2)
      window.clearTimeout(t)
    }
  }, [notebookSubtasks, notebookKey])
  const completedNotebookSubtasks = useMemo(
    () => notebookSubtasks.filter((subtask) => subtask.completed).length,
    [notebookSubtasks],
  )
  const subtaskProgressLabel = notebookSubtasks.length > 0 ? `${completedNotebookSubtasks}/${notebookSubtasks.length}` : null
  const notesFieldId = useMemo(() => {
    const safeKey = notebookKey.replace(/[^a-z0-9-]/gi, '-') || 'scratchpad'
    return `taskwatch-notes-${safeKey}`
  }, [notebookKey])
  const focusContextLabel = useMemo(() => {
    const parts: string[] = []
    if (effectiveGoalName) {
      parts.push(effectiveGoalName)
    }
    if (effectiveBucketName) {
      parts.push(effectiveBucketName)
    }
    if (parts.length === 0) {
      return 'No linked goal'
    }
    return parts.join(' → ')
  }, [effectiveGoalName, effectiveBucketName])
  const handleNotebookNotesChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value
      blockNotebookHydration()
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus][Notes] change (enter)', { taskId: getStableLinkedTaskId(), len: value.length })
        } catch {}
      }
      const result = updateNotebookForKey(notebookKey, (entry) =>
        entry.notes === value ? entry : { ...entry, notes: value },
      )
      if (!result || !result.changed) {
        return
      }
      const entry = result.entry
      const linkedTaskId = getStableLinkedTaskId()
      if (linkedTaskId) {
        // Schedule snapshot publish to reduce per-keystroke churn.
        scheduleNotebookNotesSnapshotPublish(linkedTaskId, entry, 'notes-change')
      } else if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus][Notes] skip publish (no linked task id)')
        } catch {}
      }
      updateFocusSourceFromEntry(entry)
    },
    [
      activeTaskId,
      focusSource,
      getStableLinkedTaskId,
      blockNotebookHydration,
      notebookKey,
      updateFocusSourceFromEntry,
      publishTaskEntry,
      scheduleNotebookNotesSnapshotPublish,
      updateNotebookForKey,
    ],
  )
  const pendingNotebookSubtaskFocusRef = useRef<{ notebookKey: string; subtaskId: string } | null>(null)
  // UI-only: delete reveal state
  const [revealedNotebookDeleteKey, setRevealedNotebookDeleteKey] = useState<string | null>(null)
  const previousNotebookSubtaskIdsRef = useRef<Set<string>>(new Set())
  const notebookSubtaskIdsInitializedRef = useRef(false)
  useEffect(() => {
    previousNotebookSubtaskIdsRef.current = new Set()
    notebookSubtaskIdsInitializedRef.current = false
  }, [notebookKey])
  const handleAddNotebookSubtask = useCallback(
    (options?: { focus?: boolean; afterId?: string }) => {
      let created: NotebookSubtask | null = null
      blockNotebookHydration()
      const result = updateNotebookForKey(notebookKey, (entry) => {
        const subs = entry.subtasks
        const afterId = options?.afterId
        let insertIndex = 0
        if (afterId) {
          const idx = subs.findIndex((s) => s.id === afterId)
          insertIndex = idx >= 0 ? idx + 1 : 0
        }
        const prev = subs[insertIndex - 1] || null
        const next = subs[insertIndex] || null
        let sortIndex: number
        if (prev && next) {
          const a = prev.sortIndex
          const b = next.sortIndex
          sortIndex = a < b ? Math.floor(a + (b - a) / 2) : a + NOTEBOOK_SUBTASK_SORT_STEP
        } else if (prev && !next) {
          sortIndex = prev.sortIndex + NOTEBOOK_SUBTASK_SORT_STEP
        } else if (!prev && next) {
          sortIndex = next.sortIndex - NOTEBOOK_SUBTASK_SORT_STEP
        } else {
          sortIndex = NOTEBOOK_SUBTASK_SORT_STEP
        }
        const subtask = createNotebookEmptySubtask(sortIndex)
        created = subtask
        const copy = [...subs]
        copy.splice(insertIndex, 0, subtask)
        return {
          ...entry,
          subtasks: copy,
        }
      })
      if (!result || !result.changed || !created) {
        return
      }
      const createdSubtask: NotebookSubtask = created
      if (options?.focus !== false) {
        pendingNotebookSubtaskFocusRef.current = { notebookKey, subtaskId: createdSubtask.id }
        // Try focusing the new input immediately to reduce perceived lag
        if (typeof window !== 'undefined') {
          const inputId = makeNotebookSubtaskInputId(notebookKey, createdSubtask.id)
          const tryFocusNow = () => {
            const el = document.getElementById(inputId) as HTMLTextAreaElement | null
            if (el) {
              try {
                el.focus({ preventScroll: true })
                const end = el.value.length
                el.setSelectionRange?.(end, end)
              } catch {}
            }
          }
          if (typeof queueMicrotask === 'function') {
            queueMicrotask(() => {
              if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(tryFocusNow)
              } else {
                setTimeout(tryFocusNow, 0)
              }
            })
          } else {
            setTimeout(() => {
              if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(tryFocusNow)
              } else {
                tryFocusNow()
              }
            }, 0)
          }
        }
      }
      // Keep Goals page in sync even when paused/idle by publishing the
      // updated entry to the shared goals snapshot when a real task is linked.
      const linkedTaskId = getStableLinkedTaskId()
      // New entries are blank by design; skip snapshot work on add to keep
      // the UI snappy. We'll publish on the first text change or blur.
      if (linkedTaskId && createdSubtask.text.trim().length > 0) {
        // Use publishTaskEntry to handle both regular goals and Quick List
        publishTaskEntry(linkedTaskId, result.entry, 'subtask-add')
        if (DEBUG_SYNC) {
          logDebug('[Sync][Focus] subtask add publish', {
            taskId: linkedTaskId,
            subtaskId: createdSubtask.id,
            total: result.entry.subtasks.length,
          })
        }
      } else if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask add skip publish', {
            reason: linkedTaskId ? 'blank-new-entry' : 'no linked task id',
            subtaskId: createdSubtask.id,
            total: result.entry.subtasks.length,
          })
        } catch {}
      }
      // Avoid extra work on blank add; update on first text change/blur
      if (createdSubtask.text.trim().length > 0) {
        updateFocusSourceFromEntry(result.entry)
      }
      // Hide any revealed delete affordance when adding a new row
      setRevealedNotebookDeleteKey(null)
    },
    [
      activeTaskId,
      focusSource,
      getStableLinkedTaskId,
      blockNotebookHydration,
      notebookKey,
      updateFocusSourceFromEntry,
      publishTaskEntry,
      updateNotebookForKey,
    ],
  )
  useEffect(() => {
    const previousIds = previousNotebookSubtaskIdsRef.current
    const nextIds = new Set<string>()
    notebookSubtasks.forEach((subtask) => {
      nextIds.add(subtask.id)
    })

    let pending = pendingNotebookSubtaskFocusRef.current
    if (!notebookSubtaskIdsInitializedRef.current) {
      notebookSubtaskIdsInitializedRef.current = true
    } else if (!pending || pending.notebookKey !== notebookKey) {
      const newestBlankSubtask = [...notebookSubtasks]
        .slice()
        .reverse()
        .find((subtask) => !previousIds.has(subtask.id) && subtask.text.trim().length === 0)
      if (newestBlankSubtask) {
        pending = { notebookKey, subtaskId: newestBlankSubtask.id }
        pendingNotebookSubtaskFocusRef.current = pending
      }
    }

    previousNotebookSubtaskIdsRef.current = nextIds

    if (!pending || pending.notebookKey !== notebookKey) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const focusTarget = pending
    const inputId = makeNotebookSubtaskInputId(notebookKey, focusTarget.subtaskId)
    let attempts = 0
    let rafId: number | null = null
    let timeoutId: number | null = null

    const cleanup = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }
    const clearPendingIfMatch = () => {
      const currentPending = pendingNotebookSubtaskFocusRef.current
      if (
        currentPending &&
        currentPending.notebookKey === focusTarget.notebookKey &&
        currentPending.subtaskId === focusTarget.subtaskId
      ) {
        pendingNotebookSubtaskFocusRef.current = null
      }
    }

    const tryFocus = () => {
      const input = document.getElementById(inputId) as HTMLTextAreaElement | null
      if (input) {
        try {
          input.focus({ preventScroll: true })
          const end = input.value.length
          input.setSelectionRange?.(end, end)
          ;(input as any).select?.()
        } catch {}
        clearPendingIfMatch()
        cleanup()
        return
      }
      attempts += 1
      if (attempts < 8) {
        if (attempts <= 6 && typeof window.requestAnimationFrame === 'function') {
          rafId = window.requestAnimationFrame(tryFocus)
        } else {
          timeoutId = window.setTimeout(tryFocus, 60)
        }
        return
      }
      clearPendingIfMatch()
      cleanup()
    }

    tryFocus()
    return cleanup
  }, [notebookKey, notebookSubtasks])
  const handleNotebookSubtaskTextChange = useCallback(
    (subtaskId: string, value: string) => {
      let updated: NotebookSubtask | null = null
      blockNotebookHydration()
      const result = updateNotebookForKey(notebookKey, (entry) => {
        const index = entry.subtasks.findIndex((item) => item.id === subtaskId)
        if (index === -1) {
          return entry
        }
        const target = entry.subtasks[index]
        if (!target || target.text === value) {
          return entry
        }
        const nextSubtasks = entry.subtasks.map((item, idx) => {
          if (idx !== index) {
            return item
          }
          const next = { ...item, text: value }
          updated = next
          return next
        })
        return { ...entry, subtasks: nextSubtasks }
      })
      if (!result || !result.changed || !updated) {
        return
      }
      const updatedSubtask: NotebookSubtask = updated
      const linkedTaskId = getStableLinkedTaskId()
      if (linkedTaskId) {
        if (updatedSubtask.text.trim().length === 0) {
          cancelNotebookSubtaskPersist(linkedTaskId, updatedSubtask.id)
        }
        // Debounce snapshot publish to avoid per-keystroke churn
        scheduleNotebookNotesSnapshotPublish(linkedTaskId, result.entry, 'subtasks-change')
        if (DEBUG_SYNC) {
          logDebug('[Sync][Focus] subtask text schedule publish', {
            taskId: linkedTaskId,
            subtaskId,
            textLen: updatedSubtask.text.length,
          })
        }
      } else if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask text skip publish (no linked task id)', {
            subtaskId,
            textLen: updatedSubtask.text.length,
          })
        } catch {}
      }
      updateFocusSourceFromEntry(result.entry)
    },
    [
      activeTaskId,
      focusSource,
      getStableLinkedTaskId,
      blockNotebookHydration,
      cancelNotebookSubtaskPersist,
      handleAddNotebookSubtask,
      notebookKey,
      updateFocusSourceFromEntry,
      scheduleNotebookNotesSnapshotPublish,
      updateNotebookForKey,
    ],
  )
  const handleNotebookSubtaskBlur = useCallback(
    (subtaskId: string) => {
      let removed: NotebookSubtask | null = null
      blockNotebookHydration()
      const result = updateNotebookForKey(notebookKey, (entry) => {
        const target = entry.subtasks.find((item) => item.id === subtaskId)
        if (!target || target.text.trim().length > 0) {
          // No structural change; publish current entry below.
          return entry
        }
        const nextSubtasks = entry.subtasks.filter((item) => item.id !== subtaskId)
        if (nextSubtasks.length === entry.subtasks.length) {
          return entry
        }
        removed = target
        return { ...entry, subtasks: nextSubtasks }
      })
      const linkedTaskId = getStableLinkedTaskId()
      const entryToPublish = result?.entry ?? activeNotebookEntry
      if (!result || !result.changed) {
        // Publish on blur even if no structural change (commit point)
        if (linkedTaskId) {
          // Use publishTaskEntry to handle both regular goals and Quick List
          publishTaskEntry(linkedTaskId, entryToPublish, 'subtask-blur')
          // Also flush latest subtask edit for this id to DB on blur
          const updated = entryToPublish.subtasks.find((s) => s.id === subtaskId)
          if (updated) {
            flushNotebookSubtaskPersist(linkedTaskId, updated)
          }
          if (DEBUG_SYNC) {
            logDebug('[Sync][Focus] subtask blur publish (no structural change)', {
              taskId: linkedTaskId,
              subtaskId,
            })
          }
        } else if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] subtask blur skip publish (no linked task id, no change)', {
              subtaskId,
            })
          } catch {}
        }
        updateFocusSourceFromEntry(entryToPublish)
        return
      }
      const removedSubtask: NotebookSubtask = removed!
      if (linkedTaskId) {
        cancelNotebookSubtaskPersist(linkedTaskId, removedSubtask.id)
        // Remove server-side immediately for empty-on-blur deletions
        void apiDeleteTaskSubtask(linkedTaskId, removedSubtask.id)
          .then(() => {
            publishTaskEntry(linkedTaskId, entryToPublish, 'subtask-delete-blur')
          })
          .catch((error) => logWarn('[Focus] Failed to remove subtask on blur:', error))
        if (DEBUG_SYNC) {
          logDebug('[Sync][Focus] subtask blur/remove publish', {
            taskId: linkedTaskId,
            subtaskId,
            removed: removedSubtask.text.trim().length === 0,
          })
        }
      } else if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask blur/remove skip publish (no linked task id)', {
            subtaskId,
            removed: removedSubtask.text.trim().length === 0,
          })
        } catch {}
      }
      updateFocusSourceFromEntry(entryToPublish)
    },
    [
      activeTaskId,
      focusSource,
      getStableLinkedTaskId,
      cancelNotebookSubtaskPersist,
      blockNotebookHydration,
      activeNotebookEntry,
      notebookKey,
      updateFocusSourceFromEntry,
      publishTaskEntry,
      updateNotebookForKey,
    ],
  )
  const handleNotebookSubtaskToggle = useCallback(
    (subtaskId: string) => {
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] toggle (enter)', { subtaskId, taskId: getStableLinkedTaskId() })
        } catch {}
      }
      let toggled: NotebookSubtask | null = null
      blockNotebookHydration()
      const result = updateNotebookForKey(notebookKey, (entry) => {
        const index = entry.subtasks.findIndex((item) => item.id === subtaskId)
        if (index === -1) {
          return entry
        }
        const nextSubtasks = entry.subtasks.map((item, idx) => {
          if (idx !== index) {
            return item
          }
          const next = { ...item, completed: !item.completed }
          toggled = next
          return next
        })
        return { ...entry, subtasks: nextSubtasks }
      })
      if (!result || !result.changed || !toggled) {
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] toggle (no change)', { subtaskId, changed: Boolean(result?.changed) })
          } catch {}
        }
        // Fallback: compute from authoritative UI entry
        const idx = activeNotebookEntry.subtasks.findIndex((s) => s.id === subtaskId)
        if (idx !== -1) {
          const nextSubtasks = activeNotebookEntry.subtasks.map((s, i) => (i === idx ? { ...s, completed: !s.completed } : s))
          const nextEntry: NotebookEntry = { notes: activeNotebookEntry.notes, subtasks: nextSubtasks }
          updateNotebookForKey(notebookKey, () => nextEntry)
          const linkedTaskId = getStableLinkedTaskId()
          if (linkedTaskId) {
            publishTaskEntry(linkedTaskId, nextEntry, 'subtask-toggle-fallback')
          }
          updateFocusSourceFromEntry(nextEntry)
        }
        return
      }
      const linkedTaskId = getStableLinkedTaskId()
      if (linkedTaskId) {
        // Use fallback-aware publisher so toggles publish even if the task
        // isn't in the local snapshot yet.
        publishTaskEntry(linkedTaskId, result.entry, 'subtask-toggle')
        if (DEBUG_SYNC) {
          logDebug('[Sync][Focus] subtask toggle publish', {
            taskId: linkedTaskId,
            subtaskId,
          })
        }
      } else if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask toggle skip publish (no linked task id)', {
            subtaskId,
          })
        } catch {}
      }
      updateFocusSourceFromEntry(result.entry)
    },
    [
      activeTaskId,
      focusSource,
      getStableLinkedTaskId,
      publishTaskEntry,
      blockNotebookHydration,
      notebookKey,
      updateFocusSourceFromEntry,
      updateNotebookForKey,
      activeNotebookEntry,
    ],
  )
  const handleNotebookSubtaskRemove = useCallback(
    (subtaskId: string) => {
      if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] remove (enter)', { subtaskId, taskId: getStableLinkedTaskId() })
        } catch {}
      }
      let removed: NotebookSubtask | null = null
      blockNotebookHydration()
      const result = updateNotebookForKey(notebookKey, (entry) => {
        const nextSubtasks = entry.subtasks.filter((item) => item.id !== subtaskId)
        if (nextSubtasks.length === entry.subtasks.length) {
          return entry
        }
        const target = entry.subtasks.find((item) => item.id === subtaskId) ?? null
        removed = target
        return { ...entry, subtasks: nextSubtasks }
      })
      if (!result || !result.changed || !removed) {
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] remove (no change)', { subtaskId, changed: Boolean(result?.changed) })
          } catch {}
        }
        // Fallback: compute the next entry from the authoritative UI entry
        const exists = activeNotebookEntry.subtasks.some((s) => s.id === subtaskId)
        if (exists) {
          const nextEntry: NotebookEntry = {
            notes: activeNotebookEntry.notes,
            subtasks: activeNotebookEntry.subtasks.filter((s) => s.id !== subtaskId),
          }
          updateNotebookForKey(notebookKey, () => nextEntry)
          const linkedTaskId = getStableLinkedTaskId()
          if (linkedTaskId) {
            cancelNotebookSubtaskPersist(linkedTaskId, subtaskId)
            // Queue for batched deletion and let the batch publish once
            queueSubtaskDelete(linkedTaskId, subtaskId)
            if (DEBUG_SYNC) {
              try {
                logDebug('[Sync][Focus] subtask delete queued (fallback)', {
                  taskId: linkedTaskId,
                  subtaskId,
                })
              } catch {}
            }
          }
          updateFocusSourceFromEntry(nextEntry)
        }
        return
      }
      const removedSubtask: NotebookSubtask = removed
      const linkedTaskId = getStableLinkedTaskId()
      if (linkedTaskId) {
        cancelNotebookSubtaskPersist(linkedTaskId, removedSubtask.id)
        // Queue for batched deletion; batch flush will publish once
        queueSubtaskDelete(linkedTaskId, removedSubtask.id)
        if (DEBUG_SYNC) {
          try {
            logDebug('[Sync][Focus] subtask delete queued', {
              taskId: linkedTaskId,
              subtaskId,
            })
          } catch {}
        }
      } else if (DEBUG_SYNC) {
        try {
          logDebug('[Sync][Focus] subtask remove skip publish (no linked task id)', {
            subtaskId,
          })
        } catch {}
      }
      updateFocusSourceFromEntry(result.entry)
    },
    [
      activeTaskId,
      focusSource,
      getStableLinkedTaskId,
      cancelNotebookSubtaskPersist,
      blockNotebookHydration,
      notebookKey,
      updateFocusSourceFromEntry,
      updateNotebookForKey,
      queueSubtaskDelete,
    ],
  )
  const notebookSection = useMemo(
    () => (
      <section className="taskwatch-notes" aria-label="Subtasks & notes">
        <div className="taskwatch-notes__header">
          <div className="taskwatch-notes__heading">
            <h2 className="taskwatch-notes__title">Subtasks & notes</h2>
            <p className="taskwatch-notes__subtitle">
              <span className="taskwatch-notes__task">{safeTaskName}</span>
              <span className="taskwatch-notes__context">{focusContextLabel}</span>
            </p>
          </div>
        </div>

        <div className="taskwatch-notes__subtasks">
          <div className="taskwatch-notes__subtasks-row">
            <div className="taskwatch-notes__subtasks-header">
              <p className="taskwatch-notes__label">Subtasks</p>
              {subtaskProgressLabel ? (
                <span className="taskwatch-notes__progress" aria-label={`Completed ${subtaskProgressLabel} subtasks`}>
                  {subtaskProgressLabel}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="taskwatch-notes__add"
              onClick={() => handleAddNotebookSubtask()}
            >
              + Subtask
            </button>
          </div>
          {notebookSubtasks.length === 0 ? (
            <p className="goal-task-details__empty-text">No subtasks yet</p>
          ) : (
            <ul className="goal-task-details__subtask-list">
              {notebookSubtasks.map((subtask) => {
                const subDeleteKey = `${notebookKey}__subtask__${subtask.id}`
                const isSubDeleteRevealed = revealedNotebookDeleteKey === subDeleteKey
                return (
                <li
                  key={subtask.id}
                  data-delete-key={subDeleteKey}
                  className={classNames(
                    'goal-task-details__subtask',
                    subtask.completed && 'goal-task-details__subtask--completed',
                    isSubDeleteRevealed && 'goal-task-details__subtask--delete-revealed',
                  )}
                  onClick={(event) => {
                    // Left-click: do not toggle delete; reserve for editing/caret.
                    event.stopPropagation()
                  }}
                  onContextMenu={(event) => {
                    // Right-click toggles delete reveal
                    event.preventDefault()
                    event.stopPropagation()
                    setRevealedNotebookDeleteKey(isSubDeleteRevealed ? null : subDeleteKey)
                  }}
                  onDoubleClick={(event) => {
                    // Do not interfere with native selection behavior
                    event.stopPropagation()
                    setRevealedNotebookDeleteKey(null)
                  }}
                >
                  <label className="goal-task-details__subtask-item">
                    <div className="goal-subtask-field">
                      <input
                        type="checkbox"
                        className="goal-task-details__checkbox"
                        checked={subtask.completed}
                        onChange={() => handleNotebookSubtaskToggle(subtask.id)}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={
                          subtask.text.trim().length > 0 ? `Mark "${subtask.text}" complete` : 'Toggle subtask'
                        }
                      />
                      <textarea
                        id={makeNotebookSubtaskInputId(notebookKey, subtask.id)}
                        className="goal-task-details__subtask-input"
                        rows={1}
                        ref={(el) => autosizeTextArea(el)}
                        value={subtask.text}
                        onChange={(event) => {
                          const el = event.currentTarget
                          // auto-resize height
                          el.style.height = 'auto'
                          el.style.height = `${el.scrollHeight}px`
                         handleNotebookSubtaskTextChange(subtask.id, event.target.value)
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          // Enter commits a new subtask at the top; Shift+Enter inserts newline
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            handleAddNotebookSubtask({ focus: true })
                          }
                          // Escape on empty behaves like clicking off (remove empty)
                          if (event.key === 'Escape') {
                            const value = event.currentTarget.value
                            if (value.trim().length === 0) {
                              event.preventDefault()
                              event.currentTarget.blur()
                            }
                          }
                        }}
                        onFocus={(event) => {
                          const el = event.currentTarget
                          el.style.height = 'auto'
                          el.style.height = `${el.scrollHeight}px`
                        }}
                        onBlur={() => handleNotebookSubtaskBlur(subtask.id)}
                        placeholder="Describe subtask"
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    className="goal-task-details__remove"
                    onClick={() => {
                      setRevealedNotebookDeleteKey(null)
                      handleNotebookSubtaskRemove(subtask.id)
                    }}
                    aria-label="Remove subtask"
                  >
                    ×
                  </button>
                </li>
              )})}
            </ul>
          )}
        </div>

        <div className="taskwatch-notes__notes">
          <label className="taskwatch-notes__label" htmlFor={notesFieldId}>
            Notes
          </label>
          <textarea
            id={notesFieldId}
            className="goal-task-details__textarea"
            value={notebookNotes}
            onChange={handleNotebookNotesChange}
            onBlur={() => {
              const linkedTaskId = getStableLinkedTaskId()
              if (linkedTaskId) {
                flushNotebookNotesSnapshotPublish(linkedTaskId, activeNotebookEntry, 'notes-blur')
              }
            }}
            placeholder="Capture quick ideas, wins, or blockers while you work..."
            rows={4}
          />
        </div>
      </section>
    ),
    [
      focusContextLabel,
      handleAddNotebookSubtask,
      handleNotebookNotesChange,
      handleNotebookSubtaskBlur,
      handleNotebookSubtaskRemove,
      handleNotebookSubtaskTextChange,
      handleNotebookSubtaskToggle,
      notebookKey,
      notebookNotes,
      notebookSubtasks,
      revealedNotebookDeleteKey,
      notesFieldId,
      safeTaskName,
      subtaskProgressLabel,
    ],
  )

  const subtasksCard = useMemo(
    () => (
      <section className="taskwatch-notes taskwatch-subtasks-card" aria-label="Subtasks">
        <div className="taskwatch-notes__header">
          <div className="taskwatch-notes__heading">
            <h2 className="taskwatch-notes__title">Subtasks</h2>
            <p className="taskwatch-notes__subtitle">
              <span className="taskwatch-notes__task">{safeTaskName}</span>
              <span className="taskwatch-notes__context">{focusContextLabel}</span>
            </p>
          </div>
        </div>

        <div className="taskwatch-notes__subtasks">
          <div className="taskwatch-notes__subtasks-row">
            <div className="taskwatch-notes__subtasks-header">
              <p className="taskwatch-notes__label">Subtasks</p>
              {subtaskProgressLabel ? (
                <span className="taskwatch-notes__progress" aria-label={`Completed ${subtaskProgressLabel} subtasks`}>
                  {subtaskProgressLabel}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="taskwatch-notes__add"
              onClick={() => handleAddNotebookSubtask()}
            >
              + Subtask
            </button>
          </div>
          {notebookSubtasks.length === 0 ? (
            <p className="goal-task-details__empty-text">No subtasks yet</p>
          ) : (
            <ul className="goal-task-details__subtask-list">
              {notebookSubtasks.map((subtask) => {
                const subDeleteKey = `${notebookKey}__subtask__${subtask.id}`
                const isSubDeleteRevealed = revealedNotebookDeleteKey === subDeleteKey
                return (
                  <li
                    key={subtask.id}
                    data-delete-key={subDeleteKey}
                    className={classNames(
                      'goal-task-details__subtask',
                      subtask.completed && 'goal-task-details__subtask--completed',
                      isSubDeleteRevealed && 'goal-task-details__subtask--delete-revealed',
                    )}
                    onClick={(event) => { event.stopPropagation() }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setRevealedNotebookDeleteKey(isSubDeleteRevealed ? null : subDeleteKey)
                    }}
                    onDoubleClick={(event) => { event.stopPropagation(); setRevealedNotebookDeleteKey(null) }}
                  >
                    <label className="goal-task-details__subtask-item">
                      <div className="goal-subtask-field">
                        <input
                          type="checkbox"
                          className="goal-task-details__checkbox"
                          checked={subtask.completed}
                          onChange={() => handleNotebookSubtaskToggle(subtask.id)}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                          aria-label={subtask.text.trim().length > 0 ? `Mark "${subtask.text}" complete` : 'Toggle subtask'}
                        />
                        <textarea
                          id={makeNotebookSubtaskInputId(notebookKey, subtask.id)}
                          className="goal-task-details__subtask-input"
                          rows={1}
                          ref={(el) => autosizeTextArea(el)}
                          value={subtask.text}
                          onChange={(event) => {
                            const el = event.currentTarget
                            el.style.height = 'auto'
                            el.style.height = `${el.scrollHeight}px`
                            handleNotebookSubtaskTextChange(subtask.id, event.target.value)
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault()
                              handleAddNotebookSubtask({ focus: true })
                            }
                            if (event.key === 'Escape') {
                              const value = event.currentTarget.value
                              if (value.trim().length === 0) {
                                event.preventDefault()
                                event.currentTarget.blur()
                              }
                            }
                          }}
                          onFocus={(event) => {
                            const el = event.currentTarget
                            el.style.height = 'auto'
                            el.style.height = `${el.scrollHeight}px`
                          }}
                          onBlur={() => handleNotebookSubtaskBlur(subtask.id)}
                          placeholder="Describe subtask"
                        />
                      </div>
                    </label>
                    <button
                      type="button"
                      className="goal-task-details__remove"
                      onClick={() => { setRevealedNotebookDeleteKey(null); handleNotebookSubtaskRemove(subtask.id) }}
                      aria-label="Remove subtask"
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>
    ),
    [
      focusContextLabel,
      handleAddNotebookSubtask,
      handleNotebookSubtaskBlur,
      handleNotebookSubtaskRemove,
      handleNotebookSubtaskTextChange,
      handleNotebookSubtaskToggle,
      notebookKey,
      notebookSubtasks,
      revealedNotebookDeleteKey,
      safeTaskName,
      subtaskProgressLabel,
    ],
  )

  const notesCard = useMemo(
    () => (
      <section className="taskwatch-notes taskwatch-notes-card" aria-label="Notes">
        <div className="taskwatch-notes__header">
          <div className="taskwatch-notes__heading">
            <h2 className="taskwatch-notes__title">Notes</h2>
            <p className="taskwatch-notes__subtitle">
              <span className="taskwatch-notes__task">{safeTaskName}</span>
              <span className="taskwatch-notes__context">{focusContextLabel}</span>
            </p>
          </div>
        </div>
        <div className="taskwatch-notes__notes">
          <label className="taskwatch-notes__label" htmlFor={notesFieldId}>
            Notes
          </label>
          <textarea
            id={notesFieldId}
            className="goal-task-details__textarea"
            value={notebookNotes}
            onChange={handleNotebookNotesChange}
            onBlur={() => {
              const linkedTaskId = getStableLinkedTaskId()
              if (linkedTaskId) {
                flushNotebookNotesSnapshotPublish(linkedTaskId, activeNotebookEntry, 'notes-blur')
              }
            }}
            placeholder="Capture quick ideas, wins, or blockers while you work..."
            rows={4}
          />
        </div>
      </section>
    ),
    [
      activeNotebookEntry,
      focusContextLabel,
      flushNotebookNotesSnapshotPublish,
      getStableLinkedTaskId,
      handleNotebookNotesChange,
      notebookNotes,
      notesFieldId,
      safeTaskName,
    ],
  )

  // Close revealed delete affordance when clicking elsewhere or pressing Escape
  useEffect(() => {
    if (!revealedNotebookDeleteKey || typeof window === 'undefined') {
      return
    }
    if (typeof document !== 'undefined') {
      const host = document.querySelector<HTMLElement>(`[data-delete-key="${revealedNotebookDeleteKey}"]`)
      if (!host) {
        setRevealedNotebookDeleteKey(null)
        return
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const key = target?.closest<HTMLElement>('[data-delete-key]')?.dataset.deleteKey ?? null
      if (key !== revealedNotebookDeleteKey) {
        setRevealedNotebookDeleteKey(null)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRevealedNotebookDeleteKey(null)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [revealedNotebookDeleteKey])


  useEffect(() => {
    const contextGoalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const contextBucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
    const contextTaskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
    const contextRuleId = focusSource?.repeatingRuleId ?? activeFocusCandidate?.repeatingRuleId ?? null
    const contextOccurrenceDate =
      focusSource?.repeatingOccurrenceDate ?? activeFocusCandidate?.repeatingOccurrenceDate ?? null
    const contextOriginalTime =
      focusSource?.repeatingOriginalTime ?? activeFocusCandidate?.repeatingOriginalTime ?? null
    const sessionKey = makeSessionKey(contextGoalId, contextBucketId, contextTaskId)
    focusContextRef.current = {
      goalId: contextGoalId,
      bucketId: contextBucketId,
      taskId: contextTaskId,
      sessionKey,
      goalName: effectiveGoalName,
      bucketName: effectiveBucketName,
      repeatingRuleId: contextRuleId,
      repeatingOccurrenceDate: contextOccurrenceDate,
      repeatingOriginalTime: contextOriginalTime,
    }
  }, [
    focusSource,
    activeFocusCandidate,
    effectiveGoalName,
    effectiveBucketName,
    activeFocusCandidate?.repeatingRuleId,
    focusSource?.repeatingRuleId,
    activeFocusCandidate?.repeatingOccurrenceDate,
    focusSource?.repeatingOccurrenceDate,
    activeFocusCandidate?.repeatingOriginalTime,
    focusSource?.repeatingOriginalTime,
  ])

  useEffect(() => {
    setFocusSource((current) => {
      // If nothing to update, keep as-is
      if (!current) {
        return current
      }
      // Never downgrade/clear focus linkage during an active or paused session
      // This prevents the focus entry from reverting when navigating back
      if (isRunning || elapsed > 0) {
        return current
      }
      if (!current.goalId) {
        return current
      }
      const goal = goalsSnapshot.find((g) => g.id === current.goalId)
      // Be conservative: if the snapshot doesn't include the goal (yet), keep current linkage
      if (!goal) {
        return current
      }
      const bucket = current.bucketId ? goal.buckets.find((b) => b.id === current.bucketId) : null
      // Likewise, if bucket is missing or archived in this snapshot, avoid clearing;
      // maintain the existing linkage and let completion flows clear explicitly.
      if (bucket && bucket.archived) {
        return current
      }
      if (current.bucketId && !bucket) {
        return current
      }
      const candidate = activeFocusCandidate
      let nextGoalName = current.goalName
      let nextBucketName = current.bucketName
      let nextTaskId = current.taskId
      let nextTaskDifficulty = current.taskDifficulty
      let nextPriority = current.priority
      let changed = false
      if (goal.name !== current.goalName) {
        nextGoalName = goal.name
        changed = true
      }
      // goalSurface/bucketSurface are neutralized to defaults; no change tracking needed
      if (bucket) {
        if (bucket.name !== current.bucketName) {
          nextBucketName = bucket.name
          changed = true
        }
        // bucketSurface is neutralized to default/null; no change tracking needed
      }
      if (candidate) {
        if (candidate.taskId !== current.taskId) {
          nextTaskId = candidate.taskId
          changed = true
        }
        if (candidate.difficulty !== current.taskDifficulty) {
          nextTaskDifficulty = candidate.difficulty
          changed = true
        }
        if (candidate.priority !== current.priority) {
          nextPriority = candidate.priority
          changed = true
        }
      }
      if (!changed) {
        return current
      }
      return {
        ...current,
        goalName: nextGoalName,
        bucketName: nextBucketName,
        taskId: nextTaskId,
        taskDifficulty: nextTaskDifficulty,
        priority: nextPriority,
      }
    })
  }, [activeFocusCandidate, goalsSnapshot, isRunning, elapsed])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const hasActiveSession = isRunning || elapsed > 0
    if (!hasActiveSession) {
      try {
        window.localStorage.removeItem(CURRENT_SESSION_STORAGE_KEY)
      } catch (error) {
        logWarn('Failed to clear active session state', error)
      }
      try {
        const event = new CustomEvent(CURRENT_SESSION_EVENT_NAME, { detail: null })
        window.dispatchEvent(event)
      } catch {
        // ignore dispatch errors
      }
      return
    }

    const payload = {
      taskName: sessionTaskLabel,
      goalName: sessionGoalName,
      bucketName: sessionBucketName,
      startedAt: sessionStart,
      baseElapsed: elapsed,
      committedElapsed: lastCommittedElapsedRef.current,
      isRunning,
      goalId: sessionGoalId,
      bucketId: sessionBucketId,
      taskId: sessionTaskId,
      updatedAt: Date.now(),
      // Include the active placeholder entry ID so ReflectionPage can filter it from calendar
      activeSessionEntryId: activeSessionEntryIdRef.current,
    }

    try {
      window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, JSON.stringify(payload))
    } catch (error) {
      logWarn('Failed to persist active session state', error)
    }

    try {
      const event = new CustomEvent(CURRENT_SESSION_EVENT_NAME, { detail: payload })
      window.dispatchEvent(event)
    } catch {
      // ignore dispatch errors
    }
  }, [
    isRunning,
    elapsedSeconds,
    sessionStart,
    sessionTaskLabel,
    sessionGoalName,
    sessionBucketName,
    sessionGoalId,
    sessionBucketId,
    sessionTaskId,
  ]) 

  useEffect(() => {
    if (activeGoalSnapshots.length === 0) {
      setExpandedGoals(new Set())
      setExpandedBuckets(new Set())
      return
    }
    setExpandedGoals((current) => {
      const validGoalIds = new Set(activeGoalSnapshots.map((goal) => goal.id))
      const next = new Set<string>()
      current.forEach((id) => {
        if (validGoalIds.has(id)) {
          next.add(id)
        }
      })
      return next
    })
    setExpandedBuckets((current) => {
      const validBucketIds = new Set(
        activeGoalSnapshots.flatMap((goal) =>
          goal.buckets.filter((bucket) => !bucket.archived).map((bucket) => bucket.id),
        ),
      )
      const next = new Set<string>()
      current.forEach((id) => {
        if (validBucketIds.has(id)) {
          next.add(id)
        }
      })
      return next
    })
  }, [activeGoalSnapshots])

  const currentTaskLower = normalizedCurrentTask.toLocaleLowerCase()
  const isDefaultTask = normalizedCurrentTask.length === 0
  const defaultTaskPlaceholder = timeMode === 'focus' ? 'Click to choose a focus task…' : 'Click to choose a break task...'
  // Use activeFocusCandidate first (live from goals snapshot) for difficulty/priority,
  // fall back to focusSource (stored state) if not available
  const focusDifficulty =
    activeFocusCandidate?.difficulty ?? focusSource?.taskDifficulty ?? null
  const focusPriority = activeFocusCandidate?.priority ?? focusSource?.priority ?? false
  const focusGoalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
  const focusBucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
  const effectiveTaskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
  const effectiveGoalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
  const effectiveBucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
  const canCompleteFocus = Boolean(effectiveTaskId && effectiveBucketId && effectiveGoalId) && !isCompletingFocus
  const focusDiffClass =
    focusDifficulty === 'green'
      ? 'goal-task-row--diff-green'
      : focusDifficulty === 'yellow'
      ? 'goal-task-row--diff-yellow'
      : focusDifficulty === 'red'
      ? 'goal-task-row--diff-red'
      : ''
  const canCycleFocusDifficulty = Boolean(effectiveTaskId && effectiveGoalId && effectiveBucketId)
  const focusDiffButtonClass = [
    'goal-task-diff',
    focusDifficulty && focusDifficulty !== 'none' ? `goal-task-diff--${focusDifficulty}` : '',
    'focus-task__diff-chip',
  ]
    .filter(Boolean)
    .join(' ')
  const canToggleFocusPriority = Boolean(effectiveTaskId && effectiveGoalId && effectiveBucketId)
  const focusDifficultyDescriptor = focusDifficulty && focusDifficulty !== 'none' ? focusDifficulty : 'none'
  const focusDiffButtonTitle = !canToggleFocusPriority
    ? `Cycle task difficulty (current ${focusDifficultyDescriptor})`
    : focusPriority
    ? `Tap to cycle difficulty (current ${focusDifficultyDescriptor}) • Hold ~300ms to remove priority`
    : `Tap to cycle difficulty (current ${focusDifficultyDescriptor}) • Hold ~300ms to mark as priority`

  const toggleGoalExpansion = (goalId: string) => {
    const isExpanded = expandedGoals.has(goalId)
    setExpandedGoals((current) => {
      const next = new Set(current)
      if (isExpanded) {
        next.delete(goalId)
      } else {
        next.add(goalId)
      }
      return next
    })
    if (isExpanded) {
      const goal = goalsSnapshot.find((g) => g.id === goalId)
      if (goal) {
        setExpandedBuckets((current) => {
          const next = new Set(current)
          goal.buckets.forEach((bucket) => next.delete(bucket.id))
          return next
        })
      }
    }
  }

  const toggleBucketExpansion = (bucketId: string) => {
    setExpandedBuckets((current) => {
      const next = new Set(current)
      if (next.has(bucketId)) {
        next.delete(bucketId)
      } else {
        next.add(bucketId)
      }
      return next
    })
  }

  const handleToggleSelector = () => {
    setIsSelectorOpen((open) => {
      if (open) {
        return false
      }
      setCustomTaskDraft(normalizedCurrentTask)
      return true
    })
  }

  const handleSelectorContainerClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('button')) {
      return
    }
    handleToggleSelector()
  }

  const cycleFocusDifficulty = useCallback(() => {
    if (!canCycleFocusDifficulty || !effectiveGoalId || !effectiveBucketId || !effectiveTaskId) {
      return
    }
    const nextDifficulty = getNextDifficulty(focusDifficulty ?? 'none')
    const isQuickListTask = isQuickListGoal(effectiveGoalId)
    if (isQuickListTask) {
      // Update Quick List local state and persist to localStorage (triggers cross-tab sync)
      setQuickListItems((current) => {
        const updated = current.map((item) =>
          item.id === effectiveTaskId ? { ...item, difficulty: nextDifficulty } : item,
        )
        writeStoredQuickList(updated)
        return updated
      })
    } else {
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          if (goal.id !== effectiveGoalId) {
            return goal
          }
          const updatedBuckets = goal.buckets.map((bucket) => {
            if (bucket.id !== effectiveBucketId) {
              return bucket
            }
            const updatedTasks = bucket.tasks.map((task) => {
              if (task.id !== effectiveTaskId) {
                return task
              }
              mutated = true
              return { ...task, difficulty: nextDifficulty }
            })
            return { ...bucket, tasks: updatedTasks }
          })
          return { ...goal, buckets: updatedBuckets }
        })
        if (mutated) {
          publishGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    }
    setFocusSource((current) => {
      if (!current || current.taskId !== effectiveTaskId) {
        return current
      }
      return {
        ...current,
        taskDifficulty: nextDifficulty,
      }
    })
    setTaskDifficulty(effectiveTaskId, nextDifficulty).catch((error) => {
      logWarn('Failed to update focus task difficulty', error)
    })
  }, [
    canCycleFocusDifficulty,
    effectiveGoalId,
    effectiveBucketId,
    effectiveTaskId,
    focusDifficulty,
    isQuickListGoal,
  ])

  const toggleFocusPriority = useCallback(() => {
    if (!canToggleFocusPriority || !effectiveGoalId || !effectiveBucketId || !effectiveTaskId) {
      return
    }
    const isQuickListTask = isQuickListGoal(effectiveGoalId)
    const snapshotTask = goalsSnapshot
      .find((goal) => goal.id === effectiveGoalId)?.buckets
      .find((bucket) => bucket.id === effectiveBucketId)?.tasks
      .find((task) => task.id === effectiveTaskId) ?? null
    const quickListTask = isQuickListTask
      ? quickListItems.find((item) => item.id === effectiveTaskId) ?? null
      : null
    const wasCompleted = isQuickListTask
      ? (quickListTask?.completed ?? false)
      : (snapshotTask?.completed ?? false)
    const nextPriority = !focusPriority
    if (isQuickListTask) {
      // Update Quick List local state and persist to localStorage (triggers cross-tab sync)
      setQuickListItems((current) => {
        let updatedItems = current.map((item) =>
          item.id === effectiveTaskId ? { ...item, priority: nextPriority } : item,
        )
        // Reorder: priority items first within their completion group
        const moved = updatedItems.find((item) => item.id === effectiveTaskId)
        if (moved) {
          const active = updatedItems.filter((item) => !item.completed)
          const completed = updatedItems.filter((item) => item.completed)
          if (nextPriority) {
            if (!moved.completed) {
              const without = active.filter((item) => item.id !== effectiveTaskId)
              updatedItems = [moved, ...without, ...completed]
            } else {
              const without = completed.filter((item) => item.id !== effectiveTaskId)
              updatedItems = [...active, moved, ...without]
            }
          } else {
            if (!moved.completed) {
              const prios = active.filter((item) => item.priority)
              const non = active.filter((item) => !item.priority && item.id !== effectiveTaskId)
              updatedItems = [...prios, moved, ...non, ...completed]
            } else {
              const prios = completed.filter((item) => item.priority)
              const non = completed.filter((item) => !item.priority && item.id !== effectiveTaskId)
              updatedItems = [...active, ...prios, moved, ...non]
            }
          }
        }
        writeStoredQuickList(updatedItems)
        return updatedItems
      })
    } else {
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          if (goal.id !== effectiveGoalId) {
            return goal
          }
          let goalMutated = false
          const updatedBuckets = goal.buckets.map((bucket) => {
            if (bucket.id !== effectiveBucketId) {
              return bucket
            }
            const idx = bucket.tasks.findIndex((task) => task.id === effectiveTaskId)
            if (idx === -1) {
              return bucket
            }
            goalMutated = true
            mutated = true
            let updatedTasks = bucket.tasks.map((task, index) =>
              index === idx ? { ...task, priority: nextPriority } : task,
            )
            const moved = updatedTasks.find((task) => task.id === effectiveTaskId)!
            const active = updatedTasks.filter((task) => !task.completed)
            const completed = updatedTasks.filter((task) => task.completed)
            if (nextPriority) {
              if (!moved.completed) {
                const without = active.filter((task) => task.id !== effectiveTaskId)
                const newActive = [moved, ...without]
                updatedTasks = [...newActive, ...completed]
              } else {
                const without = completed.filter((task) => task.id !== effectiveTaskId)
                const newCompleted = [moved, ...without]
                updatedTasks = [...active, ...newCompleted]
              }
            } else {
              if (!moved.completed) {
                const prios = active.filter((task) => task.priority)
                const non = active.filter((task) => !task.priority && task.id !== effectiveTaskId)
                const newActive = [...prios, moved, ...non]
                updatedTasks = [...newActive, ...completed]
              } else {
                const prios = completed.filter((task) => task.priority)
                const non = completed.filter((task) => !task.priority && task.id !== effectiveTaskId)
                const newCompleted = [...prios, moved, ...non]
                updatedTasks = [...active, ...newCompleted]
              }
            }
            return { ...bucket, tasks: updatedTasks }
          })
          return goalMutated ? { ...goal, buckets: updatedBuckets } : goal
        })
        if (mutated) {
          publishGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    }
    setFocusSource((current) => {
      if (!current || current.taskId !== effectiveTaskId) {
        return current
      }
      return {
        ...current,
        priority: nextPriority,
      }
    })
    setTaskPriorityAndResort(effectiveTaskId, effectiveBucketId, wasCompleted, nextPriority).catch((error) => {
      logWarn('Failed to update focus task priority', error)
    })
  }, [
    canToggleFocusPriority,
    effectiveGoalId,
    effectiveBucketId,
    effectiveTaskId,
    focusPriority,
    goalsSnapshot,
    isQuickListGoal,
    quickListItems,
  ])

  const clearPriorityHoldTimer = useCallback(() => {
    if (focusPriorityHoldTimerRef.current !== null) {
      if (typeof window !== 'undefined') {
        window.clearTimeout(focusPriorityHoldTimerRef.current)
      }
      focusPriorityHoldTimerRef.current = null
    }
  }, [])

  const handleDifficultyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (!canCycleFocusDifficulty) {
        return
      }
      focusPriorityHoldTriggeredRef.current = false
      clearPriorityHoldTimer()
      if (canToggleFocusPriority && typeof window !== 'undefined') {
        try {
          focusPriorityHoldTimerRef.current = window.setTimeout(() => {
            focusPriorityHoldTriggeredRef.current = true
            focusPriorityHoldTimerRef.current = null
            toggleFocusPriority()
          }, PRIORITY_HOLD_MS)
        } catch (error) {
          focusPriorityHoldTimerRef.current = null
        }
      }
    },
    [canCycleFocusDifficulty, canToggleFocusPriority, clearPriorityHoldTimer, toggleFocusPriority],
  )

  const handleDifficultyPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      const wasTriggered = focusPriorityHoldTriggeredRef.current
      clearPriorityHoldTimer()
      if (wasTriggered) {
        focusPriorityHoldTriggeredRef.current = false
        return
      }
      focusPriorityHoldTriggeredRef.current = false
      cycleFocusDifficulty()
    },
    [clearPriorityHoldTimer, cycleFocusDifficulty],
  )

  const handleDifficultyPointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      clearPriorityHoldTimer()
      focusPriorityHoldTriggeredRef.current = false
    },
    [clearPriorityHoldTimer],
  )

  const handleDifficultyPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      clearPriorityHoldTimer()
      focusPriorityHoldTriggeredRef.current = false
    },
    [clearPriorityHoldTimer],
  )

  const handleDifficultyKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        cycleFocusDifficulty()
      }
    },
    [cycleFocusDifficulty],
  )

  useEffect(() => {
    return () => {
      clearPriorityHoldTimer()
      focusPriorityHoldTriggeredRef.current = false
    }
  }, [clearPriorityHoldTimer])

  const prepareFocusCheckAnimation = useCallback((marker?: HTMLElement | null) => {
    const host = marker ?? focusCompleteButtonRef.current
    if (!host) {
      return
    }
    const path = host.querySelector('.goal-task-check path') as SVGPathElement | null
    if (!path) {
      return
    }
    try {
      const length = path.getTotalLength()
      if (Number.isFinite(length) && length > 0) {
        const dash = `${length}`
        path.style.removeProperty('stroke-dasharray')
        path.style.removeProperty('stroke-dashoffset')
        path.style.setProperty('--goal-check-length', dash)
      }
    } catch {
      // ignore measurement errors; fallback styles remain
    }
  }, [])

  useEffect(() => {
    prepareFocusCheckAnimation()
  }, [prepareFocusCheckAnimation, activeFocusCandidate?.taskId, focusSource?.taskId, normalizedCurrentTask])

  const handleClearFocus = useCallback(() => {
    setCurrentTaskName('')
    setFocusSource(null)
    setCustomTaskDraft('')
    setIsSelectorOpen(false)
    selectorButtonRef.current?.focus()
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
    activeSessionEntryIdRef.current = null
  }, [])

  const handleCompleteFocus = async (
    event?: ReactPointerEvent<HTMLButtonElement> | ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!canCompleteFocus) {
      return
    }
    const marker = event?.currentTarget
    if (marker) {
      prepareFocusCheckAnimation(marker)
    } else {
      prepareFocusCheckAnimation()
    }
    const taskId = focusSource?.taskId ?? activeFocusCandidate?.taskId ?? null
    const bucketId = focusSource?.bucketId ?? activeFocusCandidate?.bucketId ?? null
    const goalId = focusSource?.goalId ?? activeFocusCandidate?.goalId ?? null
    const entryGoalName = focusSource?.goalName ?? activeFocusCandidate?.goalName ?? null
    const entryBucketName = focusSource?.bucketName ?? activeFocusCandidate?.bucketName ?? null
    const isLifeRoutineFocus =
      goalId === LIFE_ROUTINES_GOAL_ID && bucketId !== null && lifeRoutineBucketIds.has(bucketId)
    const isQuickListFocusTarget = isQuickListGoal(goalId)

    if (!taskId || !bucketId || !goalId) {
      return
    }
    if (isCompletingFocus) {
      return
    }
    if (focusCompletionTimeoutRef.current !== null) {
      window.clearTimeout(focusCompletionTimeoutRef.current)
      focusCompletionTimeoutRef.current = null
    }
    setIsCompletingFocus(true)

    const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
    const currentElapsed = isRunning && sessionStart !== null ? Date.now() - sessionStart : elapsed
    const delta = Math.max(0, currentElapsed - lastCommittedElapsedRef.current)
    if (delta > 0) {
      const sessionMeta = sessionMetadataRef.current
      registerNewHistoryEntry(delta, entryName, {
        goalId: sessionMeta.goalId ?? goalId,
        bucketId: sessionMeta.bucketId ?? bucketId,
        taskId: sessionMeta.taskId ?? taskId,
        sessionKey: currentSessionKeyRef.current,
        goalName: sessionMeta.goalName ?? entryGoalName,
        bucketName: sessionMeta.bucketName ?? entryBucketName,
        repeatingRuleId: sessionMeta.repeatingRuleId,
        repeatingOccurrenceDate: sessionMeta.repeatingOccurrenceDate,
        repeatingOriginalTime: sessionMeta.repeatingOriginalTime,
      })
    }

    setIsRunning(false)
    setElapsed(0)
    setSessionStart(null)
    lastTickRef.current = null
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
    activeSessionEntryIdRef.current = null
    lastCommittedElapsedRef.current = 0
    sessionMetadataRef.current = createEmptySessionMetadata(safeTaskName)
    resetStopwatchDisplay()

    if (isQuickListFocusTarget) {
      const updated = quickListItems.map((item) =>
        item.id === taskId ? { ...item, completed: true, updatedAt: new Date().toISOString() } : item,
      )
      const active = updated.filter((item) => !item.completed)
      const completedItems = updated.filter((item) => item.completed)
      const normalized = [...active, ...completedItems].map((item, index) => ({ ...item, sortIndex: index }))
      const stored = writeStoredQuickList(normalized)
      setQuickListItems(stored)
    } else if (!isLifeRoutineFocus) {
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          if (goal.id !== goalId) {
            return goal
          }
          const updatedBuckets = goal.buckets.map((bucket) => {
            if (bucket.id !== bucketId) {
              return bucket
            }
            const updatedTasks = bucket.tasks.map((task) => {
              if (task.id !== taskId) {
                return task
              }
              mutated = true
              return { ...task, completed: true }
            })
            if (!mutated) {
              return { ...bucket, tasks: updatedTasks }
            }
            const activeTasks = updatedTasks.filter((task) => !task.completed)
            const completedTasks = updatedTasks.filter((task) => task.completed)
            return { ...bucket, tasks: [...activeTasks, ...completedTasks] }
          })
          return { ...goal, buckets: updatedBuckets }
        })
        if (mutated) {
          publishGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    }

    if (!isLifeRoutineFocus) {
      try {
        await setTaskCompletedAndResort(taskId, bucketId, true)
      } catch (error) {
        logWarn('Failed to mark task complete from Focus', error)
      } finally {
        if (isQuickListFocusTarget) {
          refreshQuickListFromSupabase('focus-complete')
        }
      }
    }

    const timeoutId = window.setTimeout(() => {
      setIsCompletingFocus(false)
      handleClearFocus()
      focusCompletionTimeoutRef.current = null
    }, FOCUS_COMPLETION_RESET_DELAY_MS)
    focusCompletionTimeoutRef.current = timeoutId
  }

  const handleSelectTask = (taskName: string, source: FocusSource | null) => {
    const trimmed = taskName.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
    let sanitizedSource: FocusSource | null = null
    if (source && source.goalName && source.bucketName) {
      const sanitizedNotes = typeof source.notes === 'string' ? source.notes : ''
      const sanitizedSubtasks = Array.isArray(source.subtasks)
        ? sanitizeNotebookSubtasks(source.subtasks)
        : []
      sanitizedSource = {
        goalId: source.goalId,
        bucketId: source.bucketId,
        goalName: source.goalName.trim().slice(0, MAX_TASK_STORAGE_LENGTH),
        bucketName: source.bucketName.trim().slice(0, MAX_TASK_STORAGE_LENGTH),
        taskId: source.taskId ?? null,
        taskDifficulty: source.taskDifficulty ?? null,
        priority: source.priority ?? null,
        notes: sanitizedNotes,
        subtasks: sanitizedSubtasks,
        repeatingRuleId: source.repeatingRuleId ?? null,
        repeatingOccurrenceDate: source.repeatingOccurrenceDate ?? null,
        repeatingOriginalTime: source.repeatingOriginalTime ?? null,
      }
      if (sanitizedSource.taskId) {
        const nextKey = computeNotebookKey(sanitizedSource, trimmed)
        updateNotebookForKey(nextKey, () => ({
          notes: sanitizedNotes,
          subtasks: sanitizedSubtasks,
        }))
      }
    }
    setCurrentTaskName(trimmed)
    setFocusSource(sanitizedSource)
    setCustomTaskDraft(trimmed)
    modeStateRef.current[timeMode] = {
      ...modeStateRef.current[timeMode],
      taskName: trimmed,
      customTaskDraft: trimmed,
      source: sanitizedSource,
    }
    setIsSelectorOpen(false)
    selectorButtonRef.current?.focus()
  }

  const handleCustomSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = customTaskDraft.trim().slice(0, MAX_TASK_STORAGE_LENGTH)
    setCurrentTaskName(trimmed)
    setFocusSource(null)
    setCustomTaskDraft(trimmed)
    modeStateRef.current[timeMode] = {
      ...modeStateRef.current[timeMode],
      taskName: trimmed,
      customTaskDraft: trimmed,
      source: null,
    }
    setIsSelectorOpen(false)
    selectorButtonRef.current?.focus()
  }

  const handleCustomDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value ?? ''
    setCustomTaskDraft(raw.slice(0, MAX_TASK_STORAGE_LENGTH))
  }

  // Create a placeholder history entry when starting a fresh session
  // This saves to DB immediately with 1-min duration; updated when session ends
  const createPlaceholderSessionEntry = useCallback(
    (metadata: SessionMetadata, startTime: number) => {
      const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
      const { goalId, bucketId, taskId, goalName, bucketName, repeatingRuleId, repeatingOriginalTime } = metadata

      let entryColor: string | null = null
      if (goalId === LIFE_ROUTINES_GOAL_ID && bucketId) {
        entryColor = lifeRoutineColorByBucket.get(bucketId) ?? null
      }
      if (!entryColor && goalId) {
        entryColor = goalGradientById.get(goalId) ?? null
      }
      if (!entryColor) {
        entryColor = NEUTRAL_ENTRY_GRADIENT
      }

      const entryId = makeHistoryId()
      const entry: HistoryEntry = {
        id: entryId,
        taskName: entryName,
        elapsed: SESSION_PLACEHOLDER_DURATION_MS,
        startedAt: startTime,
        endedAt: startTime + SESSION_PLACEHOLDER_DURATION_MS,
        goalName: goalName ?? null,
        bucketName: bucketName ?? null,
        goalId: goalId ?? null,
        bucketId: bucketId ?? null,
        taskId: taskId ?? null,
        goalSurface: NEUTRAL_SURFACE,
        bucketSurface: NEUTRAL_SURFACE,
        entryColor,
        notes: '',
        subtasks: [],
        repeatingSessionId: repeatingRuleId ?? null,
        originalTime:
          repeatingOriginalTime && Number.isFinite(repeatingOriginalTime)
            ? repeatingOriginalTime
            : null,
        timezone: getCurrentTimezone(),
      }

      // Save the entry ID so we can update it later
      activeSessionEntryIdRef.current = entryId

      applyLocalHistoryChange((current) => {
        const next = [entry, ...current]
        return next.length > HISTORY_LIMIT ? next.slice(0, HISTORY_LIMIT) : next
      })

      return entryId
    },
    [applyLocalHistoryChange, goalGradientById, lifeRoutineColorByBucket, normalizedCurrentTask],
  )

  const handleStartStop = () => {
    if (isRunning) {
      const now = Date.now()
      const currentElapsed = sessionStart !== null ? now - sessionStart : 0
      const delta = Math.max(0, currentElapsed - lastCommittedElapsedRef.current)

      if (delta > 0) {
        const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
        const sessionMeta = sessionMetadataRef.current
        // Capture metadata to restore it after registration (which wipes it)
        const preservedMeta = { ...sessionMeta }

        registerNewHistoryEntry(delta, entryName, {
          goalId: sessionMeta.goalId,
          bucketId: sessionMeta.bucketId,
          taskId: sessionMeta.taskId,
          sessionKey: currentSessionKeyRef.current,
          goalName: sessionMeta.goalName,
          bucketName: sessionMeta.bucketName,
          repeatingRuleId: sessionMeta.repeatingRuleId,
          repeatingOccurrenceDate: sessionMeta.repeatingOccurrenceDate,
          repeatingOriginalTime: sessionMeta.repeatingOriginalTime,
          startedAt: now - delta,
        })

        // Restore metadata and clear lock to allow resuming/logging same task
        sessionMetadataRef.current = preservedMeta
        lastLoggedSessionKeyRef.current = null
        // Clear the active entry ID so resume creates a new placeholder
        activeSessionEntryIdRef.current = null
      }

      setIsRunning(false)
      setElapsed(currentElapsed)
      setSessionStart(null)
      lastCommittedElapsedRef.current = currentElapsed
      // Do not clear session metadata or keys so we can resume
    } else {
      pauseBackgroundModes()
      const now = Date.now()
      // Resume from current elapsed
      setSessionStart(now - elapsed)
      setIsRunning(true)
      lastTickRef.current = null
      
      // Create placeholder entry for this run segment (fresh start or resume)
      // Each Start→Pause cycle creates its own session entry
      const metadata = elapsed === 0 ? deriveSessionMetadata() : sessionMetadataRef.current
      if (elapsed === 0) {
        lastCommittedElapsedRef.current = 0
        sessionMetadataRef.current = metadata
        currentSessionKeyRef.current = metadata.sessionKey
        lastLoggedSessionKeyRef.current = null
      }
      // Create placeholder entry in DB immediately (1-min duration, will be updated when session ends)
      createPlaceholderSessionEntry(metadata, now)
    }
  }

  const handleEndSession = () => {
    if (isRunning) {
      pauseAndLogCurrentSession()
    } else {
      setIsRunning(false)
      setSessionStart(null)
    }

    // Hard reset stopwatch visuals/state
    setSessionStart(null)
    lastTickRef.current = null
    setElapsed(0)
    lastCommittedElapsedRef.current = 0
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
    activeSessionEntryIdRef.current = null // Clear the active entry ID on session end
    sessionMetadataRef.current = createEmptySessionMetadata(safeTaskName)
    resetStopwatchDisplay()
  }

  const handleToggleTimeVisibility = useCallback(() => {
    setIsTimeHidden((current) => !current)
  }, [])

  const registerNewHistoryEntry = useCallback(
    (
      elapsedMs: number,
      taskName: string,
      context?: {
        goalId?: string | null
        bucketId?: string | null
        taskId?: string | null
        sessionKey?: string | null
        goalName?: string | null
        bucketName?: string | null
        repeatingRuleId?: string | null
        repeatingOccurrenceDate?: string | null
        repeatingOriginalTime?: number | null
        startedAt?: number
      },
    ) => {
      const now = Date.now()
      const startedAt = context?.startedAt ?? sessionStart ?? now - elapsedMs
      const sessionMeta = sessionMetadataRef.current
      const contextGoalId =
        context?.goalId !== undefined ? context.goalId : sessionMeta.goalId
      const contextBucketId =
        context?.bucketId !== undefined ? context.bucketId : sessionMeta.bucketId
      const contextTaskId =
        context?.taskId !== undefined ? context.taskId : sessionMeta.taskId
      const sessionKeyExplicit =
        context?.sessionKey !== undefined ? context.sessionKey : sessionMeta.sessionKey
      const contextRepeatingRuleId =
        context?.repeatingRuleId !== undefined ? context.repeatingRuleId : sessionMeta.repeatingRuleId
      const contextRepeatingOccurrenceDate =
        context?.repeatingOccurrenceDate !== undefined
          ? context.repeatingOccurrenceDate
          : sessionMeta.repeatingOccurrenceDate
      const contextRepeatingOriginalTime =
        context?.repeatingOriginalTime !== undefined
          ? context.repeatingOriginalTime
          : sessionMeta.repeatingOriginalTime
      let sessionKey: string | null =
        sessionKeyExplicit !== undefined && sessionKeyExplicit !== null
          ? sessionKeyExplicit
          : sessionMeta.sessionKey
      if (!sessionKey) {
        sessionKey = makeSessionInstanceKey(contextGoalId, contextBucketId, contextTaskId)
      }
      if (sessionKey) {
        if (lastLoggedSessionKeyRef.current === sessionKey) {
          return
        }
        lastLoggedSessionKeyRef.current = sessionKey
      }

      const goalName =
        context?.goalName !== undefined ? context.goalName : sessionMeta.goalName
      const bucketName =
        context?.bucketName !== undefined ? context.bucketName : sessionMeta.bucketName
      const derivedOccurrenceDate =
        contextRepeatingOccurrenceDate ??
        (typeof contextRepeatingOriginalTime === 'number' && Number.isFinite(contextRepeatingOriginalTime)
          ? formatLocalYmd(contextRepeatingOriginalTime)
          : null)

      let entryColor: string | null = null
      if (contextGoalId === LIFE_ROUTINES_GOAL_ID && contextBucketId) {
        entryColor = lifeRoutineColorByBucket.get(contextBucketId) ?? null
      }
      if (!entryColor && contextGoalId) {
        entryColor = goalGradientById.get(contextGoalId) ?? null
      }
      if (!entryColor) {
        entryColor = NEUTRAL_ENTRY_GRADIENT
      }

      // If we have an active session entry, update it instead of creating a new one
      const activeEntryId = activeSessionEntryIdRef.current
      if (activeEntryId) {
        applyLocalHistoryChange((current) => {
          const idx = current.findIndex((e) => e.id === activeEntryId)
          if (idx === -1) {
            // Entry not found, create new one instead
            const entry: HistoryEntry = {
              id: makeHistoryId(),
              taskName,
              elapsed: elapsedMs,
              startedAt,
              endedAt: now,
              goalName: goalName ?? null,
              bucketName: bucketName ?? null,
              goalId: contextGoalId ?? null,
              bucketId: contextBucketId ?? null,
              taskId: contextTaskId ?? null,
              goalSurface: NEUTRAL_SURFACE,
              bucketSurface: NEUTRAL_SURFACE,
              entryColor,
              notes: '',
              subtasks: [],
              repeatingSessionId: contextRepeatingRuleId ?? null,
              originalTime:
                contextRepeatingOriginalTime && Number.isFinite(contextRepeatingOriginalTime)
                  ? contextRepeatingOriginalTime
                  : null,
              timezone: getCurrentTimezone(),
            }
            const next = [entry, ...current]
            return next.length > HISTORY_LIMIT ? next.slice(0, HISTORY_LIMIT) : next
          }
          // Update the existing entry with real duration and end time
          const existingEntry = current[idx]
          const updated: HistoryEntry = {
            ...existingEntry,
            taskName,
            elapsed: elapsedMs,
            startedAt,
            endedAt: now,
            goalName: goalName ?? null,
            bucketName: bucketName ?? null,
            goalId: contextGoalId ?? null,
            bucketId: contextBucketId ?? null,
            taskId: contextTaskId ?? null,
            entryColor,
            repeatingSessionId: contextRepeatingRuleId ?? null,
            originalTime:
              contextRepeatingOriginalTime && Number.isFinite(contextRepeatingOriginalTime)
                ? contextRepeatingOriginalTime
                : null,
          }
          const next = [...current]
          next[idx] = updated
          return next
        })

        if (contextRepeatingRuleId && derivedOccurrenceDate) {
          void upsertRepeatingException({
            routineId: contextRepeatingRuleId,
            occurrenceDate: derivedOccurrenceDate,
            action: 'rescheduled',
            newStartedAt: startedAt,
            newEndedAt: now,
            notes: null,
          }).catch((error) => logWarn('[Focus] Failed to upsert repeating exception', error))
        }

        if (context?.sessionKey !== undefined || sessionMeta.sessionKey !== null) {
          const nextLabel = taskName.length > 0 ? taskName : sessionMeta.taskLabel
          sessionMetadataRef.current = createEmptySessionMetadata(nextLabel)
        }
        return
      }
      // No active entry, create a new one (fallback for edge cases)
      const entry: HistoryEntry = {
        id: makeHistoryId(),
        taskName,
        elapsed: elapsedMs,
        startedAt,
        endedAt: now,
        goalName: goalName ?? null,
        bucketName: bucketName ?? null,
        goalId: contextGoalId ?? null,
        bucketId: contextBucketId ?? null,
        taskId: contextTaskId ?? null,
        goalSurface: NEUTRAL_SURFACE,
        bucketSurface: NEUTRAL_SURFACE,
        entryColor,
        notes: '',
        subtasks: [],
        repeatingSessionId: contextRepeatingRuleId ?? null,
        originalTime:
          contextRepeatingOriginalTime && Number.isFinite(contextRepeatingOriginalTime)
            ? contextRepeatingOriginalTime
            : null,
        timezone: getCurrentTimezone(),
      }

      applyLocalHistoryChange((current) => {
        const next = [entry, ...current]
        return next.length > HISTORY_LIMIT ? next.slice(0, HISTORY_LIMIT) : next
      })

      if (entry.repeatingSessionId && derivedOccurrenceDate) {
        void upsertRepeatingException({
          routineId: entry.repeatingSessionId,
          occurrenceDate: derivedOccurrenceDate,
          action: 'rescheduled',
          newStartedAt: entry.startedAt,
          newEndedAt: entry.endedAt,
          notes: null,
        }).catch((error) => logWarn('[Focus] Failed to upsert repeating exception', error))
      }

      if (context?.sessionKey !== undefined || sessionMeta.sessionKey !== null) {
        const nextLabel = taskName.length > 0 ? taskName : sessionMeta.taskLabel
        sessionMetadataRef.current = createEmptySessionMetadata(nextLabel)
      }
    },
    [applyLocalHistoryChange, goalGradientById, lifeRoutineColorByBucket, sessionStart],
  )

  const handleOpenSnapback = useCallback(() => {
    if (isRunning && sessionStart !== null) {
      setElapsed(Date.now() - sessionStart)
    }
    setIsRunning(false)
    setSnapbackDurationMin(5)
    setSnapbackDurationMode('preset')
    setSnapbackReason('insta')
    setSnapbackReasonMode('preset')
    setSnapbackNextAction('resume')
    setSnapbackNote('')
    setSnapbackCustomReason('')
    setSnapbackCustomDuration('')
    setIsSnapbackOpen(true)
  }, [isRunning, sessionStart])

  const handleCloseSnapback = useCallback(() => {
    setIsSnapbackOpen(false)
    setSnapbackNote('')
  }, [])

  const handleSubmitSnapback = useCallback(() => {
    const reasonMeta = SNAPBACK_REASONS.find((option) => option.id === snapbackReason)
    const actionMeta = SNAPBACK_ACTIONS.find((option) => option.id === snapbackNextAction)
    const typed = snapbackCustomReason.trim()
    const reasonLabel = snapbackReasonMode === 'custom' && typed.length > 0 ? typed : (reasonMeta?.label ?? 'Snapback')
    const actionLabel = actionMeta?.label ?? 'Decide next'
    const durationLabel = `${Math.max(1, snapbackDurationMin)}m`
    const now = Date.now()
    const snapDurationMs = Math.max(60 * 1000, Math.round(Math.max(1, snapbackDurationMin) * 60 * 1000))

  if (elapsed > 0) {
    const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'Focus Session'
    const sessionMeta = sessionMetadataRef.current
    const fallbackContext = focusContextRef.current
    const sourceMeta =
      sessionMeta.goalId !== null || sessionMeta.bucketId !== null || sessionMeta.taskId !== null
        ? sessionMeta
        : {
            goalId: fallbackContext.goalId,
            bucketId: fallbackContext.bucketId,
            taskId: fallbackContext.taskId,
            goalName: fallbackContext.goalName,
            bucketName: fallbackContext.bucketName,
            sessionKey: sessionMeta.sessionKey,
            taskLabel: sessionMeta.taskLabel,
            repeatingRuleId: fallbackContext.repeatingRuleId,
            repeatingOccurrenceDate: fallbackContext.repeatingOccurrenceDate,
            repeatingOriginalTime: fallbackContext.repeatingOriginalTime,
          }
    // Calculate effective work time: (Total Elapsed - Snapback Duration) - Already Logged
    const effectiveTotal = Math.max(0, elapsed - snapDurationMs)
    const delta = Math.max(0, effectiveTotal - lastCommittedElapsedRef.current)
    
    if (delta > 0) {
      registerNewHistoryEntry(delta, entryName, {
        goalId: sourceMeta.goalId,
        bucketId: sourceMeta.bucketId,
        taskId: sourceMeta.taskId,
        sessionKey: currentSessionKeyRef.current,
        goalName: sourceMeta.goalName,
        bucketName: sourceMeta.bucketName,
        repeatingRuleId: sourceMeta.repeatingRuleId ?? null,
        repeatingOccurrenceDate: sourceMeta.repeatingOccurrenceDate ?? null,
        repeatingOriginalTime: sourceMeta.repeatingOriginalTime ?? null,
        startedAt: now - delta,
      })
    }
    setElapsed(0)
    setSessionStart(null)
    lastTickRef.current = null
    lastCommittedElapsedRef.current = 0
  } else {
    setSessionStart(null)
  }

  currentSessionKeyRef.current = null
  lastLoggedSessionKeyRef.current = null
  activeSessionEntryIdRef.current = null
  sessionMetadataRef.current = createEmptySessionMetadata(safeTaskName)

    const labelParts = [durationLabel, reasonLabel]
    const markerTaskName = `Snapback • ${labelParts.join(' – ')}`.slice(0, MAX_TASK_STORAGE_LENGTH)
    const context = focusContextRef.current
    const markerEntry: HistoryEntry = {
      id: makeHistoryId(),
      taskName: markerTaskName,
      elapsed: snapDurationMs,
      startedAt: now - snapDurationMs,
      endedAt: now,
      goalName: context.goalName,
      bucketName: actionLabel,
      goalId: context.goalId,
      bucketId: context.bucketId,
      taskId: context.taskId,
      goalSurface: NEUTRAL_SURFACE,
      bucketSurface: NEUTRAL_SURFACE,
      notes: '',
      subtasks: [],
      timezone: getCurrentTimezone(),
    }

    applyLocalHistoryChange((current) => {
      const next = [markerEntry, ...current]
      return next.length > HISTORY_LIMIT ? next.slice(0, HISTORY_LIMIT) : next
    })

    // Persist new custom reason as a trigger for the overview
    try {
      if (snapbackReasonMode === 'custom') {
        const label = reasonLabel.trim()
        if (label.length > 0 && typeof window !== 'undefined') {
          const raw = window.localStorage.getItem(SNAPBACK_CUSTOM_TRIGGERS_KEY)
          const parsed = raw ? JSON.parse(raw) : []
          const list = Array.isArray(parsed) ? parsed : []
          const exists = list.some((it: any) => typeof it?.label === 'string' && it.label.trim().toLowerCase() === label.toLowerCase())
          if (!exists) {
            list.push({ id: `snap-custom-${Date.now()}`, label })
            window.localStorage.setItem(SNAPBACK_CUSTOM_TRIGGERS_KEY, JSON.stringify(list))
          }
        }
      }
    } catch {}

    
    setIsSnapbackOpen(false)
    setSnapbackNote('')
    setSnapbackCustomReason('')

    if (snapbackNextAction === 'resume') {
      const resumeStart = Date.now()
      setSessionStart(resumeStart)
      setIsRunning(true)
      const resumeMetadata = deriveSessionMetadata()
      sessionMetadataRef.current = resumeMetadata
      currentSessionKeyRef.current = resumeMetadata.sessionKey
      lastLoggedSessionKeyRef.current = null
    } else {
      setIsRunning(false)
      if (snapbackNextAction === 'switch') {
        setIsSelectorOpen(true)
      }
    }
  }, [
    applyLocalHistoryChange,
    deriveSessionMetadata,
    elapsed,
    normalizedCurrentTask,
    registerNewHistoryEntry,
    snapbackDurationMin,
    snapbackNextAction,
    snapbackCustomReason,
    snapbackReasonMode,
    snapbackReason,
  ])

  const pauseBackgroundModes = useCallback(() => {
    const now = Date.now()
    Object.entries(modeStateRef.current).forEach(([key, snapshot]) => {
      const modeKey = key as TimeMode
      if (modeKey !== timeMode && snapshot.isRunning && snapshot.sessionStart !== null) {
        const totalElapsed = now - snapshot.sessionStart
        const delta = Math.max(0, totalElapsed - snapshot.lastCommittedElapsed)

        if (delta > 0) {
          const meta = snapshot.sessionMeta
          const entryName = snapshot.taskName.trim().length > 0 ? snapshot.taskName.trim() : 'Focus Session'
          registerNewHistoryEntry(delta, entryName, {
            goalId: meta.goalId,
            bucketId: meta.bucketId,
            taskId: meta.taskId,
            sessionKey: snapshot.currentSessionKey,
            goalName: meta.goalName,
            bucketName: meta.bucketName,
            repeatingRuleId: meta.repeatingRuleId,
            repeatingOccurrenceDate: meta.repeatingOccurrenceDate,
            repeatingOriginalTime: meta.repeatingOriginalTime,
            startedAt: now - delta,
          })
        }

        modeStateRef.current[modeKey] = {
          ...snapshot,
          isRunning: false,
          sessionStart: null,
          elapsed: totalElapsed,
          lastCommittedElapsed: totalElapsed,
          lastLoggedSessionKey: null,
        }
      }
    })
  }, [registerNewHistoryEntry, timeMode])

  const pauseAndLogCurrentSession = useCallback(() => {
    const totalElapsed = computeCurrentElapsed()
    if (isRunning && totalElapsed > 0) {
      const delta = Math.max(0, totalElapsed - lastCommittedElapsedRef.current)
      if (delta > 0) {
        const meta = sessionMetadataRef.current
        const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'Focus Session'
        registerNewHistoryEntry(delta, entryName, {
          goalId: meta.goalId,
          bucketId: meta.bucketId,
          taskId: meta.taskId,
          sessionKey: currentSessionKeyRef.current,
          goalName: meta.goalName,
          bucketName: meta.bucketName,
          repeatingRuleId: meta.repeatingRuleId,
          repeatingOccurrenceDate: meta.repeatingOccurrenceDate,
          repeatingOriginalTime: meta.repeatingOriginalTime,
          startedAt: Date.now() - delta,
        })
      }
    }
    const snappedElapsed = computeCurrentElapsed()
    setIsRunning(false)
    setElapsed(snappedElapsed)
    setSessionStart(null)
    lastTickRef.current = null
    currentSessionKeyRef.current = null
    lastLoggedSessionKeyRef.current = null
    activeSessionEntryIdRef.current = null
    lastCommittedElapsedRef.current = snappedElapsed
  }, [computeCurrentElapsed, isRunning, normalizedCurrentTask, registerNewHistoryEntry])

  const saveCurrentModeSnapshot = useCallback(
    (mode: TimeMode) => {
      const totalElapsed = computeCurrentElapsed()
      const currentIsRunning = isRunning
      const currentSessionStart = sessionStart
      
      modeStateRef.current[mode] = {
        ...modeStateRef.current[mode],
        taskName: currentTaskName,
        customTaskDraft,
        source: focusSource,
        elapsed: totalElapsed,
        sessionStart: currentSessionStart,
        isRunning: currentIsRunning,
        sessionMeta: { ...sessionMetadataRef.current },
        currentSessionKey: currentSessionKeyRef.current,
        lastLoggedSessionKey: lastLoggedSessionKeyRef.current,
        lastTick: lastTickRef.current,
        lastCommittedElapsed: lastCommittedElapsedRef.current,
      }
    },
    [computeCurrentElapsed, currentTaskName, customTaskDraft, focusSource, isRunning, sessionStart],
  )

  const restoreModeSnapshot = useCallback(
    (mode: TimeMode) => {
      const snapshot = modeStateRef.current[mode]
      setCurrentTaskName(snapshot.taskName)
      setCustomTaskDraft(snapshot.customTaskDraft)
      setFocusSource(snapshot.source)
      setElapsed(snapshot.elapsed)
      setSessionStart(snapshot.sessionStart)
      setIsRunning(Boolean(snapshot.isRunning && snapshot.sessionStart !== null))
      sessionMetadataRef.current = { ...snapshot.sessionMeta }
      currentSessionKeyRef.current = snapshot.currentSessionKey
      lastLoggedSessionKeyRef.current = snapshot.lastLoggedSessionKey
      lastTickRef.current = snapshot.lastTick
      lastCommittedElapsedRef.current = snapshot.lastCommittedElapsed
      updateTimeDisplay(snapshot.elapsed)
    },
    [updateTimeDisplay],
  )

  const handleSwitchTimeMode = useCallback(
    (mode: TimeMode) => {
      if (mode === timeMode) return
      saveCurrentModeSnapshot(timeMode)
      restoreModeSnapshot(mode)
      setTimeMode(mode)
    },
    [restoreModeSnapshot, saveCurrentModeSnapshot, timeMode],
  )

  useEffect(() => {
    if (!isSnapbackOpen) {
      return
    }
    const timerId = window.setTimeout(() => {
      snapbackDialogRef.current?.focus()
    }, 0)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleCloseSnapback()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(timerId)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleCloseSnapback, isSnapbackOpen])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleFocusBroadcast = (event: Event) => {
      const custom = event as FocusBroadcastEvent
      const detail = custom.detail as FocusBroadcastDetail | undefined
      if (!detail) {
        return
      }
      const previousContext = focusContextRef.current
      const taskName = detail.taskName?.trim().slice(0, MAX_TASK_STORAGE_LENGTH) ?? ''
      const goalName = detail.goalName?.trim().slice(0, MAX_TASK_STORAGE_LENGTH) ?? ''
      const bucketName = detail.bucketName?.trim().slice(0, MAX_TASK_STORAGE_LENGTH) ?? ''
      const detailNotes = typeof detail.notes === 'string' ? detail.notes : ''
      const detailSubtasks = sanitizeNotebookSubtasks(detail.subtasks)
      const nextSource: FocusSource = {
        goalId: detail.goalId,
        bucketId: detail.bucketId,
        goalName,
        bucketName,
        taskId: detail.taskId ?? null,
        taskDifficulty: detail.taskDifficulty ?? null,
        priority: detail.priority ?? null,
        notes: detailNotes,
        subtasks: detailSubtasks,
        repeatingRuleId: detail.repeatingRuleId ?? null,
        repeatingOccurrenceDate: detail.repeatingOccurrenceDate ?? null,
        repeatingOriginalTime: detail.repeatingOriginalTime ?? null,
      }
      if (nextSource.taskId) {
        const nextKey = computeNotebookKey(nextSource, taskName)
        updateNotebookForKey(nextKey, () => ({
          notes: detailNotes,
          subtasks: detailSubtasks,
        }))
      }

      setCurrentTaskName(taskName)
      setFocusSource(nextSource)
      setCustomTaskDraft(taskName)
      setIsSelectorOpen(false)

      // Also update the current mode's snapshot in modeStateRef
      modeStateRef.current[activeTimeModeRef.current] = {
        ...modeStateRef.current[activeTimeModeRef.current],
        taskName,
        customTaskDraft: taskName,
        source: nextSource,
      }

      if (detail.autoStart) {
        const now = Date.now()
        const previousSessionKey = currentSessionKeyRef.current
        const currentElapsed = isRunning && sessionStart !== null ? now - sessionStart : elapsed
        if (currentElapsed > 0) {
          const delta = Math.max(0, currentElapsed - lastCommittedElapsedRef.current)
          if (delta > 0) {
            const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
            const previousSessionMeta = sessionMetadataRef.current
            registerNewHistoryEntry(delta, entryName, {
              goalId: previousSessionMeta.goalId ?? previousContext.goalId,
              bucketId: previousSessionMeta.bucketId ?? previousContext.bucketId,
              taskId: previousSessionMeta.taskId ?? previousContext.taskId,
              sessionKey: previousSessionKey,
              goalName: previousSessionMeta.goalName ?? previousContext.goalName,
              bucketName: previousSessionMeta.bucketName ?? previousContext.bucketName,
              repeatingRuleId: previousSessionMeta.repeatingRuleId ?? previousContext.repeatingRuleId,
              repeatingOccurrenceDate:
                previousSessionMeta.repeatingOccurrenceDate ?? previousContext.repeatingOccurrenceDate,
              repeatingOriginalTime:
                previousSessionMeta.repeatingOriginalTime ?? previousContext.repeatingOriginalTime,
              startedAt: now - delta,
            })
          }
        }
        setElapsed(0)
        setSessionStart(now)
        lastTickRef.current = null
        setIsRunning(true)
        lastCommittedElapsedRef.current = 0
        const autoSessionKey = makeSessionInstanceKey(
          detail.goalId ?? null,
          detail.bucketId ?? null,
          detail.taskId ?? null,
        )
        const autoTaskLabel =
          taskName.length > 0 ? taskName : goalName.length > 0 ? goalName : 'New Task'
        sessionMetadataRef.current = {
          goalId: detail.goalId ?? null,
          bucketId: detail.bucketId ?? null,
          taskId: detail.taskId ?? null,
          goalName: goalName.length > 0 ? goalName : null,
          bucketName: bucketName.length > 0 ? bucketName : null,
          sessionKey: autoSessionKey,
          taskLabel: autoTaskLabel,
          repeatingRuleId: detail.repeatingRuleId ?? null,
          repeatingOccurrenceDate: detail.repeatingOccurrenceDate ?? null,
          repeatingOriginalTime: detail.repeatingOriginalTime ?? null,
        }
        currentSessionKeyRef.current = autoSessionKey
        lastLoggedSessionKeyRef.current = null
        scrollFocusToTop()
      }
    }
    window.addEventListener(FOCUS_EVENT_TYPE, handleFocusBroadcast as EventListener)
    return () => {
      window.removeEventListener(FOCUS_EVENT_TYPE, handleFocusBroadcast as EventListener)
    }
  }, [elapsed, normalizedCurrentTask, registerNewHistoryEntry, scrollFocusToTop, updateNotebookForKey, isRunning, sessionStart])

  // Listen for pause focus events from other pages (e.g., ReflectionPage)
  useEffect(() => {
    const handlePauseFocus = () => {
      if (isRunning && sessionStart !== null) {
        const now = Date.now()
        const currentElapsed = now - sessionStart
        const delta = Math.max(0, currentElapsed - lastCommittedElapsedRef.current)

        // Log the session progress to history (same as regular pause)
        if (delta > 0) {
          const entryName = normalizedCurrentTask.length > 0 ? normalizedCurrentTask : 'New Task'
          const sessionMeta = sessionMetadataRef.current
          const preservedMeta = { ...sessionMeta }

          registerNewHistoryEntry(delta, entryName, {
            goalId: sessionMeta.goalId,
            bucketId: sessionMeta.bucketId,
            taskId: sessionMeta.taskId,
            sessionKey: currentSessionKeyRef.current,
            goalName: sessionMeta.goalName,
            bucketName: sessionMeta.bucketName,
            repeatingRuleId: sessionMeta.repeatingRuleId,
            repeatingOccurrenceDate: sessionMeta.repeatingOccurrenceDate,
            repeatingOriginalTime: sessionMeta.repeatingOriginalTime,
            startedAt: now - delta,
          })

          sessionMetadataRef.current = preservedMeta
          lastLoggedSessionKeyRef.current = null
        }

        setIsRunning(false)
        setElapsed(currentElapsed)
        setSessionStart(null)
        lastCommittedElapsedRef.current = currentElapsed
      }
    }
    window.addEventListener(PAUSE_FOCUS_EVENT_TYPE, handlePauseFocus)
    return () => {
      window.removeEventListener(PAUSE_FOCUS_EVENT_TYPE, handlePauseFocus)
    }
  }, [isRunning, sessionStart, normalizedCurrentTask, registerNewHistoryEntry])

  const formattedTime = useMemo(() => formatTime(elapsed, showMilliseconds), [elapsed, showMilliseconds])
  const formattedClock = useMemo(() => formatClockTime(currentTime, use24HourTime), [currentTime, use24HourTime])
  const clockDateTime = useMemo(() => new Date(currentTime).toISOString(), [currentTime])
  const baseTimeClass = elapsed >= 3600000 ? 'time-value--long' : ''
  const charCount = formattedTime.length
  let lengthClass = ''
  if (charCount >= 15) {
    lengthClass = 'time-length-xxs'
  } else if (charCount >= 13) {
    lengthClass = 'time-length-xs'
  } else if (charCount >= 11) {
    lengthClass = 'time-length-sm'
  }

  const timeValueClassName = ['time-value', baseTimeClass, lengthClass, isTimeHidden ? 'time-value--hidden' : '']
    .filter(Boolean)
    .join(' ')
  const timeToggleLabel = isTimeHidden ? 'Show Time' : 'Hide Time'
  const timeToggleTitle = isTimeHidden ? 'Show stopwatch time' : 'Hide stopwatch time'
  const statusText = isRunning ? 'running' : elapsed > 0 ? 'paused' : 'idle'
  const primaryLabel = isRunning ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start'
  const timeModeOptions = useMemo(
    () => [
      { id: 'focus' as TimeMode, label: 'Focus' },
      { id: 'break' as TimeMode, label: 'Break' },
    ],
    [],
  )

  // Keep standard view as default; dashboard toggles on demand
  const [dashboardLayout, setDashboardLayout] = useState(false)

  const timeModeToggle = (
    <div className="time-mode-toggle" role="tablist" aria-label="Timer mode">
      {timeModeOptions.map((option) => {
        const isCurrent = timeMode === option.id
        const modeIsRunning = isCurrent ? isRunning : modeStateRef.current[option.id].isRunning
        const modeElapsed = isCurrent ? elapsed : modeStateRef.current[option.id].elapsed
        let dotClass = 'status-idle'
        if (modeIsRunning) {
          dotClass = 'status-running'
        } else if (modeElapsed > 0) {
          dotClass = 'status-paused'
        }

        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={isCurrent}
            className={classNames('time-mode-toggle__button', isCurrent && 'time-mode-toggle__button--active')}
            onClick={() => handleSwitchTimeMode(option.id)}
          >
            <span className="time-mode-toggle__text">
              <span className={`time-mode-toggle__dot ${dotClass}`} />
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )

  return (
    <div className={classNames('site-main__inner', 'taskwatch-page', dashboardLayout && 'taskwatch--dashboard')}>
      {dashboardLayout ? (
        <div className="taskwatch-header">
          <h1 className="stopwatch-heading">Taskwatch</h1>
          <button
            type="button"
            className={classNames('taskwatch-layout-toggle', dashboardLayout && 'taskwatch-layout-toggle--active')}
            aria-pressed={dashboardLayout}
            onClick={() => setDashboardLayout((v) => !v)}
            title="Toggle dashboard layout"
          >
            {dashboardLayout ? 'Standard' : 'Dashboard'}
          </button>
        </div>
      ) : (
        <>
          <div className="taskwatch-page-actions">
            <button
              type="button"
              className={classNames('taskwatch-layout-toggle', dashboardLayout && 'taskwatch-layout-toggle--active')}
              aria-pressed={dashboardLayout}
              onClick={() => setDashboardLayout((v) => !v)}
              title="Toggle dashboard layout"
            >
              {dashboardLayout ? 'Standard' : 'Dashboard'}
            </button>
          </div>
          <h1 className="stopwatch-heading">Taskwatch</h1>
        </>
      )}
      {dashboardLayout ? (
        <>
          {timeModeToggle}
          <div className="taskwatch-columns">
          <div className="taskwatch-col taskwatch-col--left">
            <div className="task-selector-container">
              <div
                className={[
                  'focus-task',
                  'goal-task-row',
                  ...focusSurfaceClasses,
                  focusDiffClass,
                  focusPriority ? 'goal-task-row--priority' : '',
                  isCompletingFocus ? 'goal-task-row--completing' : '',
                  isSelectorOpen ? 'focus-task--open' : '',
                  isDefaultTask ? 'focus-task--empty' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={focusInlineStyle}
                ref={focusTaskContainerRef}
                onClick={handleSelectorContainerClick}
              >
                <button
                  type="button"
                  className={[
                    'goal-task-marker',
                    'goal-task-marker--action',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={handleCompleteFocus}
                  onPointerDown={(event) => {
                    if (canCompleteFocus) {
                      prepareFocusCheckAnimation(event.currentTarget)
                    }
                  }}
                  onTouchStart={(event) => {
                    if (canCompleteFocus) {
                      prepareFocusCheckAnimation(event.currentTarget)
                    }
                  }}
                  aria-disabled={!canCompleteFocus}
                  aria-label="Mark focus task complete"
                  ref={focusCompleteButtonRef}
                >
                  <svg viewBox="0 0 24 24" width="24" height="24" className="goal-task-check" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="focus-task__body"
                  onClick={handleToggleSelector}
                  aria-haspopup="dialog"
                  aria-expanded={isSelectorOpen}
                  ref={selectorButtonRef}
                >
                  <div className="focus-task__content">
                    <div className="focus-task__main">
                      <span className="focus-task__label">What am I doing now?</span>
                      <span className="goal-task-text">
                        <span
                          className={[
                            'goal-task-text__inner',
                            'focus-task__name',
                            isDefaultTask ? 'focus-task__name--placeholder' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {isDefaultTask ? defaultTaskPlaceholder : safeTaskName}
                        </span>
                      </span>
                      {focusGoalName && focusBucketName ? (
                        <span className="focus-task__origin">{`${focusGoalName} → ${focusBucketName}`}</span>
                      ) : null}
                    </div>
                  </div>
                </button>
                <div className="focus-task__indicators">
                  <button
                    type="button"
                    className={focusDiffButtonClass}
                    onPointerDown={handleDifficultyPointerDown}
                    onPointerUp={handleDifficultyPointerUp}
                    onPointerLeave={handleDifficultyPointerLeave}
                    onPointerCancel={handleDifficultyPointerCancel}
                    onKeyDown={handleDifficultyKeyDown}
                    disabled={!canCycleFocusDifficulty}
                    aria-label={focusDiffButtonTitle}
                    title={focusDiffButtonTitle}
                  >
                    <span className="sr-only">{focusDiffButtonTitle}</span>
                  </button>
                  <span className={`focus-task__chevron${isSelectorOpen ? ' focus-task__chevron--open' : ''}`}>
                    <svg viewBox="0 0 20 20" fill="currentColor">
                      <path d="M5.293 7.293a1 1 0 0 1 1.414 0L10 10.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 0-1.414z" />
                    </svg>
                  </span>
                </div>
              </div>
              {isSelectorOpen ? (
                <div
                  className="task-selector-popover"
                  role="dialog"
                  aria-label="Select focus task"
                  ref={selectorPopoverRef}
                >
                  {combinedNowSuggestions.length > 0 ? (
                    <div className="task-selector__section">
                      <h2 className="task-selector__section-title">Scheduled now</h2>
                      <ul className="task-selector__list">
                        {combinedNowSuggestions.map((task) => {
                          const candidateLower = task.taskName.trim().toLocaleLowerCase()
                          const matches = focusSource
                            ? focusSource.goalId === task.goalId &&
                              focusSource.bucketId === task.bucketId &&
                              candidateLower === currentTaskLower
                            : !isDefaultTask && candidateLower === currentTaskLower
                          const diffClass =
                            task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : ''
                          const isQuickListTask = isQuickListGoal(task.goalId)
                          const rowClassName = [
                            'task-selector__task',
                            'goal-task-row',
                            diffClass,
                            'goal-task-row--priority',
                            isQuickListTask ? 'task-selector__task--quick-list' : '',
                            matches ? 'task-selector__task--active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')
                          const diffBadgeClass =
                            task.difficulty && task.difficulty !== 'none'
                              ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                  .filter(Boolean)
                                  .join(' ')
                              : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                  .join(' ')
                          return (
                            <li key={makeScheduledSuggestionKey(task)} className="task-selector__item">
                              <button
                                type="button"
                                className={rowClassName}
                                onClick={() =>
                                  handleSelectTask(task.taskName, {
                                    goalId: task.goalId,
                                    bucketId: task.bucketId,
                                    goalName: task.goalName,
                                    bucketName: task.bucketName,
                                    taskId: task.taskId,
                                    taskDifficulty: task.difficulty,
                                    priority: true,
                                    notes: task.notes,
                                    subtasks: task.subtasks,
                                    repeatingRuleId: task.repeatingRuleId,
                                    repeatingOccurrenceDate: task.repeatingOccurrenceDate,
                                    repeatingOriginalTime: task.repeatingOriginalTime,
                                  })
                                }
                              >
                                <div className="task-selector__task-main">
                                  <div className="task-selector__task-content">
                                    <span className="goal-task-text">
                                      <span className="goal-task-text__inner">{task.taskName}</span>
                                    </span>
                                    <span className="task-selector__origin task-selector__origin--dropdown">
                                      {`${task.goalName} → ${task.bucketName}`}
                                    </span>
                                  </div>
                                  <span className={diffBadgeClass} aria-hidden="true" />
                                </div>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ) : null}
                  <div className="task-selector__section">
                    <h2 className="task-selector__section-title">Custom focus</h2>
                    <form className="task-selector__custom-form" onSubmit={handleCustomSubmit}>
                      <label htmlFor="taskwatch-custom-focus" className="sr-only">
                        Custom focus task
                      </label>
                      <input
                        id="taskwatch-custom-focus"
                        type="text"
                        value={customTaskDraft}
                        onChange={handleCustomDraftChange}
                        placeholder="Type a task name"
                        className="task-selector__input"
                        maxLength={MAX_TASK_STORAGE_LENGTH}
                      />
                      <button type="submit" className="task-selector__set-button">
                        Set
                      </button>
                    </form>
                    <button
                      type="button"
                      className="task-selector__clear-button"
                      onClick={handleClearFocus}
                      disabled={isDefaultTask && !focusSource}
                    >
                      Clear focus
                    </button>
                  </div>

                  <div className="task-selector__section">
                    <h2 className="task-selector__section-title">Priority</h2>
                    {priorityTasks.length > 0 ? (
                      <ul className="task-selector__list">
                        {priorityTasks.map((task) => {
                          const candidateLower = task.taskName.trim().toLocaleLowerCase()
                          const matches = focusSource
                            ? focusSource.goalId === task.goalId &&
                              focusSource.bucketId === task.bucketId &&
                              candidateLower === currentTaskLower
                            : !isDefaultTask && candidateLower === currentTaskLower
                          const diffClass =
                            task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : ''
                          const isQuickListTask = isQuickListGoal(task.goalId)
                          const quickRowClasses = isQuickListTask ? ['task-selector__task--quick-list'] : []
                          const rowClassName = [
                            'task-selector__task',
                            'goal-task-row',
                            diffClass,
                            task.priority ? 'goal-task-row--priority' : '',
                            ...quickRowClasses,
                            matches ? 'task-selector__task--active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')
                          const diffBadgeClass =
                            task.difficulty && task.difficulty !== 'none'
                              ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                  .filter(Boolean)
                                  .join(' ')
                              : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                  .join(' ')
                          return (
                            <li key={task.taskId || task.taskName} className="task-selector__item">
                              <button
                                type="button"
                                className={rowClassName}
                                onClick={() =>
                                  handleSelectTask(task.taskName, {
                                    goalId: task.goalId,
                                    bucketId: task.bucketId,
                                    goalName: task.goalName,
                                    bucketName: task.bucketName,
                                    taskId: task.taskId,
                                    taskDifficulty: task.difficulty,
                                    priority: true,
                                    notes: task.notes,
                                    subtasks: task.subtasks,
                                    repeatingRuleId: task.repeatingRuleId,
                                    repeatingOccurrenceDate: task.repeatingOccurrenceDate,
                                    repeatingOriginalTime: task.repeatingOriginalTime,
                                  })
                                }
                              >
                                <div className="task-selector__task-main">
                                  <div className="task-selector__task-content">
                                    <span className="goal-task-text">
                                      <span className="goal-task-text__inner">{task.taskName}</span>
                                    </span>
                                    {!isQuickListTask ? (
                                      <span className="task-selector__origin task-selector__origin--dropdown">
                                        {`${task.goalName} → ${task.bucketName}`}
                                      </span>
                                    ) : (
                                      <span
                                        className="task-selector__origin task-selector__origin--dropdown task-selector__origin--placeholder"
                                        aria-hidden="true"
                                      />
                                    )}
                                  </div>
                                  <span className={diffBadgeClass} aria-hidden="true" />
                                </div>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    ) : (
                      <p className="task-selector__empty">No priority tasks.</p>
                    )}
                  </div>

                  <div className="task-selector__section">
                    <h2 className="task-selector__section-title">{LIFE_ROUTINES_NAME}</h2>
                    <button
                      type="button"
                className="task-selector__goal-toggle surface-goal surface-goal--glass"
                onClick={() => setLifeRoutinesExpanded((value) => !value)}
                aria-expanded={lifeRoutinesExpanded}
              >
                      <span className="task-selector__goal-info">
                        <span className="task-selector__goal-badge" aria-hidden="true">
                          System
                        </span>
                        <span className="task-selector__goal-name">{LIFE_ROUTINES_NAME}</span>
                      </span>
                      <span className="task-selector__chevron" aria-hidden="true">
                        {lifeRoutinesExpanded ? '−' : '+'}
                      </span>
                    </button>
                    {lifeRoutinesExpanded ? (
                      <ul className="task-selector__list">
                        {lifeRoutineTasks.map((task) => {
                          const taskLower = task.title.trim().toLocaleLowerCase()
                          const matches = focusSource
                            ? focusSource.goalId === LIFE_ROUTINES_GOAL_ID &&
                              focusSource.bucketId === task.bucketId &&
                              currentTaskLower === taskLower
                            : !isDefaultTask && currentTaskLower === taskLower
                          const rowClassName = [
                            'task-selector__task',
                            'goal-task-row',
                            'task-selector__task--life-routine',
                            matches ? 'task-selector__task--active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')
                          return (
                            <li key={task.id} className="task-selector__item">
                              <button
                                type="button"
                                className={rowClassName}
                                onClick={() =>
                                  handleSelectTask(task.title, {
                                    goalId: LIFE_ROUTINES_GOAL_ID,
                                    bucketId: task.bucketId,
                                    goalName: LIFE_ROUTINES_NAME,
                                    bucketName: task.title,
                                    taskId: task.id,
                                    taskDifficulty: 'none',
                                    priority: false,
                                    notes: '',
                                    subtasks: [],
                                    repeatingRuleId: null,
                                    repeatingOccurrenceDate: null,
                                    repeatingOriginalTime: null,
                                  })
                                }
                              >
                                <div className="task-selector__task-main">
                                  <div className="task-selector__task-content">
                                    <span className="goal-task-text">
                                      <span className="goal-task-text__inner">{task.title}</span>
                                    </span>
                                    <span className="task-selector__origin task-selector__origin--dropdown">{task.blurb}</span>
                                  </div>
                                </div>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </div>

                  {quickListActiveCandidates.length > 0 ? (
                    <div className="task-selector__section">
                      <h2 className="task-selector__section-title">{QUICK_LIST_NAME}</h2>
                      <button
                        type="button"
                        className="task-selector__goal-toggle surface-goal surface-goal--glass"
                        onClick={() => setQuickListExpanded((value) => !value)}
                        aria-expanded={quickListExpanded}
                      >
                        <span className="task-selector__goal-info">
                          <span className="task-selector__goal-badge" aria-hidden="true">
                            Quick
                          </span>
                          <span className="task-selector__goal-name">{QUICK_LIST_NAME}</span>
                        </span>
                        <span className="task-selector__chevron" aria-hidden="true">
                          {quickListExpanded ? '−' : '+'}
                        </span>
                      </button>
                      {quickListExpanded ? (
                        <ul className="task-selector__list">
                          {quickListActiveCandidates.map((task) => {
                            const candidateLower = task.taskName.trim().toLocaleLowerCase()
                            const matches = focusSource
                              ? focusSource.goalId === task.goalId &&
                                focusSource.bucketId === task.bucketId &&
                                candidateLower === currentTaskLower
                              : !isDefaultTask && candidateLower === currentTaskLower
                            const diffClass =
                              task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : ''
                          const rowClassName = [
                            'task-selector__task',
                            'goal-task-row',
                            diffClass,
                            task.priority ? 'goal-task-row--priority' : '',
                            'task-selector__task--quick-list',
                            matches ? 'task-selector__task--active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')
                          const diffBadgeClass =
                            task.difficulty && task.difficulty !== 'none'
                              ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                  .filter(Boolean)
                                  .join(' ')
                              : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                  .join(' ')
                          return (
                            <li key={`quick-${task.taskId || task.taskName}`} className="task-selector__item">
                              <button
                                  type="button"
                                  className={rowClassName}
                                  onClick={() =>
                                    handleSelectTask(task.taskName, {
                                      goalId: task.goalId,
                                      bucketId: task.bucketId,
                                      goalName: task.goalName,
                                      bucketName: task.bucketName,
                                      taskId: task.taskId,
                                      taskDifficulty: task.difficulty,
                                      priority: task.priority,
                                      notes: task.notes,
                                      subtasks: task.subtasks,
                                      repeatingRuleId: null,
                                      repeatingOccurrenceDate: null,
                                      repeatingOriginalTime: null,
                                    })
                                  }
                                >
                                  <div className="task-selector__task-main">
                                    <div className="task-selector__task-content">
                                      <span className="goal-task-text">
                                        <span className="goal-task-text__inner">{task.taskName}</span>
                                      </span>
                                      <span
                                        className="task-selector__origin task-selector__origin--dropdown task-selector__origin--placeholder"
                                        aria-hidden="true"
                                      />
                                    </div>
                                    <span className={diffBadgeClass} aria-hidden="true" />
                                  </div>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="task-selector__section">
                    <h2 className="task-selector__section-title">Goals</h2>
                    {activeGoalSnapshots.length > 0 ? (
                      <ul className="task-selector__goals">
                        {activeGoalSnapshots.map((goal) => {
                          const goalExpanded = expandedGoals.has(goal.id)
                          const goalToggleClass = 'task-selector__goal-toggle surface-goal surface-goal--glass'
                          return (
                            <li key={goal.id} className="task-selector__goal">
                              <button
                                type="button"
                                className={goalToggleClass}
                                onClick={() => toggleGoalExpansion(goal.id)}
                                aria-expanded={goalExpanded}
                              >
                                <span className="task-selector__goal-info">
                                  <span className="task-selector__goal-badge" aria-hidden="true">
                                    Goal
                                  </span>
                                  <span className="task-selector__goal-name">{goal.name}</span>
                                </span>
                                <span className="task-selector__chevron" aria-hidden="true">
                                  {goalExpanded ? '−' : '+'}
                                </span>
                              </button>
                              {goalExpanded ? (
                                <ul className="task-selector__buckets">
                                  {goal.buckets
                                    .filter((bucket) => !bucket.archived)
                                    .map((bucket) => {
                                    const bucketExpanded = expandedBuckets.has(bucket.id)
                                    const activeTasks = bucket.tasks.filter((task) => !task.completed)
                                    const completedTasks = bucket.tasks.filter((task) => task.completed)
                                    if (activeTasks.length === 0 && completedTasks.length === 0) {
                                      return null
                                    }
                                    const diffClsForTask = (diff?: FocusCandidate['difficulty']) =>
                                      diff && diff !== 'none' ? `goal-task-row--diff-${diff}` : ''

                                    return (
                                      <li key={bucket.id} className="task-selector__bucket">
                                        <button
                                          type="button"
                                          className="task-selector__bucket-toggle"
                                          onClick={() => toggleBucketExpansion(bucket.id)}
                                          aria-expanded={bucketExpanded}
                                        >
                                          <span className="task-selector__bucket-info">
                                            <span className="task-selector__bucket-badge" aria-hidden="true">
                                              Bucket
                                            </span>
                                            <span className="task-selector__bucket-name">{bucket.name}</span>
                                          </span>
                                          <span className="task-selector__chevron" aria-hidden="true">
                                            {bucketExpanded ? '−' : '+'}
                                          </span>
                                        </button>
                                        {bucketExpanded ? (
                                          <div className="task-selector__bucket-content">
                                            {activeTasks.length > 0 ? (
                                              <ul className="task-selector__tasks">
                                                {activeTasks.map((task) => {
                                                  const candidateLower = task.text.trim().toLocaleLowerCase()
                                                  const matches = focusSource
                                                    ? focusSource.goalId === goal.id &&
                                                      focusSource.bucketId === bucket.id &&
                                                      candidateLower === currentTaskLower
                                                    : !isDefaultTask && candidateLower === currentTaskLower
                                                  const diffClass = diffClsForTask(task.difficulty as any)
                                                  const taskClassName = [
                                                    'task-selector__task',
                                                    'goal-task-row',
                                                    diffClass,
                                                    task.priority ? 'goal-task-row--priority' : '',
                                                    matches ? 'task-selector__task--active' : '',
                                                  ]
                                                    .filter(Boolean)
                                                    .join(' ')
                                                  const diffBadgeClass =
                                                    task.difficulty && task.difficulty !== 'none'
                                                      ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                                          .filter(Boolean)
                                                          .join(' ')
                                                      : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                                          .join(' ')
                                                  return (
                                                    <li key={task.id}>
                                                      <button
                                                        type="button"
                                                        className={taskClassName}
                                                        onClick={() =>
                                                          handleSelectTask(task.text, {
                                                            goalId: goal.id,
                                                            bucketId: bucket.id,
                                                            goalName: goal.name,
                                                            bucketName: bucket.name,
                                                            taskId: task.id,
                                                            taskDifficulty: task.difficulty ?? 'none',
                                                            priority: task.priority ?? false,
                                                            notes: task.notes,
                                                            subtasks: task.subtasks,
                                                            repeatingRuleId: null,
                                                            repeatingOccurrenceDate: null,
                                                            repeatingOriginalTime: null,
                                                          })
                                                        }
                                                      >
                                                        <div className="task-selector__task-main">
                                                          <div className="task-selector__task-content">
                                                            <span className="goal-task-text">
                                                              <span className="goal-task-text__inner">{task.text}</span>
                                                            </span>
                                                            <span className="task-selector__origin task-selector__origin--dropdown">
                                                              {`${goal.name} → ${bucket.name}`}
                                                            </span>
                                                          </div>
                                                          <span className={diffBadgeClass} aria-hidden="true" />
                                                        </div>
                                                      </button>
                                                    </li>
                                                  )
                                                })}
                                              </ul>
                                            ) : (
                                              <p className="task-selector__empty-sub">No active tasks.</p>
                                            )}
                                        </div>
                                      ) : null}
                                      </li>
                                    )
                                  })}
                                </ul>
                              ) : null}
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <section className="stopwatch-card" role="region" aria-live="polite">
              <button
                type="button"
                className="card-clock-toggle"
                onClick={handleToggleTimeVisibility}
                aria-pressed={isTimeHidden}
                aria-label={timeToggleTitle}
              >
                {timeToggleLabel}
              </button>
              <time className="card-clock" dateTime={clockDateTime} aria-label="Current time">
                {formattedClock}
              </time>
              <div className="time-display">
                <span className="time-label">elapsed</span>
                <span className={timeValueClassName} aria-hidden={isTimeHidden} ref={timeDisplayRef}>
                  {formattedTime}
                </span>
              </div>
              {isTimeHidden ? (
                <span className="sr-only" role="status">
                  Stopwatch time hidden
                </span>
              ) : null}

              <div className="status-row" aria-live="polite">
                <span className={`status-dot status-${statusText}`} aria-hidden="true" />
                <span className="status-text">{statusText}</span>
              </div>

              <div className="controls">
                <button
                  className="control control-primary"
                  type="button"
                  onClick={handleStartStop}
                >
                  {primaryLabel}
                </button>
                <button
                  className="control control-secondary control-end-session"
                  type="button"
                  onClick={handleEndSession}
                  disabled={!isRunning && elapsed === 0}
                >
                  End Session
                </button>
              </div>
            </section>

            <section className="snapback-tool" aria-label="Snap back momentum">
              <button type="button" className="snapback-tool__button" onClick={handleOpenSnapback}>
                Snap Back
              </button>
            </section>
          </div>
          <div className="taskwatch-col taskwatch-col--right">
            {notebookSection}
          </div>
        </div>
        </>
      ) : null}
      {!dashboardLayout && (
        <>
          <div className="focus-group-header">
            {timeModeToggle}
            <div className="task-selector-container">
        <div
          className={[
            'focus-task',
            'goal-task-row',
            ...focusSurfaceClasses,
            focusDiffClass,
            focusPriority ? 'goal-task-row--priority' : '',
            isCompletingFocus ? 'goal-task-row--completing' : '',
            isSelectorOpen ? 'focus-task--open' : '',
            isDefaultTask ? 'focus-task--empty' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          ref={focusTaskContainerRef}
          onClick={handleSelectorContainerClick}
        >
          <button
            type="button"
            className={[
              'goal-task-marker',
              'goal-task-marker--action',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={handleCompleteFocus}
            onPointerDown={(event) => {
              if (canCompleteFocus) {
                prepareFocusCheckAnimation(event.currentTarget)
              }
            }}
            onTouchStart={(event) => {
              if (canCompleteFocus) {
                prepareFocusCheckAnimation(event.currentTarget)
              }
            }}
            aria-disabled={!canCompleteFocus}
            aria-label="Mark focus task complete"
            ref={focusCompleteButtonRef}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" className="goal-task-check" aria-hidden="true">
              <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="focus-task__body"
            onClick={handleToggleSelector}
            aria-haspopup="dialog"
            aria-expanded={isSelectorOpen}
            ref={selectorButtonRef}
          >
            <div className="focus-task__content">
              <div className="focus-task__main">
                <span className="focus-task__label">What am I doing now?</span>
                <span className="goal-task-text">
                  <span
                    className={[
                      'goal-task-text__inner',
                      'focus-task__name',
                      isDefaultTask ? 'focus-task__name--placeholder' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {isDefaultTask ? defaultTaskPlaceholder : safeTaskName}
                  </span>
                </span>
                {focusGoalName && focusBucketName ? (
                  <span className="focus-task__origin">{`${focusGoalName} → ${focusBucketName}`}</span>
                ) : null}
              </div>
            </div>
          </button>
          <div className="focus-task__indicators">
            <button
              type="button"
              className={focusDiffButtonClass}
              onPointerDown={handleDifficultyPointerDown}
              onPointerUp={handleDifficultyPointerUp}
              onPointerLeave={handleDifficultyPointerLeave}
              onPointerCancel={handleDifficultyPointerCancel}
              onKeyDown={handleDifficultyKeyDown}
              disabled={!canCycleFocusDifficulty}
              aria-label={focusDiffButtonTitle}
              title={focusDiffButtonTitle}
            >
              <span className="sr-only">{focusDiffButtonTitle}</span>
            </button>
            <span className={`focus-task__chevron${isSelectorOpen ? ' focus-task__chevron--open' : ''}`}>
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M5.293 7.293a1 1 0 0 1 1.414 0L10 10.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 0-1.414z" />
              </svg>
            </span>
          </div>
        </div>
        {isSelectorOpen ? (
          <div
            className="task-selector-popover"
            role="dialog"
            aria-label="Select focus task"
            ref={selectorPopoverRef}
          >
            {combinedNowSuggestions.length > 0 ? (
              <div className="task-selector__section">
              <h2 className="task-selector__section-title">Scheduled now</h2>
                <ul className="task-selector__list">
                  {combinedNowSuggestions.map((task) => {
                    const candidateLower = task.taskName.trim().toLocaleLowerCase()
                    const matches = focusSource
                      ? focusSource.goalId === task.goalId &&
                        focusSource.bucketId === task.bucketId &&
                        candidateLower === currentTaskLower
                      : !isDefaultTask && candidateLower === currentTaskLower
                          const diffClass =
                            task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : ''
                          const isQuickListTask = isQuickListGoal(task.goalId)
                          const rowClassName = [
                            'task-selector__task',
                            'goal-task-row',
                            diffClass,
                            'goal-task-row--priority',
                            isQuickListTask ? 'task-selector__task--quick-list' : '',
                            matches ? 'task-selector__task--active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')
                          const diffBadgeClass =
                            task.difficulty && task.difficulty !== 'none'
                              ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                  .filter(Boolean)
                                  .join(' ')
                              : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                  .join(' ')
                    return (
                      <li key={makeScheduledSuggestionKey(task)} className="task-selector__item">
                        <button
                          type="button"
                          className={rowClassName}
                          onClick={() =>
                            handleSelectTask(task.taskName, {
                              goalId: task.goalId,
                              bucketId: task.bucketId,
                              goalName: task.goalName,
                              bucketName: task.bucketName,
                              taskId: task.taskId,
                              taskDifficulty: task.difficulty,
                              priority: true,
                            notes: task.notes,
                            subtasks: task.subtasks,
                            repeatingRuleId: task.repeatingRuleId,
                            repeatingOccurrenceDate: task.repeatingOccurrenceDate,
                            repeatingOriginalTime: task.repeatingOriginalTime,
                          })
                        }
                        >
                          <div className="task-selector__task-main">
                            <div className="task-selector__task-content">
                              <span className="goal-task-text">
                                <span className="goal-task-text__inner">{task.taskName}</span>
                              </span>
                              <span className="task-selector__origin task-selector__origin--dropdown">
                                {`${task.goalName} → ${task.bucketName}`}
                              </span>
                            </div>
                            <span className={diffBadgeClass} aria-hidden="true" />
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
            <div className="task-selector__section">
              <h2 className="task-selector__section-title">Custom focus</h2>
              <form className="task-selector__custom-form" onSubmit={handleCustomSubmit}>
                <label htmlFor="taskwatch-custom-focus" className="sr-only">
                  Custom focus task
                </label>
                <input
                  id="taskwatch-custom-focus"
                  type="text"
                  value={customTaskDraft}
                  onChange={handleCustomDraftChange}
                  placeholder="Type a task name"
                  className="task-selector__input"
                  maxLength={MAX_TASK_STORAGE_LENGTH}
                />
                <button type="submit" className="task-selector__set-button">
                  Set
                </button>
              </form>
              <button
                type="button"
                className="task-selector__clear-button"
                onClick={handleClearFocus}
                disabled={isDefaultTask && !focusSource}
              >
                Clear focus
              </button>
            </div>

            <div className="task-selector__section">
              <h2 className="task-selector__section-title">Priority</h2>
              {priorityTasks.length > 0 ? (
                <ul className="task-selector__list">
                  {priorityTasks.map((task) => {
                    const candidateLower = task.taskName.trim().toLocaleLowerCase()
                    const matches = focusSource
                      ? focusSource.goalId === task.goalId &&
                        focusSource.bucketId === task.bucketId &&
                        candidateLower === currentTaskLower
                      : !isDefaultTask && candidateLower === currentTaskLower
                    const diffClass =
                      task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : ''
                    const isQuickListTask = isQuickListGoal(task.goalId)
                    const quickRowClasses = isQuickListTask ? ['task-selector__task--quick-list'] : []
                    const rowClassName = [
                      'task-selector__task',
                      'goal-task-row',
                      diffClass,
                      task.priority ? 'goal-task-row--priority' : '',
                      ...quickRowClasses,
                      matches ? 'task-selector__task--active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    const diffBadgeClass =
                      task.difficulty && task.difficulty !== 'none'
                        ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                            .filter(Boolean)
                            .join(' ')
                        : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                            .join(' ')
                    return (
                      <li key={task.taskId} className="task-selector__item">
                        <button
                          type="button"
                          className={rowClassName}
                          onClick={() =>
                            handleSelectTask(task.taskName, {
                              goalId: task.goalId,
                              bucketId: task.bucketId,
                              goalName: task.goalName,
                              bucketName: task.bucketName,
                              taskId: task.taskId,
                              taskDifficulty: task.difficulty,
                              priority: task.priority,
                              notes: task.notes,
                              subtasks: task.subtasks,
                              repeatingRuleId: task.repeatingRuleId,
                              repeatingOccurrenceDate: task.repeatingOccurrenceDate,
                              repeatingOriginalTime: task.repeatingOriginalTime,
                          })
                        }
                        >
                                <div className="task-selector__task-main">
                                  <div className="task-selector__task-content">
                                    <span className="goal-task-text">
                                      <span className="goal-task-text__inner">{task.taskName}</span>
                                    </span>
                                    {!isQuickListTask ? (
                                      <span className="task-selector__origin task-selector__origin--dropdown">
                                        {`${task.goalName} → ${task.bucketName}`}
                                      </span>
                                    ) : (
                                      <span
                                        className="task-selector__origin task-selector__origin--dropdown task-selector__origin--placeholder"
                                        aria-hidden="true"
                                      />
                                    )}
                                  </div>
                            <span className={diffBadgeClass} aria-hidden="true" />
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="task-selector__empty">No priority tasks yet.</p>
              )}
            </div>

            <div className="task-selector__section">
              <h2 className="task-selector__section-title">{LIFE_ROUTINES_NAME}</h2>
              <button
                type="button"
                className="task-selector__goal-toggle surface-goal surface-goal--glass"
                onClick={() => setLifeRoutinesExpanded((value) => !value)}
                aria-expanded={lifeRoutinesExpanded}
              >
                <span className="task-selector__goal-info">
                  <span className="task-selector__goal-badge" aria-hidden="true">
                    System
                  </span>
                  <span className="task-selector__goal-name">{LIFE_ROUTINES_NAME}</span>
                </span>
                <span className="task-selector__chevron" aria-hidden="true">
                  {lifeRoutinesExpanded ? '−' : '+'}
                </span>
              </button>
              {lifeRoutinesExpanded ? (
                <ul className="task-selector__list">
                  {lifeRoutineTasks.map((task) => {
                    const taskLower = task.title.trim().toLocaleLowerCase()
                    const matches = focusSource
                      ? focusSource.goalId === LIFE_ROUTINES_GOAL_ID &&
                        focusSource.bucketId === task.bucketId &&
                        currentTaskLower === taskLower
                      : !isDefaultTask && currentTaskLower === taskLower
                    const rowClassName = [
                      'task-selector__task',
                      'goal-task-row',
                      'task-selector__task--life-routine',
                      matches ? 'task-selector__task--active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <li key={task.id} className="task-selector__item">
                        <button
                          type="button"
                          className={rowClassName}
                          onClick={() =>
                            handleSelectTask(task.title, {
                              goalId: LIFE_ROUTINES_GOAL_ID,
                              bucketId: task.bucketId,
                              goalName: LIFE_ROUTINES_NAME,
                              bucketName: task.title,
                              taskId: task.id,
                              taskDifficulty: 'none',
                              priority: false,
                              notes: '',
                              subtasks: [],
                              repeatingRuleId: null,
                              repeatingOccurrenceDate: null,
                              repeatingOriginalTime: null,
                            })
                          }
                        >
                          <div className="task-selector__task-main">
                            <div className="task-selector__task-content">
                              <span className="goal-task-text">
                                <span className="goal-task-text__inner">{task.title}</span>
                              </span>
                              <span className="task-selector__origin task-selector__origin--dropdown">{task.blurb}</span>
                            </div>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
                  </div>

                  {quickListActiveCandidates.length > 0 ? (
                    <div className="task-selector__section">
                      <h2 className="task-selector__section-title">{QUICK_LIST_NAME}</h2>
                      <button
                        type="button"
                        className="task-selector__goal-toggle surface-goal surface-goal--glass"
                        onClick={() => setQuickListExpanded((value) => !value)}
                        aria-expanded={quickListExpanded}
                      >
                        <span className="task-selector__goal-info">
                          <span className="task-selector__goal-badge" aria-hidden="true">
                            Quick
                          </span>
                          <span className="task-selector__goal-name">{QUICK_LIST_NAME}</span>
                        </span>
                        <span className="task-selector__chevron" aria-hidden="true">
                          {quickListExpanded ? '−' : '+'}
                        </span>
                      </button>
                      {quickListExpanded ? (
                        <ul className="task-selector__list">
                          {quickListActiveCandidates.map((task) => {
                            const candidateLower = task.taskName.trim().toLocaleLowerCase()
                            const matches = focusSource
                              ? focusSource.goalId === task.goalId &&
                                focusSource.bucketId === task.bucketId &&
                                candidateLower === currentTaskLower
                              : !isDefaultTask && candidateLower === currentTaskLower
                            const diffBadgeClass =
                              task.difficulty && task.difficulty !== 'none'
                                ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                    .filter(Boolean)
                                    .join(' ')
                                : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                    .join(' ')
                          const rowClassName = [
                            'task-selector__task',
                            'goal-task-row',
                            task.difficulty && task.difficulty !== 'none' ? `goal-task-row--diff-${task.difficulty}` : '',
                            task.priority ? 'goal-task-row--priority' : '',
                            'task-selector__task--quick-list',
                            matches ? 'task-selector__task--active' : '',
                          ]
                              .filter(Boolean)
                              .join(' ')
                            return (
                            <li key={`quick-${task.taskId || task.taskName}`} className="task-selector__item">
                              <button
                                  type="button"
                                  className={rowClassName}
                                  onClick={() =>
                                    handleSelectTask(task.taskName, {
                                      goalId: task.goalId,
                                      bucketId: task.bucketId,
                                      goalName: task.goalName,
                                    bucketName: task.bucketName,
                                    taskId: task.taskId,
                                    taskDifficulty: task.difficulty,
                                    priority: task.priority,
                                    notes: task.notes,
                                    subtasks: task.subtasks,
                                    repeatingRuleId: null,
                                    repeatingOccurrenceDate: null,
                                    repeatingOriginalTime: null,
                                    })
                                  }
                                >
                                  <div className="task-selector__task-main">
                                    <div className="task-selector__task-content">
                                      <span className="goal-task-text">
                                        <span className="goal-task-text__inner">{task.taskName}</span>
                                      </span>
                                      <span
                                        className="task-selector__origin task-selector__origin--dropdown task-selector__origin--placeholder"
                                        aria-hidden="true"
                                      />
                                    </div>
                                    <span className={diffBadgeClass} aria-hidden="true" />
                                  </div>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="task-selector__section">
                    <h2 className="task-selector__section-title">Goals</h2>
              {activeGoalSnapshots.length > 0 ? (
                <ul className="task-selector__goals">
                  {activeGoalSnapshots.map((goal) => {
                    const goalExpanded = expandedGoals.has(goal.id)
                    const goalToggleClass = 'task-selector__goal-toggle surface-goal surface-goal--glass'
                    return (
                      <li key={goal.id} className="task-selector__goal">
                        <button
                          type="button"
                          className={goalToggleClass}
                          onClick={() => toggleGoalExpansion(goal.id)}
                          aria-expanded={goalExpanded}
                        >
                          <span className="task-selector__goal-info">
                            <span className="task-selector__goal-badge" aria-hidden="true">
                              Goal
                            </span>
                            <span className="task-selector__goal-name">{goal.name}</span>
                          </span>
                          <span className="task-selector__chevron" aria-hidden="true">
                            {goalExpanded ? '−' : '+'}
                          </span>
                        </button>
                        {goalExpanded ? (
                          <ul className="task-selector__buckets">
                            {goal.buckets
                              .filter((bucket) => !bucket.archived)
                              .map((bucket) => {
                              const bucketExpanded = expandedBuckets.has(bucket.id)
                              const activeTasks = bucket.tasks.filter((task) => !task.completed)
                              const completedTasks = bucket.tasks.filter((task) => task.completed)
                              if (activeTasks.length === 0 && completedTasks.length === 0) {
                                return null
                              }
                              const diffClsForTask = (diff?: FocusCandidate['difficulty']) =>
                                diff && diff !== 'none' ? `goal-task-row--diff-${diff}` : ''

                              return (
                                <li key={bucket.id} className="task-selector__bucket">
                                  <button
                                    type="button"
                                    className="task-selector__bucket-toggle"
                                    onClick={() => toggleBucketExpansion(bucket.id)}
                                    aria-expanded={bucketExpanded}
                                  >
                                    <span className="task-selector__bucket-info">
                                      <span className="task-selector__bucket-badge" aria-hidden="true">
                                        Bucket
                                      </span>
                                      <span className="task-selector__bucket-name">{bucket.name}</span>
                                    </span>
                                    <span className="task-selector__chevron" aria-hidden="true">
                                      {bucketExpanded ? '−' : '+'}
                                    </span>
                                  </button>
                                  {bucketExpanded ? (
                                    <div className="task-selector__bucket-content">
                                      {activeTasks.length > 0 ? (
                                        <ul className="task-selector__tasks">
                                          {activeTasks.map((task) => {
                                            const candidateLower = task.text.trim().toLocaleLowerCase()
                                            const matches = focusSource
                                              ? focusSource.goalId === goal.id &&
                                                focusSource.bucketId === bucket.id &&
                                                candidateLower === currentTaskLower
                                              : !isDefaultTask && candidateLower === currentTaskLower
                                            const diffClass = diffClsForTask(task.difficulty as any)
                                            const taskClassName = [
                                              'task-selector__task',
                                              'goal-task-row',
                                              diffClass,
                                              task.priority ? 'goal-task-row--priority' : '',
                                              matches ? 'task-selector__task--active' : '',
                                            ]
                                              .filter(Boolean)
                                              .join(' ')
                                            const diffBadgeClass =
                                              task.difficulty && task.difficulty !== 'none'
                                                ? ['goal-task-diff', `goal-task-diff--${task.difficulty}`, 'task-selector__diff', 'task-selector__diff-chip']
                                                    .filter(Boolean)
                                                    .join(' ')
                                                : ['goal-task-diff', 'goal-task-diff--none', 'task-selector__diff', 'task-selector__diff-chip']
                                                    .join(' ')
                                            return (
                                              <li key={task.id}>
                                                <button
                                                  type="button"
                                                  className={taskClassName}
                                                  onClick={() =>
                                                    handleSelectTask(task.text, {
                                                      goalId: goal.id,
                                                      bucketId: bucket.id,
                                                      goalName: goal.name,
                                                      bucketName: bucket.name,
                                                      taskId: task.id,
                                                      taskDifficulty: task.difficulty ?? 'none',
                                                      priority: task.priority ?? false,
                                                      notes: task.notes,
                                                      subtasks: task.subtasks,
                                                      repeatingRuleId: null,
                                                      repeatingOccurrenceDate: null,
                                                      repeatingOriginalTime: null,
                                                    })
                                                  }
                                                >
                                                  <div className="task-selector__task-main">
                                                    <div className="task-selector__task-content">
                                                      <span className="goal-task-text">
                                                        <span className="goal-task-text__inner">{task.text}</span>
                                                      </span>
                                                      <span className="task-selector__origin task-selector__origin--dropdown">
                                                        {`${goal.name} → ${bucket.name}`}
                                                      </span>
                                                    </div>
                                                    <span className={diffBadgeClass} aria-hidden="true" />
                                                  </div>
                                                </button>
                                              </li>
                                            )
                                          })}
                                        </ul>
                                      ) : (
                                        <p className="task-selector__empty-sub">No active tasks.</p>
                                      )}
                                    </div>
                                  ) : null}
                                </li>
                              )
                            })}
                          </ul>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="task-selector__empty">Goals will appear here once synced.</p>
              )}
            </div>
          </div>
        ) : null}
          </div>
        </div>
      <section className="stopwatch-card" role="region" aria-live="polite">
        <button
          type="button"
          className="card-clock-toggle"
          onClick={handleToggleTimeVisibility}
          aria-pressed={isTimeHidden}
          aria-label={timeToggleTitle}
        >
          {timeToggleLabel}
        </button>
        <time className="card-clock" dateTime={clockDateTime} aria-label="Current time">
          {formattedClock}
        </time>
        <div className="time-display">
          <span className="time-label">elapsed</span>
          <span className={timeValueClassName} aria-hidden={isTimeHidden} ref={timeDisplayRef}>
            {formattedTime}
          </span>
        </div>
        {isTimeHidden ? (
          <span className="sr-only" role="status">
            Stopwatch time hidden
          </span>
        ) : null}

        <div className="status-row" aria-live="polite">
          <span className={`status-dot status-${statusText}`} aria-hidden="true" />
          <span className="status-text">{statusText}</span>
        </div>

        <div className="controls">
          <button
            className="control control-primary"
            type="button"
            onClick={handleStartStop}
          >
            {primaryLabel}
          </button>
          <button
            className="control control-secondary control-end-session"
            type="button"
            onClick={handleEndSession}
            disabled={!isRunning && elapsed === 0}
          >
            End Session
          </button>
        </div>
      </section>

      <section className="snapback-tool" aria-label="Snap back momentum">
        <button type="button" className="snapback-tool__button" onClick={handleOpenSnapback}>
          Snap Back
        </button>
      </section>

      {notebookSection}

      </>
      )}

      {/* keep prebuilt cards referenced to avoid unused locals */}
      {false && subtasksCard}
      {false && notesCard}
      {isSnapbackOpen ? (
        <div className="snapback-overlay" role="dialog" aria-modal="true" aria-labelledby="snapback-title" onClick={handleCloseSnapback}>
          <div
            className="snapback-panel"
            ref={snapbackDialogRef}
            tabIndex={-1}
            role="document"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="snapback-panel__header">
              <div className="snapback-panel__heading">
                <h2 className="snapback-panel__title" id="snapback-title">
                  Snap back to focus
                </h2>
              </div>
              <button type="button" className="snapback-panel__close" onClick={handleCloseSnapback} aria-label="Close snapback panel">
                ×
              </button>
            </div>

            <div className="snapback-panel__context">
              <span className="snapback-panel__context-label">Current focus</span>
              <span className="snapback-panel__context-task">{safeTaskName}</span>
              {focusContextLabel ? <span className="snapback-panel__context-meta">{focusContextLabel}</span> : null}
            </div>

            <div className="snapback-panel__content">
              <div className="snapback-panel__grid">
                <div className="snapback-panel__section snapback-panel__section--compact" aria-labelledby="snapback-duration-label">
                  <h3 id="snapback-duration-label" className="snapback-panel__heading">How long were you off track for?</h3>
                  <div className="snapback-panel__chips" role="group" aria-label="Select duration">
                    {SNAPBACK_DURATIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`snapback-option${snapbackDurationMode === 'preset' && snapbackDurationMin === opt.id ? ' snapback-option--active' : ''}`}
                        aria-pressed={snapbackDurationMode === 'preset' && snapbackDurationMin === opt.id}
                        onClick={() => {
                          setSnapbackDurationMode('preset')
                          setSnapbackDurationMin(opt.id)
                          setSnapbackCustomDuration('')
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                    <input
                      ref={customDurationInputRef}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={480}
                      className={`snapback-option-input${snapbackDurationMode === 'custom' ? ' is-active' : ''}`}
                      placeholder="mins"
                      value={snapbackCustomDuration}
                      onFocus={() => setSnapbackDurationMode('custom')}
                      onChange={(e) => {
                        const raw = e.target.value
                        setSnapbackCustomDuration(raw)
                        const n = Math.max(1, Math.floor(Number(raw)))
                        if (Number.isFinite(n)) {
                          setSnapbackDurationMode('custom')
                          setSnapbackDurationMin(n)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const n = Math.max(1, Math.floor(Number(snapbackCustomDuration)))
                          if (Number.isFinite(n)) {
                            setSnapbackDurationMode('custom')
                            setSnapbackDurationMin(n)
                          }
                          ;(e.currentTarget as HTMLInputElement).blur()
                        }
                      }}
                      aria-label="Enter minutes"
                    />
                  </div>
                </div>
                <div className="snapback-panel__section snapback-panel__section--stretch" aria-labelledby="snapback-reason-label">
                  <h3 id="snapback-reason-label" className="snapback-panel__heading">What were you doing instead (be specific)?</h3>
                  <div className="snapback-panel__chips" role="group" aria-label="Common triggers">
                    {snapbackReasonStats.topTwo.map((label) => (
                      <button
                        key={`top-${label}`}
                        type="button"
                        className={`snapback-option${snapbackReasonMode === 'custom' && snapbackCustomReason.toLowerCase() === label ? ' snapback-option--active' : ''}`}
                        aria-pressed={snapbackReasonMode === 'custom' && snapbackCustomReason.toLowerCase() === label}
                        onClick={() => {
                          setSnapbackReasonMode('custom')
                          setSnapbackCustomReason(label)
                          setSnapbackReasonSelect(label)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                    {snapbackReasonStats.others.length > 0 ? (
                      <select
                        className="snapback-option-input snapback-option-select"
                        aria-label="Other triggers"
                        value={snapbackReasonSelect}
                        onChange={(e) => {
                          const v = e.target.value
                          setSnapbackReasonSelect(v)
                          setSnapbackReasonMode('custom')
                          setSnapbackCustomReason(v)
                        }}
                        onFocus={() => setSnapbackReasonMode('custom')}
                      >
                        <option value="" disabled>
                          Other triggers…
                        </option>
                        {snapbackReasonStats.others.map((label) => (
                          <option key={`other-${label}`} value={label}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <input
                      type="text"
                      value={snapbackCustomReason}
                      onFocus={() => {
                        setSnapbackReasonMode('custom')
                        setSnapbackReasonSelect('')
                      }}
                      onChange={(e) => {
                        setSnapbackReasonMode('custom')
                        setSnapbackCustomReason(e.target.value.slice(0, MAX_TASK_STORAGE_LENGTH))
                      }}
                      placeholder="Enter a reason"
                      aria-label="Enter a reason"
                      className={`snapback-option-input${snapbackReasonMode === 'custom' ? ' is-active' : ''}`}
                    />
                  </div>
                </div>

                <div className="snapback-panel__section snapback-panel__section--compact" aria-labelledby="snapback-action-label">
                  <h3 id="snapback-action-label" className="snapback-panel__heading">Next step</h3>
                  <div className="snapback-panel__chips" role="group" aria-label="Choose a next action">
                    {SNAPBACK_ACTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`snapback-option${snapbackNextAction === option.id ? ' snapback-option--active' : ''}`}
                        aria-pressed={snapbackNextAction === option.id}
                        onClick={() => setSnapbackNextAction(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="snapback-panel__actions">
              <button type="button" className="snapback-panel__button snapback-panel__button--ghost" onClick={handleCloseSnapback}>
                Cancel
              </button>
              <button type="button" className="snapback-panel__button snapback-panel__button--primary" onClick={handleSubmitSnapback}>
                Log Snapback
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="meta meta-note">BUILT WITH REACT + VITE :D</p>
    </div>
  )
}

export default FocusPage
