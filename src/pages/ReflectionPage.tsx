import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  memo,
  useRef,
  useState,
  startTransition,
  type CSSProperties,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type TouchEvent,
  type PointerEvent as ReactPointerEvent,
  type ChangeEvent,
  type ReactElement,
  type RefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import './ReflectionPage.css'
import './FocusPage.css'
import './GoalsPage.css'
import { readStoredGoalsSnapshot, subscribeToGoalsSnapshot, publishGoalsSnapshot, createGoalsSnapshot, type GoalSnapshot } from '../lib/goalsSync'
import { SCHEDULE_EVENT_TYPE, type ScheduleBroadcastEvent } from '../lib/scheduleChannel'
import { createTask as apiCreateTask, fetchGoalsHierarchy, moveTaskToBucket, updateTaskNotes as apiUpdateTaskNotes } from '../lib/goalsApi'
import {
  DEFAULT_SURFACE_STYLE,
  ensureSurfaceStyle,
  sanitizeSurfaceStyle,
  type SurfaceStyle,
} from '../lib/surfaceStyles'
import {
  LIFE_ROUTINE_STORAGE_KEY,
  LIFE_ROUTINE_UPDATE_EVENT,
  readStoredLifeRoutines,
  sanitizeLifeRoutineList,
  syncLifeRoutinesWithSupabase,
  type LifeRoutineConfig,
} from '../lib/lifeRoutines'
import {
  CURRENT_SESSION_EVENT_NAME,
  CURRENT_SESSION_STORAGE_KEY,
  HISTORY_EVENT_NAME,
  HISTORY_GUEST_USER_ID,
  HISTORY_STORAGE_KEY,
  HISTORY_USER_EVENT,
  HISTORY_USER_KEY,
  readHistoryOwnerId,
  readStoredHistory as readPersistedHistory,
  persistHistorySnapshot,
  syncHistoryWithSupabase,
  gradientFromSurface,
  type HistoryEntry,
  type HistorySubtask,
  areHistorySubtasksEqual,
} from '../lib/sessionHistory'
import { fetchSubtasksForEntry, upsertSubtaskForParent, deleteSubtaskForParent } from '../lib/subtasks'
import {
  fetchRepeatingSessionRules,
  createRepeatingRuleForEntry,
  deactivateMatchingRulesForEntry,
  deleteMatchingRulesForEntry,
  readLocalRepeatingRules,
  storeRepeatingRulesLocal,
  isRepeatingRuleId,
  type RepeatingSessionRule,
} from '../lib/repeatingSessions'
import {
  readRepeatingExceptions,
  subscribeRepeatingExceptions,
  upsertRepeatingException,
  deleteRescheduleExceptionFor,
  type RepeatingException,
} from '../lib/repeatingExceptions'
import { evaluateAndMaybeRetireRule, setRepeatToNoneAfterTimestamp, deleteRepeatingRuleById } from '../lib/repeatingSessions'
import { broadcastFocusTask } from '../lib/focusChannel'
import {
  fetchSnapbackOverviewRows as apiFetchSnapbackRows,
  upsertSnapbackOverviewByBaseKey as apiUpsertSnapbackByKey,
  createCustomSnapbackTrigger as apiCreateCustomSnapback,
  deleteSnapbackRowById as apiDeleteSnapbackById,
  updateSnapbackTriggerNameById as apiUpdateSnapbackNameById,
  type DbSnapbackOverview,
} from '../lib/snapbackApi'
import { supabase } from '../lib/supabaseClient'
import { logWarn } from '../lib/logging'

type ReflectionRangeKey = '24h' | '48h' | '7d' | 'all'

type RangeDefinition = {
  label: string
  shortLabel: string
  durationMs: number
}

const RANGE_DEFS: Record<ReflectionRangeKey, RangeDefinition> = {
  '24h': { label: 'Last 24 Hours', shortLabel: '24h', durationMs: 24 * 60 * 60 * 1000 },
  '48h': { label: 'Last 48 Hours', shortLabel: '48h', durationMs: 48 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 Days', shortLabel: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  all: { label: 'All Time', shortLabel: 'All Time', durationMs: Number.POSITIVE_INFINITY },
}

const RANGE_KEYS: ReflectionRangeKey[] = ['24h', '48h', '7d', 'all']

// Snapback ranges include an "All Time" option and are managed separately
type SnapRangeKey = ReflectionRangeKey | 'all'
const SNAP_RANGE_DEFS: Record<SnapRangeKey, RangeDefinition> = {
  ...RANGE_DEFS,
  all: { label: 'All Time', shortLabel: 'All', durationMs: Number.POSITIVE_INFINITY },
}
// snap-tabs removed; keep range fixed to 'all'

const PAN_MIN_ANIMATION_MS = 220
const PAN_MAX_ANIMATION_MS = 450
const MAX_BUFFER_DAYS = 28

// IMPORTANT BOOL FLAG
const ENABLE_HISTORY_INSPECTOR_PANEL = false
const INSPECTOR_DELETED_MESSAGE = 'This entry was deleted.'
const MULTI_DAY_OPTIONS = [2, 3, 4, 5, 6] as const
const isValidMultiDayOption = (value: number): value is (typeof MULTI_DAY_OPTIONS)[number] =>
  (MULTI_DAY_OPTIONS as readonly number[]).includes(value)
const getCalendarBufferDays = (visibleDayCount: number): number => {
  if (!Number.isFinite(visibleDayCount) || visibleDayCount <= 0) {
    return 4
  }
  const scaled = Math.ceil(visibleDayCount * 1.6)
  return Math.min(MAX_BUFFER_DAYS, Math.max(4, scaled))
}

const clampPanDelta = (dx: number, dayWidth: number, spanDays: number): number => {
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) {
    return 0
  }
  const safeSpan = Number.isFinite(spanDays) ? Math.max(1, Math.min(MAX_BUFFER_DAYS, Math.abs(spanDays))) : 1
  const maxShift = dayWidth * safeSpan
  if (!Number.isFinite(maxShift) || maxShift <= 0) {
    return 0
  }
  if (dx > maxShift) return maxShift
  if (dx < -maxShift) return -maxShift
  return dx
}

type EditableSelectionSnapshot = {
  path: number[]
  offset: number
}

const classNames = (...values: Array<string | false | null | undefined>): string =>
  values.filter(Boolean).join(' ')

const sanitizeDomIdSegment = (value: string): string => value.replace(/[^a-z0-9]/gi, '-')

const makeHistorySubtaskInputId = (entryId: string, subtaskId: string): string =>
  `history-subtask-${sanitizeDomIdSegment(entryId)}-${sanitizeDomIdSegment(subtaskId)}`

// Auto-size a textarea to fit its content without requiring focus
const autosizeHistorySubtaskTextArea = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  try {
    el.style.height = 'auto'
    const next = `${el.scrollHeight}px`
    el.style.height = next
  } catch {}
}

const HISTORY_SUBTASK_SORT_STEP = 1024

const buildSelectionSnapshotFromRange = (root: HTMLElement, range: Range | null): EditableSelectionSnapshot | null => {
  if (!range) return null
  const container = range.endContainer
  if (!root.contains(container)) return null
  const path: number[] = []
  let current: Node | null = container
  while (current && current !== root) {
    const parent: Node | null = current.parentNode
    if (!parent) return null
    const index = Array.prototype.indexOf.call(parent.childNodes, current)
    if (index === -1) return null
    path.push(index)
    current = parent
  }
  if (current !== root) {
    return null
  }
  path.reverse()
  return { path, offset: range.endOffset }
}

const resolveNodeFromPath = (root: HTMLElement, path: number[]): Node => {
  let node: Node = root
  for (const index of path) {
    if (!node.childNodes || index < 0 || index >= node.childNodes.length) {
      return node
    }
    node = node.childNodes[index]
  }
  return node
}

const applySelectionSnapshot = (root: HTMLElement, snapshot: EditableSelectionSnapshot | null): boolean => {
  if (!snapshot || typeof window === 'undefined') {
    return false
  }
  const selection = window.getSelection()
  if (!selection) {
    return false
  }
  const doc = root.ownerDocument || document
  const node = resolveNodeFromPath(root, snapshot.path)
  const range = doc.createRange()
  const maxOffset =
    node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length
  const clampedOffset = Math.max(0, Math.min(snapshot.offset, maxOffset))
  try {
    range.setStart(node, clampedOffset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  } catch {
    return false
  }
}

type HistoryDraftState = {
  taskName: string
  goalName: string
  bucketName: string
  startedAt: number | null
  endedAt: number | null
  notes: string
  subtasks: HistorySubtask[]
}

const cloneHistorySubtasks = (subtasks: HistorySubtask[]): HistorySubtask[] =>
  subtasks.map((subtask) => ({ ...subtask }))

const createHistoryDraftFromEntry = (entry?: HistoryEntry | null): HistoryDraftState => ({
  taskName: entry?.taskName ?? '',
  goalName: entry?.goalName ?? '',
  bucketName: entry?.bucketName ?? '',
  startedAt: entry?.startedAt ?? null,
  endedAt: entry?.endedAt ?? null,
  notes: entry?.notes ?? '',
  subtasks: entry ? cloneHistorySubtasks(entry.subtasks) : [],
})

const createEmptyHistoryDraft = (): HistoryDraftState => createHistoryDraftFromEntry(null)

const areHistoryDraftsEqual = (a: HistoryDraftState | null, b: HistoryDraftState | null): boolean => {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return (
    a.taskName === b.taskName &&
    a.goalName === b.goalName &&
    a.bucketName === b.bucketName &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.notes === b.notes &&
    areHistorySubtasksEqual(a.subtasks, b.subtasks)
  )
}

const monthDayKey = (ms: number): string => {
  const d = new Date(ms)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${m}-${day}`
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

type CustomRecurrenceUnit = 'day' | 'week' | 'month' | 'year'
type CustomRecurrenceEnds = 'never' | 'on' | 'after'
type CustomRecurrenceDraft = {
  interval: number
  unit: CustomRecurrenceUnit
  weeklyDays: Set<number>
  monthlyDay: number
  monthlyPattern: 'day' | 'first' | 'last'
  ends: CustomRecurrenceEnds
  endDate: string
  occurrences: number
}

type CalendarPopoverEditingState = {
  entryId: string
  value: string
  initialTaskName: string
  initialDisplayValue: string
  dirty: boolean
  selectionSnapshot: EditableSelectionSnapshot | null
}

type CalendarActionsKebabProps = {
  onDuplicate: () => void
  previewRef: RefObject<HTMLDivElement | null>
}

const CalendarActionsKebab = ({ onDuplicate, previewRef }: CalendarActionsKebabProps) => {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const host = previewRef.current
      if (host && host.contains(target)) {
        const menu = host.querySelector('.calendar-popover__menu') as HTMLElement | null
        if (menu && menu.contains(target)) return
        if (btnRef.current && btnRef.current.contains(target)) return
      }
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDocDown as EventListener, true)
    return () => window.removeEventListener('pointerdown', onDocDown as EventListener, true)
  }, [open, previewRef])

  return (
    <div className="calendar-popover__kebab-wrap">
      <button
        ref={btnRef}
        type="button"
        className="calendar-popover__action"
        aria-label="More actions"
        onPointerDown={(ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          setOpen((v) => !v)
        }}
        onClick={(ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="12" cy="19" r="1.75"/></svg>
      </button>
      {open ? (
        <div className="calendar-popover__menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="calendar-popover__menu-item"
            onPointerDown={(ev) => {
              ev.preventDefault()
              ev.stopPropagation()
              try {
                onDuplicate()
              } finally {
                setOpen(false)
              }
            }}
          >
            Duplicate entry
          </button>
        </div>
      ) : null}
    </div>
  )
}

type GradientStop = {
  position: number
  color: string
}

type GoalGradientInfo = {
  start: string
  end: string
  angle?: number
  css: string
  stops: GradientStop[]
}

type GoalColorInfo = {
  gradient?: GoalGradientInfo
  solidColor?: string
}

type PieSegment = {
  id: string
  label: string
  durationMs: number
  fraction: number
  swatch: string
  baseColor: string
  gradient?: GoalGradientInfo
  colorInfo?: GoalColorInfo
  isUnlogged?: boolean
}

type PieArc = {
  id: string
  label: string
  color: string
  path: string
  fill: string
  startAngle: number
  endAngle: number
  baseColor: string
  colorInfo?: GoalColorInfo
  isUnlogged?: boolean
}

const UNCATEGORISED_LABEL = 'Uncategorised'
const CHART_COLORS = ['#6366f1', '#22d3ee', '#f97316', '#f472b6', '#a855f7', '#4ade80', '#60a5fa', '#facc15', '#38bdf8', '#fb7185']
const LIFE_ROUTINES_NAME = 'Daily Life'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'
// Snapback virtual goal
// Session History: use orange→crimson gradient
// Time Overview: we render Snapback arcs with reversed sampling (crimson→orange)
const SNAPBACK_NAME = 'Snapback'
const SNAPBACK_SURFACE: SurfaceStyle = 'ember'
const SNAPBACK_COLOR_INFO: GoalColorInfo = {
  gradient: {
    css: 'linear-gradient(135deg, #fb923c 0%, #ef4444 50%, #991b1b 100%)',
    start: '#fb923c',
    end: '#991b1b',
    angle: 135,
    stops: [
      { color: '#fb923c', position: 0 },
      { color: '#ef4444', position: 0.5 },
      { color: '#991b1b', position: 1 },
    ],
  },
  solidColor: '#ef4444',
}
// Removed default surface lookup; life routine surfaces are derived only from user data.

type SurfaceGradientInfo = {
  gradient: string
  start: string
  mid: string
  end: string
  base: string
}

// Not all surfaces need explicit gradients; provide for core ones and fall back dynamically.
const SURFACE_GRADIENT_INFO: Partial<Record<SurfaceStyle, SurfaceGradientInfo>> = {
  glass: {
    gradient: 'linear-gradient(135deg, #313c67 0%, #1f2952 45%, #121830 100%)',
    start: '#313c67',
    mid: '#1f2952',
    end: '#121830',
    base: '#1f2952',
  },
  midnight: {
    gradient: 'linear-gradient(135deg, #8e9bff 0%, #6c86ff 45%, #3f51b5 100%)',
    start: '#8e9bff',
    mid: '#6c86ff',
    end: '#3f51b5',
    base: '#5a63f1',
  },
  coastal: {
    gradient: 'linear-gradient(135deg, #97e3ff 0%, #5ec0ff 45%, #1f7adb 100%)',
    start: '#97e3ff',
    mid: '#5ec0ff',
    end: '#1f7adb',
    base: '#45b0ff',
  },
  cherry: {
    gradient: 'linear-gradient(135deg, #ffb8d5 0%, #f472b6 45%, #be3a84 100%)',
    start: '#ffb8d5',
    mid: '#f472b6',
    end: '#be3a84',
    base: '#f472b6',
  },
  linen: {
    gradient: 'linear-gradient(135deg, #ffd4aa 0%, #f9a84f 45%, #d97706 100%)',
    start: '#ffd4aa',
    mid: '#f9a84f',
    end: '#d97706',
    base: '#f9a84f',
  },
  frost: {
    gradient: 'linear-gradient(135deg, #aee9ff 0%, #6dd3ff 45%, #1d9bf0 100%)',
    start: '#aee9ff',
    mid: '#6dd3ff',
    end: '#1d9bf0',
    base: '#38bdf8',
  },
  grove: {
    gradient: 'linear-gradient(135deg, #baf5d8 0%, #4ade80 45%, #15803d 100%)',
    start: '#baf5d8',
    mid: '#4ade80',
    end: '#15803d',
    base: '#34d399',
  },
  lagoon: {
    gradient: 'linear-gradient(135deg, #a7dcff 0%, #60a5fa 45%, #2563eb 100%)',
    start: '#a7dcff',
    mid: '#60a5fa',
    end: '#2563eb',
    base: '#3b82f6',
  },
  ember: {
    gradient: 'linear-gradient(135deg, #ffd5b5 0%, #fb923c 45%, #c2410c 100%)',
    start: '#ffd5b5',
    mid: '#fb923c',
    end: '#c2410c',
    base: '#f97316',
  },
  'deep-indigo': {
    gradient: 'linear-gradient(135deg, #b4b8ff 0%, #6a6ee8 45%, #2c2f7a 100%)',
    start: '#b4b8ff',
    mid: '#6a6ee8',
    end: '#2c2f7a',
    base: '#4f46e5',
  },
  'warm-amber': {
    gradient: 'linear-gradient(135deg, #ffe6b3 0%, #fbbf24 45%, #b45309 100%)',
    start: '#ffe6b3',
    mid: '#fbbf24',
    end: '#b45309',
    base: '#f59e0b',
  },
  'fresh-teal': {
    gradient: 'linear-gradient(135deg, #99f6e4 0%, #2dd4bf 45%, #0f766e 100%)',
    start: '#99f6e4',
    mid: '#2dd4bf',
    end: '#0f766e',
    base: '#14b8a6',
  },
  'sunset-orange': {
    gradient: 'linear-gradient(135deg, #ffc6b3 0%, #fb8a72 45%, #e1532e 100%)',
    start: '#ffc6b3',
    mid: '#fb8a72',
    end: '#e1532e',
    base: '#f97316',
  },
  'cool-blue': {
    gradient: 'linear-gradient(135deg, #cfe8ff 0%, #60a5fa 45%, #1e40af 100%)',
    start: '#cfe8ff',
    mid: '#60a5fa',
    end: '#1e40af',
    base: '#3b82f6',
  },
  'soft-magenta': {
    gradient: 'linear-gradient(135deg, #ffd1f4 0%, #f472b6 45%, #a21caf 100%)',
    start: '#ffd1f4',
    mid: '#f472b6',
    end: '#a21caf',
    base: '#e879f9',
  },
  'muted-lavender': {
    gradient: 'linear-gradient(135deg, #e9e1ff 0%, #c4b5fd 45%, #6d28d9 100%)',
    start: '#e9e1ff',
    mid: '#c4b5fd',
    end: '#6d28d9',
    base: '#8b5cf6',
  },
  'neutral-grey-blue': {
    gradient: 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 45%, #475569 100%)',
    start: '#e2e8f0',
    mid: '#94a3b8',
    end: '#475569',
    base: '#64748b',
  },
}

const LIFE_ROUTINE_SURFACE_GRADIENT_INFO: Partial<Record<SurfaceStyle, SurfaceGradientInfo>> = {
  glass: {
    gradient:
      'linear-gradient(135deg, rgba(76, 118, 255, 0.42) 0%, rgba(56, 96, 230, 0.34) 48%, rgba(28, 54, 156, 0.28) 100%)',
    start: 'rgba(76, 118, 255, 0.42)',
    mid: 'rgba(56, 96, 230, 0.34)',
    end: 'rgba(28, 54, 156, 0.28)',
    base: '#3f60d6',
  },
  midnight: {
    gradient:
      'linear-gradient(135deg, rgba(118, 126, 255, 0.3) 0%, rgba(110, 118, 246, 0.26) 48%, rgba(92, 106, 230, 0.22) 100%)',
    start: 'rgba(118, 126, 255, 0.3)',
    mid: 'rgba(110, 118, 246, 0.26)',
    end: 'rgba(92, 106, 230, 0.22)',
  base: (SURFACE_GRADIENT_INFO.midnight!).base,
  },
  coastal: {
    gradient:
      'linear-gradient(135deg, rgba(151, 227, 255, 0.3) 0%, rgba(120, 198, 255, 0.26) 48%, rgba(96, 180, 255, 0.22) 100%)',
    start: 'rgba(151, 227, 255, 0.3)',
    mid: 'rgba(120, 198, 255, 0.26)',
    end: 'rgba(96, 180, 255, 0.22)',
  base: (SURFACE_GRADIENT_INFO.coastal!).base,
  },
  cherry: {
    gradient:
      'linear-gradient(135deg, rgba(255, 188, 213, 0.34) 0%, rgba(250, 190, 216, 0.3) 50%, rgba(244, 174, 206, 0.26) 100%)',
    start: 'rgba(255, 188, 213, 0.34)',
    mid: 'rgba(250, 190, 216, 0.3)',
    end: 'rgba(244, 174, 206, 0.26)',
  base: (SURFACE_GRADIENT_INFO.cherry!).base,
  },
  linen: {
    gradient:
      'linear-gradient(135deg, rgba(255, 214, 170, 0.34) 0%, rgba(255, 200, 156, 0.3) 48%, rgba(255, 233, 192, 0.26) 100%)',
    start: 'rgba(255, 214, 170, 0.34)',
    mid: 'rgba(255, 200, 156, 0.3)',
    end: 'rgba(255, 233, 192, 0.26)',
  base: (SURFACE_GRADIENT_INFO.linen!).base,
  },
  frost: {
    gradient:
      'linear-gradient(135deg, rgba(174, 233, 255, 0.3) 0%, rgba(150, 224, 255, 0.26) 48%, rgba(142, 210, 255, 0.22) 100%)',
    start: 'rgba(174, 233, 255, 0.3)',
    mid: 'rgba(150, 224, 255, 0.26)',
    end: 'rgba(142, 210, 255, 0.22)',
  base: (SURFACE_GRADIENT_INFO.frost!).base,
  },
  grove: {
    gradient:
      'linear-gradient(135deg, rgba(140, 255, 204, 0.3) 0%, rgba(112, 240, 176, 0.26) 48%, rgba(74, 222, 128, 0.22) 100%)',
    start: 'rgba(140, 255, 204, 0.3)',
    mid: 'rgba(112, 240, 176, 0.26)',
    end: 'rgba(74, 222, 128, 0.22)',
  base: (SURFACE_GRADIENT_INFO.grove!).base,
  },
  lagoon: {
    gradient:
      'linear-gradient(135deg, rgba(146, 213, 255, 0.3) 0%, rgba(116, 190, 255, 0.26) 48%, rgba(88, 168, 255, 0.22) 100%)',
    start: 'rgba(146, 213, 255, 0.3)',
    mid: 'rgba(116, 190, 255, 0.26)',
    end: 'rgba(88, 168, 255, 0.22)',
  base: (SURFACE_GRADIENT_INFO.lagoon!).base,
  },
  ember: {
    gradient:
      'linear-gradient(135deg, rgba(255, 210, 170, 0.34) 0%, rgba(255, 192, 136, 0.3) 48%, rgba(249, 160, 68, 0.24) 100%)',
    start: 'rgba(255, 210, 170, 0.34)',
    mid: 'rgba(255, 192, 136, 0.3)',
    end: 'rgba(249, 160, 68, 0.24)',
  base: (SURFACE_GRADIENT_INFO.ember!).base,
  },
  'deep-indigo': {
    gradient:
      'linear-gradient(135deg, rgba(180, 184, 255, 0.34) 0%, rgba(144, 149, 255, 0.3) 50%, rgba(122, 127, 232, 0.26) 100%)',
    start: 'rgba(180, 184, 255, 0.34)',
    mid: 'rgba(144, 149, 255, 0.3)',
    end: 'rgba(122, 127, 232, 0.26)',
  base: (SURFACE_GRADIENT_INFO['deep-indigo']!).base,
  },
  'warm-amber': {
    gradient:
      'linear-gradient(135deg, rgba(255, 230, 179, 0.34) 0%, rgba(255, 214, 140, 0.3) 48%, rgba(251, 191, 36, 0.26) 100%)',
    start: 'rgba(255, 230, 179, 0.34)',
    mid: 'rgba(255, 214, 140, 0.3)',
    end: 'rgba(251, 191, 36, 0.26)',
  base: (SURFACE_GRADIENT_INFO['warm-amber']!).base,
  },
  'fresh-teal': {
    gradient:
      'linear-gradient(135deg, rgba(153, 246, 228, 0.3) 0%, rgba(125, 238, 214, 0.26) 48%, rgba(109, 230, 206, 0.22) 100%)',
    start: 'rgba(153, 246, 228, 0.3)',
    mid: 'rgba(125, 238, 214, 0.26)',
    end: 'rgba(109, 230, 206, 0.22)',
  base: (SURFACE_GRADIENT_INFO['fresh-teal']!).base,
  },
  'sunset-orange': {
    gradient:
      'linear-gradient(135deg, rgba(255, 198, 179, 0.34) 0%, rgba(255, 182, 156, 0.3) 48%, rgba(251, 138, 114, 0.24) 100%)',
    start: 'rgba(255, 198, 179, 0.34)',
    mid: 'rgba(255, 182, 156, 0.3)',
    end: 'rgba(251, 138, 114, 0.24)',
  base: (SURFACE_GRADIENT_INFO['sunset-orange']!).base,
  },
  'cool-blue': {
    gradient:
      'linear-gradient(135deg, rgba(207, 232, 255, 0.34) 0%, rgba(190, 225, 255, 0.3) 48%, rgba(153, 206, 255, 0.24) 100%)',
    start: 'rgba(207, 232, 255, 0.34)',
    mid: 'rgba(190, 225, 255, 0.3)',
    end: 'rgba(153, 206, 255, 0.24)',
  base: (SURFACE_GRADIENT_INFO['cool-blue']!).base,
  },
  'soft-magenta': {
    gradient:
      'linear-gradient(135deg, rgba(255, 209, 244, 0.34) 0%, rgba(245, 195, 234, 0.3) 50%, rgba(240, 180, 226, 0.26) 100%)',
    start: 'rgba(255, 209, 244, 0.34)',
    mid: 'rgba(245, 195, 234, 0.3)',
    end: 'rgba(240, 180, 226, 0.26)',
  base: (SURFACE_GRADIENT_INFO['soft-magenta']!).base,
  },
  'muted-lavender': {
    gradient:
      'linear-gradient(135deg, rgba(233, 225, 255, 0.34) 0%, rgba(221, 212, 255, 0.3) 48%, rgba(204, 196, 253, 0.24) 100%)',
    start: 'rgba(233, 225, 255, 0.34)',
    mid: 'rgba(221, 212, 255, 0.3)',
    end: 'rgba(204, 196, 253, 0.24)',
  base: (SURFACE_GRADIENT_INFO['muted-lavender']!).base,
  },
  'neutral-grey-blue': {
    gradient:
      'linear-gradient(135deg, rgba(226, 232, 240, 0.34) 0%, rgba(209, 216, 225, 0.3) 48%, rgba(195, 203, 213, 0.24) 100%)',
    start: 'rgba(226, 232, 240, 0.34)',
    mid: 'rgba(209, 216, 225, 0.3)',
    end: 'rgba(195, 203, 213, 0.24)',
  base: (SURFACE_GRADIENT_INFO['neutral-grey-blue']!).base,
  },
}

// Resolve gradient info for a surface with a safe fallback to the default style
const getGradientInfo = (surface: SurfaceStyle): SurfaceGradientInfo => {
  const info = SURFACE_GRADIENT_INFO[surface]
  if (info) return info
  // Fall back to default style which is guaranteed to exist in the map
  const fallback = SURFACE_GRADIENT_INFO[DEFAULT_SURFACE_STYLE]
  // Non-null assertion: default entry is defined in literal above
  return fallback!
}

const toGoalColorInfo = (info: SurfaceGradientInfo): GoalColorInfo => ({
  gradient: {
    css: info.gradient,
    start: info.start,
    end: info.end,
    angle: 135,
    stops: [
      { color: info.start, position: 0 },
      { color: info.mid, position: 0.48 },
      { color: info.end, position: 1 },
    ],
  },
  solidColor: info.base,
})

const hexToRgba = (hex: string, alpha: number): string => {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex
  if (normalized.length !== 6) {
    return hex
  }
  const value = Number.parseInt(normalized, 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const deriveLifeRoutineSolidColor = (surface: SurfaceStyle): string => {
  const info = LIFE_ROUTINE_SURFACE_GRADIENT_INFO[surface] ?? getGradientInfo(surface)
  return hexToRgba(info.base, 0.78)
}

type HistoryDropdownOption = {
  value: string
  label: string
  disabled?: boolean
}

type HistoryDropdownProps = {
  id?: string
  value: string
  placeholder: string
  options: HistoryDropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
  labelId?: string
}

const HistoryDropdown = ({ id, value, placeholder, options, onChange, disabled, labelId }: HistoryDropdownProps) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const pointerSelectionRef = useRef(false)
  const previousValueRef = useRef(value)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 })
  const [menuPositionReady, setMenuPositionReady] = useState(false)

  const selectedOption = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value])
  const displayLabel = selectedOption?.label ?? placeholder
  const isPlaceholder = !selectedOption
  const valueElementId = id ? `${id}-value` : undefined
  const buttonLabelledBy =
    labelId && valueElementId ? `${labelId} ${valueElementId}` : labelId ?? undefined
  const menuLabelledBy = labelId ?? id

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current
    const menu = menuRef.current
    if (!button || !menu) {
      return
    }
    const buttonRect = button.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const spacing = 8
    
    let left = buttonRect.left
    let top = buttonRect.bottom + spacing
    const width = buttonRect.width
    
    // Ensure menu doesn't go off-screen horizontally
    if (left + width > window.innerWidth - 16) {
      left = window.innerWidth - width - 16
    }
    if (left < 16) {
      left = 16
    }
    
    // If menu would go below viewport, show it above the button instead
    if (top + menuRect.height > window.innerHeight - 16) {
      top = buttonRect.top - menuRect.height - spacing
    }
    
    setMenuPosition({ top, left, width })
    setMenuPositionReady(true)
  }, [])

  useEffect(() => {
    if (!open) {
      setMenuPositionReady(false)
      return
    }
    
    // Update position when opened
    updateMenuPosition()
    
    // Update position on scroll/resize
    const handleUpdate = () => updateMenuPosition()
    window.addEventListener('scroll', handleUpdate, true)
    window.addEventListener('resize', handleUpdate)
    
    return () => {
      window.removeEventListener('scroll', handleUpdate, true)
      window.removeEventListener('resize', handleUpdate)
    }
  }, [open, updateMenuPosition])

  useEffect(() => {
    if (!open) {
      return
    }
    const handleClickOutside = (event: Event) => {
      const container = containerRef.current
      const menu = menuRef.current
      
      // If click is on the button itself, let the button handler deal with it
      if (container && event.target instanceof Node && container.contains(event.target)) {
        return
      }
      
      // If click is on the menu, don't close
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return
      }
      
      // Click is outside both - close the dropdown
      setOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleClickOutside, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (disabled && open) {
      setOpen(false)
    }
  }, [disabled, open])

  useEffect(() => {
    if (previousValueRef.current !== value) {
      previousValueRef.current = value
      if (open) {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
  }, [open, value])

  useEffect(() => {
    if (!open) {
      return
    }
    const focusTarget = () => {
      const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
      const fallbackIndex = options.findIndex((option) => !option.disabled)
      const targetIndex = selectedIndex !== -1 ? selectedIndex : fallbackIndex
      if (targetIndex === -1) {
        return
      }
      const target = optionRefs.current[targetIndex]
      if (target) {
        target.focus()
      }
    }
    const frame = window.requestAnimationFrame(focusTarget)
    return () => window.cancelAnimationFrame(frame)
  }, [open, options, value])

  const findNextEnabledIndex = useCallback(
    (startIndex: number, direction: 1 | -1) => {
      if (options.length === 0) {
        return -1
      }
      let index = startIndex
      for (let attempt = 0; attempt < options.length; attempt += 1) {
        index = (index + direction + options.length) % options.length
        if (!options[index]?.disabled) {
          return index
        }
      }
      return -1
    },
    [options],
  )

  const focusOptionAt = useCallback(
    (targetIndex: number) => {
      if (targetIndex === -1) {
        return
      }
      const target = optionRefs.current[targetIndex]
      if (target) {
        target.focus()
      }
    },
    [],
  )

  const handleButtonClick = useCallback(() => {
    if (disabled) {
      return
    }
    setOpen((current) => !current)
  }, [disabled])

  const handleButtonKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!open) {
          setOpen(true)
          return
        }
        const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
        const direction: 1 | -1 = event.key === 'ArrowDown' ? 1 : -1
        const startIndex = selectedIndex !== -1 ? selectedIndex : direction === 1 ? -1 : 0
        const nextIndex = findNextEnabledIndex(startIndex, direction)
        focusOptionAt(nextIndex)
      }
    },
    [disabled, findNextEnabledIndex, focusOptionAt, open, options, value],
  )

  const handleOptionSelect = useCallback(
    (nextValue: string) => {
      onChange(nextValue)
      setOpen(false)
      buttonRef.current?.focus()
    },
    [onChange],
  )

  const handleOptionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, optionIndex: number) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction: 1 | -1 = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = findNextEnabledIndex(optionIndex, direction)
        focusOptionAt(nextIndex)
      } else if (event.key === 'Home') {
        event.preventDefault()
        const firstIndex = options.findIndex((option) => !option.disabled)
        focusOptionAt(firstIndex)
      } else if (event.key === 'End') {
        event.preventDefault()
        let lastIndex = -1
        for (let i = options.length - 1; i >= 0; i -= 1) {
          if (!options[i]?.disabled) {
            lastIndex = i
            break
          }
        }
        focusOptionAt(lastIndex)
      } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        const option = options[optionIndex]
        if (!option?.disabled) {
          handleOptionSelect(option.value)
          pointerSelectionRef.current = false
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        buttonRef.current?.focus()
      }
    },
    [findNextEnabledIndex, focusOptionAt, handleOptionSelect, options],
  )

  return (
    <div className="history-dropdown" ref={containerRef}>
      <button
        type="button"
        id={id}
        ref={buttonRef}
        className={[
          'history-dropdown__button',
          'history-timeline__field-input',
          'history-timeline__field-input--select',
          open ? 'history-dropdown__button--open' : '',
          disabled ? 'history-dropdown__button--disabled' : '',
          isPlaceholder ? 'history-dropdown__button--placeholder' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        aria-labelledby={buttonLabelledBy}
        onClick={handleButtonClick}
        onKeyDown={handleButtonKeyDown}
        disabled={disabled}
      >
        <span className="history-dropdown__value" id={valueElementId}>
          {displayLabel}
        </span>
        <span className="history-dropdown__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              className="history-dropdown__menu history-dropdown__menu--overlay"
              aria-labelledby={menuLabelledBy}
              tabIndex={-1}
              style={{
                position: 'fixed',
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
                width: `${menuPosition.width}px`,
                visibility: menuPositionReady ? 'visible' : 'hidden',
              }}
            >
              {options.length === 0 ? (
                <div className="history-dropdown__empty">No options</div>
              ) : (
                options.map((option, index) => (
                  <button
                    key={`${option.value || 'empty-option'}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={[
                      'history-dropdown__option',
                      option.value === value ? 'history-dropdown__option--selected' : '',
                      option.disabled ? 'history-dropdown__option--disabled' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onPointerDown={(event) => {
                      if (option.disabled) {
                        event.preventDefault()
                        return
                      }
                      pointerSelectionRef.current = true
                    }}
                    onPointerUp={() => {
                      pointerSelectionRef.current = false
                    }}
                    onClick={(event) => {
                      if (option.disabled) {
                        event.preventDefault()
                        return
                      }
                      if (pointerSelectionRef.current) {
                        pointerSelectionRef.current = false
                        handleOptionSelect(option.value)
                        return
                      }
                      event.preventDefault()
                      handleOptionSelect(option.value)
                    }}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    disabled={option.disabled}
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    tabIndex={-1}
                  >
                    {option.label}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

const getSurfaceColorInfo = (surface: SurfaceStyle): GoalColorInfo => toGoalColorInfo(getGradientInfo(surface))

const getLifeRoutineSurfaceColorInfo = (surface: SurfaceStyle): GoalColorInfo => {
  return {
    solidColor: deriveLifeRoutineSolidColor(surface),
  }
}

type GoalLookup = Map<string, { goalName: string; colorInfo?: GoalColorInfo }>

type DragKind = 'move' | 'resize-start' | 'resize-end'

type DragState = {
  entryId: string
  type: DragKind
  pointerId: number
  rectWidth: number
  startX: number
  initialStart: number
  initialEnd: number
  dayStart: number
  dayEnd: number
  minDurationMs: number
  hasMoved: boolean
}

type DragPreview = {
  entryId: string
  startedAt: number
  endedAt: number
}

type CalendarEventDragState = {
  pointerId: number
  entryId: string
  startX: number
  startY: number
  initialStart: number
  initialEnd: number
  initialTimeOfDayMs: number
  durationMs: number
  kind: DragKind
  columns: Array<{ rect: DOMRect; dayStart: number }>
  moved?: boolean
  activated?: boolean
}

type TimelineSegment = {
  id: string
  entry: HistoryEntry
  start: number
  end: number
  lane: number
  leftPercent: number
  widthPercent: number
  color: string
  gradientCss?: string
  colorInfo?: GoalColorInfo
  goalLabel: string
  bucketLabel: string
  deletable: boolean
  originalRangeLabel: string
  tooltipTask: string
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
      left.goalSurface !== right.goalSurface ||
      left.bucketSurface !== right.bucketSurface ||
      (left.repeatingSessionId ?? null) !== (right.repeatingSessionId ?? null) ||
      (left.originalTime ?? null) !== (right.originalTime ?? null) ||
      Boolean((left as any).futureSession) !== Boolean((right as any).futureSession)
    ) {
      return false
    }
  }
  return true
}

const formatDuration = (ms: number) => {
  const safeMs = Math.max(0, Math.round(ms))
  const totalMinutes = Math.floor(safeMs / 60000)
  if (totalMinutes <= 0) {
    return '0m'
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  if (remainingHours === 0) {
    return `${days}d`
  }
  return minutes > 0 ? `${days}d ${remainingHours}h` : `${days}d ${remainingHours}h`
}

const formatTimeOfDay = (timestamp: number) => {
  const date = new Date(timestamp)
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return `${hours12}:${minutes}${period}`
}

const formatHourLabel = (hour24: number) => {
  const normalized = ((hour24 % 24) + 24) % 24
  if (normalized === 0) {
    return '12 AM'
  }
  if (normalized === 12) {
    return '12 PM'
  }
  if (normalized < 12) {
    return `${normalized} AM`
  }
  return `${normalized - 12} PM`
}

const MINUTE_MS = 60 * 1000
const DAY_DURATION_MS = 24 * 60 * 60 * 1000

// All‑day helpers (shared across calendar + popover/editor)
const toLocalMidnightTs = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const isLocalMidnightTs = (ms: number): boolean => {
  const d = new Date(ms)
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
}
const isAllDayRangeTs = (start: number, end: number): boolean => {
  if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) return false
  if (!isLocalMidnightTs(start) || !isLocalMidnightTs(end)) return false
  const startMid = toLocalMidnightTs(start)
  const endMid = toLocalMidnightTs(end)
  const days = Math.round((endMid - startMid) / DAY_DURATION_MS)
  return days >= 1
}
const DRAG_DETECTION_THRESHOLD_PX = 3
const MIN_SESSION_DURATION_DRAG_MS = MINUTE_MS
// Double-tap (touch) detection settings
// Double-tap (touch) detection thresholds (tighter to reduce accidental triggers)
const DOUBLE_TAP_DELAY_MS = 220
const DOUBLE_TAP_DISTANCE_PX = 8

// Removed legacy native input formatters; using unified Inspector pickers instead

const formatDateDisplay = (timestamp: number): string => {
  const date = new Date(timestamp)
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const formatLocalDateYmd = (ms: number): string => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const parseLocalDateInput = (value: string): number | null => {
  const parts = value.split('-').map((p) => Number(p))
  if (parts.length !== 3) return null
  const [y, m, d] = parts
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  const dt = new Date(y, m - 1, d)
  dt.setHours(0, 0, 0, 0)
  const ms = dt.getTime()
  return Number.isFinite(ms) ? ms : null
}

const startOfMonth = (value: number): number => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  date.setDate(1)
  return date.getTime()
}

type InspectorDateInputProps = {
  value: number
  onChange: (timestamp: number) => void
  ariaLabel: string
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const InspectorDateInput = ({ value, onChange, ariaLabel }: InspectorDateInputProps) => {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(value))
  const [popoverCoords, setPopoverCoords] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) {
      setVisibleMonth(startOfMonth(value))
    }
  }, [value, open])

  useEffect(() => {
    if (!open) {
      return
    }
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const updatePopoverPosition = useCallback(() => {
    if (!open) return
    if (!triggerRef.current || !popoverRef.current) return
    const margin = 10
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const popRect = popoverRef.current.getBoundingClientRect()
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : popRect.width
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : popRect.height
    let top = triggerRect.bottom + margin
    let left = triggerRect.left
    if (top + popRect.height > viewportHeight - margin) {
      const aboveTop = triggerRect.top - margin - popRect.height
      if (aboveTop >= margin) {
        top = aboveTop
      } else {
        top = Math.max(margin, Math.min(top, viewportHeight - margin - popRect.height))
      }
    }
    if (left + popRect.width > viewportWidth - margin) {
      left = viewportWidth - margin - popRect.width
    }
    left = Math.max(margin, left)
    setPopoverCoords({ top, left })
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const rafId = typeof window !== 'undefined' ? window.requestAnimationFrame(updatePopoverPosition) : 0
    const handle = () => updatePopoverPosition()
    window.addEventListener('resize', handle)
    window.addEventListener('scroll', handle, true)
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', handle)
      window.removeEventListener('scroll', handle, true)
    }
  }, [open, updatePopoverPosition])

  const monthDate = new Date(visibleMonth)
  const monthLabel = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const startDayIndex = firstDay.getDay()
  const baseDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1 - startDayIndex)
  const cells: Date[] = []
  for (let index = 0; index < 42; index += 1) {
    cells.push(new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + index))
  }

  const selected = new Date(value)
  selected.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const handleSelect = (date: Date) => {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    const current = new Date(value)
    next.setHours(current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds())
    onChange(next.getTime())
    setOpen(false)
  }

  const handleMonthShift = (delta: number) => {
    setVisibleMonth((prev) => {
      const next = new Date(prev)
      next.setMonth(next.getMonth() + delta)
      return next.getTime()
    })
  }

  return (
    <div className="inspector-picker">
      <button
        type="button"
        ref={triggerRef}
        className="inspector-picker__button history-timeline__field-input history-timeline__field-input--button"
        onClick={(e) => {
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          if (now < SUPPRESS_DATE_OPEN_UNTIL) {
            try { e.preventDefault() } catch {}
            try { e.stopPropagation() } catch {}
            return
          }
          setOpen((prev) => !prev)
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {formatDateDisplay(value)}
      </button>
      {open ? (
        <div
          className="inspector-picker__popover inspector-picker__popover--date"
          ref={popoverRef}
          role="dialog"
          style={popoverCoords ? { position: 'fixed', top: popoverCoords.top, left: popoverCoords.left, zIndex: 9999 } : undefined}
        >
          <div className="inspector-date-picker">
            <div className="inspector-date-picker__header">
              <button type="button" className="inspector-date-picker__nav" onClick={() => handleMonthShift(-1)} aria-label="Previous month">
                ‹
              </button>
              <div className="inspector-date-picker__label">{monthLabel}</div>
              <button type="button" className="inspector-date-picker__nav" onClick={() => handleMonthShift(1)} aria-label="Next month">
                ›
              </button>
            </div>
            <div className="inspector-date-picker__grid">
              {WEEKDAY_SHORT.map((day) => (
                <div key={day} className="inspector-date-picker__weekday" aria-hidden="true">
                  {day}
                </div>
              ))}
              {cells.map((date) => {
                const isCurrentMonth = date.getMonth() === monthDate.getMonth()
                const cellDay = date.getDate()
                const cellKey = date.toISOString()
                const isToday =
                  date.getTime() === today.getTime()
                const isSelected = date.getTime() === selected.getTime()
                const className = [
                  'inspector-date-picker__cell',
                  isCurrentMonth ? '' : 'inspector-date-picker__cell--adjacent',
                  isToday ? 'inspector-date-picker__cell--today' : '',
                  isSelected ? 'inspector-date-picker__cell--selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={cellKey}
                    type="button"
                    className={className}
                    aria-pressed={isSelected}
                    aria-selected={isSelected}
                    aria-current={isToday ? 'date' : undefined}
                    aria-label={formatDateDisplay(date.getTime())}
                    onMouseDown={(e) => {
                      // Commit selection on mousedown and prevent bubbling so the trigger
                      // doesn't receive a trailing click that could re-open/toggle unexpectedly
                      try { e.preventDefault() } catch {}
                      try { e.stopPropagation() } catch {}
                      handleSelect(date)
                      try { (triggerRef.current as HTMLButtonElement | null)?.focus() } catch {}
                    }}
                    onClick={(e) => {
                      // Keyboard activation fallback
                      try { e.preventDefault() } catch {}
                      try { e.stopPropagation() } catch {}
                      handleSelect(date)
                      try { (triggerRef.current as HTMLButtonElement | null)?.focus() } catch {}
                    }}
                  >
                    {cellDay}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type InspectorTimeInputProps = {
  value: number
  onChange: (timestamp: number) => void
  ariaLabel: string
}

const buildTimeOptions = () => {
  const options: Array<{ label: string; minutes: number }> = []
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 15) {
      const minutesTotal = hour * 60 + minute
      const sample = new Date(2020, 0, 1, hour, minute)
      const label = formatTimeOfDay(sample.getTime())
      options.push({ label, minutes: minutesTotal })
    }
  }
  return options
}

const TIME_OPTIONS = buildTimeOptions()

// Short-term suppression window to avoid accidental date-picker opens immediately after selecting a time
let SUPPRESS_DATE_OPEN_UNTIL = 0

const InspectorTimeInput = ({ value, onChange, ariaLabel }: InspectorTimeInputProps) => {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useEffect(() => {
    if (open && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [open])

  const date = new Date(value)
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const label = formatTimeOfDay(value)
  const currentMinutes = hours * 60 + minutes
  const highlightedMinutes = Math.min(23 * 60 + 45, Math.max(0, Math.round(currentMinutes / 15) * 15))

  const handleSelect = (totalMinutes: number) => {
    const next = new Date(value)
    const hoursPart = Math.floor(totalMinutes / 60)
    const minutesPart = totalMinutes % 60
    next.setHours(hoursPart, minutesPart, 0, 0)
    onChange(next.getTime())
    setOpen(false)
    // Suppress the date picker opening for a brief moment after time selection
    try {
      SUPPRESS_DATE_OPEN_UNTIL = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 300
    } catch {
      SUPPRESS_DATE_OPEN_UNTIL = Date.now() + 300
    }
  }

  return (
    <div className="inspector-picker">
      <button
        type="button"
        ref={triggerRef}
        className="inspector-picker__button history-timeline__field-input history-timeline__field-input--button"
        onClick={(e) => {
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          if (now < SUPPRESS_DATE_OPEN_UNTIL) {
            try { e.preventDefault() } catch {}
            try { e.stopPropagation() } catch {}
            return
          }
          setOpen((prev) => !prev)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {label}
      </button>
      {open ? (
        <div className="inspector-picker__popover inspector-picker__popover--time" ref={popoverRef} role="listbox">
          <ul className="inspector-time-picker">
            {TIME_OPTIONS.map((option) => {
              const selected = option.minutes === highlightedMinutes
              const itemClass = [
                'inspector-time-picker__option',
                selected ? 'inspector-time-picker__option--selected' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <li key={option.minutes}>
                  <button
                    type="button"
                    className={itemClass}
                    role="option"
                    aria-selected={selected}
                    ref={selected ? selectedRef : undefined}
                    onMouseDown={(e) => {
                      // Handle selection on mousedown and prevent the subsequent click from hitting underlying controls
                      try { e.preventDefault() } catch {}
                      try { e.stopPropagation() } catch {}
                      handleSelect(option.minutes)
                      try { triggerRef.current?.focus() } catch {}
                    }}
                    onClick={(e) => {
                      // Keyboard or fallback click
                      try { e.preventDefault() } catch {}
                      try { e.stopPropagation() } catch {}
                      handleSelect(option.minutes)
                      try { triggerRef.current?.focus() } catch {}
                    }}
                  >
                    {option.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

// Removed legacy parser used for native inputs; Inspector pickers provide timestamps directly

const resolveTimestamp = (value: number | null | undefined, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return fallback
}

const makeHistoryId = () => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (error) {
    // Silenced non-critical UUID generation warning
  }
  return `history-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const deriveEntryTaskName = (entry: HistoryEntry): string => {
  const name = entry.taskName?.trim()
  if (name && name.length > 0) {
    return name
  }
  const bucket = entry.bucketName?.trim()
  if (bucket && bucket.length > 0) {
    return bucket
  }
  const goal = entry.goalName?.trim()
  if (goal && goal.length > 0) {
    return goal
  }
  return 'Session'
}

const hashString = (value: string) => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return hash
}

const getPaletteColorForLabel = (label: string) => {
  const hash = Math.abs(hashString(label))
  const index = hash % CHART_COLORS.length
  return CHART_COLORS[index]
}

const formatLocalYmd = (ms: number): string => {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${y}-${pad(m)}-${pad(day)}`
}

type LoopSlice = {
  key: string
  path: string
  color: string
}

const sampleGradientColor = (
  colorInfo: GoalColorInfo | undefined,
  fallback: string,
  ratio: number,
): string => {
  const normalizedFallback = normalizeHexColor(fallback) ?? fallback
  const gradient = colorInfo?.gradient
  if (gradient && gradient.stops.length >= 2) {
    const t = clamp01(ratio)
    const stops = gradient.stops
    let previous = stops[0]
    for (let index = 1; index < stops.length; index += 1) {
      const current = stops[index]
      if (t <= current.position) {
        const span = current.position - previous.position
        const local = span <= 0 ? 0 : clamp01((t - previous.position) / span)
        return mixHexColors(previous.color, current.color, local)
      }
      previous = current
    }
    return stops[stops.length - 1].color
  }
  if (colorInfo?.solidColor) {
    return colorInfo.solidColor
  }
  return normalizedFallback
}

const GRADIENT_SLICE_DEGREES = 0.25
const GRADIENT_MIN_SLICES = 48
const GRADIENT_MAX_SLICES = 1440

const buildArcLoopSlices = (arc: PieArc): LoopSlice[] => {
  if (arc.isUnlogged) {
    return [
      {
        key: `${arc.id}-full`,
        path: describeDonutSlice(arc.startAngle, arc.endAngle),
        color: arc.fill,
      },
    ]
  }
  const span = Math.max(arc.endAngle - arc.startAngle, 0)
  if (span <= 0) {
    return []
  }
  const gradient = arc.colorInfo?.gradient
  const sliceCount = gradient
    ? Math.min(
        GRADIENT_MAX_SLICES,
        Math.max(
          GRADIENT_MIN_SLICES,
          Math.ceil(span / Math.max(GRADIENT_SLICE_DEGREES, ARC_EPSILON)),
        ),
      )
    : 1
  const slices: LoopSlice[] = []
  const isSnapbackArc = (arc.label?.trim().toLowerCase() === SNAPBACK_NAME.toLowerCase())
  for (let index = 0; index < sliceCount; index += 1) {
    const sliceStart = arc.startAngle + (span * index) / sliceCount
    const sliceEnd = index === sliceCount - 1 ? arc.endAngle : arc.startAngle + (span * (index + 1)) / sliceCount
    if (sliceEnd - sliceStart <= ARC_EPSILON) {
      continue
    }
    const midAngle = sliceStart + (sliceEnd - sliceStart) / 2
    let localRatio = span <= 0 ? 0 : clamp01((midAngle - arc.startAngle) / span)
    // Invert gradient sampling for Snapback arcs to achieve crimson→orange effect in the pie
    if (isSnapbackArc) {
      localRatio = 1 - localRatio
    }
    const color = sampleGradientColor(arc.colorInfo, arc.baseColor, localRatio)
    slices.push({
      key: `${arc.id}-slice-${index}`,
      path: describeDonutSlice(sliceStart, sliceEnd),
      color,
    })
  }
  return slices
}

const formatDatePart = (timestamp: number) => {
  const date = new Date(timestamp)
  const day = date.getDate()
  const month = date.toLocaleString(undefined, { month: 'short' })
  const year = date.getFullYear()
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return {
    dateLabel: `${day}/${month}/${year}`,
    timeLabel: `${hours12}:${minutes}${period}`,
  }
}

const formatDateRange = (start: number, end: number) => {
  const startPart = formatDatePart(start)
  const endPart = formatDatePart(end)

  if (startPart.dateLabel === endPart.dateLabel) {
    return `${startPart.dateLabel} ${startPart.timeLabel}-${endPart.timeLabel}`
  }

  return `${startPart.dateLabel} ${startPart.timeLabel} - ${endPart.dateLabel} ${endPart.timeLabel}`
}

const PIE_VIEWBOX_SIZE = 200
const PIE_CENTER = PIE_VIEWBOX_SIZE / 2
const PIE_RADIUS = PIE_VIEWBOX_SIZE / 2 - 2
const PIE_INNER_RADIUS = PIE_RADIUS * 0.56
const ARC_EPSILON = 1e-6

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1)

const polarToCartesian = (cx: number, cy: number, radius: number, angleDeg: number) => {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  }
}

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const normalizeHexColor = (value: string): string | null => {
  const trimmed = value.trim()
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return null
  }
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

const hexToRgb = (hex: string) => {
  const normalized = normalizeHexColor(hex)
  if (!normalized) {
    return null
  }
  const value = normalized.slice(1)
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return { r, g, b }
}

const rgbToHex = (r: number, g: number, b: number) => {
  const clamp = (component: number) => Math.min(255, Math.max(0, Math.round(component)))
  const toHex = (component: number) => clamp(component).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const mixHexColors = (source: string, target: string, ratio: number) => {
  const sourceRgb = hexToRgb(source)
  const targetRgb = hexToRgb(target)
  if (!sourceRgb || !targetRgb) {
    return source
  }
  const safeRatio = clamp01(ratio)
  const mix = (a: number, b: number) => a * (1 - safeRatio) + b * safeRatio
  return rgbToHex(mix(sourceRgb.r, targetRgb.r), mix(sourceRgb.g, targetRgb.g), mix(sourceRgb.b, targetRgb.b))
}

const resolveCssColor = (value: string, fallback?: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('var(') && typeof window !== 'undefined' && typeof document !== 'undefined') {
    const content = trimmed.slice(4, -1)
    const [rawName, ...rest] = content.split(',')
    const variableName = rawName.trim()
    const fallbackValue = rest.join(',').trim()
    const computed = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim()
    if (computed.length > 0) {
      return computed
    }
    if (fallbackValue.length > 0) {
      return resolveCssColor(fallbackValue, fallback)
    }
    if (typeof fallback === 'string' && fallback !== trimmed) {
      return resolveCssColor(fallback, undefined)
    }
  }
  if (trimmed.length === 0 && typeof fallback === 'string') {
    return fallback
  }
  return trimmed
}

const applyAlphaToHex = (hex: string, alpha: number) => {
  const normalized = normalizeHexColor(hex)
  if (!normalized) {
    return hex
  }
  const clampedAlpha = Math.min(1, Math.max(0, alpha))
  const alphaByte = Math.round(clampedAlpha * 255)
  return `${normalized}${alphaByte.toString(16).padStart(2, '0')}`
}

const PRESET_GOAL_GRADIENTS: Record<string, string> = {
  'from-fuchsia-500 to-purple-500': 'linear-gradient(135deg, #f471b5 0%, #a855f7 50%, #6b21a8 100%)',
  'from-emerald-500 to-cyan-500': 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  'from-lime-400 to-emerald-500': 'linear-gradient(135deg, #bef264 0%, #4ade80 45%, #22c55e 100%)',
  'from-sky-500 to-indigo-500': 'linear-gradient(135deg, #38bdf8 0%, #60a5fa 50%, #6366f1 100%)',
  'from-amber-400 to-orange-500': 'linear-gradient(135deg, #fbbf24 0%, #fb923c 45%, #f97316 100%)',
}

const splitGradientArgs = (value: string): string[] => {
  const result: string[] = []
  let current = ''
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') {
      depth += 1
      current += char
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
    } else if (char === ',' && depth === 0) {
      if (current.trim().length > 0) {
        result.push(current.trim())
      }
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim().length > 0) {
    result.push(current.trim())
  }
  return result
}

type PartialGradientStop = {
  color: string
  position?: number
}

const parseGradientStopToken = (token: string): PartialGradientStop | null => {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 0) {
    return null
  }
  const color = normalizeHexColor(parts[0])
  if (!color) {
    return null
  }
  let position: number | undefined
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]
    const match = part.match(/^(-?\d+(?:\.\d+)?)%$/)
    if (match) {
      position = clamp01(Number.parseFloat(match[1]) / 100)
      break
    }
  }
  return { color, position }
}

const normalizeGradientStops = (stops: PartialGradientStop[]): GradientStop[] => {
  if (stops.length < 2) {
    return []
  }
  const working = stops.map((stop) => ({ ...stop }))
  if (working[0].position === undefined) {
    working[0].position = 0
  }
  if (working[working.length - 1].position === undefined) {
    working[working.length - 1].position = 1
  }
  let lastDefinedIndex = 0
  for (let index = 1; index < working.length; index += 1) {
    const stop = working[index]
    if (stop.position !== undefined) {
      const startPos = clamp01(working[lastDefinedIndex].position ?? 0)
      const endPos = clamp01(stop.position)
      const gap = index - lastDefinedIndex
      if (gap > 1) {
        const step = (endPos - startPos) / gap
        for (let offset = 1; offset < gap; offset += 1) {
          const target = working[lastDefinedIndex + offset]
          target.position = clamp01(startPos + step * offset)
        }
      }
      stop.position = endPos
      lastDefinedIndex = index
    }
  }
  for (let index = 0; index < working.length; index += 1) {
    if (working[index].position !== undefined) {
      continue
    }
    const prevIndex = Math.max(0, index - 1)
    let nextIndex = index + 1
    while (nextIndex < working.length && working[nextIndex].position === undefined) {
      nextIndex += 1
    }
    const prevPos = clamp01(working[prevIndex].position ?? 0)
    const nextPos = nextIndex < working.length ? clamp01(working[nextIndex].position ?? prevPos) : prevPos
    const span = nextIndex - prevIndex
    if (span <= 0) {
      working[index].position = prevPos
    } else {
      const relativeIndex = index - prevIndex
      working[index].position = clamp01(prevPos + ((nextPos - prevPos) * relativeIndex) / span)
    }
  }
  return working
    .map<GradientStop>((stop) => ({
      color: stop.color,
      position: clamp01(stop.position ?? 0),
    }))
    .sort((a, b) => a.position - b.position)
}

const parseGoalGradient = (gradient: string): GoalGradientInfo | null => {
  const trimmed = gradient.trim()
  if (!trimmed.toLowerCase().startsWith('linear-gradient')) {
    return null
  }
  const openIndex = trimmed.indexOf('(')
  const closeIndex = trimmed.lastIndexOf(')')
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex + 1) {
    return null
  }
  const inner = trimmed.slice(openIndex + 1, closeIndex)
  const args = splitGradientArgs(inner)
  if (args.length < 2) {
    return null
  }
  let angle: number | undefined
  let stopStartIndex = 0
  const angleMatch = args[0].match(/^(-?\d+(?:\.\d+)?)deg$/i)
  if (angleMatch) {
    angle = Number.parseFloat(angleMatch[1])
    stopStartIndex = 1
  }
  const stopTokens = args.slice(stopStartIndex)
  const partialStops = stopTokens
    .map((token) => parseGradientStopToken(token))
    .filter((stop): stop is PartialGradientStop => Boolean(stop))
  const stops = normalizeGradientStops(partialStops)
  if (stops.length < 2) {
    return null
  }
  return {
    css: gradient,
    start: stops[0].color,
    end: stops[stops.length - 1].color,
    angle,
    stops,
  }
}

const extractGradientColors = (gradient: string): { start: string; end: string; angle?: number } | null => {
  const matches = gradient.match(/#(?:[0-9a-fA-F]{3}){1,2}/g)
  if (!matches || matches.length === 0) {
    return null
  }
  const start = normalizeHexColor(matches[0]) ?? matches[0]
  const end = normalizeHexColor(matches[matches.length - 1]) ?? matches[matches.length - 1]
  const angleMatch = gradient.match(/(-?\d+(?:\.\d+)?)deg/)
  return {
    start,
    end,
    angle: angleMatch ? Number.parseFloat(angleMatch[1]) : undefined,
  }
}

const resolveGoalColorInfo = (value: string | undefined): GoalColorInfo | undefined => {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  let gradientString: string | null = null
  if (trimmed.startsWith('custom:')) {
    gradientString = trimmed.slice(7)
  } else if (trimmed.includes('gradient(')) {
    gradientString = trimmed
  } else if (PRESET_GOAL_GRADIENTS[trimmed]) {
    gradientString = PRESET_GOAL_GRADIENTS[trimmed]
  } else {
    const normalized = normalizeHexColor(trimmed)
    if (normalized) {
      return { solidColor: normalized }
    }
    return undefined
  }

  const parsed = parseGoalGradient(gradientString)
  if (parsed) {
    return {
      gradient: parsed,
    }
  }

  const fallback = extractGradientColors(gradientString)
  if (!fallback) {
    return undefined
  }

  return {
    gradient: {
      css: gradientString,
      start: fallback.start,
      end: fallback.end,
      angle: fallback.angle,
      stops: [
        { color: fallback.start, position: 0 },
        { color: fallback.end, position: 1 },
      ],
    },
  }
}

const describeFullDonut = () => {
  const outerStart = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, 0)
  const outerOpposite = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, 180)
  const innerStart = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, 0)
  const innerOpposite = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, 180)
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${outerOpposite.x} ${outerOpposite.y}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${outerStart.x} ${outerStart.y}`,
    'Z',
    `M ${innerStart.x} ${innerStart.y}`,
    `A ${PIE_INNER_RADIUS} ${PIE_INNER_RADIUS} 0 1 0 ${innerOpposite.x} ${innerOpposite.y}`,
    `A ${PIE_INNER_RADIUS} ${PIE_INNER_RADIUS} 0 1 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

const describeDonutSlice = (startAngle: number, endAngle: number) => {
  const start = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, startAngle)
  const end = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, endAngle)
  const innerEnd = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, endAngle)
  const innerStart = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, startAngle)
  const sweepAngle = Math.max(Math.min(endAngle - startAngle, 360), 0)
  if (sweepAngle >= 360 - ARC_EPSILON) {
    return describeFullDonut()
  }
  const largeArcFlag = sweepAngle > 180 ? 1 : 0
  const sweepFlagOuter = 1
  const sweepFlagInner = 0
  return [
    `M ${start.x} ${start.y}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArcFlag} ${sweepFlagOuter} ${end.x} ${end.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${PIE_INNER_RADIUS} ${PIE_INNER_RADIUS} 0 ${largeArcFlag} ${sweepFlagInner} ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

const createPieArcs = (segments: PieSegment[], windowMs: number): PieArc[] => {
  if (segments.length === 0) {
    return []
  }

  const filteredSegments = segments.filter((segment) => Math.max(segment.durationMs, 0) > 0)
  if (filteredSegments.length === 0) {
    return []
  }

  const segmentTotal = filteredSegments.reduce((sum, segment) => sum + Math.max(segment.durationMs, 0), 0)
  const denominator = Math.max(windowMs, segmentTotal, 1)
  let accumulated = 0
  const arcs: PieArc[] = []

  for (let index = 0; index < filteredSegments.length; index += 1) {
    const segment = filteredSegments[index]
    const value = Math.max(segment.durationMs, 0)
    if (!Number.isFinite(value) || value <= 0) {
      continue
    }

    const startRatio = clamp01(accumulated / denominator)
    accumulated += value
    let endRatio = index === filteredSegments.length - 1 ? 1 : clamp01(accumulated / denominator)
    if (endRatio < startRatio) {
      endRatio = startRatio
    }

    const sweepRatio = endRatio - startRatio
    if (sweepRatio <= ARC_EPSILON) {
      continue
    }

    const startAngle = startRatio * 360
    const endAngle = Math.min(startAngle + sweepRatio * 360, 360)
    const normalizedBase = normalizeHexColor(segment.baseColor)
    const fallbackFill = normalizedBase ? applyAlphaToHex(normalizedBase, 0.58) : segment.baseColor
    const isUnlogged = Boolean(segment.isUnlogged)
    const fillValue = isUnlogged ? 'var(--reflection-chart-unlogged-soft)' : fallbackFill
    arcs.push({
      id: segment.id,
      label: segment.label,
      color: segment.swatch,
      path: describeDonutSlice(startAngle, endAngle),
      fill: fillValue,
      startAngle,
      endAngle,
      baseColor: segment.baseColor,
      colorInfo: segment.colorInfo,
      isUnlogged,
    })
  }

  return arcs
}

const FULL_DONUT_PATH = describeFullDonut()

const createGoalTaskMap = (snapshot: GoalSnapshot[]): GoalLookup => {
  const map: GoalLookup = new Map()
  snapshot.forEach((goal) => {
    const goalName = goal.name?.trim()
    if (!goalName) {
      return
    }
    const colorInfo = resolveGoalColorInfo((goal as any).goalColour ?? (goal as any).goal_colour)
    goal.buckets.forEach((bucket) => {
      bucket.tasks.forEach((task) => {
        const key = task.text.trim().toLowerCase()
        if (!key || map.has(key)) {
          return
        }
        map.set(key, { goalName, colorInfo })
      })
    })
  })
  return map
}

const createGoalColorMap = (snapshot: GoalSnapshot[]): Map<string, GoalColorInfo | undefined> => {
  const map = new Map<string, GoalColorInfo | undefined>()
  snapshot.forEach((goal) => {
    const goalName = goal.name?.trim()
    if (!goalName) {
      return
    }
    const normalized = goalName.toLowerCase()
    if (map.has(normalized)) {
      return
    }
    map.set(normalized, resolveGoalColorInfo((goal as any).goalColour ?? (goal as any).goal_colour))
  })
  return map
}

type GoalMetadata = {
  label: string
  colorInfo?: GoalColorInfo
}

type ActiveSessionState = {
  taskName: string
  goalName: string | null
  bucketName: string | null
  goalId: string | null
  bucketId: string | null
  taskId: string | null
  goalSurface: SurfaceStyle
  bucketSurface: SurfaceStyle | null
  startedAt: number | null
  baseElapsed: number
  committedElapsed?: number
  isRunning: boolean
  updatedAt: number
}

const resolveGoalMetadata = (
  entry: HistoryEntry,
  taskLookup: GoalLookup,
  goalColorLookup: Map<string, GoalColorInfo | undefined>,
  lifeRoutineSurfaceLookup: Map<string, SurfaceStyle>,
): GoalMetadata => {
  const goalNameRaw = entry.goalName?.trim()
  const bucketNameRaw = entry.bucketName?.trim()
  const normalizedGoalName = goalNameRaw?.toLowerCase() ?? ''
  const normalizedBucketName = bucketNameRaw?.toLowerCase() ?? ''
  const storedGoalSurfaceInfo = entry.goalSurface ? getSurfaceColorInfo(entry.goalSurface) : undefined
  const entryColorInfo = resolveGoalColorInfo(entry.entryColor)
  // Treat logged Snapback markers as a virtual goal with crimson/orange accent
  const parseSnapbackReason = (taskName: string): string | null => {
    const prefix = 'Snapback • '
    if (!taskName || !taskName.startsWith(prefix)) return null
    const rest = taskName.slice(prefix.length)
    const enDash = ' – '
    if (rest.includes(enDash)) return rest.split(enDash).slice(1).join(enDash).trim()
    if (rest.includes(' - ')) return rest.split(' - ').slice(1).join(' - ').trim()
    return null
  }
  const snapReason = parseSnapbackReason(entry.taskName)
  if (snapReason) {
    return { label: SNAPBACK_NAME, colorInfo: SNAPBACK_COLOR_INFO }
  }
  // If a session is explicitly labeled with the Snapback goal, use the Snapback palette
  if (goalNameRaw && normalizedGoalName === SNAPBACK_NAME.toLowerCase()) {
    return { label: SNAPBACK_NAME, colorInfo: SNAPBACK_COLOR_INFO }
  }
  const isLifeRoutineEntry =
    (goalNameRaw && normalizedGoalName === LIFE_ROUTINES_NAME.toLowerCase()) ||
    (bucketNameRaw && lifeRoutineSurfaceLookup.has(normalizedBucketName))

  if (isLifeRoutineEntry) {
    const routineSurface =
      entry.bucketSurface ?? (normalizedBucketName ? lifeRoutineSurfaceLookup.get(normalizedBucketName) ?? null : null)
    const surfaceInfo = getLifeRoutineSurfaceColorInfo(routineSurface ?? LIFE_ROUTINES_SURFACE)
    const labelCandidate =
      bucketNameRaw && bucketNameRaw.length > 0
        ? bucketNameRaw
        : entry.taskName.trim().length > 0
          ? entry.taskName.trim()
          : LIFE_ROUTINES_NAME
    return { label: labelCandidate, colorInfo: surfaceInfo }
  }

  const goalName = entry.goalName?.trim()
  if (goalName && goalName.length > 0) {
    const colorInfo = goalColorLookup.get(goalName.toLowerCase()) ?? storedGoalSurfaceInfo
    return { label: goalName, colorInfo }
  }

  const taskName = entry.taskName.trim()
  if (taskName.length > 0) {
    const match = taskLookup.get(taskName.toLowerCase())
    if (match) {
      return { label: match.goalName, colorInfo: match.colorInfo }
    }
  }

  const fallbackSurfaceInfo = entryColorInfo ?? storedGoalSurfaceInfo ?? getSurfaceColorInfo(entry.goalSurface)
  return { label: UNCATEGORISED_LABEL, colorInfo: fallbackSurfaceInfo }
}

const sanitizeActiveSession = (value: unknown): ActiveSessionState | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const rawTaskName = typeof candidate.taskName === 'string' ? candidate.taskName : ''
  const taskName = rawTaskName.trim()
  const rawGoalName = typeof candidate.goalName === 'string' ? candidate.goalName.trim() : ''
  const goalName = rawGoalName.length > 0 ? rawGoalName : null
  const rawBucketName = typeof candidate.bucketName === 'string' ? candidate.bucketName.trim() : ''
  const bucketName = rawBucketName.length > 0 ? rawBucketName : null
  const rawGoalId = typeof candidate.goalId === 'string' ? candidate.goalId.trim() : ''
  const goalId = rawGoalId.length > 0 ? rawGoalId : null
  const rawBucketId = typeof candidate.bucketId === 'string' ? candidate.bucketId.trim() : ''
  const bucketId = rawBucketId.length > 0 ? rawBucketId : null
  const rawTaskId = typeof candidate.taskId === 'string' ? candidate.taskId.trim() : ''
  const taskId = rawTaskId.length > 0 ? rawTaskId : null
  const sanitizedGoalSurface = sanitizeSurfaceStyle(candidate.goalSurface)
  const goalSurface = ensureSurfaceStyle(
    sanitizedGoalSurface ?? DEFAULT_SURFACE_STYLE,
    DEFAULT_SURFACE_STYLE,
  )
  const sanitizedBucketSurface = sanitizeSurfaceStyle(candidate.bucketSurface)
  const bucketSurface = sanitizedBucketSurface ?? null
  const startedAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : null
  const rawBaseElapsed = typeof candidate.baseElapsed === 'number' ? candidate.baseElapsed : 0
  const baseElapsed = Number.isFinite(rawBaseElapsed) ? Math.max(0, rawBaseElapsed) : 0
  const rawCommittedElapsed = typeof candidate.committedElapsed === 'number' ? candidate.committedElapsed : 0
  const committedElapsed = Number.isFinite(rawCommittedElapsed) ? Math.max(0, rawCommittedElapsed) : 0
  const rawIsRunning = Boolean(candidate.isRunning)
  const isRunning = rawIsRunning
  const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()
  return {
    taskName,
    goalName,
    bucketName,
    goalId,
    bucketId,
    taskId,
    goalSurface,
    bucketSurface,
    startedAt,
    baseElapsed,
    committedElapsed,
    isRunning,
    updatedAt,
  }
}

const readStoredActiveSession = (): ActiveSessionState | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    return sanitizeActiveSession(parsed)
  } catch {
    return null
  }
}

const computeRangeOverview = (
  history: HistoryEntry[],
  range: ReflectionRangeKey,
  taskLookup: GoalLookup,
  goalColorLookup: Map<string, GoalColorInfo | undefined>,
  lifeRoutineSurfaceLookup: Map<string, SurfaceStyle>,
  options?: { windowStartMs?: number; nowMs?: number },
): { segments: PieSegment[]; windowMs: number; loggedMs: number } => {
  const now = Number.isFinite(options?.nowMs as number) ? Number(options?.nowMs) : Date.now()
  const defaultWindowMs = RANGE_DEFS[range]?.durationMs ?? 0
  const customStart = Number.isFinite(options?.windowStartMs as number)
  if (!customStart && !Number.isFinite(defaultWindowMs)) {
    return { segments: [], windowMs: 0, loggedMs: 0 }
  }
  const windowStart = customStart ? (options?.windowStartMs as number) : Math.max(0, now - defaultWindowMs)
  const windowMs = customStart ? Math.max(0, now - windowStart) : defaultWindowMs
  const safeWindowMs = windowMs > 0 && Number.isFinite(windowMs) ? windowMs : 1
  const totals = new Map<
    string,
    {
      durationMs: number
      colorInfo?: GoalColorInfo
    }
  >()

  history.forEach((entry) => {
    const start = Math.min(entry.startedAt, entry.endedAt)
    const end = Math.max(entry.startedAt, entry.endedAt)
    // All-day blocks distort the time-of-day breakdown; omit them from the overview pie
    if (isAllDayRangeTs(start, end)) {
      return
    }
    if (end <= windowStart || start >= now) {
      return
    }
    const clampedStart = Math.max(start, windowStart)
    const clampedEnd = Math.min(end, now)
    const overlapMs = Math.max(0, clampedEnd - clampedStart)
    if (overlapMs <= 0) {
      return
    }
    const metadata = resolveGoalMetadata(entry, taskLookup, goalColorLookup, lifeRoutineSurfaceLookup)
    const current = totals.get(metadata.label)
    if (current) {
      current.durationMs += overlapMs
    } else {
      totals.set(metadata.label, { durationMs: overlapMs, colorInfo: metadata.colorInfo })
    }
  })

  let segments = Array.from(totals.entries()).map(([label, info]) => ({
    label,
    durationMs: info.durationMs,
    colorInfo: info.colorInfo,
  }))

  segments.sort((a, b) => b.durationMs - a.durationMs)

  let loggedMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0)

  if (loggedMs > windowMs && loggedMs > 0) {
    const scale = windowMs / loggedMs
    segments = segments.map((segment) => ({
      ...segment,
      durationMs: segment.durationMs * scale,
    }))
    loggedMs = windowMs
  }

  const pieSegments: PieSegment[] = segments.map((segment) => {
    const gradient = segment.colorInfo?.gradient
    const solid = segment.colorInfo?.solidColor
    const baseColor = gradient?.start ?? solid ?? getPaletteColorForLabel(segment.label)
    const swatch = gradient?.css ?? baseColor
    const slug = segment.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'segment'
    const id = `${slug}-${Math.abs(hashString(segment.label))}`
    return {
      id,
      label: segment.label,
      durationMs: segment.durationMs,
      fraction: Math.min(Math.max(segment.durationMs / safeWindowMs, 0), 1),
      swatch,
      baseColor,
      gradient,
      colorInfo: segment.colorInfo,
    }
  })

  const loggedMsTotal = pieSegments.reduce((sum, segment) => sum + segment.durationMs, 0)
  const unloggedMs = Math.max(windowMs - loggedMsTotal, 0)

  if (unloggedMs > 0) {
    pieSegments.push({
      id: 'unlogged',
      label: 'Unlogged Time',
      durationMs: unloggedMs,
      fraction: unloggedMs / windowMs,
      swatch: 'var(--reflection-chart-unlogged)',
      baseColor: 'var(--reflection-chart-unlogged)',
      isUnlogged: true,
    })
  }

  return {
    segments: pieSegments,
    windowMs,
    loggedMs: Math.min(loggedMs, windowMs),
  }
}

export default function ReflectionPage() {
  type CalendarViewMode = 'day' | '3d' | 'week' | 'month' | 'year'
  const [calendarView, setCalendarView] = useState<CalendarViewMode>('3d')
  // No explicit visibility gating; transforms are guarded until measured
  const [multiDayCount, setMultiDayCount] = useState<number>(6)
  const [showMultiDayChooser, setShowMultiDayChooser] = useState(false)
  const [historyDayOffset, setHistoryDayOffset] = useState(0)
  const historyDayOffsetRef = useRef(historyDayOffset)
  const multiChooserRef = useRef<HTMLDivElement | null>(null)
  const lastCalendarHotkeyRef = useRef<{ key: string; timestamp: number } | null>(null)
  // Defer clearing the calendar title override until the anchor date has updated
  const pendingTitleClearRef = useRef<number | null>(null)
  // Queue for month/year carousel keypresses while an animation is active
  const monthYearNavQueueRef = useRef(0)
  const multiDayKeyboardStateRef = useRef<{ active: boolean; selection: number }>({
    active: false,
    selection: multiDayCount,
  })
  const calendarDaysAreaRef = useRef<HTMLDivElement | null>(null)
  const calendarDaysRef = useRef<HTMLDivElement | null>(null)
  const calendarHeadersRef = useRef<HTMLDivElement | null>(null)
  // Track for all-day events row so it pans in sync with days/headers
  const calendarAllDayRef = useRef<HTMLDivElement | null>(null)
  const calendarBaseTranslateRef = useRef<number>(0)
  const calendarDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startTime: number
    areaWidth: number
    dayCount: number
    baseOffset: number
    mode: 'pending' | 'hdrag'
    lastAppliedDx: number
    isTouch?: boolean
  } | null>(null)
  const calendarPanCleanupRef = useRef<((shouldCommit: boolean) => void) | null>(null)
  const calendarPanFallbackTimeoutRef = useRef<number | null>(null)
  const calendarPanDesiredOffsetRef = useRef<number>(historyDayOffset)
  // Repeating sessions (rules fetched from backend)
  const [repeatingRules, setRepeatingRules] = useState<RepeatingSessionRule[]>([])
  const [historyOwnerSignal, setHistoryOwnerSignal] = useState(0)
  const historyOwnerId = useMemo(() => readHistoryOwnerId(), [historyOwnerSignal])
  const [accountCreatedAtMs, setAccountCreatedAtMs] = useState<number | null>(null)
  const [accountCreatedAtStatus, setAccountCreatedAtStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'guest'>('idle')
  const [customRecurrenceOpen, setCustomRecurrenceOpen] = useState(false)
  const [customRecurrenceBaseMs, setCustomRecurrenceBaseMs] = useState<number | null>(null)
  const [customRecurrenceEntry, setCustomRecurrenceEntry] = useState<HistoryEntry | null>(null)
  const [customUnitMenuOpen, setCustomUnitMenuOpen] = useState(false)
  const [customMonthlyMenuOpen, setCustomMonthlyMenuOpen] = useState(false)
  const customUnitMenuRef = useRef<HTMLDivElement | null>(null)
  const customMonthlyMenuRef = useRef<HTMLDivElement | null>(null)
  const [customRecurrenceDraft, setCustomRecurrenceDraft] = useState<CustomRecurrenceDraft>(() => ({
    interval: 1,
    unit: 'week',
    weeklyDays: new Set<number>([new Date().getDay()]),
    monthlyDay: new Date().getDate(),
    monthlyPattern: 'day',
    ends: 'never',
    endDate: (() => {
      const now = new Date()
      now.setDate(now.getDate() + 30)
      return now.toISOString().slice(0, 10)
    })(),
    occurrences: 10,
  }))
  const openCustomRecurrence = useCallback((entry: HistoryEntry | null) => {
    const baseMs = entry?.startedAt ?? null
    setCalendarPreview(null)
    setCustomRecurrenceBaseMs(baseMs)
    setCustomRecurrenceEntry(entry)
    setCustomUnitMenuOpen(false)
    setCustomMonthlyMenuOpen(false)
    setCustomRecurrenceDraft((prev) => {
      const now = Number.isFinite(baseMs as number) ? new Date(baseMs as number) : new Date()
      const nextWeekly = new Set<number>(prev.weeklyDays)
      nextWeekly.add(now.getDay())
      return {
        ...prev,
        weeklyDays: nextWeekly,
        monthlyDay: now.getDate(),
        monthlyPattern: prev.monthlyPattern ?? 'day',
      }
    })
    setCustomRecurrenceOpen(true)
  }, [])
  const closeCustomRecurrence = useCallback(() => {
    setCustomRecurrenceOpen(false)
    setCustomRecurrenceEntry(null)
  }, [])

  const clearCalendarPanFallbackTimeout = useCallback(() => {
    const timeoutId = calendarPanFallbackTimeoutRef.current
    if (timeoutId === null) {
      return
    }
    calendarPanFallbackTimeoutRef.current = null
    if (typeof window !== 'undefined') {
      window.clearTimeout(timeoutId)
    }
  }, [])

  // Load repeating session rules once and refresh when account ownership changes
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
      } catch (err) {
        // ignore local read issues
      }
      if (isGuestOwner) {
        return
      }
      try {
        const rules = await fetchRepeatingSessionRules()
        if (!cancelled && Array.isArray(rules)) {
          setRepeatingRules(rules)
          storeRepeatingRulesLocal(rules)
        }
      } catch (err) {
        // Silenced repeating sessions load warning
      }
    }
    void hydrateRepeatingRules()
    return () => {
      cancelled = true
    }
  }, [historyOwnerSignal])

  const stopCalendarPanAnimation = useCallback(
    (options?: { commit?: boolean }) => {
      clearCalendarPanFallbackTimeout()
      const cleanup = calendarPanCleanupRef.current
      if (!cleanup) return
      calendarPanCleanupRef.current = null
      cleanup(options?.commit ?? true)
    },
    [clearCalendarPanFallbackTimeout],
  )
  const resetCalendarPanTransform = useCallback(() => {
    const base = calendarBaseTranslateRef.current
    if (!Number.isFinite(base)) {
      return
    }
    const daysEl = calendarDaysRef.current
    const allDayEl = calendarAllDayRef.current
    if (daysEl) {
      daysEl.style.transform = `translateX(${base}px)`
    }
    const hdrEl = calendarHeadersRef.current
    if (hdrEl) {
      hdrEl.style.transform = `translateX(${base}px)`
    }
    if (allDayEl) {
      allDayEl.style.transform = `translateX(${base}px)`
    }
  }, [])
  const focusMultiDayOption = useCallback((value: number) => {
    const chooser = multiChooserRef.current
    if (!chooser) {
      return
    }
    const button = chooser.querySelector<HTMLButtonElement>(`button[data-day-count="${value}"]`)
    if (button) {
      button.focus()
    }
  }, [])

  const animateCalendarPan = useCallback(
    (snapDays: number, dayWidth: number, baseOffset: number) => {
      const targetOffset = baseOffset - snapDays
      calendarPanDesiredOffsetRef.current = targetOffset
      historyDayOffsetRef.current = targetOffset
      const daysEl = calendarDaysRef.current
      const hdrEl = calendarHeadersRef.current
      const allDayEl = calendarAllDayRef.current
      if (!daysEl || !hdrEl || !Number.isFinite(dayWidth) || dayWidth <= 0) {
        if (targetOffset !== baseOffset) {
          setHistoryDayOffset(targetOffset)
        }
        return
      }

      if (snapDays === 0) {
        stopCalendarPanAnimation({ commit: false })
        const baseTransform = calendarBaseTranslateRef.current
        daysEl.style.transition = ''
        hdrEl.style.transition = ''
        if (allDayEl) allDayEl.style.transition = ''
        daysEl.style.transform = `translateX(${baseTransform}px)`
        hdrEl.style.transform = `translateX(${baseTransform}px)`
        if (allDayEl) allDayEl.style.transform = `translateX(${baseTransform}px)`
        return
      }

      const baseTransform = calendarBaseTranslateRef.current
      const endTransform = baseTransform + snapDays * dayWidth

      const parseCurrentTransform = (value: string): number => {
        const match = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(value)
        if (!match) return baseTransform
        const parsed = Number(match[1])
        return Number.isFinite(parsed) ? parsed : baseTransform
      }

      const currentTransform = parseCurrentTransform(daysEl.style.transform)
      const deltaPx = endTransform - currentTransform
      if (Math.abs(deltaPx) < 0.5) {
        daysEl.style.transition = ''
        hdrEl.style.transition = ''
        if (allDayEl) allDayEl.style.transition = ''
        daysEl.style.transform = `translateX(${baseTransform}px)`
        hdrEl.style.transform = `translateX(${baseTransform}px)`
        if (allDayEl) allDayEl.style.transform = `translateX(${baseTransform}px)`
        if (targetOffset !== baseOffset) {
          setHistoryDayOffset(targetOffset)
        }
        return
      }

      stopCalendarPanAnimation()
      const distanceFactor = Math.min(1.8, Math.max(1, Math.abs(deltaPx) / Math.max(dayWidth, 1)))
      const duration = Math.round(
        Math.min(PAN_MAX_ANIMATION_MS, Math.max(PAN_MIN_ANIMATION_MS, PAN_MIN_ANIMATION_MS * distanceFactor)),
      )
      const easing = 'cubic-bezier(0.22, 0.72, 0.28, 1)'

      const finalize = (shouldCommit: boolean) => {
        daysEl.style.transition = ''
        hdrEl.style.transition = ''
        if (allDayEl) allDayEl.style.transition = ''
        if (!shouldCommit || snapDays === 0) {
          daysEl.style.transform = `translateX(${baseTransform}px)`
          hdrEl.style.transform = `translateX(${baseTransform}px)`
          if (allDayEl) allDayEl.style.transform = `translateX(${baseTransform}px)`
          calendarPanDesiredOffsetRef.current = baseOffset
          historyDayOffsetRef.current = baseOffset
        } else {
          calendarPanDesiredOffsetRef.current = targetOffset
          historyDayOffsetRef.current = targetOffset
          if (targetOffset !== baseOffset) {
            if (typeof flushSync === 'function') {
              flushSync(() => {
                setHistoryDayOffset(targetOffset)
              })
            } else {
              setHistoryDayOffset(targetOffset)
            }
          }
          calendarBaseTranslateRef.current = baseTransform
          // Leave the transform at endTransform temporarily; the next layout effect will
          // reapply the base translate with the updated window data to avoid a visible flicker.
        }
      }

      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.propertyName !== 'transform') {
          return
        }
        daysEl.removeEventListener('transitionend', onTransitionEnd)
        calendarPanCleanupRef.current = null
        finalize(true)
      }

      calendarPanCleanupRef.current = (shouldCommit: boolean) => {
        clearCalendarPanFallbackTimeout()
        daysEl.removeEventListener('transitionend', onTransitionEnd)
        finalize(shouldCommit)
      }

      // Start animation on next frame to ensure transition registers
      requestAnimationFrame(() => {
        daysEl.style.transition = `transform ${duration}ms ${easing}`
        hdrEl.style.transition = `transform ${duration}ms ${easing}`
        if (allDayEl) allDayEl.style.transition = `transform ${duration}ms ${easing}`
        daysEl.style.transform = `translateX(${endTransform}px)`
        hdrEl.style.transform = `translateX(${endTransform}px)`
        if (allDayEl) allDayEl.style.transform = `translateX(${endTransform}px)`
      })

      daysEl.addEventListener('transitionend', onTransitionEnd)
      clearCalendarPanFallbackTimeout()
      const timeoutId = window.setTimeout(() => {
        if (calendarPanFallbackTimeoutRef.current !== timeoutId) {
          return
        }
        calendarPanFallbackTimeoutRef.current = null
        const cleanup = calendarPanCleanupRef.current
        if (!cleanup) {
          return
        }
        calendarPanCleanupRef.current = null
        cleanup(true)
      }, duration + 60)
      calendarPanFallbackTimeoutRef.current = timeoutId
    },
    [stopCalendarPanAnimation, setHistoryDayOffset, clearCalendarPanFallbackTimeout],
  )

  const resolvePanSnap = useCallback(
    (
      state: { baseOffset: number; startTime: number; dayCount: number; isTouch?: boolean; mode?: 'pending' | 'hdrag' },
      dx: number,
      dayWidth: number,
      view: CalendarViewMode,
      appliedDx?: number,
    ) => {
      const hasDayWidth = Number.isFinite(dayWidth) && dayWidth > 0
      const effectiveDx = hasDayWidth
        ? Number.isFinite(appliedDx)
          ? appliedDx!
          : clampPanDelta(dx, dayWidth, state.dayCount)
        : 0
      const rawDays = hasDayWidth ? effectiveDx / dayWidth : 0
      const chunkSize = state.dayCount > 0 ? state.dayCount : 1
      const snapUnitSpan = view === '3d'
        ? 1
        : chunkSize <= 1
          ? 1
          : chunkSize
      const effectiveRaw = snapUnitSpan === 1 ? rawDays : rawDays / snapUnitSpan
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsedMs = Math.max(now - state.startTime, 1)
      const absRaw = Math.abs(effectiveRaw)
      const direction = effectiveRaw >= 0 ? 1 : -1

      if (view !== '3d') {
        // Day/week: always page by at least one chunk based on swipe direction (no half-threshold)
        const steps = Math.max(1, Math.round(absRaw + 0.1))
        const snap = direction * steps * snapUnitSpan
        const targetOffset = state.baseOffset - snap
        return { snap, targetOffset }
      }

      const quickTouchFling = Boolean(state.isTouch) && state.mode === 'hdrag' && (elapsedMs < 450 || absRaw > 0.2)
      let snapUnits: number
      if (quickTouchFling) {
        // Fast swipe: always advance at least one chunk in the swipe direction (no snap-back on fling)
        const steps = Math.max(1, Math.round(absRaw + 0.2))
        snapUnits = direction * steps
      } else {
        // Controlled drag: snap only if past halfway into the next chunk
        snapUnits = absRaw >= 0.5 ? direction * Math.max(1, Math.round(absRaw)) : 0
      }

      const snap = snapUnits * snapUnitSpan
      const targetOffset = state.baseOffset - snap
      return { snap, targetOffset }
    },
    [],
  )
  const [activeRange, setActiveRange] = useState<ReflectionRangeKey>('24h')
  // Snapback overview uses its own range and defaults to All Time
  const [snapActiveRange] = useState<SnapRangeKey>('all')
  const [history, setHistory] = useState<HistoryEntry[]>(() => readPersistedHistory())
  const [repeatingExceptions, setRepeatingExceptions] = useState<RepeatingException[]>(() => readRepeatingExceptions())
  const latestHistoryRef = useRef(history)
  const goalsSnapshotSignatureRef = useRef<string | null>(null)
  const skipNextGoalsSnapshotRef = useRef(false)
  const editorOpenRef = useRef(false)
  const [goalsSnapshot, setGoalsSnapshot] = useState<GoalSnapshot[]>(() => {
    const stored = readStoredGoalsSnapshot()
    goalsSnapshotSignatureRef.current = JSON.stringify(stored)
    return stored
  })
  const taskNoteOverlayCacheRef = useRef<Map<string, { note: string; entry: HistoryEntry }>>(new Map())
  const [lifeRoutineTasks, setLifeRoutineTasks] = useState<LifeRoutineConfig[]>(() => readStoredLifeRoutines())
  const initialLifeRoutineCountRef = useRef(lifeRoutineTasks.length)
  const [activeSession, setActiveSession] = useState<ActiveSessionState | null>(() => readStoredActiveSession())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [pendingNewHistoryId, setPendingNewHistoryId] = useState<string | null>(null)
  const [hoveredHistoryId, setHoveredHistoryId] = useState<string | null>(null)
  const [historyDraft, setHistoryDraft] = useState<HistoryDraftState>(() => createEmptyHistoryDraft())
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null)
  const historyDraftRef = useRef<HistoryDraftState | null>(null)
  const pendingHistorySubtaskFocusRef = useRef<{ entryId: string; subtaskId: string } | null>(null)
  const [revealedHistoryDeleteKey, setRevealedHistoryDeleteKey] = useState<string | null>(null)
  const previousHistorySubtaskIdsRef = useRef<Set<string>>(new Set())
  const historySubtaskIdsInitializedRef = useRef(false)
  const [subtasksCache, setSubtasksCache] = useState<Map<string, HistorySubtask[]>>(() => new Map())
  const subtasksCacheRef = useRef<Map<string, HistorySubtask[]>>(subtasksCache)
  const subtaskFetchesInFlightRef = useRef<Set<string>>(new Set())
  const cachedDraftSubtasksRef = useRef<Map<string, HistorySubtask[]>>(new Map())
  // When set, shows a modal editor for a calendar entry
  const [calendarEditorEntryId, setCalendarEditorEntryId] = useState<string | null>(null)
  const [hoveredDuringDragId, setHoveredDuringDragId] = useState<string | null>(null)
  const pieCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // Ref to the live-updating current-time line in the calendar view (DOM-updated to avoid React re-renders)
  const calendarNowLineRef = useRef<HTMLDivElement | null>(null)
  const [supportsConicGradient, setSupportsConicGradient] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }
    const context = document.createElement('canvas').getContext('2d')
    return Boolean(context && 'createConicGradient' in context)
  })
  const [themeToken, setThemeToken] = useState(() => {
    if (typeof document === 'undefined') {
      return 'dark'
    }
    return document.documentElement.getAttribute('data-theme') ?? 'dark'
  })
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const timelineBarRef = useRef<HTMLDivElement | null>(null)
  const activeTooltipRef = useRef<HTMLDivElement | null>(null)
  const editingTooltipRef = useRef<HTMLDivElement | null>(null)
  const historyCalendarRef = useRef<HTMLDivElement | null>(null)
  // Month/Year carousel root for programmatic keyboard navigation animations
  const monthYearCarouselRef = useRef<HTMLDivElement | null>(null)
  const handlePrevWindowRef = useRef<() => void>(() => {})
  const handleNextWindowRef = useRef<() => void>(() => {})
  // Ref to the calendar editor panel so global outside-click handlers don't cancel edits when interacting with the modal
  const [calendarInspectorEntryId, setCalendarInspectorEntryId] = useState<string | null>(null)
const calendarEditorRef = useRef<HTMLDivElement | null>(null)
const calendarInspectorRef = useRef<HTMLDivElement | null>(null)
const historyBlockRef = useRef<HTMLDivElement | null>(null)
const [calendarViewportVersion, setCalendarViewportVersion] = useState(0)
const [showInspectorExtras, setShowInspectorExtras] = useState(false)
const [showEditorExtras, setShowEditorExtras] = useState(false)
const [showInlineExtras, setShowInlineExtras] = useState(false)
  const [inspectorFallbackMessage, setInspectorFallbackMessage] = useState<string | null>(null)
  useEffect(() => {
    editorOpenRef.current = Boolean(calendarEditorEntryId || calendarInspectorEntryId)
  }, [calendarEditorEntryId, calendarInspectorEntryId])
  const calendarTouchAction = useMemo(
    () => (calendarView === '3d' ? 'pan-x pan-y' : 'pan-y'),
    [calendarView],
  )
  // Ref to the session name input inside the calendar editor modal (for autofocus on new entries)
  const calendarEditorNameInputRef = useRef<HTMLInputElement | null>(null)

  const [activeTooltipOffsets, setActiveTooltipOffsets] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [activeTooltipPlacement, setActiveTooltipPlacement] = useState<'above' | 'below'>('above')
  const dragStateRef = useRef<DragState | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const dragPreviewRef = useRef<DragPreview | null>(null)
  const calendarEventDragRef = useRef<CalendarEventDragState | null>(null)
  const dragPreventClickRef = useRef(false)
  const selectedHistoryIdRef = useRef<string | null>(selectedHistoryId)
  // Long-press to move on touch
  const longPressTimerRef = useRef<number | null>(null)
  const longPressPointerIdRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const longPressCancelHandlersRef = useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
    cancel: (e: PointerEvent) => void
  } | null>(null)
  // Double-tap (touch) to edit
  const lastTapRef = useRef<{ time: number; id: string; x: number; y: number } | null>(null)
  const lastTapTimeoutRef = useRef<number | null>(null)
  // One-time auto-fill guard for session name when selecting Life Routine bucket
  const taskNameAutofilledRef = useRef(false)
  const lastCommittedHistoryDraftRef = useRef<HistoryDraftState | null>(null)
  const autoCommitFrameRef = useRef<number | null>(null)
  // Mouse pre-drag detection to preserve click/double-click semantics
  const mousePreDragRef = useRef<{
    pointerId: number
    startX: number
    segment: TimelineSegment
  } | null>(null)
  const mousePreDragHandlersRef = useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
  } | null>(null)

  const clearLongPressWatch = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      try { window.clearTimeout(longPressTimerRef.current) } catch {}
    }
    longPressTimerRef.current = null
    longPressPointerIdRef.current = null
    longPressStartRef.current = null
    const handlers = longPressCancelHandlersRef.current
    if (handlers) {
      window.removeEventListener('pointermove', handlers.move)
      window.removeEventListener('pointerup', handlers.up)
      window.removeEventListener('pointercancel', handlers.cancel)
    }
    longPressCancelHandlersRef.current = null
  }, [])
  // Helper: toggle global scroll lock (prevents page scroll on touch during active event drags)
  const setPageScrollLock = (locked: boolean) => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const body = document.body as HTMLBodyElement & { dataset: DOMStringMap }
    const ua = navigator.userAgent || ''
    const isIOS = /iP(ad|hone|od)/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1)
    if (locked) {
      // If already locked, no-op
      if (body.dataset.scrollLockActive === '1') return
      body.dataset.scrollLockActive = '1'
      const y = (window.scrollY || root.scrollTop || (document.scrollingElement?.scrollTop ?? 0) || 0)
      body.dataset.scrollLockY = String(y)
      if (isIOS) {
        // iOS Safari: avoid position:fixed to prevent address bar/UI jumps; block scrolling via global touchmove preventer
        const preventer: EventListener = (e: Event) => {
          try { e.preventDefault() } catch {}
        }
        ;(window as any).__scrollLockTouchPreventer = preventer
        try { window.addEventListener('touchmove', preventer, { passive: false }) } catch {}
      } else {
        root.classList.add('scroll-lock')
        body.classList.add('scroll-lock')
        // Non-iOS fallback: freeze body to prevent any viewport scroll reliably
        body.style.position = 'fixed'
        body.style.top = `-${y}px`
        body.style.left = '0'
        body.style.right = '0'
        body.style.width = '100%'
        body.style.overflow = 'hidden'
      }
    } else {
      // If not locked, no-op
      if (body.dataset.scrollLockActive !== '1') return
      delete body.dataset.scrollLockActive
      const yStr = body.dataset.scrollLockY || root.dataset.scrollLockY
      delete body.dataset.scrollLockY
      delete root.dataset.scrollLockY
      // Remove iOS touchmove preventer if present
      const preventer = (window as any).__scrollLockTouchPreventer as EventListener | undefined
      if (preventer) {
        try { window.removeEventListener('touchmove', preventer) } catch {}
        delete (window as any).__scrollLockTouchPreventer
      }
      // Restore body styles (for non-iOS fallback)
      if (body.style.position === 'fixed') {
        body.style.position = ''
        body.style.top = ''
        body.style.left = ''
        body.style.right = ''
        body.style.width = ''
        body.style.overflow = ''
        root.classList.remove('scroll-lock')
        body.classList.remove('scroll-lock')
      }
      // Restore scroll position
      const y = yStr ? parseInt(yStr, 10) : (window.scrollY || 0)
      try { window.scrollTo(0, y) } catch {}
    }
  }

  useEffect(() => {
    // Cleanup double-tap timer on unmount
    return () => {
      if (lastTapTimeoutRef.current !== null) {
        try { window.clearTimeout(lastTapTimeoutRef.current) } catch {}
      }
      lastTapTimeoutRef.current = null
      lastTapRef.current = null
      // Cleanup mouse pre-drag handlers
      if (mousePreDragHandlersRef.current) {
        window.removeEventListener('pointermove', mousePreDragHandlersRef.current.move)
        window.removeEventListener('pointerup', mousePreDragHandlersRef.current.up)
      }
      mousePreDragHandlersRef.current = null
      mousePreDragRef.current = null
    }
  }, [])

  useEffect(() => {
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
    dragPreviewRef.current = dragPreview
  }, [dragPreview])

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId
  }, [selectedHistoryId])

  useEffect(() => {
    if (supportsConicGradient || typeof window === 'undefined') {
      return
    }
    const context = document.createElement('canvas').getContext('2d')
    if (context && 'createConicGradient' in context) {
      setSupportsConicGradient(true)
    }
  }, [supportsConicGradient])

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return
    }
    const root = document.documentElement
    const handleMutation = () => {
      setThemeToken(root.getAttribute('data-theme') ?? 'dark')
    }
    const observer = new MutationObserver(handleMutation)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setSelectedHistoryId(null)
    setHoveredHistoryId(null)
    setEditingHistoryId(null)
    setHistoryDraft(createEmptyHistoryDraft())
    setDragPreview(null)
    dragStateRef.current = null
    dragPreviewRef.current = null
    calendarEventDragRef.current = null
  }, [historyDayOffset])

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

  const updateActiveTooltipOffsets = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }
    const tooltipEl = activeTooltipRef.current
    if (!tooltipEl) {
      setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
      return
    }

    const rect = tooltipEl.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const padding = 16

    // Decide whether to anchor below if there isn't enough space above
    const shouldBeBelow = rect.top < padding && rect.bottom < viewportHeight - padding
    if (shouldBeBelow && activeTooltipPlacement !== 'below') {
      setActiveTooltipPlacement('below')
    } else if (!shouldBeBelow && activeTooltipPlacement !== 'above') {
      setActiveTooltipPlacement('above')
    }

    let shiftX = 0
    if (rect.left < padding) {
      shiftX = padding - rect.left
    } else if (rect.right > viewportWidth - padding) {
      shiftX = viewportWidth - padding - rect.right
    }

    let shiftY = 0
    if (rect.top < padding) {
      shiftY = padding - rect.top
    } else {
      const overflowBottom = rect.bottom - (viewportHeight - padding)
      if (overflowBottom > 0) {
        shiftY = -overflowBottom
      }
    }

    setActiveTooltipOffsets((prev) => {
      if (prev.x === shiftX && prev.y === shiftY) {
        return prev
      }
      return { x: shiftX, y: shiftY }
    })
  }, [activeTooltipPlacement])

  const setActiveTooltipNode = useCallback(
    (node: HTMLDivElement | null) => {
      activeTooltipRef.current = node
      if (!node) {
        setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
        return
      }
      updateActiveTooltipOffsets()
    },
    [updateActiveTooltipOffsets],
  )

  const setEditingTooltipNode = useCallback((node: HTMLDivElement | null) => {
    editingTooltipRef.current = node
  }, [])

  const lifeRoutineSurfaceLookup = useMemo(() => {
    const map = new Map<string, SurfaceStyle>()
    lifeRoutineTasks.forEach((routine) => {
      const title = routine.title.trim().toLowerCase()
      if (title) {
        map.set(title, routine.surfaceStyle)
      }
    })
    return map
  }, [lifeRoutineTasks])

  // Snapback Overview rows (Supabase) — available early so we can feed the bucket dropdown
  const [snapDbRows, setSnapDbRows] = useState<DbSnapbackOverview[]>([])
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await apiFetchSnapbackRows()
        if (!cancelled && Array.isArray(rows)) setSnapDbRows(rows)
      } catch (err) {
        logWarn('[Snapback] Failed to load overview rows', err)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const lifeRoutineBucketOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    lifeRoutineTasks.forEach((routine) => {
      const title = routine.title.trim()
      if (!title) {
        return
      }
      const normalized = title.toLowerCase()
      if (seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      result.push(title)
    })
    return result.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [lifeRoutineTasks])

  // Snapback trigger options (as bucket names under the Snapback goal)
  const snapbackTriggerOptions = useMemo(() => {
    const titles = new Set<string>()
    const prefix = 'Snapback • '
    const enDash = ' – '
    const parseReason = (taskName: string): string | null => {
      if (!taskName || !taskName.startsWith(prefix)) return null
      const rest = taskName.slice(prefix.length)
      if (rest.includes(enDash)) return rest.split(enDash).slice(1).join(enDash).trim()
      if (rest.includes(' - ')) return rest.split(' - ').slice(1).join(' - ').trim()
      return null
    }
    // Map base_key -> alias from DB
    const aliasByBase = new Map<string, string>()
    snapDbRows.forEach((row) => {
      if (row.base_key && !row.base_key.startsWith('custom:')) {
        const alias = (row.trigger_name ?? '').trim()
        if (alias) aliasByBase.set(row.base_key, alias)
      }
    })
    // Add history-derived reasons, applying alias from DB when present
    history.forEach((entry) => {
      const reason = parseReason(entry.taskName)
      if (!reason) return
      const key = reason.trim().toLowerCase()
      const label = aliasByBase.get(key) || reason.slice(0, 120)
      if (label) titles.add(label)
    })
    // Include user-defined triggers stored in DB (custom: rows)
    snapDbRows.forEach((row) => {
      if (row.base_key && row.base_key.startsWith('custom:')) {
        const label = (row.trigger_name ?? '').trim()
        if (label) titles.add(label)
      }
    })
    return Array.from(titles).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [history, snapDbRows])

  const updateHistory = useCallback((updater: (current: HistoryEntry[]) => HistoryEntry[]) => {
    setHistory((current) => {
      const next = updater(current)
      if (historiesAreEqual(current, next)) {
        return current
      }
      return persistHistorySnapshot(next)
    })
  }, [])

  const cacheSubtasksForEntry = useCallback((entryId: string, subtasks: HistorySubtask[]) => {
    setSubtasksCache((prev) => {
      const existing = prev.get(entryId)
      if (existing && areHistorySubtasksEqual(existing, subtasks)) {
        return prev
      }
      const next = new Map(prev)
      next.set(entryId, cloneHistorySubtasks(subtasks))
      subtasksCacheRef.current = next
      return next
    })
  }, [])

  const ensureSubtasksFetched = useCallback(
    async (entry: HistoryEntry | null | undefined, options?: { hydrateDraft?: boolean; force?: boolean }) => {
      if (!entry) return
      const cached = subtasksCacheRef.current.get(entry.id)
      const shouldUseCache = cached && !options?.force
      const shouldHydrateDraft = Boolean(options?.hydrateDraft && selectedHistoryEntryRef.current?.id === entry.id)
      const hasLocalSubtaskEdits = (): boolean => {
        if (!shouldHydrateDraft) return false
        const draft = historyDraftRef.current
        const committed = lastCommittedHistoryDraftRef.current
        return Boolean(draft && committed && !areHistoryDraftsEqual(draft, committed))
      }
      if (shouldUseCache && shouldHydrateDraft) {
        if (hasLocalSubtaskEdits()) {
          return
        }
        setHistoryDraft((draftState) => {
          const nextDraft = { ...draftState, subtasks: cloneHistorySubtasks(cached) }
          lastCommittedHistoryDraftRef.current = {
            ...nextDraft,
            subtasks: cloneHistorySubtasks(cached),
          }
          return nextDraft
        })
      }
      if (shouldUseCache) {
        return
      }
      if (subtaskFetchesInFlightRef.current.has(entry.id)) {
        return
      }
      subtaskFetchesInFlightRef.current.add(entry.id)
      try {
        const subtasks = await fetchSubtasksForEntry(entry)
        cacheSubtasksForEntry(entry.id, subtasks)
        if (shouldHydrateDraft && !hasLocalSubtaskEdits()) {
          setHistoryDraft((draftState) => {
            const nextDraft = { ...draftState, subtasks: cloneHistorySubtasks(subtasks) }
            lastCommittedHistoryDraftRef.current = {
              ...nextDraft,
              subtasks: cloneHistorySubtasks(subtasks),
            }
            return nextDraft
          })
        }
      } catch {
      } finally {
        subtaskFetchesInFlightRef.current.delete(entry.id)
      }
    },
    [cacheSubtasksForEntry],
  )

  const computeEntryScheduledStart = useCallback((entry: HistoryEntry): number => {
    const start = new Date(entry.startedAt)
    const minutes = start.getHours() * 60 + start.getMinutes()
    const dayStart = new Date(entry.startedAt)
    dayStart.setHours(0, 0, 0, 0)
    return dayStart.getTime() + minutes * 60000
  }, [])

  useEffect(() => {
    latestHistoryRef.current = history
  }, [history])

  useLayoutEffect(() => {
    historyDraftRef.current = historyDraft
  }, [historyDraft])

  useEffect(() => {
    subtasksCacheRef.current = subtasksCache
  }, [subtasksCache])

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
    if (!historyOwnerId || historyOwnerId === HISTORY_GUEST_USER_ID) {
      setAccountCreatedAtStatus('guest')
      setAccountCreatedAtMs(null)
      return
    }
    let cancelled = false
    setAccountCreatedAtStatus('loading')
    setAccountCreatedAtMs(null)
    const fetchCreatedAt = async () => {
      if (!supabase) {
        if (!cancelled) setAccountCreatedAtStatus('error')
        return
      }
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('created_at')
          .eq('id', historyOwnerId)
          .maybeSingle()
        if (cancelled) {
          return
        }
        const createdAtValue = typeof data?.created_at === 'string' ? data.created_at : null
        if (error || !createdAtValue) {
          setAccountCreatedAtStatus('error')
          return
        }
        const parsed = Date.parse(createdAtValue)
        if (!Number.isFinite(parsed)) {
          setAccountCreatedAtStatus('error')
          return
        }
        setAccountCreatedAtMs(parsed)
        setAccountCreatedAtStatus('ready')
      } catch {
        if (!cancelled) {
          setAccountCreatedAtStatus('error')
        }
      }
    }
    void fetchCreatedAt()
    return () => {
      cancelled = true
    }
  }, [historyOwnerId])

  // Subscribe to repeating exceptions updates
  useEffect(() => {
    setRepeatingExceptions(readRepeatingExceptions())
  const unsub = subscribeRepeatingExceptions((rows: RepeatingException[]) => setRepeatingExceptions(rows))
    return () => {
      unsub?.()
    }
  }, [])

  useEffect(() => {
    const owner = readHistoryOwnerId()
    if (!owner || owner === HISTORY_GUEST_USER_ID) {
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

  const goalLookup = useMemo(() => createGoalTaskMap(goalsSnapshot), [goalsSnapshot])
  const goalColorLookup = useMemo(() => createGoalColorMap(goalsSnapshot), [goalsSnapshot])
  const goalSurfaceLookup = useMemo(() => {
    const map = new Map<string, SurfaceStyle>()
    goalsSnapshot.forEach((goal) => {
      const name = goal.name?.trim()
      if (!name) {
        return
      }
      map.set(name.toLowerCase(), ensureSurfaceStyle(goal.surfaceStyle, DEFAULT_SURFACE_STYLE))
    })
    return map
  }, [goalsSnapshot])
  const taskNotesById = useMemo(() => {
    const map = new Map<string, string>()
    goalsSnapshot.forEach((goal) => {
      goal.buckets.forEach((bucket) => {
        bucket.tasks.forEach((task) => {
          if (!task.id) return
          const raw = (task as any).notes
          if (typeof raw === 'string') {
            map.set(task.id, raw)
          }
        })
      })
    })
    return map
  }, [goalsSnapshot])
  const bucketSurfaceLookup = useMemo(() => {
    const byGoal = new Map<string, SurfaceStyle>()
    const byName = new Map<string, SurfaceStyle>()
    goalsSnapshot.forEach((goal) => {
      const goalName = goal.name?.trim()
      if (!goalName) {
        return
      }
      const goalKey = goalName.toLowerCase()
      const goalSurface = ensureSurfaceStyle(goal.surfaceStyle, DEFAULT_SURFACE_STYLE)
      goal.buckets.forEach((bucket) => {
        const bucketName = bucket.name?.trim()
        if (!bucketName) {
          return
        }
        const bucketKey = bucketName.toLowerCase()
        const bucketSurface = ensureSurfaceStyle(bucket.surfaceStyle, goalSurface)
        const scopedKey = `${goalKey}::${bucketKey}`
        if (!byGoal.has(scopedKey)) {
          byGoal.set(scopedKey, bucketSurface)
        }
        if (!byName.has(bucketKey)) {
          byName.set(bucketKey, bucketSurface)
        }
      })
    })
    return { byGoal, byName }
  }, [goalsSnapshot])
  
  // Respond to schedule requests from Goals page: switch to week view and create a future session 1 hour from now for 1 hour.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: Event) => {
      const detail = (event as ScheduleBroadcastEvent).detail
      if (!detail) return
      // Ensure 6D view
      setActiveRange('7d')
      setCalendarView('3d')
      setMultiDayCount(6)
      // Scroll calendar into view
      setTimeout(() => {
        if (historyBlockRef.current) {
          const element = historyBlockRef.current
          const rect = element.getBoundingClientRect()
          const scrollTop = window.scrollY || document.documentElement.scrollTop
          const elementTop = rect.top + scrollTop
          // Center the element in the viewport
          const targetY = elementTop + (rect.height / 2) - (window.innerHeight / 2)
          window.scrollTo({ top: targetY, behavior: 'smooth' })
        }
      }, 100)
      // Compute a start time one hour from now, snapped to minute
      const now = Date.now()
      const start = Math.max(now + 60 * 60 * 1000, now + 60 * 1000)
      const end = start + 60 * 60 * 1000
      const elapsed = Math.max(1, end - start)
      const goalName = detail.goalName?.trim() ?? ''
      const bucketName = detail.bucketName?.trim() ?? ''
      const goalKey = goalName.toLowerCase()
      const bucketKey = bucketName.toLowerCase()
      const goalSurface = goalKey.length > 0 ? (goalSurfaceLookup.get(goalKey) ?? DEFAULT_SURFACE_STYLE) : DEFAULT_SURFACE_STYLE
      let bucketSurface: SurfaceStyle | null = null
      const scopedBucketKey = `${goalKey}::${bucketKey}`
      if (bucketKey.length > 0) {
        bucketSurface = bucketSurfaceLookup.byGoal.get(scopedBucketKey) ?? bucketSurfaceLookup.byName.get(bucketKey) ?? null
      }
      const entryColor = gradientFromSurface(goalSurface)
      const entry: HistoryEntry = {
        id: makeHistoryId(),
        taskName: detail.taskName,
        goalName: goalName || null,
        bucketName: bucketName || null,
        goalId: detail.goalId || null,
        bucketId: detail.bucketId || null,
        taskId: detail.taskId || null,
        elapsed,
        startedAt: start,
        endedAt: end,
        goalSurface,
        bucketSurface: bucketSurface,
        entryColor,
        notes: '',
        subtasks: [],
        futureSession: true,
      }
      // Close any open editors; do not open an edit panel for scheduled items.
      setInspectorFallbackMessage(null)
      setHoveredHistoryId(null)
      setSelectedHistoryId(null)
      setEditingHistoryId(null)
      setPendingNewHistoryId(null)
      setCalendarEditorEntryId(null)
      setCalendarInspectorEntryId(null)
      updateHistory((current) => {
        const next = current.slice()
        // Binary insert by startedAt to avoid O(n log n) resort of entire array
        let lo = 0
        let hi = next.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (next[mid].startedAt < entry.startedAt) lo = mid + 1
          else hi = mid
        }
        next.splice(lo, 0, entry)
        return next
      })
      // No edit panel: allow the calendar to render the new planned session inline.
    }
    window.addEventListener(SCHEDULE_EVENT_TYPE, handler as EventListener)
    return () => {
      window.removeEventListener(SCHEDULE_EVENT_TYPE, handler as EventListener)
    }
  }, [ENABLE_HISTORY_INSPECTOR_PANEL, goalSurfaceLookup, bucketSurfaceLookup, updateHistory])
  const enhancedGoalLookup = useMemo(() => {
    if (!activeSession || !activeSession.goalName) {
      return goalLookup
    }
    const key = activeSession.taskName?.trim().toLowerCase()
    const goalName = activeSession.goalName.trim()
    if (!key) {
      return goalLookup
    }
    const existing = goalLookup.get(key)
    if (existing && existing.goalName === goalName) {
      return goalLookup
    }
    const map = new Map(goalLookup)
    map.set(key, { goalName, colorInfo: goalColorLookup.get(goalName.toLowerCase()) })
    return map
  }, [goalLookup, goalColorLookup, activeSession])

  const goalOptions = useMemo(() => {
    const normalizedLifeRoutines = LIFE_ROUTINES_NAME.toLowerCase()
    const normalizedSnapback = SNAPBACK_NAME.toLowerCase()
    const seen = new Set<string>()
    const ordered: string[] = []
    goalsSnapshot.forEach((goal) => {
      const trimmed = goal.name?.trim()
      if (!trimmed || goal.archived) {
        return
      }
      const normalized = trimmed.toLowerCase()
      if (normalized === normalizedLifeRoutines || normalized === normalizedSnapback) {
        return
      }
      if (seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      ordered.push(trimmed)
    })
    // Insert Snapback option right after Life Routines
    return [LIFE_ROUTINES_NAME, SNAPBACK_NAME, ...ordered]
  }, [goalsSnapshot])

  const bucketOptionsByGoal = useMemo(() => {
    const map = new Map<string, string[]>()
    goalsSnapshot.forEach((goal) => {
      const goalName = goal.name?.trim()
      if (!goalName || goal.archived) {
        return
      }
      const bucketNames = goal.buckets
        .filter((bucket) => !bucket.archived)
        .map((bucket) => bucket.name?.trim())
        .filter((name): name is string => Boolean(name))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      if (bucketNames.length > 0) {
        map.set(goalName, bucketNames)
      }
    })
    if (lifeRoutineBucketOptions.length > 0) {
      map.set(LIFE_ROUTINES_NAME, lifeRoutineBucketOptions)
    }
    if (snapbackTriggerOptions.length > 0) {
      map.set(SNAPBACK_NAME, snapbackTriggerOptions)
    }
    return map
  }, [goalsSnapshot, lifeRoutineBucketOptions, snapbackTriggerOptions])

  const allBucketOptions = useMemo(() => {
    const set = new Set<string>()
    goalsSnapshot.forEach((goal) => {
      if (goal.archived) return
      goal.buckets.forEach((bucket) => {
        if (bucket.archived) return
        const trimmed = bucket.name?.trim()
        if (trimmed) {
          set.add(trimmed)
        }
      })
    })
    lifeRoutineBucketOptions.forEach((title) => set.add(title))
    snapbackTriggerOptions.forEach((title) => set.add(title))
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [goalsSnapshot, lifeRoutineBucketOptions, snapbackTriggerOptions])

  // Reverse lookup: for a given bucket name (case-insensitive), which goal(s) contain it?
  const bucketToGoals = useMemo(() => {
    const map = new Map<string, string[]>()
    goalsSnapshot.forEach((goal) => {
      const goalName = goal.name?.trim()
      if (!goalName || goal.archived) return
      goal.buckets.forEach((bucket) => {
        const bucketName = bucket.name?.trim()
        if (!bucketName || bucket.archived) return
        const key = bucketName.toLowerCase()
        const arr = map.get(key) ?? []
        if (!arr.includes(goalName)) arr.push(goalName)
        map.set(key, arr)
      })
    })
    // Include Life Routine buckets mapped to the Life Routines pseudo-goal
    lifeRoutineBucketOptions.forEach((title) => {
      const trimmed = title.trim()
      if (!trimmed) return
      const key = trimmed.toLowerCase()
      const arr = map.get(key) ?? []
      if (!arr.includes(LIFE_ROUTINES_NAME)) arr.push(LIFE_ROUTINES_NAME)
      map.set(key, arr)
    })
    // Map Snapback triggers to Snapback pseudo-goal
    snapbackTriggerOptions.forEach((title) => {
      const trimmed = title.trim()
      if (!trimmed) return
      const key = trimmed.toLowerCase()
      const arr = map.get(key) ?? []
      if (!arr.includes(SNAPBACK_NAME)) arr.push(SNAPBACK_NAME)
      map.set(key, arr)
    })
    return map
  }, [goalsSnapshot, lifeRoutineBucketOptions, snapbackTriggerOptions])

  // Tasks by goal and bucket, and a reverse lookup from task text -> owners
  const tasksByGoalBucket = useMemo(() => {
    const byGoalBucket = new Map<string, Map<string, string[]>>()
    goalsSnapshot.forEach((goal) => {
      const goalName = goal.name?.trim()
      if (!goalName || goal.archived) return // skip archived goals
      const bucketMap = byGoalBucket.get(goalName) ?? new Map<string, string[]>()
      goal.buckets.forEach((bucket) => {
        const bucketName = bucket.name?.trim()
        if (!bucketName || bucket.archived) return // skip archived buckets
        const list = bucketMap.get(bucketName) ?? []
        bucket.tasks.forEach((task) => {
          if (task.completed) return // only show active (not completed) tasks
          const text = task.text?.trim()
          if (text && !list.includes(text)) list.push(text)
        })
        list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        bucketMap.set(bucketName, list)
      })
      byGoalBucket.set(goalName, bucketMap)
    })
    return byGoalBucket
  }, [goalsSnapshot])

  const allTaskOptions = useMemo(() => {
    const set = new Set<string>()
    goalsSnapshot.forEach((goal) => {
      if (goal.archived) return
      goal.buckets.forEach((bucket) => {
        if (bucket.archived) return
        bucket.tasks.forEach((task) => {
          if (task.completed) return // exclude completed tasks
          const text = task.text?.trim()
          if (text) set.add(text)
        })
      })
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [goalsSnapshot])

  type TaskOwner = { goalName: string; bucketName: string }
  const taskToOwners = useMemo(() => {
    const map = new Map<string, TaskOwner[]>()
    goalsSnapshot.forEach((goal) => {
      const gName = goal.name?.trim()
      if (!gName || goal.archived) return
      goal.buckets.forEach((bucket) => {
        const bName = bucket.name?.trim()
        if (!bName || bucket.archived) return
        bucket.tasks.forEach((task) => {
          if (task.completed) return // only map active tasks
          const key = task.text?.trim().toLowerCase()
          if (!key) return
          const owners = map.get(key) ?? []
          if (!owners.some((o) => o.goalName === gName && o.bucketName === bName)) {
            owners.push({ goalName: gName, bucketName: bName })
          }
          map.set(key, owners)
        })
      })
    })
    return map
  }, [goalsSnapshot])

  // Lookup bucket id from goal+bucket names (for creating a task)
  const bucketIdLookup = useMemo(() => {
    const map = new Map<string, string>() // key: `${goalName.toLowerCase()}::${bucketName.toLowerCase()}` -> bucketId
    goalsSnapshot.forEach((goal) => {
      if (goal.archived) return
      const gName = goal.name?.trim()
      if (!gName) return
      goal.buckets.forEach((bucket) => {
        if (bucket.archived) return
        const bName = bucket.name?.trim()
        if (!bName) return
        const key = `${gName.toLowerCase()}::${bName.toLowerCase()}`
        if (!map.has(key)) {
          map.set(key, bucket.id)
        }
      })
    })
    return map
  }, [goalsSnapshot])

  const goalIdLookup = useMemo(() => {
    const map = new Map<string, string>()
    goalsSnapshot.forEach((goal) => {
      const gName = goal.name?.trim()
      if (!gName || goal.archived) return
      const key = gName.toLowerCase()
      if (!map.has(key)) {
        map.set(key, goal.id)
      }
    })
    return map
  }, [goalsSnapshot])

  // Lookup task id from goal+bucket+task name (case-insensitive)
  const taskIdLookup = useMemo(() => {
    const map = new Map<string, string>() // key: `${goal.toLowerCase()}::${bucket.toLowerCase()}::${task.toLowerCase()}` -> taskId
    goalsSnapshot.forEach((goal) => {
      if (goal.archived) return
      const gName = goal.name?.trim()
      if (!gName) return
      goal.buckets.forEach((bucket) => {
        if (bucket.archived) return
        const bName = bucket.name?.trim()
        if (!bName) return
        bucket.tasks.forEach((task) => {
          if (task.completed) return
          const tName = task.text?.trim()
          if (!tName) return
          const key = `${gName.toLowerCase()}::${bName.toLowerCase()}::${tName.toLowerCase()}`
          if (!map.has(key)) map.set(key, task.id)
        })
      })
    })
    return map
  }, [goalsSnapshot])

  const trimmedDraftGoal = historyDraft.goalName.trim()
  const trimmedDraftBucket = historyDraft.bucketName.trim()

  const availableBucketOptions = useMemo(() => {
    if (trimmedDraftGoal.length > 0) {
      const match = bucketOptionsByGoal.get(trimmedDraftGoal)
      if (match && match.length > 0) {
        return match
      }
    }
    return allBucketOptions
  }, [trimmedDraftGoal, bucketOptionsByGoal, allBucketOptions])

  const resolvedGoalOptions = useMemo(() => {
    if (trimmedDraftGoal.length > 0 && !goalOptions.includes(trimmedDraftGoal)) {
      return [trimmedDraftGoal, ...goalOptions]
    }
    return goalOptions
  }, [goalOptions, trimmedDraftGoal])

  const resolvedBucketOptions = useMemo(() => {
    if (trimmedDraftBucket.length > 0 && !availableBucketOptions.includes(trimmedDraftBucket)) {
      return [trimmedDraftBucket, ...availableBucketOptions]
    }
    return availableBucketOptions
  }, [availableBucketOptions, trimmedDraftBucket])

  const availableTaskOptions = useMemo(() => {
    // Prefer bucket -> goal -> all
    if (trimmedDraftGoal.length > 0 && trimmedDraftBucket.length > 0) {
      const tasks = tasksByGoalBucket.get(trimmedDraftGoal)?.get(trimmedDraftBucket)
      if (tasks && tasks.length > 0) return tasks
    }
    if (trimmedDraftGoal.length > 0) {
      const bucketMap = tasksByGoalBucket.get(trimmedDraftGoal)
      if (bucketMap) {
        const merged = new Set<string>()
        bucketMap.forEach((list) => list.forEach((t) => merged.add(t)))
        if (merged.size > 0) return Array.from(merged).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      }
    }
    return allTaskOptions
  }, [trimmedDraftGoal, trimmedDraftBucket, tasksByGoalBucket, allTaskOptions])

  const taskDropdownOptions = useMemo<HistoryDropdownOption[]>(() => {
    const options: HistoryDropdownOption[] = [{ value: '', label: 'No task' }]
    const name = historyDraft.taskName.trim()
    const goal = historyDraft.goalName.trim()
    const bucket = historyDraft.bucketName.trim()
    const isLifeRoutine = goal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()
    const taskExistsInBucket =
      goal.length > 0 && bucket.length > 0
        ? (tasksByGoalBucket.get(goal)?.get(bucket)?.some((t) => t.toLowerCase() === name.toLowerCase()) ?? false)
        : false
    const bucketKey = `${goal.toLowerCase()}::${bucket.toLowerCase()}`
    const hasBucketId = bucketIdLookup.has(bucketKey)
    const canOfferCreate =
      name.length > 0 && goal.length > 0 && bucket.length > 0 && hasBucketId && !isLifeRoutine && !taskExistsInBucket
    if (canOfferCreate) {
      // Add a clear header for the create action
      options.push({ value: '__hdr_create__', label: 'Create from session', disabled: true })
      const label = `➕ Add as new task: “${name}” → ${goal} › ${bucket}`
      options.push({ value: '__add_session_task__', label })
      if (availableTaskOptions.length > 0) {
        options.push({ value: '__hdr_existing__', label: 'Existing tasks', disabled: true })
      }
    }
    options.push(...availableTaskOptions.map((option) => ({ value: option, label: option })))
    return options
  }, [availableTaskOptions, historyDraft.taskName, historyDraft.goalName, historyDraft.bucketName, tasksByGoalBucket, bucketIdLookup])

  

  const goalDropdownId = useId()
  const bucketDropdownId = useId()
  const taskDropdownId = useId()
  const goalDropdownLabelId = `${goalDropdownId}-label`
  const bucketDropdownLabelId = `${bucketDropdownId}-label`
  const taskDropdownLabelId = `${taskDropdownId}-label`
  const subtaskSaveTimersRef = useRef<Map<string, number>>(new Map())

  const goalDropdownOptions = useMemo<HistoryDropdownOption[]>(() => {
    const normalizedLifeRoutines = LIFE_ROUTINES_NAME.toLowerCase()
    const normalizedSnapback = SNAPBACK_NAME.toLowerCase()
    const optionsWithoutSpecial = resolvedGoalOptions.filter((option) => {
      const lower = option.trim().toLowerCase()
      return lower !== normalizedLifeRoutines && lower !== normalizedSnapback
    })
    const hasLifeOption =
      resolvedGoalOptions.some((option) => option.trim().toLowerCase() === normalizedLifeRoutines) ||
      lifeRoutineBucketOptions.length > 0
    const next: HistoryDropdownOption[] = [{ value: '', label: 'No goal' }]
    if (hasLifeOption) {
      next.push({ value: LIFE_ROUTINES_NAME, label: LIFE_ROUTINES_NAME })
    }
    // Include Snapback once, under Life Routines
    next.push({ value: SNAPBACK_NAME, label: SNAPBACK_NAME })
    optionsWithoutSpecial.forEach((option) => {
      next.push({ value: option, label: option })
    })
    return next
  }, [lifeRoutineBucketOptions, resolvedGoalOptions])

  const bucketDropdownOptions = useMemo<HistoryDropdownOption[]>(
    () => [
      { value: '', label: 'No bucket' },
      ...resolvedBucketOptions.map((option) => ({ value: option, label: option })),
    ],
    [resolvedBucketOptions],
  )

  const historyWithTaskNotes = useMemo(() => {
    if (editorOpenRef.current) {
      return history
    }
    if (taskNotesById.size === 0) {
      return history
    }
    let overlays = 0
    const cache = taskNoteOverlayCacheRef.current
    const mapped = history.map((entry) => {
      if (entry.taskId) {
        const taskNote = taskNotesById.get(entry.taskId)
        if (taskNote !== undefined && taskNote !== entry.notes) {
          overlays += 1
          const cached = cache.get(entry.id)
          const isStale =
            !cached ||
            cached.note !== taskNote ||
            cached.entry.startedAt !== entry.startedAt ||
            cached.entry.endedAt !== entry.endedAt ||
            cached.entry.elapsed !== entry.elapsed ||
            cached.entry.goalName !== entry.goalName ||
            cached.entry.bucketName !== entry.bucketName ||
            cached.entry.taskName !== entry.taskName ||
            cached.entry.goalId !== entry.goalId ||
            cached.entry.bucketId !== entry.bucketId ||
            cached.entry.taskId !== entry.taskId ||
            cached.entry.futureSession !== entry.futureSession ||
            (cached.entry.repeatingSessionId ?? null) !== (entry.repeatingSessionId ?? null) ||
            (cached.entry.originalTime ?? null) !== (entry.originalTime ?? null)
          if (!isStale) {
            return cached.entry
          }
          const overlaid = { ...entry, notes: taskNote ?? '' }
          cache.set(entry.id, { note: taskNote ?? '', entry: overlaid })
          return overlaid
        }
      }
      return entry
    })
    if (overlays === 0) {
      cache.clear()
    }
    return mapped
  }, [history, taskNotesById])

  const selectedHistoryEntry = useMemo(() => {
    if (!selectedHistoryId) {
      return null
    }
    const match = historyWithTaskNotes.find((entry) => entry.id === selectedHistoryId)
    return match ?? null
  }, [historyWithTaskNotes, selectedHistoryId])
  const selectedHistoryEntryRef = useRef<HistoryEntry | null>(null)

  useEffect(() => {
    selectedHistoryEntryRef.current = selectedHistoryEntry
    // If we are already editing this entry and have local draft changes, don't clobber them
    if (
      selectedHistoryEntry &&
      historyDraftRef.current &&
      lastCommittedHistoryDraftRef.current &&
      selectedHistoryEntryRef.current?.id === selectedHistoryEntry.id &&
      !areHistoryDraftsEqual(historyDraftRef.current, lastCommittedHistoryDraftRef.current)
    ) {
      return
    }
    if (!selectedHistoryEntry) {
      if (typeof window !== 'undefined' && autoCommitFrameRef.current !== null) {
        window.cancelAnimationFrame(autoCommitFrameRef.current)
        autoCommitFrameRef.current = null
      }
      lastCommittedHistoryDraftRef.current = null
      setEditingHistoryId(null)
      return
    }
    const nextDraft = createHistoryDraftFromEntry(selectedHistoryEntry)
    setHistoryDraft(nextDraft)
    lastCommittedHistoryDraftRef.current = {
      ...nextDraft,
      subtasks: cloneHistorySubtasks(nextDraft.subtasks),
    }
    setEditingHistoryId((current) => (current === selectedHistoryEntry.id ? current : null))
    taskNameAutofilledRef.current = false
  }, [selectedHistoryEntry])

  // Clear any pending subtask save timers when changing selection/unmounting
  useEffect(() => {
    return () => {
      subtaskSaveTimersRef.current.forEach((timerId) => {
        if (typeof window !== 'undefined') {
          window.clearTimeout(timerId)
        }
      })
      subtaskSaveTimersRef.current.clear()
    }
  }, [selectedHistoryEntry?.id])

  useEffect(() => {
    const entry = selectedHistoryEntryRef.current
    if (!entry) return
    const cached = subtasksCacheRef.current.get(entry.id)
    const initialSubtasks =
      cached ?? (Array.isArray(entry.subtasks) && entry.subtasks.length > 0 ? entry.subtasks : null)
    if (initialSubtasks) {
      setHistoryDraft((draftState) => {
        const nextDraft = { ...draftState, subtasks: cloneHistorySubtasks(initialSubtasks) }
        lastCommittedHistoryDraftRef.current = {
          ...nextDraft,
          subtasks: cloneHistorySubtasks(initialSubtasks),
        }
        return nextDraft
      })
    }
    ;(async () => {
      try {
        await ensureSubtasksFetched(entry, { hydrateDraft: true, force: true })
      } catch {}
    })()
  }, [selectedHistoryEntry?.id, ensureSubtasksFetched])

  useEffect(() => {
    if (!editingHistoryId) {
      return
    }
    if (!selectedHistoryEntry || editingHistoryId !== selectedHistoryEntry.id) {
      setEditingHistoryId(null)
      return
    }
  }, [editingHistoryId, selectedHistoryEntry])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const activeTooltipId = hoveredHistoryId ?? selectedHistoryId
    if (!activeTooltipId) {
      setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
      return
    }
    const tooltipEl = activeTooltipRef.current
    if (!tooltipEl) {
      setActiveTooltipOffsets((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }))
      return
    }

    const handleUpdate = () => {
      updateActiveTooltipOffsets()
    }

    handleUpdate()

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => handleUpdate())
      resizeObserver.observe(tooltipEl)
    }

    window.addEventListener('resize', handleUpdate)
    window.addEventListener('scroll', handleUpdate, true)
    const timelineEl = timelineRef.current
    timelineEl?.addEventListener('scroll', handleUpdate)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleUpdate)
      window.removeEventListener('scroll', handleUpdate, true)
      timelineEl?.removeEventListener('scroll', handleUpdate)
    }
  }, [hoveredHistoryId, selectedHistoryId, activeTooltipPlacement, updateActiveTooltipOffsets])

  const handleDeleteHistoryEntry = useCallback(
    (entryId: string) => (
      event:
        | MouseEvent<HTMLButtonElement>
        | ReactPointerEvent<HTMLButtonElement>
        | TouchEvent<HTMLButtonElement>
    ) => {
      event.preventDefault()
      event.stopPropagation()
      startTransition(() => {
        // Delete by id against the latest state to avoid stale-index bugs when multiple events fire
        setHoveredHistoryId((current) => (current === entryId ? null : current))
        setHoveredDuringDragId((current) => (current === entryId ? null : current))
        const deletingInspectorEntry = calendarInspectorEntryId === entryId
        if (selectedHistoryId === entryId) {
          setSelectedHistoryId(null)
          setEditingHistoryId(null)
          setHistoryDraft(createEmptyHistoryDraft())
        }
        if (pendingNewHistoryId === entryId) {
          setPendingNewHistoryId(null)
        }
        if (deletingInspectorEntry) {
          setInspectorFallbackMessage(INSPECTOR_DELETED_MESSAGE)
          setShowInspectorExtras(false)
        }
        // If deleting a confirmed instance of a repeating guide (rescheduled),
        // remove the associated 'rescheduled' exception so the guide re-renders
        // unless another entry for the same occurrence still exists.
        let cleanupRid: string | null = null
        let cleanupOcc: string | null = null
        updateHistory((current) => {
          const idx = current.findIndex((e) => e.id === entryId)
          if (idx === -1) return current
          const target = current[idx] as any
          const rid = typeof target.repeatingSessionId === 'string' ? (target.repeatingSessionId as string) : null
          const ot = (target as any).originalTime as number | undefined | null
          const od = Number.isFinite(ot as number) ? formatLocalYmd(ot as number) : null
          const next = current.filter((e) => e.id !== entryId)
          if (rid && od) {
            const stillConfirmed = next.some((e: any) => {
              const nr = typeof e.repeatingSessionId === 'string' ? e.repeatingSessionId : null
              const no =
                Number.isFinite((e as any).originalTime as number) ? formatLocalYmd((e as any).originalTime as number) : null
              return nr === rid && no === od
            })
            if (!stillConfirmed) { cleanupRid = rid; cleanupOcc = od }
          }
          return next
        })
        if (cleanupRid && cleanupOcc) {
          const rid = cleanupRid
          const occ = cleanupOcc
          // Optimistically update local exception state so the guide re-renders immediately,
          // then perform the durable removal (local persistence + optional remote) in the background.
          setRepeatingExceptions((prev) =>
            (prev as RepeatingException[]).filter(
              (r) => !(r.routineId === rid && r.occurrenceDate === occ && r.action === 'rescheduled'),
            ),
          )
          try {
            void deleteRescheduleExceptionFor(rid, occ)
          } catch {}
        }
      })
    },
    [
      calendarInspectorEntryId,
      pendingNewHistoryId,
      selectedHistoryId,
      setInspectorFallbackMessage,
      setShowInspectorExtras,
      updateHistory,
    ],
  )

  const handleAddHistoryEntry = useCallback(() => {
    const nowDate = new Date()
    const targetDate = new Date()
    targetDate.setHours(0, 0, 0, 0)
    if (historyDayOffset !== 0) {
      targetDate.setDate(targetDate.getDate() + historyDayOffset)
    }
    const timeOfDayMs =
      nowDate.getHours() * 60 * 60 * 1000 +
      nowDate.getMinutes() * 60 * 1000 +
      nowDate.getSeconds() * 1000 +
      nowDate.getMilliseconds()
    const startedAt = targetDate.getTime() + timeOfDayMs
    const defaultDuration = 30 * 60 * 1000
    const endedAt = Math.max(startedAt + defaultDuration, startedAt + MINUTE_MS)
    const elapsed = Math.max(endedAt - startedAt, 1)
    const isFuture = startedAt > Date.now()
    const entry: HistoryEntry = {
      id: makeHistoryId(),
      taskName: 'New session',
      goalName: null,
      bucketName: null,
      goalId: null,
      bucketId: null,
      taskId: null,
      elapsed,
      startedAt,
      endedAt,
      goalSurface: DEFAULT_SURFACE_STYLE,
      bucketSurface: null,
      entryColor: gradientFromSurface(DEFAULT_SURFACE_STYLE),
      notes: '',
      subtasks: [],
      futureSession: isFuture,
    }
    startTransition(() => {
      updateHistory((current) => {
        const next = [...current, entry]
        next.sort((a, b) => a.startedAt - b.startedAt)
        return next
      })
      setInspectorFallbackMessage(null)
      setHoveredHistoryId(null)
      setSelectedHistoryId(entry.id)
      setEditingHistoryId(entry.id)
      setPendingNewHistoryId(entry.id)
      setHistoryDraft(createHistoryDraftFromEntry(entry))
      taskNameAutofilledRef.current = false
      if (ENABLE_HISTORY_INSPECTOR_PANEL) {
        setCalendarInspectorEntryId(entry.id)
        setCalendarEditorEntryId(null)
      } else {
        setCalendarEditorEntryId(entry.id)
        setCalendarInspectorEntryId(null)
      }
    })
  }, [historyDayOffset, setCalendarEditorEntryId, setCalendarInspectorEntryId, setInspectorFallbackMessage, updateHistory])

  const handleSelectHistorySegment = useCallback(
    (entry: HistoryEntry, options?: { preserveSelection?: boolean }) => {
      startTransition(() => {
        if (selectedHistoryId === entry.id) {
          const editorIsOpen = ENABLE_HISTORY_INSPECTOR_PANEL ? calendarInspectorEntryId : calendarEditorEntryId
          if (editorIsOpen || options?.preserveSelection) {
            return
          }
          setSelectedHistoryId(null)
          setEditingHistoryId(null)
          setHistoryDraft(createEmptyHistoryDraft())
          setHoveredHistoryId((current) => (current === entry.id ? null : current))
          return
        }
        setHistoryDraft(() => {
          const base = createHistoryDraftFromEntry(entry)
          base.taskName = deriveEntryTaskName(entry)
          return base
        })
        setSelectedHistoryId(entry.id)
        setEditingHistoryId(null)
      })
    },
    [calendarEditorEntryId, calendarInspectorEntryId, selectedHistoryId],
  )

  const updateHistoryDraftField = useCallback(
    (field: 'taskName' | 'goalName' | 'bucketName', nextValue: string) => {
      setHistoryDraft((draft) => {
        let base = { ...draft, [field]: nextValue }
        if (field === 'taskName') {
          const chosenTask = nextValue.trim()
          if (chosenTask.length > 0) {
            const owners = taskToOwners.get(chosenTask.toLowerCase())
            if (owners && owners.length > 0) {
              const currentGoal = base.goalName.trim()
              const currentBucket = base.bucketName.trim()
              let owner = owners[0]
              if (currentBucket.length > 0) {
                const match = owners.find((o) => o.bucketName.toLowerCase() === currentBucket.toLowerCase())
                if (match) owner = match
              } else if (currentGoal.length > 0) {
                const match = owners.find((o) => o.goalName.toLowerCase() === currentGoal.toLowerCase())
                if (match) owner = match
              }
              base = { ...base, goalName: owner.goalName, bucketName: owner.bucketName }
            }
          }
        }
        // When selecting a bucket, auto-select the corresponding goal if determinable.
        if (field === 'bucketName') {
          const nextBucket = nextValue.trim()
          if (nextBucket.length > 0) {
            const currentGoal = base.goalName.trim()
            const bucketKey = nextBucket.toLowerCase()
            // If current goal already contains this bucket, keep it; otherwise pick a goal that owns it.
            const currentGoalHasBucket = currentGoal.length > 0
              ? (bucketOptionsByGoal.get(currentGoal)?.some((b) => b.toLowerCase() === bucketKey) ?? false)
              : false
            if (!currentGoalHasBucket) {
              const candidates = bucketToGoals.get(bucketKey)
              const autoGoal = candidates?.[0] // pick first if ambiguous
              if (autoGoal && autoGoal !== currentGoal) {
                base = { ...base, goalName: autoGoal }
              }
            }
          }
          // Only auto-fill once: when choosing a Life Routine bucket, and only if name is effectively empty or default
          const effectiveGoal = base.goalName.trim()
          const isLifeRoutine = effectiveGoal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()
          const trimmedTask = base.taskName.trim()
          const looksDefault = trimmedTask.length === 0 || /^new session$/i.test(trimmedTask)
          if (isLifeRoutine && nextBucket.length > 0 && looksDefault && !taskNameAutofilledRef.current) {
            taskNameAutofilledRef.current = true
            return { ...base, taskName: nextBucket }
          }
        }
        return base
      })
    },
    [bucketOptionsByGoal, bucketToGoals, taskToOwners],
  )

  const handleHistoryFieldChange = useCallback(
    (field: 'taskName' | 'goalName' | 'bucketName') => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { value } = event.target
      updateHistoryDraftField(field, value)
    },
    [updateHistoryDraftField],
  )

  const handleHistoryNotesChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = event.target
    setHistoryDraft((draft) => ({ ...draft, notes: value }))
  }, [])

  const handleHistoryNotesKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      event.currentTarget.blur()
    }
  }, [])

  // Handle special Task dropdown action to add the current session name as a task to the linked bucket
  const handleTaskDropdownChange = useCallback(
    (nextValue: string) => {
      if (nextValue !== '__add_session_task__') {
        updateHistoryDraftField('taskName', nextValue)
        return
      }
      const name = historyDraft.taskName.trim()
      const goal = historyDraft.goalName.trim()
      const bucket = historyDraft.bucketName.trim()
      const key = `${goal.toLowerCase()}::${bucket.toLowerCase()}`
      const bucketId = bucketIdLookup.get(key) ?? null
      if (!bucketId || name.length === 0) {
        return
      }
      ;(async () => {
        try {
          await apiCreateTask(bucketId, name)
          const result = await fetchGoalsHierarchy()
          if (result?.goals) {
            const snapshot = createGoalsSnapshot(result.goals)
            publishGoalsSnapshot(snapshot)
          }
          updateHistoryDraftField('taskName', name)
        } catch (error) {
          // Silenced create task warning
        }
      })()
    },
    [bucketIdLookup, historyDraft.bucketName, historyDraft.goalName, historyDraft.taskName, updateHistoryDraftField],
  )

  // When changing the bucket while a known existing task is selected, move that task to the new bucket in Goals/DB.
  const handleBucketDropdownChange = useCallback(
    (nextValue: string) => {
      const prevBucket = historyDraft.bucketName.trim()
      const currentGoal = historyDraft.goalName.trim()
      const taskName = historyDraft.taskName.trim()
      // Update local draft first (this will also auto-select goal if needed)
      updateHistoryDraftField('bucketName', nextValue)

      // Only proceed if a real task is selected and both previous and next buckets are non-empty
      if (taskName.length === 0) return
      if (prevBucket.length === 0) return
      const owners = taskToOwners.get(taskName.toLowerCase())
      if (!owners || owners.length === 0) return // not an existing task

      // Resolve source goal for prev bucket: prefer current goal if it owns the bucket; else pick first owner goal for that bucket
      const prevBucketKey = prevBucket.toLowerCase()
      const currentGoalOwnsPrev = currentGoal.length > 0
        ? (bucketOptionsByGoal.get(currentGoal)?.some((b) => b.toLowerCase() === prevBucketKey) ?? false)
        : false
      const prevGoal = currentGoalOwnsPrev
        ? currentGoal
        : (bucketToGoals.get(prevBucketKey)?.[0] ?? currentGoal)

      const fromBucketId = prevGoal && prevBucket
        ? bucketIdLookup.get(`${prevGoal.toLowerCase()}::${prevBucket.toLowerCase()}`) ?? null
        : null

      const nextBucket = nextValue.trim()
      if (nextBucket.length === 0) return
      const nextBucketKey = nextBucket.toLowerCase()
      // Resolve destination goal using the same auto-select policy used in updateHistoryDraftField
      const currentGoalOwnsNext = currentGoal.length > 0
        ? (bucketOptionsByGoal.get(currentGoal)?.some((b) => b.toLowerCase() === nextBucketKey) ?? false)
        : false
      const nextGoal = currentGoalOwnsNext
        ? currentGoal
        : (bucketToGoals.get(nextBucketKey)?.[0] ?? currentGoal)

      const toBucketId = nextGoal && nextBucket
        ? bucketIdLookup.get(`${nextGoal.toLowerCase()}::${nextBucket.toLowerCase()}`) ?? null
        : null

      if (!fromBucketId || !toBucketId || fromBucketId === toBucketId) return

      const taskKey = `${prevGoal?.toLowerCase() ?? ''}::${prevBucket.toLowerCase()}::${taskName.toLowerCase()}`
      const taskId = taskIdLookup.get(taskKey) ?? null
      if (!taskId) return

      ;(async () => {
        try {
          await moveTaskToBucket(taskId, fromBucketId, toBucketId)
          const result = await fetchGoalsHierarchy()
          if (result?.goals) {
            const snapshot = createGoalsSnapshot(result.goals)
            publishGoalsSnapshot(snapshot)
          }
        } catch (error) {
          // Silenced move task warning
        }
      })()
    }, 
    [bucketIdLookup, bucketOptionsByGoal, bucketToGoals, historyDraft.bucketName, historyDraft.goalName, historyDraft.taskName, moveTaskToBucket, taskIdLookup, taskToOwners, updateHistoryDraftField],
  )

  const getSubtaskParent = useCallback(() => {
    const entry = selectedHistoryEntryRef.current
    if (!entry) return null
    if (entry.taskId) return { taskId: entry.taskId }
    return entry.id ? { sessionId: entry.id } : null
  }, [])

  const publishLocalGoalsSnapshot = useCallback((snapshot: GoalSnapshot[]) => {
    if (editorOpenRef.current) {
      return
    }
    const signature = JSON.stringify(snapshot)
    goalsSnapshotSignatureRef.current = signature
    skipNextGoalsSnapshotRef.current = true
    setGoalsSnapshot(snapshot)
    publishGoalsSnapshot(snapshot)
  }, [])

  const updateTaskNotesSnapshot = useCallback(
    (taskId: string, notes: string) => {
      if (!taskId) return
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          let goalMutated = false
          const buckets = goal.buckets.map((bucket) => {
            const tasks = bucket.tasks.map((task) => {
              if (task.id !== taskId) return task
              const existing = typeof (task as any).notes === 'string' ? ((task as any).notes as string) : ''
              if (existing === notes) {
                return task
              }
              goalMutated = true
              mutated = true
              return { ...task, notes }
            })
            return goalMutated ? { ...bucket, tasks } : bucket
          })
          return goalMutated ? { ...goal, buckets } : goal
        })
        if (mutated) {
          publishLocalGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    },
    [publishLocalGoalsSnapshot],
  )

  // Keep task-linked subtasks in the goals snapshot so other tabs (Goals/Focus) reflect edits immediately.
  const mirrorSubtaskToGoalsSnapshot = useCallback(
    (parent: { taskId?: string | null; sessionId?: string | null } | null, subtask: HistorySubtask) => {
      const taskId = parent?.taskId
      if (!taskId) return
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          let goalMutated = false
          const buckets = goal.buckets.map((bucket) => {
            const taskIdx = bucket.tasks.findIndex((task) => task.id === taskId)
            if (taskIdx === -1) return bucket
            const task = bucket.tasks[taskIdx]
            const nextSubtasks = Array.isArray(task.subtasks) ? [...task.subtasks] : []
            const candidate = {
              id: subtask.id,
              text: subtask.text,
              completed: subtask.completed,
              sortIndex: subtask.sortIndex,
            }
            const existingIdx = nextSubtasks.findIndex((s) => s.id === subtask.id)
            let changed = false
            if (existingIdx >= 0) {
              const existing = nextSubtasks[existingIdx]
              if (
                existing.text !== candidate.text ||
                existing.completed !== candidate.completed ||
                existing.sortIndex !== candidate.sortIndex
              ) {
                nextSubtasks[existingIdx] = candidate
                changed = true
              }
            } else {
              nextSubtasks.push(candidate)
              changed = true
            }
            if (!changed) return bucket
            nextSubtasks.sort((a, b) => a.sortIndex - b.sortIndex)
            const nextTasks = bucket.tasks.slice()
            nextTasks[taskIdx] = { ...task, subtasks: nextSubtasks }
            goalMutated = true
            mutated = true
            return { ...bucket, tasks: nextTasks }
          })
          return goalMutated ? { ...goal, buckets } : goal
        })
        if (mutated) {
          publishLocalGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    },
    [publishLocalGoalsSnapshot],
  )

  const mirrorSubtaskDeletionToGoalsSnapshot = useCallback(
    (parent: { taskId?: string | null; sessionId?: string | null } | null, subtaskId: string) => {
      const taskId = parent?.taskId
      if (!taskId || !subtaskId) return
      setGoalsSnapshot((current) => {
        let mutated = false
        const updated = current.map((goal) => {
          let goalMutated = false
          const buckets = goal.buckets.map((bucket) => {
            const taskIdx = bucket.tasks.findIndex((task) => task.id === taskId)
            if (taskIdx === -1) return bucket
            const task = bucket.tasks[taskIdx]
            const nextSubtasks = (task.subtasks ?? []).filter((s) => s.id !== subtaskId)
            if (nextSubtasks.length === (task.subtasks ?? []).length) {
              return bucket
            }
            const nextTasks = bucket.tasks.slice()
            nextTasks[taskIdx] = { ...task, subtasks: nextSubtasks }
            goalMutated = true
            mutated = true
            return { ...bucket, tasks: nextTasks }
          })
          return goalMutated ? { ...goal, buckets } : goal
        })
        if (mutated) {
          publishLocalGoalsSnapshot(updated)
          return updated
        }
        return current
      })
    },
    [publishLocalGoalsSnapshot],
  )

  const scheduleSubtaskPersist = useCallback(
    (subtask: HistorySubtask) => {
      const parent = getSubtaskParent()
      if (!parent) return
      const timers = subtaskSaveTimersRef.current
      const existing = timers.get(subtask.id)
      if (typeof existing === 'number' && typeof window !== 'undefined') {
        window.clearTimeout(existing)
      }
      const timerId =
        typeof window !== 'undefined'
          ? window.setTimeout(() => {
              timers.delete(subtask.id)
              void upsertSubtaskForParent(parent, subtask)
              mirrorSubtaskToGoalsSnapshot(parent, subtask)
            }, 150)
          : (undefined as any)
      timers.set(subtask.id, timerId as number)
    },
    [getSubtaskParent, mirrorSubtaskToGoalsSnapshot],
  )

  const handleAddHistorySubtask = useCallback(
    (options?: { focus?: boolean; afterId?: string }) => {
      const parent = getSubtaskParent()
      if (!parent) return
      const entryId = selectedHistoryEntryRef.current?.id ?? selectedHistoryId ?? 'history'
      setHistoryDraft((draft) => {
        const sorted = draft.subtasks.slice().sort((a, b) => a.sortIndex - b.sortIndex)
        const afterId = options?.afterId
        let insertIndex = 0
        if (afterId) {
          const idx = sorted.findIndex((s) => s.id === afterId)
          insertIndex = idx >= 0 ? idx + 1 : 0
        }
        const prev = sorted[insertIndex - 1] || null
        const next = sorted[insertIndex] || null
        let sortIndex: number
        if (prev && next) {
          const a = prev.sortIndex
          const b = next.sortIndex
          sortIndex = a < b ? Math.floor(a + (b - a) / 2) : a + HISTORY_SUBTASK_SORT_STEP
        } else if (prev && !next) {
          sortIndex = prev.sortIndex + HISTORY_SUBTASK_SORT_STEP
        } else if (!prev && next) {
          sortIndex = next.sortIndex - HISTORY_SUBTASK_SORT_STEP
        } else {
          sortIndex = HISTORY_SUBTASK_SORT_STEP
        }
        const newSubtask: HistorySubtask = {
          id: makeHistoryId(),
          text: '',
          completed: false,
          sortIndex,
        }
        const copy = [...sorted]
        copy.splice(insertIndex, 0, newSubtask)
        if (options?.focus !== false) {
          pendingHistorySubtaskFocusRef.current = { entryId, subtaskId: newSubtask.id }
          const inputId = makeHistorySubtaskInputId(entryId, newSubtask.id)
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
              if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(tryFocusNow)
              } else {
                setTimeout(tryFocusNow, 0)
              }
            })
          } else {
            setTimeout(() => {
              if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(tryFocusNow)
              } else {
                tryFocusNow()
              }
            }, 0)
          }
        }
        setRevealedHistoryDeleteKey(null)
        return { ...draft, subtasks: copy }
      })
    },
    [getSubtaskParent, selectedHistoryId],
  )

  const handleUpdateHistorySubtaskText = useCallback((id: string, value: string) => {
    setHistoryDraft((draft) => {
      const next = draft.subtasks.map((subtask) => (subtask.id === id ? { ...subtask, text: value } : subtask))
      const updated = next.find((s) => s.id === id)
      if (updated) {
        scheduleSubtaskPersist(updated)
      }
      return { ...draft, subtasks: next }
    })
  }, [scheduleSubtaskPersist])

  const handleToggleHistorySubtaskCompletion = useCallback((id: string) => {
    setHistoryDraft((draft) => {
      const next = draft.subtasks.map((subtask) =>
        subtask.id === id ? { ...subtask, completed: !subtask.completed } : subtask,
      )
      const updated = next.find((s) => s.id === id)
      if (updated) {
        scheduleSubtaskPersist(updated)
      }
      return { ...draft, subtasks: next }
    })
  }, [scheduleSubtaskPersist])

  const handleHistorySubtaskBlur = useCallback(
    (id: string) => {
      const parent = getSubtaskParent()
      setHistoryDraft((draft) => {
        const target = draft.subtasks.find((s) => s.id === id)
        if (!target) return draft
        if (target.text.trim().length === 0) {
          const nextSubtasks = draft.subtasks.filter((s) => s.id !== id)
          if (parent) {
            void deleteSubtaskForParent(parent, id)
            mirrorSubtaskDeletionToGoalsSnapshot(parent, id)
            const timers = subtaskSaveTimersRef.current
            const existing = timers.get(id)
            if (typeof existing === 'number' && typeof window !== 'undefined') {
              window.clearTimeout(existing)
              timers.delete(id)
            }
          }
          return { ...draft, subtasks: nextSubtasks }
        }
        scheduleSubtaskPersist(target)
        return draft
      })
    },
    [getSubtaskParent, mirrorSubtaskDeletionToGoalsSnapshot, scheduleSubtaskPersist],
  )

  const handleDeleteHistorySubtask = useCallback((id: string) => {
    const parent = getSubtaskParent()
    setHistoryDraft((draft) => ({
      ...draft,
      subtasks: draft.subtasks.filter((subtask) => subtask.id !== id),
    }))
    if (parent) {
      void deleteSubtaskForParent(parent, id)
      mirrorSubtaskDeletionToGoalsSnapshot(parent, id)
      const timers = subtaskSaveTimersRef.current
      const existing = timers.get(id)
      if (typeof existing === 'number' && typeof window !== 'undefined') {
        window.clearTimeout(existing)
        timers.delete(id)
      }
    }
  }, [getSubtaskParent, mirrorSubtaskDeletionToGoalsSnapshot])

  const sortedSubtasks = useMemo(
    () => historyDraft.subtasks.slice().sort((a, b) => a.sortIndex - b.sortIndex),
    [historyDraft.subtasks],
  )

  useEffect(() => {
    const entryId = selectedHistoryEntryRef.current?.id ?? selectedHistoryId ?? ''
    const previousIds = previousHistorySubtaskIdsRef.current
    const nextIds = new Set(sortedSubtasks.map((subtask) => subtask.id))
    let pending = pendingHistorySubtaskFocusRef.current
    if (!historySubtaskIdsInitializedRef.current) {
      historySubtaskIdsInitializedRef.current = true
      const newestBlankSubtask = [...sortedSubtasks]
        .sort((a, b) => b.sortIndex - a.sortIndex)
        .find((subtask) => !previousIds.has(subtask.id) && subtask.text.trim().length === 0)
      if (newestBlankSubtask) {
        pending = { entryId, subtaskId: newestBlankSubtask.id }
        pendingHistorySubtaskFocusRef.current = pending
      }
    }
    previousHistorySubtaskIdsRef.current = nextIds
    if (!pending || !pending.subtaskId || pending.entryId !== entryId) {
      return
    }
    const focusTarget = pending
    const inputId = makeHistorySubtaskInputId(entryId, focusTarget.subtaskId)
    const tryFocus = () => {
      const el = document.getElementById(inputId) as HTMLTextAreaElement | null
      if (!el) {
        return
      }
      try {
        el.focus({ preventScroll: true })
        const end = el.value.length
        el.setSelectionRange?.(end, end)
      } catch {}
      pendingHistorySubtaskFocusRef.current = null
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(tryFocus)
    } else {
      setTimeout(tryFocus, 0)
    }
  }, [sortedSubtasks, selectedHistoryId])

  const historySubtaskKey = selectedHistoryEntryRef.current?.id ?? selectedHistoryId ?? 'history'
  const renderHistorySubtasksEditor = () => (
    <div className="calendar-inspector__subtasks">
      <div className="taskwatch-notes__subtasks-row">
        <div className="calendar-inspector__subtasks-header">
          <span className="history-timeline__field-text">Subtasks</span>
        </div>
        <button type="button" className="taskwatch-notes__add" onClick={() => handleAddHistorySubtask()}>
          + Subtask
        </button>
      </div>
      {sortedSubtasks.length === 0 ? (
        <p className="goal-task-details__empty-text">No subtasks yet</p>
      ) : (
        <ul className="goal-task-details__subtask-list">
          {sortedSubtasks.map((subtask) => {
            const subDeleteKey = `${historySubtaskKey}__subtask__${subtask.id}`
            const isSubDeleteRevealed = revealedHistoryDeleteKey === subDeleteKey
            const inputId = makeHistorySubtaskInputId(historySubtaskKey, subtask.id)
            return (
              <li
                key={subtask.id}
                data-delete-key={subDeleteKey}
                className={classNames(
                  'goal-task-details__subtask',
                  subtask.completed && 'goal-task-details__subtask--completed',
                  isSubDeleteRevealed && 'goal-task-details__subtask--delete-revealed',
                )}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setRevealedHistoryDeleteKey(isSubDeleteRevealed ? null : subDeleteKey)
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  setRevealedHistoryDeleteKey(null)
                }}
              >
                <label className="goal-task-details__subtask-item">
                  <div className="goal-subtask-field">
                    <input
                      type="checkbox"
                      className="goal-task-details__checkbox"
                      checked={subtask.completed}
                      onChange={() => handleToggleHistorySubtaskCompletion(subtask.id)}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      aria-label={
                        subtask.text.trim().length > 0 ? `Mark "${subtask.text}" complete` : 'Toggle subtask'
                      }
                    />
                    <textarea
                      id={inputId}
                      className="goal-task-details__subtask-input"
                      rows={1}
                      ref={(el) => autosizeHistorySubtaskTextArea(el)}
                      value={subtask.text}
                      onChange={(event) => {
                        const el = event.currentTarget
                        el.style.height = 'auto'
                        el.style.height = `${el.scrollHeight}px`
                        handleUpdateHistorySubtaskText(subtask.id, event.target.value)
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          handleAddHistorySubtask({ focus: true })
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          setRevealedHistoryDeleteKey(null)
                          event.currentTarget.blur()
                        }
                      }}
                      onFocus={(event) => {
                        const el = event.currentTarget
                        el.style.height = 'auto'
                        el.style.height = `${el.scrollHeight}px`
                      }}
                      onBlur={() => handleHistorySubtaskBlur(subtask.id)}
                      placeholder="Describe subtask"
                    />
                  </div>
                </label>
                <button
                  type="button"
                  className="goal-task-details__remove"
                  onClick={() => {
                    setRevealedHistoryDeleteKey(null)
                    handleDeleteHistorySubtask(subtask.id)
                  }}
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
  )

  const commitHistoryDraft = useCallback(() => {
    if (!selectedHistoryEntry) {
      return
    }
    // Preserve blank names if the user cleared it intentionally
    const draft = historyDraft
    const nextTaskName = draft.taskName.trim()
    const nextGoalName = draft.goalName.trim()
    const nextBucketName = draft.bucketName.trim()
    let nextNotes = draft.notes
    const nextSubtasks = cloneHistorySubtasks(draft.subtasks)
    const draftStartedAt = draft.startedAt ?? selectedHistoryEntry.startedAt
    const draftEndedAt = draft.endedAt ?? selectedHistoryEntry.endedAt
    let nextStartedAt = Number.isFinite(draftStartedAt) ? draftStartedAt : selectedHistoryEntry.startedAt
    let nextEndedAt = Number.isFinite(draftEndedAt) ? draftEndedAt : selectedHistoryEntry.endedAt
    if (!Number.isFinite(nextStartedAt)) {
      nextStartedAt = selectedHistoryEntry.startedAt
    }
    if (!Number.isFinite(nextEndedAt)) {
      nextEndedAt = selectedHistoryEntry.endedAt
    }
    if (nextEndedAt <= nextStartedAt) {
      nextEndedAt = nextStartedAt + MIN_SESSION_DURATION_DRAG_MS
    }
    const nextElapsed = Math.max(nextEndedAt - nextStartedAt, 1)
    const normalizedGoalName = nextGoalName
    const normalizedBucketName = nextBucketName
    const goalKey = normalizedGoalName.toLowerCase()
    const bucketKey = normalizedBucketName.toLowerCase()
    const hasGoalName = normalizedGoalName.length > 0
    const hasBucketName = normalizedBucketName.length > 0
    const lifeRoutineKey = LIFE_ROUTINES_NAME.toLowerCase()
    const resolvedGoalSurface = ensureSurfaceStyle(
      (() => {
        if (!hasGoalName) {
          return DEFAULT_SURFACE_STYLE
        }
        if (goalKey === lifeRoutineKey) {
          return LIFE_ROUTINES_SURFACE
        }
        if (goalKey === SNAPBACK_NAME.toLowerCase()) {
          // Snapback uses a crimson/ember accent
          return SNAPBACK_SURFACE
        }
        return goalSurfaceLookup.get(goalKey) ?? DEFAULT_SURFACE_STYLE
      })(),
      DEFAULT_SURFACE_STYLE,
    )
    const resolvedBucketSurface = (() => {
      if (!hasBucketName) {
        return null
      }
      if (goalKey === lifeRoutineKey) {
        const routineSurface = lifeRoutineSurfaceLookup.get(bucketKey)
        return routineSurface ? ensureSurfaceStyle(routineSurface, LIFE_ROUTINES_SURFACE) : null
      }
      if (!hasGoalName) {
        const fallback = bucketSurfaceLookup.byName.get(bucketKey)
        return fallback ? ensureSurfaceStyle(fallback, DEFAULT_SURFACE_STYLE) : null
      }
      const scopedKey = `${goalKey}::${bucketKey}`
      const scopedSurface = bucketSurfaceLookup.byGoal.get(scopedKey)
      if (scopedSurface) {
        return ensureSurfaceStyle(scopedSurface, DEFAULT_SURFACE_STYLE)
      }
      const fallback = bucketSurfaceLookup.byName.get(bucketKey)
      return fallback ? ensureSurfaceStyle(fallback, DEFAULT_SURFACE_STYLE) : null
    })()
    const prevTaskId = selectedHistoryEntry.taskId
    const prevTaskNotes = prevTaskId ? taskNotesById.get(prevTaskId) ?? '' : ''
    const resolvedTaskId =
      hasGoalName && hasBucketName && nextTaskName.length > 0
        ? taskIdLookup.get(`${goalKey}::${bucketKey}::${nextTaskName.toLowerCase()}`) ?? null
        : null
    const justUnlinked = Boolean(prevTaskId) && !resolvedTaskId
    if (justUnlinked && nextNotes.trim().length === 0 && prevTaskNotes.trim().length > 0) {
      nextNotes = prevTaskNotes
    }
    const currentTaskNotes = resolvedTaskId ? taskNotesById.get(resolvedTaskId) ?? '' : ''
    const taskNoteChanged = resolvedTaskId
      ? prevTaskId !== resolvedTaskId
        ? nextNotes.trim().length > 0 || currentTaskNotes === ''
        : nextNotes !== currentTaskNotes
      : false
    let didUpdateHistory = false
    updateHistory((current) => {
      const index = current.findIndex((entry) => entry.id === selectedHistoryEntry.id)
      if (index === -1) {
        return current
      }
      const target = current[index]
      if (
        target.taskName === nextTaskName &&
        (target.goalName ?? '') === normalizedGoalName &&
        (target.bucketName ?? '') === normalizedBucketName &&
        target.startedAt === nextStartedAt &&
        target.endedAt === nextEndedAt &&
        target.goalSurface === resolvedGoalSurface &&
        target.bucketSurface === resolvedBucketSurface &&
        target.notes === nextNotes &&
        areHistorySubtasksEqual(target.subtasks, nextSubtasks)
      ) {
        return current
      }
      const next = [...current]
      next[index] = {
        ...target,
        taskName: nextTaskName,
        goalName: normalizedGoalName.length > 0 ? normalizedGoalName : null,
        bucketName: normalizedBucketName.length > 0 ? normalizedBucketName : null,
        startedAt: nextStartedAt,
        endedAt: nextEndedAt,
        elapsed: nextElapsed,
        goalSurface: resolvedGoalSurface,
        bucketSurface: resolvedBucketSurface,
        notes: nextNotes,
        subtasks: nextSubtasks,
        // Keep the flag in sync with time edits: anything in the future is planned
        futureSession: nextStartedAt > Date.now(),
        goalId:
          normalizedGoalName.length > 0
            ? goalIdLookup.get(normalizedGoalName.toLowerCase()) ?? target.goalId ?? null
            : null,
        bucketId:
          normalizedGoalName.length > 0 && normalizedBucketName.length > 0
            ? bucketIdLookup.get(`${normalizedGoalName.toLowerCase()}::${normalizedBucketName.toLowerCase()}`) ??
              target.bucketId ??
              null
            : null,
        taskId: resolvedTaskId,
      }
      didUpdateHistory = true
      return next
    })
    const normalizedDraft: HistoryDraftState = {
      taskName: nextTaskName,
      goalName: normalizedGoalName,
      bucketName: normalizedBucketName,
      startedAt: nextStartedAt,
      endedAt: nextEndedAt,
      notes: nextNotes,
      subtasks: cloneHistorySubtasks(nextSubtasks),
    }
    const draftChanged = !areHistoryDraftsEqual(draft, normalizedDraft)
    if (draftChanged) {
      setHistoryDraft(normalizedDraft)
    }
    lastCommittedHistoryDraftRef.current = {
      ...normalizedDraft,
      subtasks: cloneHistorySubtasks(normalizedDraft.subtasks),
    }
    if (resolvedTaskId && taskNoteChanged) {
      updateTaskNotesSnapshot(resolvedTaskId, nextNotes)
      void apiUpdateTaskNotes(resolvedTaskId, nextNotes).catch((error) =>
        logWarn('[Reflection] Failed to update task notes:', error),
      )
    }
    if (didUpdateHistory || draftChanged) {
      if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
        setPendingNewHistoryId(null)
      }
      setEditingHistoryId(null)
    }
  }, [
    bucketSurfaceLookup,
    goalSurfaceLookup,
    bucketIdLookup,
    goalIdLookup,
    historyDraft,
    lifeRoutineSurfaceLookup,
    taskIdLookup,
    taskNotesById,
    updateTaskNotesSnapshot,
    apiUpdateTaskNotes,
    pendingNewHistoryId,
    selectedHistoryEntry,
    selectedHistoryId,
    setPendingNewHistoryId,
    updateHistory,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const cancelPending = () => {
      if (autoCommitFrameRef.current !== null) {
        window.cancelAnimationFrame(autoCommitFrameRef.current)
        autoCommitFrameRef.current = null
      }
    }
    if (!selectedHistoryEntry) {
      cancelPending()
      return
    }
    // When the calendar editor modal is open, defer auto-commit to avoid fighting with typing in inputs.
    if (calendarEditorEntryId) {
      cancelPending()
      return
    }
    const lastCommitted = lastCommittedHistoryDraftRef.current
    if (areHistoryDraftsEqual(historyDraft, lastCommitted)) {
      return
    }
    cancelPending()
    autoCommitFrameRef.current = window.requestAnimationFrame(() => {
      autoCommitFrameRef.current = null
      commitHistoryDraft()
    })
    return cancelPending
  }, [calendarEditorEntryId, commitHistoryDraft, historyDraft, selectedHistoryEntry])

  const handleHistoryFieldKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
          setPendingNewHistoryId(null)
        }
        commitHistoryDraft()
        // If the calendar editor modal is open, close it after saving via Enter
        if (calendarEditorEntryId) {
          setCalendarEditorEntryId(null)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        // For a freshly created, pending entry: do not mutate the draft before cancel.
        // This preserves the untouched state so the cancel handler can auto-delete it.
        if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
          // Defer to the centralized cancel logic which will delete if untouched
          handleCancelHistoryEdit()
          if (calendarEditorEntryId) {
            setCalendarEditorEntryId(null)
          }
        } else {
          if (selectedHistoryEntry) {
            setHistoryDraft(() => createHistoryDraftFromEntry(selectedHistoryEntry))
          } else {
            setHistoryDraft(createEmptyHistoryDraft())
          }
          setEditingHistoryId(null)
        }
      }
    },
    [
      calendarEditorEntryId,
      commitHistoryDraft,
      pendingNewHistoryId,
      selectedHistoryEntry,
      selectedHistoryId,
    ],
  )

  useEffect(() => {
    if (!calendarInspectorEntryId) {
      return
    }
    const exists = history.some((entry) => entry.id === calendarInspectorEntryId)
    if (!exists && inspectorFallbackMessage === null) {
      setInspectorFallbackMessage(INSPECTOR_DELETED_MESSAGE)
      setShowInspectorExtras(false)
      setHistoryDraft(createEmptyHistoryDraft())
      setSelectedHistoryId((current) => (current === calendarInspectorEntryId ? null : current))
      setEditingHistoryId((current) => (current === calendarInspectorEntryId ? null : current))
    }
  }, [
    calendarInspectorEntryId,
    history,
    inspectorFallbackMessage,
    setEditingHistoryId,
    setHistoryDraft,
    setInspectorFallbackMessage,
    setSelectedHistoryId,
    setShowInspectorExtras,
  ])

  const handleCancelHistoryEdit = useCallback(() => {
    setInspectorFallbackMessage(null)
    setShowInspectorExtras(false)
    // If we're cancelling a newly added (pending) entry, always delete it (discard creation)
    if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
      const entry = selectedHistoryEntry
      if (entry) {
        // Remove the new entry since user dismissed the editor
        updateHistory((current) => current.filter((e) => e.id !== entry.id))
      }
      setPendingNewHistoryId(null)
      setSelectedHistoryId(null)
      setEditingHistoryId(null)
      setHoveredHistoryId(null)
      setCalendarInspectorEntryId(null)
      setHistoryDraft(createEmptyHistoryDraft())
      return
    }
    setHistoryDraft(() => (selectedHistoryEntry ? createHistoryDraftFromEntry(selectedHistoryEntry) : createEmptyHistoryDraft()))
    setCalendarInspectorEntryId(null)
    setEditingHistoryId(null)
  }, [
    pendingNewHistoryId,
    selectedHistoryEntry,
    selectedHistoryId,
    setCalendarInspectorEntryId,
    setInspectorFallbackMessage,
    setShowInspectorExtras,
  ])

  const handleSaveHistoryDraft = useCallback(() => {
    // If we were editing a newly added entry, it's no longer pending after save
    if (pendingNewHistoryId && selectedHistoryId === pendingNewHistoryId) {
      setPendingNewHistoryId(null)
    }
    commitHistoryDraft()
  }, [commitHistoryDraft, pendingNewHistoryId, selectedHistoryId])

  useEffect(() => {
    if (!calendarInspectorEntryId) {
      return
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleCancelHistoryEdit()
        setCalendarInspectorEntryId(null)
      }
    }
    document.addEventListener('keydown', onKeyDown as EventListener)
    return () => document.removeEventListener('keydown', onKeyDown as EventListener)
  }, [calendarInspectorEntryId, handleCancelHistoryEdit])

  const handleStartEditingHistoryEntry = useCallback((entry: HistoryEntry) => {
    setSelectedHistoryId(entry.id)
    setHoveredHistoryId(entry.id)
    setEditingHistoryId(entry.id)
    taskNameAutofilledRef.current = false
    setHistoryDraft(createHistoryDraftFromEntry(entry))
  }, [])

  // Kick off editing using whichever UI is currently enabled (inspector or legacy modal).
  const openCalendarInspector = useCallback(
    (entry: HistoryEntry) => {
      handleStartEditingHistoryEntry(entry)
      setInspectorFallbackMessage(null)
      if (ENABLE_HISTORY_INSPECTOR_PANEL) {
        setCalendarInspectorEntryId(entry.id)
        setCalendarEditorEntryId(null)
      } else {
        setCalendarEditorEntryId(entry.id)
        setCalendarInspectorEntryId(null)
      }
    },
    [ENABLE_HISTORY_INSPECTOR_PANEL, handleStartEditingHistoryEntry],
  )

  useEffect(() => {
    if (!selectedHistoryId) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const timelineEl = timelineRef.current
      const portalEl = editingTooltipRef.current
      const editorEl = calendarEditorRef.current
      const targetNode = event.target as Node | null
      // Ignore clicks inside the dropdown overlay menu (rendered via portal)
      let withinDropdown = false
      if (targetNode instanceof HTMLElement) {
        let el: HTMLElement | null = targetNode
        while (el) {
          if (el.classList && el.classList.contains('history-dropdown__menu')) {
            withinDropdown = true
            break
          }
          el = el.parentElement
        }
      }
      if (withinDropdown) {
        return
      }
      if (
        (timelineEl && targetNode && timelineEl.contains(targetNode)) ||
        (portalEl && targetNode && portalEl.contains(targetNode)) ||
        (editorEl && targetNode && editorEl.contains(targetNode))
      ) {
        return
      }
      if (calendarInspectorEntryId) {
        return
      }
      handleCancelHistoryEdit()
      setSelectedHistoryId(null)
      setHistoryDraft(createEmptyHistoryDraft())
      setHoveredHistoryId(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [calendarInspectorEntryId, handleCancelHistoryEdit, selectedHistoryId, timelineRef])

  useEffect(() => {
    if (!calendarInspectorEntryId) {
      return
    }
    setCalendarPreview(null)
  }, [calendarInspectorEntryId])

useEffect(() => {
  setShowInspectorExtras(false)
  setShowEditorExtras(false)
}, [calendarInspectorEntryId, calendarEditorEntryId])

useEffect(() => {
  setShowInlineExtras(false)
}, [editingHistoryId, selectedHistoryId])

  useEffect(() => {
    const goalName = historyDraft.goalName.trim()
    const bucketName = historyDraft.bucketName.trim()
    if (goalName.length === 0 || bucketName.length === 0) {
      return
    }
    const allowedBuckets = bucketOptionsByGoal.get(goalName)
    if (!allowedBuckets || allowedBuckets.includes(bucketName)) {
      return
    }
    setHistoryDraft((draft) => {
      if (draft.bucketName.trim().length === 0) {
        return draft
      }
      return { ...draft, bucketName: '' }
    })
  }, [historyDraft.goalName, historyDraft.bucketName, bucketOptionsByGoal])

  const handleTimelineBlockKeyDown = useCallback(
    (entry: HistoryEntry) => (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        handleSelectHistorySegment(entry)
      } else if (event.key === 'Escape' && selectedHistoryId === entry.id) {
        event.preventDefault()
        setSelectedHistoryId(null)
        setHistoryDraft(createEmptyHistoryDraft())
        setEditingHistoryId(null)
      }
    },
    [handleSelectHistorySegment, selectedHistoryId],
  )

  const handleTimelineBackgroundClick = useCallback(() => {
    if (calendarInspectorEntryId) {
      return
    }
    startTransition(() => {
      setSelectedHistoryId(null)
      setHistoryDraft(createEmptyHistoryDraft())
      setEditingHistoryId(null)
      setHoveredHistoryId(null)
    })
  }, [calendarInspectorEntryId])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === HISTORY_STORAGE_KEY) {
        const stored = readPersistedHistory()
        if (!historiesAreEqual(latestHistoryRef.current, stored)) {
          setHistory(stored)
        }
        return
      }
      if (event.key === CURRENT_SESSION_STORAGE_KEY) {
        setActiveSession(readStoredActiveSession())
      }
    }
    const handleHistoryBroadcast = () => {
      const stored = readPersistedHistory()
      if (!historiesAreEqual(latestHistoryRef.current, stored)) {
        setHistory(stored)
      }
    }
    const handleSessionBroadcast = (event: Event) => {
      const custom = event as CustomEvent<unknown>
      const detail = sanitizeActiveSession(custom.detail)
      if (detail) {
        setActiveSession(detail)
      } else {
        setActiveSession(readStoredActiveSession())
      }
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
    window.addEventListener(CURRENT_SESSION_EVENT_NAME, handleSessionBroadcast as EventListener)

    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(HISTORY_EVENT_NAME, handleHistoryBroadcast as EventListener)
      window.removeEventListener(CURRENT_SESSION_EVENT_NAME, handleSessionBroadcast as EventListener)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToGoalsSnapshot((snapshot) => {
      if (editorOpenRef.current) {
        return
      }
      const signature = JSON.stringify(snapshot)
      if (skipNextGoalsSnapshotRef.current && signature === goalsSnapshotSignatureRef.current) {
        skipNextGoalsSnapshotRef.current = false
        return
      }
      if (signature === goalsSnapshotSignatureRef.current) {
        return
      }
      goalsSnapshotSignatureRef.current = signature
      setGoalsSnapshot(snapshot)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now())
    }, 60000) // update once per minute to reduce render churn
    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const effectiveHistory = useMemo(() => {
    const baseHistory = historyWithTaskNotes
    if (!activeSession) {
      return baseHistory
    }
    const now = Date.now()
    const baseElapsed = Math.max(0, activeSession.baseElapsed)
    const committedElapsed = Number.isFinite(activeSession.committedElapsed) ? Math.max(0, activeSession.committedElapsed!) : 0
    const runningElapsed =
      activeSession.isRunning && typeof activeSession.startedAt === 'number'
        ? Math.max(0, now - activeSession.startedAt)
        : 0
    const totalElapsed = baseElapsed + runningElapsed
    const effectiveElapsed = Math.max(0, totalElapsed - committedElapsed)
    if (effectiveElapsed <= 0) {
      return baseHistory
    }
    const defaultStart = now - effectiveElapsed
    const startCandidate =
      typeof activeSession.startedAt === 'number'
        ? activeSession.startedAt
        : activeSession.updatedAt - effectiveElapsed
    const startedAt = Math.min(startCandidate, now)
    const safeStartedAt = Number.isFinite(startedAt) ? startedAt : defaultStart
    const endedAt = activeSession.isRunning ? now : safeStartedAt + effectiveElapsed
    const taskLabel =
      activeSession.taskName.length > 0
        ? activeSession.taskName
        : activeSession.bucketName && activeSession.bucketName.trim().length > 0
          ? activeSession.bucketName
          : activeSession.goalName ?? UNCATEGORISED_LABEL
    const activeEntry: HistoryEntry = {
      id: 'active-session',
      taskName: taskLabel,
      elapsed: effectiveElapsed,
      startedAt: safeStartedAt,
      endedAt,
      goalName: activeSession.goalName ?? null,
      bucketName: activeSession.bucketName ?? null,
      goalId: activeSession.goalId,
      bucketId: activeSession.bucketId,
      taskId: activeSession.taskId,
      goalSurface: activeSession.goalSurface,
      bucketSurface: activeSession.bucketSurface,
      notes: '',
      subtasks: [],
    }
    const filteredHistory = baseHistory.filter((entry) => entry.id !== activeEntry.id)
    return [activeEntry, ...filteredHistory]
  }, [historyWithTaskNotes, activeSession, nowTick])

  useEffect(() => {
    const PREFETCH_LIMIT = 20
    let fetched = 0
    for (const entry of effectiveHistory) {
      if (fetched >= PREFETCH_LIMIT) break
      if (subtasksCacheRef.current.has(entry.id)) {
        continue
      }
      if (entry.subtasks && entry.subtasks.length > 0) {
        cacheSubtasksForEntry(entry.id, entry.subtasks)
        continue
      }
      fetched += 1
      void ensureSubtasksFetched(entry)
    }
  }, [effectiveHistory, ensureSubtasksFetched, cacheSubtasksForEntry])

  useEffect(() => {
    if (!selectedHistoryId) {
      return
    }
    const exists = effectiveHistory.some((entry) => entry.id === selectedHistoryId)
    if (!exists) {
      setSelectedHistoryId(null)
      setHistoryDraft(createEmptyHistoryDraft())
    }
  }, [effectiveHistory, selectedHistoryId])

  useEffect(() => {
    previousHistorySubtaskIdsRef.current = new Set()
    historySubtaskIdsInitializedRef.current = false
    setRevealedHistoryDeleteKey(null)
  }, [selectedHistoryId])

  useEffect(() => {
    if (!revealedHistoryDeleteKey || typeof document === 'undefined') {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-delete-key]')) {
        return
      }
      setRevealedHistoryDeleteKey(null)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [revealedHistoryDeleteKey])

  useEffect(() => {
    if (!selectedHistoryId) return
    const last = cachedDraftSubtasksRef.current.get(selectedHistoryId)
    if (last && areHistorySubtasksEqual(last, historyDraft.subtasks)) {
      return
    }
    const cloned = cloneHistorySubtasks(historyDraft.subtasks)
    cachedDraftSubtasksRef.current.set(selectedHistoryId, cloned)
    cacheSubtasksForEntry(selectedHistoryId, cloned)
  }, [selectedHistoryId, historyDraft.subtasks, cacheSubtasksForEntry])

  const allTimeWindowStart = useMemo(
    () => (accountCreatedAtStatus === 'ready' && accountCreatedAtMs !== null ? accountCreatedAtMs : null),
    [accountCreatedAtStatus, accountCreatedAtMs],
  )
  const { segments, windowMs, loggedMs } = useMemo(() => {
    if (activeRange === 'all' && !allTimeWindowStart) {
      return { segments: [], windowMs: 0, loggedMs: 0 }
    }
    return computeRangeOverview(
      effectiveHistory,
      activeRange,
      enhancedGoalLookup,
      goalColorLookup,
      lifeRoutineSurfaceLookup,
      activeRange === 'all' && allTimeWindowStart ? { windowStartMs: allTimeWindowStart } : undefined,
    )
  }, [
    effectiveHistory,
    activeRange,
    enhancedGoalLookup,
    goalColorLookup,
    lifeRoutineSurfaceLookup,
    allTimeWindowStart,
  ])
  const activeRangeConfig = RANGE_DEFS[activeRange]
  const isAllTimeRange = activeRange === 'all'
  const overviewBlockedMessage = useMemo(() => {
    if (!isAllTimeRange) {
      return null
    }
    switch (accountCreatedAtStatus) {
      case 'guest':
        return 'Guest accounts do not have access to the all-time overview.'
      case 'loading':
        return 'Loading your all-time overview…'
      case 'error':
        return 'Unable to load your account start date right now.'
      case 'idle':
        return 'Preparing your all-time overview…'
      default:
        return null
    }
  }, [accountCreatedAtStatus, isAllTimeRange])
  const loggedSegments = useMemo(() => segments.filter((segment) => !segment.isUnlogged), [segments])
  const unloggedFraction = useMemo(
    () => Math.max(0, 1 - loggedSegments.reduce((sum, segment) => sum + segment.fraction, 0)),
    [loggedSegments],
  )
  const legendSegments = useMemo(() => {
    const base = loggedSegments.length > 1 ? [...loggedSegments].sort((a, b) => b.durationMs - a.durationMs) : loggedSegments
    if (unloggedFraction > 0 && windowMs > loggedMs) {
      return [
        ...base,
        {
          id: 'unlogged',
          label: 'Unlogged Time',
          durationMs: windowMs - loggedMs,
          fraction: unloggedFraction,
          swatch: 'var(--reflection-chart-unlogged)',
          baseColor: 'var(--reflection-chart-unlogged)',
          isUnlogged: true,
        } as PieSegment,
      ]
    }
    return base
  }, [loggedSegments, windowMs, loggedMs, unloggedFraction])

  // Snap Back Overview data (counts + duration by reason within active range)
  const snapbackOverview = useMemo(() => {
    const now = Date.now()
    const windowMs = SNAP_RANGE_DEFS[snapActiveRange].durationMs
    const windowStart = now - windowMs
    const totals = new Map<string, { count: number; label: string; durationMs: number }>()

    // Build alias -> base_key and base_key -> label maps from DB rows
    const aliasToBase = new Map<string, string>()
    const baseToLabel = new Map<string, string>()
    snapDbRows.forEach((row) => {
      const base = (row.base_key ?? '').trim().toLowerCase()
      if (!base) return
      const alias = (row.trigger_name ?? '').trim()
      if (alias) aliasToBase.set(alias.toLowerCase(), base)
      if (alias) baseToLabel.set(base, alias)
    })

    const parseReason = (taskName: string): string | null => {
      const prefix = 'Snapback • '
      if (!taskName || !taskName.startsWith(prefix)) return null
      const rest = taskName.slice(prefix.length)
      const enDash = ' – '
      let reason: string | null = null
      if (rest.includes(enDash)) {
        reason = rest.split(enDash).slice(1).join(enDash).trim()
      } else if (rest.includes(' - ')) {
        reason = rest.split(' - ').slice(1).join(' - ').trim()
      }
      if (reason && reason.length > 0) return reason.slice(0, 120)
      return 'Snapback'
    }

    effectiveHistory.forEach((entry) => {
      const start = Math.min(entry.startedAt, entry.endedAt)
      const end = Math.max(entry.startedAt, entry.endedAt)
      if (end <= windowStart || start >= now) return
      const clampedStart = Math.max(start, windowStart)
      const clampedEnd = Math.min(end, now)
      const overlapMs = Math.max(0, clampedEnd - clampedStart)
      if (overlapMs <= 0) return
      const goalLower = (entry.goalName ?? '').trim().toLowerCase()
      let baseKey: string | null = null
      let label: string | null = null
      // Case 1: explicit Snapback goal — use bucket name as trigger, map to base_key via DB alias if possible
      if (goalLower === SNAPBACK_NAME.toLowerCase()) {
        const bucket = (entry.bucketName ?? '').trim()
        if (bucket) {
          const aliasLower = bucket.toLowerCase()
          baseKey = aliasToBase.get(aliasLower) ?? aliasLower
          label = baseToLabel.get(baseKey) ?? bucket
        }
      }
      // Case 2: marker task name
      if (!baseKey) {
        const reason = parseReason(entry.taskName)
        if (!reason) return
        const aliasLower = reason.trim().toLowerCase()
        baseKey = aliasToBase.get(aliasLower) ?? aliasLower
        label = baseToLabel.get(baseKey) ?? reason
      }
      if (!baseKey) return
      const existing = totals.get(baseKey)
      if (existing) {
        existing.count += 1
        existing.durationMs += overlapMs
      } else {
        totals.set(baseKey, { count: 1, label: label ?? baseKey, durationMs: overlapMs })
      }
    })

    const items = Array.from(totals.entries())
      .map(([key, info]) => ({ key, count: info.count, label: info.label, durationMs: info.durationMs }))
      .sort((a, b) => (b.count === a.count ? b.durationMs - a.durationMs : b.count - a.count))

    const legend = items.map((item) => {
      const color = getPaletteColorForLabel(item.label)
      return { id: `snap-${item.key}`, label: item.label, count: item.count, durationMs: item.durationMs, swatch: color }
    })

    const total = items.reduce((sum, it) => sum + it.count, 0)
    const maxDurationMs = legend.reduce((max, it) => Math.max(max, it.durationMs), 0)
    return { legend, total, windowMs, maxDurationMs }
  }, [effectiveHistory, snapActiveRange, snapDbRows])
  const pieArcs = useMemo(() => createPieArcs(segments, windowMs), [segments, windowMs])
  useLayoutEffect(() => {
    if (!supportsConicGradient) {
      return
    }
    const canvas = pieCanvasRef.current
    if (!canvas) {
      return
    }
    const context = canvas.getContext('2d')
    if (!context || typeof (context as CanvasRenderingContext2D & { createConicGradient?: unknown }).createConicGradient !== 'function') {
      return
    }
    const ctx = context as CanvasRenderingContext2D & {
      createConicGradient: (startAngle: number, x: number, y: number) => CanvasGradient
    }

    const draw = () => {
      if (typeof window === 'undefined') {
        return
      }
      const displayWidth = canvas.clientWidth || PIE_VIEWBOX_SIZE
      const displayHeight = canvas.clientHeight || PIE_VIEWBOX_SIZE
      const dpr = window.devicePixelRatio || 1
      const scaleX = displayWidth / PIE_VIEWBOX_SIZE
      const scaleY = displayHeight / PIE_VIEWBOX_SIZE
      const pixelWidth = Math.max(1, Math.round(displayWidth * dpr))
      const pixelHeight = Math.max(1, Math.round(displayHeight * dpr))

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(dpr * scaleX, 0, 0, dpr * scaleY, 0, 0)
      ctx.clearRect(0, 0, PIE_VIEWBOX_SIZE, PIE_VIEWBOX_SIZE)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'butt'
      ctx.imageSmoothingEnabled = true
      if ('imageSmoothingQuality' in ctx) {
        ;(ctx as unknown as { imageSmoothingQuality: ImageSmoothingQuality }).imageSmoothingQuality = 'high'
      }

      const fillDonut = (fillStyle: string | CanvasGradient) => {
        ctx.beginPath()
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_RADIUS, 0, Math.PI * 2, false)
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, Math.PI * 2, 0, true)
        ctx.closePath()
        ctx.fillStyle = fillStyle
        ctx.fill()
      }

      if (pieArcs.length === 0) {
        const fallbackFill = resolveCssColor('var(--reflection-chart-unlogged-soft)', '#31374d')
        fillDonut(fallbackFill)
        return
      }

      pieArcs.forEach((arc) => {
        const spanDegrees = arc.endAngle - arc.startAngle
        if (spanDegrees <= ARC_EPSILON) {
          return
        }
        const startRad = ((arc.startAngle - 90) * Math.PI) / 180
        const endRad = ((arc.endAngle - 90) * Math.PI) / 180
        ctx.beginPath()
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_RADIUS, startRad, endRad, false)
        ctx.arc(PIE_CENTER, PIE_CENTER, PIE_INNER_RADIUS, endRad, startRad, true)
        ctx.closePath()

        let fillStyle: string | CanvasGradient
        if (arc.isUnlogged) {
          fillStyle = resolveCssColor(arc.fill, '#31374d')
        } else if (arc.colorInfo?.gradient) {
          const gradientInfo = arc.colorInfo.gradient
          const gradient = ctx.createConicGradient(startRad, PIE_CENTER, PIE_CENTER)
          const spanRatio = clamp01(spanDegrees / 360)
          gradientInfo.stops.forEach((stop) => {
            gradient.addColorStop(spanRatio * clamp01(stop.position), stop.color)
          })
          const lastStop = gradientInfo.stops[gradientInfo.stops.length - 1]
          if (lastStop) {
            gradient.addColorStop(spanRatio, lastStop.color)
          }
          fillStyle = gradient
        } else if (arc.colorInfo?.solidColor) {
          fillStyle = arc.colorInfo.solidColor
        } else {
          fillStyle = resolveCssColor(arc.fill, arc.baseColor)
        }
        ctx.fillStyle = fillStyle
        ctx.fill()
      })
    }

    let rafId: number | null = null
    const scheduleDraw = () => {
      if (typeof window === 'undefined') {
        draw()
        return
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
      }
      rafId = window.requestAnimationFrame(() => {
        draw()
        rafId = null
      })
    }

    scheduleDraw()

    const handleResize = () => {
      scheduleDraw()
    }

    window.addEventListener('resize', handleResize)

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleDraw()
      })
      resizeObserver.observe(canvas)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      if (rafId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [pieArcs, supportsConicGradient, themeToken])
  const unloggedMs = useMemo(() => Math.max(windowMs - loggedMs, 0), [windowMs, loggedMs])
  const tabPanelId = 'reflection-range-panel'
  const snapbackPanelId = 'snapback-range-panel'
  const snapActiveRangeConfig = SNAP_RANGE_DEFS[snapActiveRange]

  // Snapback plans (DB-backed); initialize empty and hydrate from DB rows
  type SnapbackPlan = { cue: string; deconstruction: string; plan: string }
  type SnapbackPlanState = Record<string, SnapbackPlan>
  const [snapPlans, setSnapPlans] = useState<SnapbackPlanState>({})
  const snapPlansRef = useRef<SnapbackPlanState>({})
  useEffect(() => { snapPlansRef.current = snapPlans }, [snapPlans])
  const saveTimersRef = useRef<Map<string, number>>(new Map())
  const persistPlanForId = useCallback(async (idKey: string, planOverride?: { cue: string; deconstruction: string; plan: string }) => {
    const plan = planOverride ?? (snapPlansRef.current[idKey] ?? { cue: '', deconstruction: '', plan: '' })
    if (!plan) return
    let baseKey = ''
    let triggerName = ''
    if (idKey.startsWith('snap-')) {
      baseKey = idKey.slice(5)
      const existing = snapDbRows.find((r) => r.base_key === baseKey)
      triggerName = (existing?.trigger_name ?? '').trim()
      if (!triggerName) {
        const match = snapbackOverview.legend.find((it) => it.id === idKey)
        triggerName = match?.label ?? baseKey
      }
    } else {
      const row = snapDbRows.find((r) => r.id === idKey)
      if (!row) return
      baseKey = row.base_key
      triggerName = row.trigger_name ?? ''
    }
    const row = await apiUpsertSnapbackByKey({
      base_key: baseKey,
      trigger_name: triggerName,
      cue_text: plan.cue,
      deconstruction_text: plan.deconstruction,
      plan_text: plan.plan,
    })
    if (row) {
      startTransition(() => {
        setSnapDbRows((cur) => {
          const idx = cur.findIndex((r) => r.base_key === row.base_key)
          if (idx >= 0) { const copy = cur.slice(); copy[idx] = row; return copy }
          return [...cur, row]
        })
        setSnapPlans((cur) => ({ ...cur, [idKey]: { ...plan } }))
      })
    }
  }, [snapDbRows, snapbackOverview.legend])
  const schedulePersistPlan = useCallback((idKey: string, planSnapshot: { cue: string; deconstruction: string; plan: string }) => {
    if (typeof window === 'undefined') return
    const m = saveTimersRef.current
    const prev = m.get(idKey)
    if (prev) window.clearTimeout(prev)
    const tid = window.setTimeout(() => {
      m.delete(idKey)
      void persistPlanForId(idKey, planSnapshot)
    }, 500)
    m.set(idKey, tid as unknown as number)
  }, [persistPlanForId])

  // Lightweight, memoized editor for Snapback plans to avoid re-rendering the whole page while typing
  const SnapbackPlanForm = useMemo(() => {
    type Props = {
      idKey: string
      initialPlan: { cue: string; deconstruction: string; plan: string }
      onScheduleSave: (idKey: string, snapshot: { cue: string; deconstruction: string; plan: string }) => void
    }
    const Component = memo(function Component({ idKey, initialPlan, onScheduleSave }: Props) {
      const [draft, setDraft] = useState(initialPlan)
      useEffect(() => { setDraft(initialPlan) }, [initialPlan])
      return (
        <>
          <div className="snapback-drawer__group">
            <label className="snapback-drawer__label">Why is this happening?</label>
            {/* Hint removed */}
            <input
              type="text"
              className="snapback-drawer__input"
              placeholder="Describe the lead-up or trigger."
              value={draft.cue}
              onChange={(e) => {
                const next = { cue: e.target.value, deconstruction: draft.deconstruction, plan: draft.plan }
                setDraft(next)
                onScheduleSave(idKey, next)
              }}
            />
          </div>

          <div className="snapback-drawer__group">
            <label className="snapback-drawer__label">Is it aligned with who you want to be? What's the reward, is it sustainable?</label>
            {/* Hint removed */}
            <textarea
              className="snapback-drawer__textarea"
              placeholder="Be honest about the short-term reward and the long-term cost."
              value={draft.deconstruction}
              onChange={(e) => {
                const next = { cue: draft.cue, deconstruction: e.target.value, plan: draft.plan }
                setDraft(next)
                onScheduleSave(idKey, next)
              }}
            />
          </div>

          <div className="snapback-drawer__group">
            <label className="snapback-drawer__label">How do you change it next time?</label>
            {/* Hint removed */}
            <textarea
              className="snapback-drawer__textarea"
              placeholder="Write one small, concrete thing you’ll try."
              value={draft.plan}
              onChange={(e) => {
                const next = { cue: draft.cue, deconstruction: draft.deconstruction, plan: e.target.value }
                setDraft(next)
                onScheduleSave(idKey, next)
              }}
            />
          </div>
        </>
      )
    })
    Component.displayName = 'SnapbackPlanForm'
    return Component
  }, [])

  // Cleanup any pending autosave timers on unmount
  useEffect(() => {
    return () => {
      const m = saveTimersRef.current
      m.forEach((tid) => {
        if (typeof window !== 'undefined') {
          window.clearTimeout(tid)
        }
      })
      m.clear()
    }
  }, [])

  // Custom Triggers (user-defined, supplement overview legend)
  type CustomTrigger = { id: string; label: string }
  
  const [customTriggers, setCustomTriggers] = useState<CustomTrigger[]>([])

  // Aliases: override labels for history-derived triggers without creating new entries
  type SnapbackAliasMap = Record<string, string>
  const [snapbackAliases, setSnapbackAliases] = useState<SnapbackAliasMap>({})

  

  // Derive aliases, custom extras, and initial plans from DB rows + computed legend
  useEffect(() => {
    const baseKeys = new Set(
      snapbackOverview.legend
        .map((it) => (typeof it.id === 'string' && it.id.startsWith('snap-') ? it.id.slice(5) : null))
        .filter((k): k is string => Boolean(k)),
    )
    const aliasMap: SnapbackAliasMap = {}
    const extras: CustomTrigger[] = []
    const mergedPlans: SnapbackPlanState = {}
    snapDbRows.forEach((row) => {
      const isBase = baseKeys.has(row.base_key)
      const idKey = isBase ? `snap-${row.base_key}` : row.id
      if (isBase) aliasMap[idKey] = row.trigger_name
      else extras.push({ id: row.id, label: row.trigger_name })
      mergedPlans[idKey] = {
        cue: row.cue_text ?? '',
        deconstruction: row.deconstruction_text ?? '',
        plan: row.plan_text ?? '',
      }
    })
    setSnapbackAliases(aliasMap)
    setCustomTriggers(extras)
    setSnapPlans((cur) => {
      const next: SnapbackPlanState = { ...cur }
      for (const [k, v] of Object.entries(mergedPlans)) {
        if (!(k in next)) next[k] = v
      }
      return next
    })
  }, [snapDbRows, snapbackOverview.legend.map((i) => i.id).join('|')])

  // Inline edit within list for newly created trigger
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null)
  const editTriggerInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editingTriggerId) {
      const id = setTimeout(() => editTriggerInputRef.current?.focus(), 0)
      return () => clearTimeout(id)
    }
  }, [editingTriggerId])
  const startAddTrigger = useCallback(async () => {
    const row = await apiCreateCustomSnapback('New Trigger')
    if (!row) return
    setSnapDbRows((cur) => [...cur, row])
    setSelectedTriggerKey(row.id)
    setEditingTriggerId(row.id)
  }, [])
  const commitEditTrigger = useCallback(async () => {
    if (!editingTriggerId) return
    const raw = editTriggerInputRef.current?.value ?? ''
    const trimmed = raw.trim()
    const newLabel = trimmed.length === 0 ? 'New Trigger' : trimmed
    const ok = await apiUpdateSnapbackNameById(editingTriggerId, newLabel)
    if (ok) {
      setSnapDbRows((cur) => cur.map((r) => (r.id === editingTriggerId ? { ...r, trigger_name: newLabel } as DbSnapbackOverview : r)))
    }
    setEditingTriggerId(null)
  }, [editingTriggerId])

  const combinedLegend = useMemo(() => {
    const base = snapbackOverview.legend
    if (customTriggers.length === 0) return base
    const existing = new Set(base.map((it) => it.label.toLowerCase().trim()))
    const extras = customTriggers
      .filter((ct) => !existing.has(ct.label.toLowerCase().trim()))
      .map((ct) => ({ id: ct.id, label: ct.label, count: 0, durationMs: 0, swatch: getPaletteColorForLabel(ct.label) }))
    const merged = [...base, ...extras]
    return merged.map((it) => ({ ...it, label: snapbackAliases[it.id] ?? it.label }))
  }, [snapbackOverview.legend, customTriggers, snapbackAliases])

  // Persist current overview trigger labels for the Snapback panel to mirror
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const labels = combinedLegend.map((i) => i.label)
      window.localStorage.setItem('nc-taskwatch-overview-triggers', JSON.stringify(labels))
    } catch {}
  }, [combinedLegend.map((i) => i.label).join('|')])

  const [selectedTriggerKey, setSelectedTriggerKey] = useState<string | null>(null)
  useEffect(() => {
    const first = combinedLegend[0]?.id ?? null
    setSelectedTriggerKey(first)
  }, [snapActiveRange, combinedLegend.map((i) => i.id).join('|')])

  const selectedItem = useMemo(() => combinedLegend.find((i) => i.id === selectedTriggerKey) ?? combinedLegend[0] ?? null, [selectedTriggerKey, combinedLegend])

  // Compute last time the selected Snapback trigger was recorded (across all time)
  const selectedTriggerLastAtLabel = useMemo(() => {
    if (!selectedItem) return 'Never'
    const baseKey = selectedItem.id.startsWith('snap-') ? selectedItem.id.slice(5) : selectedItem.id
    // Build alias -> base_key map from DB so we interpret historical aliases consistently
    const aliasToBase = new Map<string, string>()
    const baseToLabel = new Map<string, string>()
    snapDbRows.forEach((row) => {
      const base = (row.base_key ?? '').trim().toLowerCase()
      if (!base) return
      const alias = (row.trigger_name ?? '').trim()
      if (alias) aliasToBase.set(alias.toLowerCase(), base)
      if (alias) baseToLabel.set(base, alias)
    })
    const parseReason = (taskName: string): string | null => {
      const prefix = 'Snapback • '
      if (!taskName || !taskName.startsWith(prefix)) return null
      const rest = taskName.slice(prefix.length)
      const enDash = ' – '
      let reason: string | null = null
      if (rest.includes(enDash)) {
        reason = rest.split(enDash).slice(1).join(enDash).trim()
      } else if (rest.includes(' - ')) {
        reason = rest.split(' - ').slice(1).join(' - ').trim()
      }
      if (reason && reason.length > 0) return reason.slice(0, 120)
      return 'Snapback'
    }
    let lastAt: number | null = null
    const targetBase = baseKey.toLowerCase()
    for (const entry of effectiveHistory) {
      const goalLower = (entry.goalName ?? '').trim().toLowerCase()
      let key: string | null = null
      if (goalLower === SNAPBACK_NAME.toLowerCase()) {
        const bucket = (entry.bucketName ?? '').trim()
        if (bucket) {
          const aliasLower = bucket.toLowerCase()
          key = aliasToBase.get(aliasLower) ?? aliasLower
        }
      }
      if (!key) {
        const reason = parseReason(entry.taskName)
        if (reason) {
          const aliasLower = reason.trim().toLowerCase()
          key = aliasToBase.get(aliasLower) ?? aliasLower
        }
      }
      if (!key) continue
      if (key === targetBase) {
        const when = Math.max(entry.startedAt, entry.endedAt)
        if (lastAt === null || when > lastAt) lastAt = when
      }
    }
    if (!lastAt) return 'Never'
    const now = Date.now()
    const diff = Math.max(0, now - lastAt)
    const days = Math.floor(diff / (24 * 60 * 60 * 1000))
    if (days <= 0) return 'Today'
    if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`
    const weeks = Math.floor(days / 7)
    if (weeks < 8) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
    const months = Math.floor(days / 30)
    if (months < 24) return months === 1 ? '1 month ago' : `${months} months ago`
    const years = Math.floor(days / 365)
    return years === 1 ? '1 year ago' : `${years} years ago`
  }, [selectedItem, effectiveHistory, snapDbRows])
  const selectedPlan = useMemo(() => {
    if (!selectedItem) return { cue: '', deconstruction: '', plan: '' }
    const key = selectedItem.id
    return snapPlans[key] ?? { cue: '', deconstruction: '', plan: '' }
  }, [selectedItem, snapPlans])
  // Lightweight editable title to avoid re-rendering the whole page on each keystroke
  const SnapbackEditableTitle = useMemo(() => {
    function Component({
      item,
      isCustom,
      onRename,
      onAlias,
    }: {
      item: { id: string; label: string } | null
      isCustom: boolean
      onRename: (id: string, label: string) => void
      onAlias: (id: string, label: string) => void
    }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const inputRef = useRef<HTMLInputElement | null>(null)
      useEffect(() => {
        setDraft(item?.label ?? '')
        setEditing(false)
      }, [item?.id])
      useEffect(() => {
        if (editing) {
          const id = setTimeout(() => {
            inputRef.current?.focus()
            try { inputRef.current?.select() } catch {}
          }, 0)
          return () => clearTimeout(id)
        }
      }, [editing])
      const commit = useCallback(() => {
        if (!item) return
        const next = draft.trim()
        if (next.length === 0 || next === item.label) { setEditing(false); return }
        if (isCustom) {
          startTransition(() => onRename(item.id, next))
        } else {
          startTransition(() => onAlias(item.id, next))
        }
        setEditing(false)
      }, [draft, isCustom, item, onAlias, onRename])
      if (!item) return <h3 className="snapback-drawer__title">—</h3>
      return editing ? (
        <input
          ref={inputRef}
          type="text"
          className="snapback-drawer__title-input"
          defaultValue={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(item.label); setEditing(false) }
          }}
          aria-label="Edit trigger title"
        />
      ) : (
        <h3
          className="snapback-drawer__title snapback-drawer__title--editable"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to edit"
        >
          {item.label}
        </h3>
      )
    }
    return Component
  }, [])
  const dayStart = useMemo(() => {
    const date = new Date(nowTick)
    date.setHours(0, 0, 0, 0)
    if (calendarView === '3d' && historyDayOffset !== 0) {
      const adjusted = new Date(date)
      adjusted.setDate(adjusted.getDate() + historyDayOffset)
      return adjusted.getTime()
    }
    if (historyDayOffset !== 0) {
      date.setDate(date.getDate() + historyDayOffset)
    }
    return date.getTime()
  }, [nowTick, historyDayOffset, calendarView])
  const dayEnd = dayStart + DAY_DURATION_MS
  const anchorDate = useMemo(() => new Date(dayStart), [dayStart])
  const currentTimePercent = useMemo(() => {
    if (nowTick < dayStart || nowTick > dayEnd) {
      return null
    }
    const raw = ((nowTick - dayStart) / DAY_DURATION_MS) * 100
    return Math.min(Math.max(raw, 0), 100)
  }, [nowTick, dayStart, dayEnd])
  const daySegments = useMemo(() => {
    const preview = dragPreview
    const entries = effectiveHistory
      .map((entry) => {
        const isPreviewed = preview && preview.entryId === entry.id
        const startedAt = isPreviewed ? preview.startedAt : entry.startedAt
        const endedAt = isPreviewed ? preview.endedAt : entry.endedAt
        const previewedEntry = isPreviewed
          ? {
              ...entry,
              startedAt,
              endedAt,
              elapsed: Math.max(endedAt - startedAt, 1),
            }
          : entry
        const start = Math.max(previewedEntry.startedAt, dayStart)
        const end = Math.min(previewedEntry.endedAt, dayEnd)
        if (end <= start) {
          return null
        }
        return { entry: previewedEntry, start, end }
      })
      .filter((segment): segment is { entry: HistoryEntry; start: number; end: number } => Boolean(segment))

    if (preview && preview.entryId === 'new-entry') {
      const start = Math.max(Math.min(preview.startedAt, preview.endedAt), dayStart)
      const end = Math.min(Math.max(preview.startedAt, preview.endedAt), dayEnd)
      if (end > start) {
        const syntheticEntry: HistoryEntry = {
          id: 'new-entry',
          taskName: '',
          goalName: null,
          bucketName: null,
          goalId: null,
          bucketId: null,
          taskId: null,
          elapsed: Math.max(end - start, MIN_SESSION_DURATION_DRAG_MS),
          startedAt: start,
          endedAt: end,
          goalSurface: DEFAULT_SURFACE_STYLE,
          bucketSurface: null,
          notes: '',
          subtasks: [],
        }
        entries.push({ entry: syntheticEntry, start, end })
      }
    }

    entries.sort((a, b) => a.start - b.start)
    const lanes: number[] = []
    return entries.map(({ entry, start, end }) => {
      let lane = lanes.findIndex((laneEnd) => start >= laneEnd - 1000)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(end)
      } else {
        lanes[lane] = end
      }
      const left = ((start - dayStart) / DAY_DURATION_MS) * 100
      const rawWidth = ((end - start) / DAY_DURATION_MS) * 100
      const safeLeft = Math.min(Math.max(left, 0), 100)
      const maxWidth = Math.max(100 - safeLeft, 0)
      const widthPercent = Math.min(Math.max(rawWidth, 0.8), maxWidth)
      const labelSource = entry.goalName?.trim().length ? entry.goalName! : entry.taskName
      const metadata = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
      const gradientCss = metadata.colorInfo?.gradient?.css
      const solidColor = metadata.colorInfo?.solidColor
      const fallbackLabel =
        labelSource && labelSource.trim().length > 0 ? labelSource : metadata.label ?? 'Session'
      const color =
        gradientCss ?? solidColor ?? getPaletteColorForLabel(fallbackLabel && fallbackLabel.trim().length > 0 ? fallbackLabel : 'Session')
      const goalLabel = metadata.label
      const bucketLabel = entry.bucketName && entry.bucketName.trim().length > 0 ? entry.bucketName : ''
      const originalRangeLabel = formatDateRange(entry.startedAt, entry.endedAt)
      const tooltipTask =
        entry.taskName.trim().length > 0 ? entry.taskName : goalLabel !== UNCATEGORISED_LABEL ? goalLabel : 'Focus Session'
      return {
        id: entry.id,
        entry,
        start,
        end,
        lane,
        leftPercent: safeLeft,
        widthPercent,
        color,
        gradientCss,
        colorInfo: metadata.colorInfo,
        goalLabel,
        bucketLabel,
        deletable: entry.id !== 'active-session',
        originalRangeLabel,
        tooltipTask,
      }
    })
  }, [effectiveHistory, dayStart, dayEnd, enhancedGoalLookup, goalColorLookup, dragPreview])
  const timelineRowCount = daySegments.length > 0 ? daySegments.reduce((max, segment) => Math.max(max, segment.lane), 0) + 1 : 1
  const showCurrentTimeIndicator = typeof currentTimePercent === 'number' && editingHistoryId === null
  const timelineStyle = useMemo(() => ({ '--history-timeline-rows': timelineRowCount } as CSSProperties), [timelineRowCount])
  const timelineTicks = useMemo(() => {
    const ticks: Array<{ hour: number; showLabel: boolean }> = []
    for (let hour = 0; hour <= 24; hour += 1) {
      const isLabeledTick = hour % 6 === 0 && hour < 24
      ticks.push({ hour, showLabel: isLabeledTick })
    }
    return ticks
  }, [])

  // --- Calendar event preview (popover) ---
  const [calendarPreview, setCalendarPreview] = useState<
    | null
    | {
        entryId: string
        entrySnapshot?: HistoryEntry | null
        top: number
        left: number
        anchorEl: HTMLElement | null
      }
  >(null)
  const calendarPreviewRef = useRef<HTMLDivElement | null>(null)
  const [calendarPopoverEditing, setCalendarPopoverEditing] = useState<CalendarPopoverEditingState | null>(null)
  const calendarPopoverFocusedEntryRef = useRef<string | null>(null)
  const calendarPopoverTitleRef = useRef<HTMLDivElement | null>(null)
  // Suppress one subsequent open caused by bubbling/click-after-close on mobile
  const suppressEventOpenRef = useRef(false)
  const suppressNextEventOpen = useCallback(() => {
    suppressEventOpenRef.current = true
    window.setTimeout(() => {
      suppressEventOpenRef.current = false
    }, 300)
  }, [])

  const positionCalendarPreview = useCallback((anchorEl: HTMLElement | null) => {
    if (!anchorEl) return
    const anchorRect = anchorEl.getBoundingClientRect()
    const padding = 8
    const pop = calendarPreviewRef.current
    // Use actual size if mounted, otherwise fall back to assumptions
    const popWidth = pop ? Math.ceil(pop.getBoundingClientRect().width) || 420 : 420
    const popHeight = pop ? Math.ceil(pop.getBoundingClientRect().height) || 220 : 220

    // Available space in each direction
    const rightSpace = Math.max(0, window.innerWidth - padding - anchorRect.right)
    const leftSpace = Math.max(0, anchorRect.left - padding)
    const belowSpace = Math.max(0, window.innerHeight - padding - anchorRect.bottom)
    const aboveSpace = Math.max(0, anchorRect.top - padding)

    // Try placements in priority order: right, left, below, above
    // Choose the first placement that fully fits; otherwise use the best partial and clamp
    type Placement = 'right' | 'left' | 'below' | 'above'
    const candidates: Placement[] = []
    if (rightSpace >= leftSpace) {
      candidates.push('right', 'left', 'below', 'above')
    } else {
      candidates.push('left', 'right', 'below', 'above')
    }

    let left = 0
    let top = 0
    let placed = false

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

    for (const placement of candidates) {
      if (placement === 'right') {
        if (rightSpace >= popWidth) {
          left = Math.round(anchorRect.right + padding)
          // align to anchor top by default, then clamp vertically
          top = Math.round(anchorRect.top)
          placed = true
          break
        }
      } else if (placement === 'left') {
        if (leftSpace >= popWidth) {
          left = Math.round(anchorRect.left - popWidth - padding)
          top = Math.round(anchorRect.top)
          placed = true
          break
        }
      } else if (placement === 'below') {
        if (belowSpace >= popHeight) {
          top = Math.round(anchorRect.bottom + padding)
          // Prefer aligning left edges; clamp within viewport
          left = Math.round(anchorRect.left)
          placed = true
          break
        }
      } else if (placement === 'above') {
        if (aboveSpace >= popHeight) {
          top = Math.round(anchorRect.top - popHeight - padding)
          left = Math.round(anchorRect.left)
          placed = true
          break
        }
      }
    }

    if (!placed) {
      // Fallback: choose the direction with the most space and clamp within viewport
      const bestHorizontal = rightSpace >= leftSpace ? 'right' : 'left'
      const bestVertical = belowSpace >= aboveSpace ? 'below' : 'above'
      const preferHorizontal = Math.max(rightSpace, leftSpace) >= Math.max(belowSpace, aboveSpace)
      const placement = preferHorizontal ? bestHorizontal : bestVertical
      switch (placement) {
        case 'right':
          left = Math.round(anchorRect.right + padding)
          top = Math.round(anchorRect.top)
          break
        case 'left':
          left = Math.round(anchorRect.left - popWidth - padding)
          top = Math.round(anchorRect.top)
          break
        case 'below':
          top = Math.round(anchorRect.bottom + padding)
          left = Math.round(anchorRect.left)
          break
        case 'above':
          top = Math.round(anchorRect.top - popHeight - padding)
          left = Math.round(anchorRect.left)
          break
      }
    }

    // Final clamp into the viewport
    left = clamp(left, padding, Math.max(padding, window.innerWidth - padding - popWidth))
    top = clamp(top, padding, Math.max(padding, window.innerHeight - padding - popHeight))

    if (pop) {
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
    }
  }, [])

  const handleOpenCalendarPreview = useCallback(
    (entry: HistoryEntry, targetEl: HTMLElement) => {
      // Select entry for consistency with other flows.
      handleSelectHistorySegment(entry, { preserveSelection: true })
      void ensureSubtasksFetched(entry)
      if (calendarInspectorEntryId) {
        openCalendarInspector(entry)
        setCalendarPreview(null)
        return
      }
      // Compute an initial position immediately
      const rect = targetEl.getBoundingClientRect()
      const viewportPadding = 8
      const assumedWidth = 420
      const assumedHeight = 220
      const rightSpace = Math.max(0, window.innerWidth - viewportPadding - rect.right)
      const leftSpace = Math.max(0, rect.left - viewportPadding)
      const belowSpace = Math.max(0, window.innerHeight - viewportPadding - rect.bottom)
      const aboveSpace = Math.max(0, rect.top - viewportPadding)
      // Try right/left first, then below/above; pick best fit
      let left = 0
      let top = 0
      let placed = false
      if (rightSpace >= assumedWidth) {
        left = Math.round(rect.right + viewportPadding)
        top = Math.round(rect.top)
        placed = true
      } else if (leftSpace >= assumedWidth) {
        left = Math.round(rect.left - assumedWidth - viewportPadding)
        top = Math.round(rect.top)
        placed = true
      } else if (belowSpace >= assumedHeight) {
        top = Math.round(rect.bottom + viewportPadding)
        left = Math.round(rect.left)
        placed = true
      } else if (aboveSpace >= assumedHeight) {
        top = Math.round(rect.top - assumedHeight - viewportPadding)
        left = Math.round(rect.left)
        placed = true
      }
      if (!placed) {
        // Fallback: choose side with most space and clamp
        if (Math.max(rightSpace, leftSpace) >= Math.max(belowSpace, aboveSpace)) {
          if (rightSpace >= leftSpace) {
            left = Math.round(rect.right + viewportPadding)
          } else {
            left = Math.round(rect.left - assumedWidth - viewportPadding)
          }
          top = Math.round(rect.top)
        } else {
          if (belowSpace >= aboveSpace) {
            top = Math.round(rect.bottom + viewportPadding)
          } else {
            top = Math.round(rect.top - assumedHeight - viewportPadding)
          }
          left = Math.round(rect.left)
        }
        // Clamp into viewport
        left = Math.min(Math.max(left, viewportPadding), Math.max(viewportPadding, window.innerWidth - viewportPadding - assumedWidth))
        top = Math.min(Math.max(top, viewportPadding), Math.max(viewportPadding, window.innerHeight - viewportPadding - assumedHeight))
      }
  setCalendarPreview({ entryId: entry.id, entrySnapshot: entry, top, left, anchorEl: targetEl })
      // Position on next frame to refine based on actual size
      requestAnimationFrame(() => positionCalendarPreview(targetEl))
    },
    [calendarInspectorEntryId, handleSelectHistorySegment, openCalendarInspector, positionCalendarPreview, ensureSubtasksFetched],
  )

  const handleCloseCalendarPreview = useCallback(() => setCalendarPreview(null), [])

  useEffect(() => {
    if (customRecurrenceOpen) {
      setCalendarPreview(null)
    }
  }, [customRecurrenceOpen])

  useEffect(() => {
    if (customRecurrenceOpen || calendarEditorEntryId) {
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
  }, [customRecurrenceOpen, calendarEditorEntryId])

  useEffect(() => {
    if (!customRecurrenceOpen || (!customUnitMenuOpen && !customMonthlyMenuOpen)) return
    const onDocPointerDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null
      if (!el) return
      const withinUnit = customUnitMenuRef.current && customUnitMenuRef.current.contains(el)
      const withinMonthly = customMonthlyMenuRef.current && customMonthlyMenuRef.current.contains(el)
      if (withinUnit || withinMonthly) return
      setCustomUnitMenuOpen(false)
      setCustomMonthlyMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [customRecurrenceOpen, customUnitMenuOpen, customMonthlyMenuOpen])

  useEffect(() => {
    if (!calendarPreview) return
    const onDocPointerDown = (e: PointerEvent) => {
      const node = e.target as Node | null
      if (!node) return
      // Ignore interactions with dropdown overlays rendered in a portal
      if (node instanceof Element) {
        const dropdownMenu = node.closest('.history-dropdown__menu')
        if (dropdownMenu) return
      }
      // Ignore clicks inside the popover
      if (calendarPreviewRef.current && calendarPreviewRef.current.contains(node)) return
      // If tapping a calendar event while a popover is open, handle toggle for the same entry id.
      // For a different event, let its own onClick open the popover so guides (not in effectiveHistory) work too.
      if (node instanceof Element) {
        const evEl = (node.closest('.calendar-event') || node.closest('.calendar-allday-event')) as HTMLElement | null
        const tappedId = evEl?.dataset.entryId
        if (tappedId) {
          if (calendarPreview && calendarPreview.entryId === tappedId) {
            suppressNextEventOpen()
            handleCloseCalendarPreview()
            return
          }
          // Different event tapped: allow its own onClick to open
          return
        }
      }
      // Clicked outside both the popover and any event: close
      handleCloseCalendarPreview()
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') handleCloseCalendarPreview()
    }
    const onReposition = () => {
      if (typeof window !== 'undefined' && 'visualViewport' in window) {
        const vv = window.visualViewport
        if (vv) {
          // Skip repositioning for tiny viewport heights (likely keyboard).
          if (vv.height < window.innerHeight * 0.6) {
            return
          }
        }
      }
      positionCalendarPreview(calendarPreview.anchorEl || null)
      // After moving, clamp again based on actual size (DOM-only)
      const pop = calendarPreviewRef.current
      if (!pop) return
      const rect = pop.getBoundingClientRect()
      const padding = 8
      let top = rect.top
      let left = rect.left
      if (rect.right > window.innerWidth - padding) {
        left = Math.max(padding, window.innerWidth - padding - rect.width)
      }
      if (rect.bottom > window.innerHeight - padding) {
        top = Math.max(padding, window.innerHeight - padding - rect.height)
      }
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onKeyDown as any)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onKeyDown as any)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [calendarPreview, handleCloseCalendarPreview, positionCalendarPreview, effectiveHistory, handleOpenCalendarPreview, suppressNextEventOpen])

  useEffect(() => {
    if (!calendarPreview) {
      setCalendarPopoverEditing(null)
      calendarPopoverFocusedEntryRef.current = null
      return
    }
    setCalendarPopoverEditing((current) => {
      if (!current) {
        return current
      }
      return current.entryId === calendarPreview.entryId ? current : null
    })
  }, [calendarPreview])

  useEffect(() => {
    if (!calendarPopoverEditing) {
      calendarPopoverFocusedEntryRef.current = null
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    if (calendarPopoverFocusedEntryRef.current === calendarPopoverEditing.entryId) {
      return
    }
    const editingState = calendarPopoverEditing
    calendarPopoverFocusedEntryRef.current = editingState.entryId
    const raf = window.requestAnimationFrame(() => {
      const editableEl = calendarPopoverTitleRef.current
      if (!editableEl) {
        return
      }
      try {
        editableEl.focus({ preventScroll: true })
      } catch {
        try { editableEl.focus() } catch {}
      }
      let snapshotApplied = false
      if (editingState.selectionSnapshot) {
        snapshotApplied = applySelectionSnapshot(editableEl, editingState.selectionSnapshot)
      }
      if (!snapshotApplied) {
        const selection = window.getSelection()
        if (selection) {
          const range = (editableEl.ownerDocument || document).createRange()
          range.selectNodeContents(editableEl)
          range.collapse(false)
          selection.removeAllRanges()
          selection.addRange(range)
        }
      }
      if (editingState.selectionSnapshot) {
        setCalendarPopoverEditing((state) => {
          if (!state || state.entryId !== editingState.entryId || !state.selectionSnapshot) {
            return state
          }
          return { ...state, selectionSnapshot: null }
        })
      }
    })
    return () => {
      window.cancelAnimationFrame(raf)
    }
  }, [calendarPopoverEditing, setCalendarPopoverEditing])

  useLayoutEffect(() => {
    const editableEl = calendarPopoverTitleRef.current
    const editingState = calendarPopoverEditing
    if (!editableEl || !editingState) {
      return
    }
    const desired = editingState.value
    if (editableEl.textContent !== desired) {
      editableEl.textContent = desired
    }
  }, [calendarPopoverEditing])

  const anchoredTooltipId = hoveredHistoryId ?? selectedHistoryId
  const dayEntryCount = daySegments.length
  const [calendarTitleOverride, setCalendarTitleOverride] = useState<string | null>(null)
  const monthAndYearLabel = useMemo(() => {
    if (calendarTitleOverride) return calendarTitleOverride
    if (calendarView === 'year') {
      return String(anchorDate.getFullYear())
    }
    return anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }, [anchorDate, calendarView, calendarTitleOverride])

  // Clear preview title once the anchor date reflects the committed window
  useEffect(() => {
    if (!(calendarView === 'month' || calendarView === 'year')) return
    const target = pendingTitleClearRef.current
    if (target == null) return
    const currentAnchorMs = new Date(anchorDate.getFullYear(), calendarView === 'month' ? anchorDate.getMonth() : 0, 1).getTime()
    if (currentAnchorMs === target) {
      setCalendarTitleOverride(null)
      pendingTitleClearRef.current = null
    }
  }, [anchorDate, calendarView])

  // Ensure the month/year carousel track is centered on the middle panel
  // even on initial render or after anchorDate/view changes.
  useLayoutEffect(() => {
    if (!(calendarView === 'month' || calendarView === 'year')) return
    const container = monthYearCarouselRef.current
    const track = container?.querySelector('.calendar-carousel__track') as HTMLDivElement | null
    if (!container || !track) return
    if ((container as any).dataset.animating === '1') return
    const base = -container.clientWidth
    track.style.transition = 'none'
    track.style.transform = `translate3d(${base}px, 0, 0)`
    requestAnimationFrame(() => { track.style.transition = '' })
  }, [calendarView, anchorDate])

  // Keep month/year carousel centered on the middle panel when the viewport resizes
  useEffect(() => {
    if (!(calendarView === 'month' || calendarView === 'year')) return
    const container = monthYearCarouselRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const recenter = () => {
      const track = container.querySelector('.calendar-carousel__track') as HTMLDivElement | null
      if (!track) return
      if ((container as any).dataset.animating === '1') return
      const base = -container.clientWidth
      track.style.transition = 'none'
      track.style.transform = `translate3d(${base}px, 0, 0)`
      // Double rAF to ensure styles apply after layout settles during resize
      requestAnimationFrame(() => { requestAnimationFrame(() => { track.style.transition = '' }) })
    }
    const ro = new ResizeObserver(() => recenter())
    ro.observe(container)
    // Also recenter on orientation change (mobile browsers)
    const handleOrientation = () => recenter()
    const handleWindowResize = () => recenter()
    window.addEventListener('orientationchange', handleOrientation)
    window.addEventListener('resize', handleWindowResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('orientationchange', handleOrientation)
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [calendarView])
  const dayLabel = useMemo(() => {
    const date = new Date(dayStart)
    const weekday = date.toLocaleDateString(undefined, { weekday: 'long' })
    const dayNumber = date.getDate().toString().padStart(2, '0')
    return `${weekday} · ${dayNumber}`
  }, [dayStart])
  const daysInMonth = useMemo(() => {
    const d = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0)
    return d.getDate()
  }, [anchorDate])

  const stepSizeByView: Record<CalendarViewMode, number> = useMemo(
    () => ({ day: 1, '3d': Math.max(2, Math.min(multiDayCount, 14)), week: 7, month: daysInMonth, year: 365 }),
    [daysInMonth, multiDayCount],
  )

  useEffect(() => {
    historyDayOffsetRef.current = historyDayOffset
    calendarPanDesiredOffsetRef.current = historyDayOffset
  }, [historyDayOffset])

  const navigateByDelta = useCallback(
    (delta: number) => {
      if (delta === 0) {
        return
      }
      const baseOffset = calendarPanDesiredOffsetRef.current
      const targetOffset = baseOffset + delta
      if (!(calendarView === 'day' || calendarView === '3d' || calendarView === 'week')) {
        calendarPanDesiredOffsetRef.current = targetOffset
        historyDayOffsetRef.current = targetOffset
        setHistoryDayOffset(targetOffset)
        return
      }
      const area = calendarDaysAreaRef.current
      if (!area) {
        calendarPanDesiredOffsetRef.current = targetOffset
        historyDayOffsetRef.current = targetOffset
        setHistoryDayOffset(targetOffset)
        return
      }
      const visibleDayCount =
        calendarView === '3d'
          ? Math.max(2, Math.min(multiDayCount, 14))
          : calendarView === 'week'
            ? 7
            : 1
      const dayWidth = area.clientWidth / Math.max(1, visibleDayCount)
      if (!Number.isFinite(dayWidth) || dayWidth <= 0) {
        calendarPanDesiredOffsetRef.current = targetOffset
        historyDayOffsetRef.current = targetOffset
        setHistoryDayOffset(targetOffset)
        return
      }
      stopCalendarPanAnimation({ commit: true })
      resetCalendarPanTransform()
      calendarPanDesiredOffsetRef.current = targetOffset
      historyDayOffsetRef.current = targetOffset
      const snapDays = -(targetOffset - baseOffset)
      animateCalendarPan(snapDays, dayWidth, baseOffset)
    },
    [animateCalendarPan, calendarView, multiDayCount, resetCalendarPanTransform, stopCalendarPanAnimation],
  )

  const handlePrevWindow = useCallback(() => {
    if (calendarView === 'month' || calendarView === 'year') {
      // Animate month/year like a swipe: previous = slide right (dir = +1)
      const container = monthYearCarouselRef.current
      const track = container?.querySelector('.calendar-carousel__track') as HTMLDivElement | null
      if (!container || !track) {
        // Fallback: instant jump
        const base = calendarView === 'month'
          ? new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 1, 1)
          : new Date(anchorDate.getFullYear() - 1, 0, 1)
        base.setHours(0, 0, 0, 0)
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const deltaDays = Math.round((base.getTime() - today.getTime()) / DAY_DURATION_MS)
        setHistoryDayOffset(deltaDays)
        return
      }
      if ((container as any).dataset.animating === '1') {
        // Queue a backward step while current animation completes
        monthYearNavQueueRef.current -= 1
        return
      }
      ;(container as any).dataset.animating = '1'
      const prevPointer = container.style.pointerEvents
      container.style.pointerEvents = 'none'
      const width = container.clientWidth
      const baseX = -width
      // Prepare base position
      track.style.transition = 'none'
      track.style.willChange = 'transform'
      track.style.transform = `translate3d(${baseX}px, 0, 0)`
      // Show target title during animation
      if (calendarView === 'month') {
        const previewMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 1, 1)
        setCalendarTitleOverride(previewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
      } else {
        setCalendarTitleOverride(String(anchorDate.getFullYear() - 1))
      }
      // Animate to the right (dir = +1)
      const target = baseX + 1 * width
      const easing = 'cubic-bezier(0.22, 0.72, 0.28, 1)'
      const duration = PAN_MIN_ANIMATION_MS
      let done = false
      let fallback: number | null = null
      const commit = () => {
        if (done) return; done = true
        // Commit the new window first to avoid any flash
        const nextBase = calendarView === 'month'
          ? new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 1, 1)
          : new Date(anchorDate.getFullYear() - 1, 0, 1)
        nextBase.setHours(0, 0, 0, 0)
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const deltaDays = Math.round((nextBase.getTime() - today.getTime()) / DAY_DURATION_MS)
        if (typeof flushSync === 'function') {
          flushSync(() => setHistoryDayOffset(deltaDays))
        } else {
          setHistoryDayOffset(deltaDays)
        }
        // Defer clearing the title until the anchor date updates
        pendingTitleClearRef.current = nextBase.getTime()
        // After new content mounts, snap track back to base without anim
        requestAnimationFrame(() => {
          const latestTrack = monthYearCarouselRef.current?.querySelector('.calendar-carousel__track') as HTMLDivElement | null
          if (latestTrack) {
            latestTrack.style.transition = 'none'
            latestTrack.style.transform = `translate3d(${baseX}px, 0, 0)`
            requestAnimationFrame(() => { latestTrack.style.transition = '' })
          }
          delete (container as any).dataset.animating
          container.style.pointerEvents = prevPointer
          // Chain any queued steps
          const pending = monthYearNavQueueRef.current
          if (pending !== 0) {
            const dir = pending > 0 ? 1 : -1
            monthYearNavQueueRef.current -= dir
            requestAnimationFrame(() => {
              if (dir > 0) {
                handleNextWindowRef.current()
              } else {
                handlePrevWindowRef.current()
              }
            })
          }
        })
      }
      const onEnd = () => {
        track.removeEventListener('transitionend', onEnd)
        if (fallback != null) { window.clearTimeout(fallback); fallback = null }
        track.style.transition = ''
        track.style.willChange = ''
        commit()
      }
      fallback = window.setTimeout(onEnd, duration + 80)
      const start = () => {
        track.style.transition = `transform ${duration}ms ${easing}`
        track.style.transform = `translate3d(${target}px, 0, 0)`
      }
      requestAnimationFrame(start)
      track.addEventListener('transitionend', onEnd, { once: true })
      return
    }
    navigateByDelta(-stepSizeByView[calendarView])
  }, [anchorDate, calendarView, navigateByDelta, setHistoryDayOffset, stepSizeByView])

  const handleNextWindow = useCallback(() => {
    if (calendarView === 'month' || calendarView === 'year') {
      // Animate month/year like a swipe: next = slide left (dir = -1)
      const container = monthYearCarouselRef.current
      const track = container?.querySelector('.calendar-carousel__track') as HTMLDivElement | null
      if (!container || !track) {
        // Fallback: instant jump
        const base = calendarView === 'month'
          ? new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1)
          : new Date(anchorDate.getFullYear() + 1, 0, 1)
        base.setHours(0, 0, 0, 0)
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const deltaDays = Math.round((base.getTime() - today.getTime()) / DAY_DURATION_MS)
        setHistoryDayOffset(deltaDays)
        return
      }
      if ((container as any).dataset.animating === '1') {
        // Queue a forward step while current animation completes
        monthYearNavQueueRef.current += 1
        return
      }
      ;(container as any).dataset.animating = '1'
      const prevPointer = container.style.pointerEvents
      container.style.pointerEvents = 'none'
      const width = container.clientWidth
      const baseX = -width
      // Prepare base position
      track.style.transition = 'none'
      track.style.willChange = 'transform'
      track.style.transform = `translate3d(${baseX}px, 0, 0)`
      // Show target title during animation
      if (calendarView === 'month') {
        const previewMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1)
        setCalendarTitleOverride(previewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
      } else {
        setCalendarTitleOverride(String(anchorDate.getFullYear() + 1))
      }
      // Animate to the left (dir = -1)
      const target = baseX - 1 * width
      const easing = 'cubic-bezier(0.22, 0.72, 0.28, 1)'
      const duration = PAN_MIN_ANIMATION_MS
      let done = false
      let fallback: number | null = null
      const commit = () => {
        if (done) return; done = true
        // Commit the new window first to avoid any flash
        const nextBase = calendarView === 'month'
          ? new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1)
          : new Date(anchorDate.getFullYear() + 1, 0, 1)
        nextBase.setHours(0, 0, 0, 0)
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const deltaDays = Math.round((nextBase.getTime() - today.getTime()) / DAY_DURATION_MS)
        if (typeof flushSync === 'function') {
          flushSync(() => setHistoryDayOffset(deltaDays))
        } else {
          setHistoryDayOffset(deltaDays)
        }
        // Defer clearing the title until the anchor date updates
        pendingTitleClearRef.current = nextBase.getTime()
        // After new content mounts, snap track back to base without anim
        requestAnimationFrame(() => {
          const latestTrack = monthYearCarouselRef.current?.querySelector('.calendar-carousel__track') as HTMLDivElement | null
          if (latestTrack) {
            latestTrack.style.transition = 'none'
            latestTrack.style.transform = `translate3d(${baseX}px, 0, 0)`
            requestAnimationFrame(() => { latestTrack.style.transition = '' })
          }
          delete (container as any).dataset.animating
          container.style.pointerEvents = prevPointer
          // Chain any queued steps
          const pending = monthYearNavQueueRef.current
          if (pending !== 0) {
            const dir = pending > 0 ? 1 : -1
            monthYearNavQueueRef.current -= dir
            requestAnimationFrame(() => {
              if (dir > 0) {
                handleNextWindowRef.current()
              } else {
                handlePrevWindowRef.current()
              }
            })
          }
        })
      }
      const onEnd = () => {
        track.removeEventListener('transitionend', onEnd)
        if (fallback != null) { window.clearTimeout(fallback); fallback = null }
        track.style.transition = ''
        track.style.willChange = ''
        commit()
      }
      fallback = window.setTimeout(onEnd, duration + 80)
      const start = () => {
        track.style.transition = `transform ${duration}ms ${easing}`
        track.style.transform = `translate3d(${target}px, 0, 0)`
      }
      requestAnimationFrame(start)
      track.addEventListener('transitionend', onEnd, { once: true })
      return
    }
    navigateByDelta(stepSizeByView[calendarView])
  }, [anchorDate, calendarView, navigateByDelta, setHistoryDayOffset, stepSizeByView])

  // Keep refs pointing to the latest prev/next handlers so queued animations
  // always use fresh logic and the latest anchorDate
  useEffect(() => { handlePrevWindowRef.current = handlePrevWindow }, [handlePrevWindow])
  useEffect(() => { handleNextWindowRef.current = handleNextWindow }, [handleNextWindow])

  const handleJumpToToday = useCallback(() => {
    const currentOffset = historyDayOffsetRef.current
    navigateByDelta(-currentOffset)
  }, [navigateByDelta])

  const setView = useCallback((view: CalendarViewMode) => {
    // If leaving month/year, clear any transient title override right away
    if (view !== 'month' && view !== 'year') {
      setCalendarTitleOverride(null)
      pendingTitleClearRef.current = null
    }
    setCalendarView(view)
  }, [])

  useEffect(() => {
    if (!showMultiDayChooser) {
      multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
    }
  }, [multiDayCount, showMultiDayChooser])

  useEffect(() => {
    if (!showMultiDayChooser) return
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      const container = multiChooserRef.current
      if (container && target && container.contains(target)) {
        return
      }
      setShowMultiDayChooser(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [showMultiDayChooser])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const DOUBLE_PRESS_THRESHOLD_MS = 450
    const options = Array.from(MULTI_DAY_OPTIONS) as Array<(typeof MULTI_DAY_OPTIONS)[number]>
    const getNormalizedSelection = (fallback?: number): (typeof MULTI_DAY_OPTIONS)[number] => {
      if (fallback !== undefined && isValidMultiDayOption(fallback)) {
        return fallback
      }
      if (isValidMultiDayOption(multiDayCount)) {
        return multiDayCount
      }
      return options[options.length - 1]
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (calendarEditorEntryId || calendarInspectorEntryId || customRecurrenceOpen || editingHistoryId) {
        lastCalendarHotkeyRef.current = null
        multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
        if (showMultiDayChooser) {
          setShowMultiDayChooser(false)
        }
        return
      }
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = (event.target as HTMLElement | null) || (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null)
      if (target) {
        const tag = target.tagName
        const isEditable = target.isContentEditable
        const isFormField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        const isSubtaskField =
          target.classList?.contains('calendar-inspector__subtask-input') ||
          target.closest('.calendar-inspector__subtask-input') !== null
        const isNotesField = target.classList?.contains('calendar-inspector__notes') || target.closest('.calendar-inspector__notes') !== null
        if (isEditable || isFormField || isSubtaskField || isNotesField) {
          return
        }
      }
      const key = event.key.toLowerCase()
      const keyboardState = multiDayKeyboardStateRef.current
      if (keyboardState?.active && showMultiDayChooser) {
        if (key === 'arrowleft' || key === 'arrowright') {
          event.preventDefault()
          const currentSelection = getNormalizedSelection(keyboardState.selection)
          const currentIndex = Math.max(0, options.indexOf(currentSelection))
          let nextIndex = currentIndex
          if (key === 'arrowleft') {
            nextIndex = Math.max(0, currentIndex - 1)
          } else if (key === 'arrowright') {
            nextIndex = Math.min(options.length - 1, currentIndex + 1)
          }
          const nextSelection = options[nextIndex]
          multiDayKeyboardStateRef.current = { active: true, selection: nextSelection }
          focusMultiDayOption(nextSelection)
          return
        }
        if (key === 'enter') {
          event.preventDefault()
          const selection = getNormalizedSelection(keyboardState.selection)
          setMultiDayCount(selection)
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection }
          return
        }
        if (key === 'escape') {
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          return
        }
      }
      switch (key) {
        case 'd': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'd', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('day')
          return
        }
        case 'x': {
          const now = Date.now()
          const last = lastCalendarHotkeyRef.current
          const isDouble = Boolean(last && last.key === 'x' && now - last.timestamp < DOUBLE_PRESS_THRESHOLD_MS)
          lastCalendarHotkeyRef.current = { key: 'x', timestamp: now }
          event.preventDefault()
          if (calendarView !== '3d') {
            setView('3d')
            setShowMultiDayChooser(false)
            multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
            return
          }
          if (isDouble) {
            const selection = getNormalizedSelection()
            setShowMultiDayChooser(true)
            multiDayKeyboardStateRef.current = { active: true, selection }
            if (typeof window !== 'undefined') {
              window.requestAnimationFrame(() => focusMultiDayOption(selection))
            }
          } else {
            setShowMultiDayChooser(false)
            multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          }
          return
        }
        case 'w': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'w', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('week')
          return
        }
        case 'm': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'm', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('month')
          return
        }
        case 'y': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'y', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          setView('year')
          return
        }
        case 'p': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'p', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          handlePrevWindow()
          return
        }
        case 'n': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 'n', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          handleNextWindow()
          return
        }
        case 't': {
          const now = Date.now()
          lastCalendarHotkeyRef.current = { key: 't', timestamp: now }
          event.preventDefault()
          setShowMultiDayChooser(false)
          multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
          handleJumpToToday()
          return
        }
        default: {
          lastCalendarHotkeyRef.current = { key, timestamp: Date.now() }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    calendarView,
    focusMultiDayOption,
    multiDayCount,
    setMultiDayCount,
    setView,
    setShowMultiDayChooser,
    showMultiDayChooser,
    handlePrevWindow,
    handleNextWindow,
    handleJumpToToday,
    calendarEditorEntryId,
    calendarInspectorEntryId,
    customRecurrenceOpen,
    editingHistoryId,
  ])

  // Outside-React updater for the calendar now-line to keep UI smooth without full re-renders
  useEffect(() => {
    if (typeof window === 'undefined') return
    let rafId: number | null = null
    let intervalId: number | null = null
    const update = () => {
      const el = calendarNowLineRef.current
      if (!el) return
      const ds = Number((el as any).dataset.dayStart || 0)
      if (!Number.isFinite(ds) || ds <= 0) {
        el.style.display = 'none'
        return
      }
      const now = Date.now()
      const pct = ((now - ds) / DAY_DURATION_MS) * 100
      if (pct < 0 || pct > 100) {
        el.style.display = 'none'
        return
      }
      if (el.style.display === 'none') {
        el.style.display = ''
      }
      el.style.top = `${Math.min(Math.max(pct, 0), 100)}%`
    }
    const tick = () => {
      if (rafId !== null) {
        try { window.cancelAnimationFrame(rafId) } catch {}
      }
      rafId = window.requestAnimationFrame(update)
    }
    // Initial paint
    tick()
    // Update roughly once per second for smoothness without heavy cost
    intervalId = window.setInterval(tick, 1000)
    return () => {
      if (intervalId !== null) {
        try { window.clearInterval(intervalId) } catch {}
      }
      if (rafId !== null) {
        try { window.cancelAnimationFrame(rafId) } catch {}
      }
    }
  }, [calendarView, historyDayOffset])

  // Clamp the multi-day chooser popover within the viewport
  useEffect(() => {
    if (!showMultiDayChooser) return
    const node = multiChooserRef.current
    if (!node) return
    const clamp = () => {
      const pad = 8
      // Reset any previous overrides
      node.style.left = ''
      node.style.right = ''
      node.style.top = ''
      node.style.bottom = ''
      node.style.transform = ''
      let rect = node.getBoundingClientRect()
      // If overflowing bottom, flip above the toggle
      if (rect.bottom > window.innerHeight - pad) {
        node.style.top = 'auto'
        node.style.bottom = 'calc(100% + 6px)'
        rect = node.getBoundingClientRect()
      }
      // Compute translation needed to fully fit within viewport horizontally and vertically
      let dx = 0
      let dy = 0
      if (rect.right > window.innerWidth - pad) {
        dx = Math.min(dx, (window.innerWidth - pad) - rect.right)
      }
      if (rect.left < pad) {
        dx = Math.max(dx, pad - rect.left)
      }
      if (rect.top < pad) {
        dy = Math.max(dy, pad - rect.top)
      }
      if (rect.bottom > window.innerHeight - pad) {
        dy = Math.min(dy, (window.innerHeight - pad) - rect.bottom)
      }
      if (dx !== 0 || dy !== 0) {
        node.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
      }
    }
    // Clamp now and on resize/scroll
    const raf = requestAnimationFrame(clamp)
    const onReflow = () => clamp()
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [showMultiDayChooser])

  const handleMultiDayDoubleClick = useCallback(() => {
    setView('3d')
    multiDayKeyboardStateRef.current = { active: false, selection: multiDayCount }
    setShowMultiDayChooser(true)
  }, [multiDayCount, setView])

  const handleCalendarAreaPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(calendarView === 'day' || calendarView === '3d' || calendarView === 'week')) {
      return
    }
    if (event.button !== 0) return
    const isTouch = (event as any).pointerType === 'touch'
    let scrollLocked = false
    const target = event.target as HTMLElement | null
    if (target && (target.closest('.calendar-event') || target.closest('.calendar-allday-event') || target.closest('button'))) {
      return
    }
    const area = calendarDaysAreaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    if (rect.width <= 0) return
    stopCalendarPanAnimation()
    const daysEl = calendarDaysRef.current
    const hdrEl = calendarHeadersRef.current
    const allDayEl = calendarAllDayRef.current
    if (daysEl) {
      daysEl.style.transition = ''
    }
    if (hdrEl) {
      hdrEl.style.transition = ''
    }
    if (allDayEl) {
      allDayEl.style.transition = ''
    }
    resetCalendarPanTransform()
    const dayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
    const baseOffset = calendarPanDesiredOffsetRef.current
    calendarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      areaWidth: rect.width,
      dayCount,
      baseOffset,
      mode: 'pending',
      lastAppliedDx: 0,
      isTouch,
    }
    // Don't capture or preventDefault yet; wait until we detect horizontal intent
    const handleMove = (e: PointerEvent) => {
      const state = calendarDragRef.current
      if (!state || e.pointerId !== state.pointerId) return
      const dy = e.clientY - state.startY
      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
      if (!Number.isFinite(dayWidth) || dayWidth <= 0) return
      const dx = e.clientX - state.startX
      // Intent detection
      if (state.mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        const threshold = 8
        if (absY > threshold && absY > absX) {
          // Vertical scroll intent: abort calendar drag and let page scroll
          window.removeEventListener('pointermove', handleMove)
          window.removeEventListener('pointerup', handleUp)
          window.removeEventListener('pointercancel', handleUp)
          calendarDragRef.current = null
          return
        }
        if (absX > threshold && absX > absY) {
          // Horizontal drag confirmed: capture and prevent default
          try { area.setPointerCapture?.(e.pointerId) } catch {}
          state.mode = 'hdrag'
          if (isTouch && !scrollLocked) {
            setPageScrollLock(true)
            scrollLocked = true
          }
        } else {
          return
        }
      }
      // From here, horizontal drag is active
      try { e.preventDefault() } catch {}
      const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
      state.lastAppliedDx = constrainedDx
      // Smooth pan: do not update historyDayOffset while dragging to avoid re-renders
      const totalPx = calendarBaseTranslateRef.current + constrainedDx
      const daysEl = calendarDaysRef.current
      const allDayEl = calendarAllDayRef.current
      if (daysEl) {
        daysEl.style.transform = `translateX(${totalPx}px)`
      }
      const hdrEl = calendarHeadersRef.current
      if (hdrEl) {
        hdrEl.style.transform = `translateX(${totalPx}px)`
      }
      if (allDayEl) {
        allDayEl.style.transform = `translateX(${totalPx}px)`
      }
    }
    const handleUp = (e: PointerEvent) => {
      const state = calendarDragRef.current
      if (!state || e.pointerId !== state.pointerId) return
      area.releasePointerCapture?.(e.pointerId)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      const dx = e.clientX - state.startX
      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
      let resetImmediately = true
      if (state.mode === 'hdrag' && Number.isFinite(dayWidth) && dayWidth > 0) {
        const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
        state.lastAppliedDx = appliedDx
        const totalPx = calendarBaseTranslateRef.current + appliedDx
        const daysEl = calendarDaysRef.current
        const allDayEl = calendarAllDayRef.current
        if (daysEl) {
          daysEl.style.transform = `translateX(${totalPx}px)`
        }
        const hdrEl = calendarHeadersRef.current
        if (hdrEl) {
          hdrEl.style.transform = `translateX(${totalPx}px)`
        }
        if (allDayEl) {
          allDayEl.style.transform = `translateX(${totalPx}px)`
        }
        const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
        if (snap !== 0) {
          animateCalendarPan(snap, dayWidth, state.baseOffset)
          resetImmediately = false
        } else {
          animateCalendarPan(0, dayWidth, state.baseOffset)
        }
      }
      if (resetImmediately) {
        const base = calendarBaseTranslateRef.current
        const daysEl = calendarDaysRef.current
        const allDayEl = calendarAllDayRef.current
        if (daysEl) {
          daysEl.style.transform = `translateX(${base}px)`
        }
        const hdrEl = calendarHeadersRef.current
        if (hdrEl) {
          hdrEl.style.transform = `translateX(${base}px)`
        }
        if (allDayEl) {
          allDayEl.style.transform = `translateX(${base}px)`
        }
      }
      calendarDragRef.current = null
      if (scrollLocked) {
        setPageScrollLock(false)
        scrollLocked = false
      }
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }, [calendarView, multiDayCount, resetCalendarPanTransform, stopCalendarPanAnimation, resolvePanSnap, animateCalendarPan])

  // Build minimal calendar content for non-day views
  const renderCalendarContent = useCallback(() => {
    const entries = effectiveHistory
    const dayHasSessions = (startMs: number, endMs: number) =>
      entries.some((e) => Math.min(e.endedAt, endMs) > Math.max(e.startedAt, startMs))

    // (removed unused legacy swipe handler for month/year grids)

    const jumpToDateAndShowWeek = (targetMidnightMs: number) => {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const todayMs = today.getTime()
      const deltaDays = Math.round((targetMidnightMs - todayMs) / DAY_DURATION_MS)
      setHistoryDayOffset(deltaDays)
      setView('week')
    }

    const jumpToMonthView = (year: number, monthIndex: number) => {
      const base = new Date(year, monthIndex, 1)
      base.setHours(0, 0, 0, 0)
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const deltaDays = Math.round((base.getTime() - today.getTime()) / DAY_DURATION_MS)
      setHistoryDayOffset(deltaDays)
      setView('month')
    }

    const todayMidnightMs = (() => {
      const t = new Date()
      t.setHours(0, 0, 0, 0)
      return t.getTime()
    })()

    const renderCell = (date: Date, isCurrentMonth: boolean) => {
      const start = new Date(date)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      const has = dayHasSessions(start.getTime(), end.getTime())
      const isToday = start.getTime() === todayMidnightMs
      return (
        <div
          key={`cell-${start.toISOString()}`}
          className={`calendar-cell${isCurrentMonth ? '' : ' calendar-cell--muted'}${isToday ? ' calendar-cell--today' : ''}`}
          aria-label={start.toDateString()}
        >
          <div
            className="calendar-day-number"
            role="button"
            tabIndex={0}
            onClick={() => jumpToDateAndShowWeek(start.getTime())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                jumpToDateAndShowWeek(start.getTime())
              }
            }}
            title={`Go to week of ${start.toDateString()}`}
          >
            {start.getDate()}
          </div>
          {has ? <div className="calendar-session-dot" aria-hidden="true" /> : null}
        </div>
      )
    }

    if (calendarView === 'day' || calendarView === '3d' || calendarView === 'week') {
      const visibleDayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
      const bufferDays = getCalendarBufferDays(visibleDayCount)
      const totalCount = visibleDayCount + bufferDays * 2
      // Determine range start (shifted by buffer)
      const windowStart = new Date(anchorDate)
      if (calendarView === 'week') {
        const dow = windowStart.getDay() // 0=Sun
        windowStart.setDate(windowStart.getDate() - dow)
      }
      windowStart.setDate(windowStart.getDate() - bufferDays)
      const dayStarts: number[] = []
      for (let i = 0; i < totalCount; i += 1) {
        const d = new Date(windowStart)
        d.setDate(windowStart.getDate() + i)
        d.setHours(0, 0, 0, 0)
        dayStarts.push(d.getTime())
      }

      // Helpers for all-day support
      const toLocalMidnight = (ms: number): number => {
        const d = new Date(ms)
        d.setHours(0, 0, 0, 0)
        return d.getTime()
      }
      const isLocalMidnight = (ms: number): boolean => {
        const d = new Date(ms)
        return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
      }
      const isAllDayRange = (start: number, end: number): boolean => {
        if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) return false
        // All‑day if both endpoints are at local midnight and span at least 1 day
        if (!isLocalMidnight(start) || !isLocalMidnight(end)) return false
        const startMid = toLocalMidnight(start)
        const endMid = toLocalMidnight(end)
        // Allow for DST shifts by comparing local midnight indices instead of exact ms duration
        const days = Math.round((endMid - startMid) / DAY_DURATION_MS)
        return days >= 1
      }

      type AllDayBar = {
        entry: HistoryEntry
        colStart: number
        colEnd: number // exclusive
        lane: number
        label: string
        colorCss: string
        baseColor: string
        isPlanned?: boolean
        isGuide?: boolean
      }

      const getRuleAnchorDayStart = (rule: RepeatingSessionRule): number | null => {
        const startAt = (rule as any).startAtMs as number | undefined
        const createdAt = (rule as any).createdAtMs as number | undefined
        const anchor = Number.isFinite(startAt as number) ? (startAt as number) : (Number.isFinite(createdAt as number) ? (createdAt as number) : null)
        if (!Number.isFinite(anchor as number)) return null
        const d = new Date(anchor as number)
        d.setHours(0, 0, 0, 0)
        return d.getTime()
      }

      const ruleIntervalAllowsDay = (rule: RepeatingSessionRule, dayStart: number): boolean => {
        const interval = Math.max(1, Number.isFinite((rule as any).repeatEvery as number) ? Math.floor((rule as any).repeatEvery as number) : 1)
        if (interval === 1) return true
        const anchor = getRuleAnchorDayStart(rule)
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

      const computeAllDayBars = (): AllDayBar[] => {
        if (dayStarts.length === 0) return []
        const windowStartMs = dayStarts[0]
        const windowEndMs = dayStarts[dayStarts.length - 1] + DAY_DURATION_MS
        type Raw = {
          entry: HistoryEntry
          colStart: number
          colEnd: number
          label: string
          colorCss: string
          baseColor: string
          isPlanned?: boolean
          isGuide?: boolean
        }

        const raws: Raw[] = []
        for (const entry of effectiveHistory) {
          const isPreviewed = dragPreview && dragPreview.entryId === entry.id
          const startAt = isPreviewed ? dragPreview.startedAt : entry.startedAt
          const endAt = isPreviewed ? dragPreview.endedAt : entry.endedAt
          if (!isAllDayRange(startAt, endAt)) continue
          // Clamp the visual range to the current window
          const startMid = toLocalMidnight(startAt)
          const endMid = toLocalMidnight(endAt)
          if (endMid <= windowStartMs || startMid >= windowEndMs) continue
          const clampedStart = Math.max(startMid, windowStartMs)
          const clampedEnd = Math.min(endMid, windowEndMs)
          // Map to column indices (inclusive start, exclusive end)
          const colStart = Math.floor((clampedStart - windowStartMs) / DAY_DURATION_MS)
          const colEnd = Math.ceil((clampedEnd - windowStartMs) / DAY_DURATION_MS)
          if (colEnd <= colStart) continue
          const meta = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
          const derivedLabel = deriveEntryTaskName(entry)
          const colorCss = meta.colorInfo?.gradient?.css ?? meta.colorInfo?.solidColor ?? getPaletteColorForLabel(meta.label)
          const baseColor = meta.colorInfo?.solidColor ?? meta.colorInfo?.gradient?.start ?? getPaletteColorForLabel(derivedLabel)
          raws.push({
            entry,
            colStart: Math.max(0, colStart),
            colEnd: Math.min(dayStarts.length, colEnd),
            label: derivedLabel,
            colorCss,
            baseColor,
            isPlanned: !!entry.futureSession,
            isGuide: false,
          })
        }
        if (Array.isArray(repeatingRules) && repeatingRules.length > 0) {
          const confirmedKeySet = (() => {
            const set = new Set<string>()
            effectiveHistory.forEach((h) => {
              const rid = (h as any).repeatingSessionId as string | undefined | null
              const ot = (h as any).originalTime as number | undefined | null
              if (rid && Number.isFinite(ot as number)) set.add(`${rid}:${formatLocalYmd(ot as number)}`)
            })
            return set
          })()
          const excKeySet = (() => {
            const set = new Set<string>()
            repeatingExceptions.forEach((r) => {
              if ((r as any).action === 'skipped') {
                set.add(`${r.routineId}:${r.occurrenceDate}`)
              }
            })
            return set
          })()
          const coveredOriginalSet = (() => {
            const set = new Set<string>()
            effectiveHistory.forEach((h) => {
              const rid = (h as any).repeatingSessionId as string | undefined | null
              const ot = (h as any).originalTime as number | undefined | null
              if (rid && Number.isFinite(ot as number)) {
                set.add(`${rid}:${ot as number}`)
              }
            })
            return set
          })()
          const makeOccurrenceKey = (ruleId: string, baseMs: number) => `${ruleId}:${formatLocalYmd(baseMs)}`
          const isRuleScheduledForDay = (rule: RepeatingSessionRule, dayStart: number) => {
            if (!rule.isActive) return false
            if (rule.frequency === 'daily') return ruleIntervalAllowsDay(rule, dayStart)
            if (rule.frequency === 'weekly') {
              const d = new Date(dayStart)
              return Array.isArray(rule.dayOfWeek) && rule.dayOfWeek.includes(d.getDay()) && ruleIntervalAllowsDay(rule, dayStart)
            }
            if (rule.frequency === 'monthly') {
              return matchesMonthlyDay(rule, dayStart) && ruleIntervalAllowsDay(rule, dayStart)
            }
            if (rule.frequency === 'annually') {
              const dayKey = monthDayKey(dayStart)
              const ruleKey = ruleMonthDayKey(rule)
              return ruleKey !== null && ruleKey === dayKey && ruleIntervalAllowsDay(rule, dayStart)
            }
            return false
          }
          const isWithinBoundaries = (rule: RepeatingSessionRule, baseDayStart: number) => {
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            const scheduledStart = baseDayStart + timeOfDayMin * MINUTE_MS
            const startAtMs = (rule as any).startAtMs as number | undefined
            if (Number.isFinite(startAtMs as number)) {
              if (scheduledStart < (startAtMs as number)) return false
            } else {
              const createdMs = (rule as any).createdAtMs as number | undefined
              if (Number.isFinite(createdMs as number)) {
                if (scheduledStart <= (createdMs as number)) return false
              }
            }
            const endAtMs = (rule as any).endAtMs as number | undefined
            if (Number.isFinite(endAtMs as number)) {
              if (scheduledStart > (endAtMs as number)) return false
            }
            return true
          }
          const isAllDayRule = (rule: RepeatingSessionRule) => {
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            const durationMinutes = Math.max(1, rule.durationMinutes ?? 60)
            return timeOfDayMin === 0 && durationMinutes >= 1440
          }
          const TOL = 60 * 1000
          repeatingRules.forEach((rule) => {
            if (!isAllDayRule(rule)) return
            dayStarts.forEach((dayStart, columnIndex) => {
              if (!isRuleScheduledForDay(rule, dayStart)) return
              if (!isWithinBoundaries(rule, dayStart)) return
              const occKey = makeOccurrenceKey(rule.id, dayStart)
              if (confirmedKeySet.has(occKey) || excKeySet.has(occKey)) return
              const startedAt = dayStart
              const endedAt = dayStart + DAY_DURATION_MS
              if (coveredOriginalSet.has(`${rule.id}:${startedAt}`)) return
              const duplicateReal = effectiveHistory.some((h) => {
                const startMatch = Math.abs(h.startedAt - startedAt) <= TOL
                const endMatch = Math.abs(h.endedAt - endedAt) <= TOL
                return startMatch && endMatch
              })
              if (duplicateReal) return
              const taskName = rule.taskName?.trim() || 'Session'
              const goalName = rule.goalName?.trim() || null
              const bucketName = rule.bucketName?.trim() || null
              const entry: HistoryEntry = {
                id: `repeat:${rule.id}:${dayStart}:allday`,
                taskName,
                elapsed: Math.max(endedAt - startedAt, 1),
                startedAt,
                endedAt,
                goalName,
                bucketName,
                goalId: null,
                bucketId: null,
                taskId: null,
                goalSurface: DEFAULT_SURFACE_STYLE,
                bucketSurface: null,
                entryColor: gradientFromSurface(DEFAULT_SURFACE_STYLE),
                notes: '',
                subtasks: [],
              }
              const meta = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
              const label = deriveEntryTaskName(entry)
              const colorCss = meta.colorInfo?.gradient?.css ?? meta.colorInfo?.solidColor ?? getPaletteColorForLabel(label)
              const baseColor = meta.colorInfo?.solidColor ?? meta.colorInfo?.gradient?.start ?? getPaletteColorForLabel(label)
              raws.push({
                entry,
                colStart: columnIndex,
                colEnd: Math.min(dayStarts.length, columnIndex + 1),
                label,
                colorCss,
                baseColor,
                isGuide: true,
              })
            })
          })
        }

        // Lane assignment: greedy place into first lane that doesn't collide
        const occupancy: boolean[][] = []
        const bars: AllDayBar[] = []
        // sort by start then by duration desc so longer bars reserve lanes first
        raws.sort((a, b) => (a.colStart === b.colStart ? b.colEnd - b.colStart - (a.colEnd - a.colStart) : a.colStart - b.colStart))
        for (const r of raws) {
          let lane = 0
          // find first lane without overlap
          while (true) {
            if (!occupancy[lane]) {
              occupancy[lane] = new Array(dayStarts.length).fill(false)
            }
            const row = occupancy[lane]
            let overlaps = false
            for (let c = r.colStart; c < r.colEnd; c += 1) {
              if (row[c]) { overlaps = true; break }
            }
            if (!overlaps) {
              for (let c = r.colStart; c < r.colEnd; c += 1) row[c] = true
              bars.push({
                entry: r.entry,
                colStart: r.colStart,
                colEnd: r.colEnd,
                lane,
                label: r.label,
                colorCss: r.colorCss,
                baseColor: r.baseColor,
                isPlanned: r.isPlanned,
                isGuide: r.isGuide,
              })
              break
            }
            lane += 1
          }
        }
        return bars
      }
      type DayEvent = {
        entry: HistoryEntry
        topPct: number
        heightPct: number
        color: string
        gradientCss?: string
        label: string
        rangeLabel: string
        clipPath?: string
        zIndex: number
        showLabel: boolean
        showTime: boolean
        // Guide (repeating) sessions support
        baseColor?: string
        isGuide?: boolean
        // Planned future sessions (real entries scheduled in the future)
        isPlanned?: boolean
      }

      // Render-cost guardrails: only compute events for the visible window ± margin.
      const visibleStartIndex = bufferDays
      const visibleEndIndex = bufferDays + visibleDayCount - 1
      // Ensure upcoming window is fully rendered to avoid blank columns during swipe.
      // Using full buffer as margin effectively pre-renders the entire track.
      const RENDER_MARGIN = bufferDays + visibleDayCount

      const computeDayEvents = (startMs: number, dayIndex: number): DayEvent[] => {
        if (dayIndex < visibleStartIndex - RENDER_MARGIN || dayIndex > visibleEndIndex + RENDER_MARGIN) {
          return []
        }
        const endMs = startMs + DAY_DURATION_MS
        const START_GROUP_EPS = 60 * 1000

        type RawEvent = {
          entry: HistoryEntry
          start: number
          end: number
          previewStart: number
          previewEnd: number
        }

        type Segment = { start: number; end: number; left: number; right: number }
        type SliceAssignment = { left: number; right: number }

        const raw: RawEvent[] = effectiveHistory
          .map((entry) => {
            // Exclude all‑day entries from the time grid; they render in the all‑day lane
            if (isAllDayRange(entry.startedAt, entry.endedAt)) return null
            const isPreviewed = dragPreview && dragPreview.entryId === entry.id
            const previewStart = isPreviewed ? dragPreview.startedAt : entry.startedAt
            const previewEnd = isPreviewed ? dragPreview.endedAt : entry.endedAt
            const clampedStart = Math.max(Math.min(previewStart, previewEnd), startMs)
            const clampedEnd = Math.min(Math.max(previewStart, previewEnd), endMs)
            if (clampedEnd <= clampedStart) {
              return null
            }
            return {
              entry,
              start: clampedStart,
              end: clampedEnd,
              previewStart,
              previewEnd,
            }
          })
          .filter((v): v is RawEvent => Boolean(v))
          .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start))

        // Build lookup for confirmed occurrences and exceptions to suppress guides
        const confirmedKeySet = (() => {
          const set = new Set<string>()
          effectiveHistory.forEach((h) => {
            const rid = (h as any).repeatingSessionId as string | undefined | null
            const ot = (h as any).originalTime as number | undefined | null
            if (rid && Number.isFinite(ot as number)) set.add(`${rid}:${formatLocalYmd(ot as number)}`)
          })
          return set
        })()
        const excKeySet = (() => {
          // Only skipped occurrences should suppress guides. Rescheduled ones
          // are already covered by the presence of a confirmed entry (via
          // routineId+occurrenceDate) or by repeat-original linkage.
          const set = new Set<string>()
          repeatingExceptions.forEach((r) => {
            if ((r as any).action === 'skipped') {
              set.add(`${r.routineId}:${r.occurrenceDate}`)
            }
          })
          return set
        })()
        // Also suppress guides that have already transformed (confirmed/skipped/rescheduled)
        // by checking session_history linkage repeatingSessionId + originalTime
        // Key format: `${ruleId}:${originalTimeMs}`
        const coveredOriginalSet = (() => {
          const set = new Set<string>()
          effectiveHistory.forEach((h) => {
            const rid = (h as any).repeatingSessionId as string | undefined | null
            const ot = (h as any).originalTime as number | undefined | null
            if (rid && Number.isFinite(ot as number)) {
              set.add(`${rid}:${ot as number}`)
            }
          })
          return set
        })()

        // Synthesize guide events from repeating session rules for this day
        const guideRaw: RawEvent[] = (() => {
          if (!Array.isArray(repeatingRules) || repeatingRules.length === 0) return []
          // Resolve basic day info (not needed explicitly here; kept via startMs)

          const makeOccurrenceKey = (ruleId: string, baseMs: number) => `${ruleId}:${formatLocalYmd(baseMs)}`

          const isRuleScheduledForDay = (rule: RepeatingSessionRule, dayStart: number) => {
            if (!rule.isActive) return false
            if (rule.frequency === 'daily') return ruleIntervalAllowsDay(rule, dayStart)
            if (rule.frequency === 'weekly') {
              const d = new Date(dayStart)
              return Array.isArray(rule.dayOfWeek) && rule.dayOfWeek.includes(d.getDay()) && ruleIntervalAllowsDay(rule, dayStart)
            }
            if (rule.frequency === 'monthly') {
              return matchesMonthlyDay(rule, dayStart) && ruleIntervalAllowsDay(rule, dayStart)
            }
            if (rule.frequency === 'annually') {
              const dayKey = monthDayKey(dayStart)
              const ruleKey = ruleMonthDayKey(rule)
              return ruleKey !== null && ruleKey === dayKey && ruleIntervalAllowsDay(rule, dayStart)
            }
            return false
          }

          const isWithinBoundaries = (rule: RepeatingSessionRule, baseDayStart: number) => {
            // Compute the scheduled startedAt for this occurrence
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            const scheduledStart = baseDayStart + timeOfDayMin * MINUTE_MS
            // Start boundary: prefer explicit startAtMs (inclusive). If absent, fall back to createdAtMs (strictly after)
            const startAtMs = (rule as any).startAtMs as number | undefined
            if (Number.isFinite(startAtMs as number)) {
              if (scheduledStart < (startAtMs as number)) return false
            } else {
              const createdMs = (rule as any).createdAtMs as number | undefined
              if (Number.isFinite(createdMs as number)) {
                if (scheduledStart <= (createdMs as number)) return false
              }
            }
            // End boundary: inclusive (allow selected occurrence when end_date equals its start time)
            const endAtMs = (rule as any).endAtMs as number | undefined
            if (Number.isFinite(endAtMs as number)) {
              if (scheduledStart > (endAtMs as number)) return false
            }
            return true
          }

          const buildGuideForDay = (rule: RepeatingSessionRule, baseDayStart: number): RawEvent | null => {
            // Suppression by confirmed/exception for this occurrence date
            const occKey = makeOccurrenceKey(rule.id, baseDayStart)
            if (confirmedKeySet.has(occKey) || excKeySet.has(occKey)) return null
            // Fallback suppression if an identical real session exists for this occurrence's full timing
            const startedAt = baseDayStart + Math.max(0, Math.min(1439, rule.timeOfDayMinutes)) * MINUTE_MS
            // Suppress if this occurrence has been linked already in session_history
            if (coveredOriginalSet.has(`${rule.id}:${startedAt}`)) return null
            const durationMs = Math.max(1, (rule.durationMinutes ?? 60) * MINUTE_MS)
            // Allow crossing midnight: DO NOT clamp to end of day here
            const endedAt = startedAt + durationMs
            if (isAllDayRange(startedAt, endedAt)) {
              return null
            }
            const task = (rule.taskName?.trim() || 'Session')
            const goal = rule.goalName?.trim() || null
            const bucket = rule.bucketName?.trim() || null
          const TOL = 60 * 1000 // 1 minute tolerance for DST/rounding
          const duplicateReal = effectiveHistory.some((h) => {
            const sameLabel = (h.taskName?.trim() || 'Session') === task && (h.goalName ?? null) === goal && (h.bucketName ?? null) === bucket
            const startMatch = Math.abs(h.startedAt - startedAt) <= TOL
            const endMatch = Math.abs(h.endedAt - endedAt) <= TOL
            return sameLabel && startMatch && endMatch
          })
          if (duplicateReal) return null
            const entryId = `repeat:${rule.id}:${baseDayStart}`
            const entry: HistoryEntry = {
              id: entryId,
              taskName: task,
              elapsed: Math.max(endedAt - startedAt, 1),
              startedAt,
              endedAt,
              goalName: goal,
              bucketName: bucket,
              goalId: null,
              bucketId: null,
              taskId: null,
              goalSurface: DEFAULT_SURFACE_STYLE,
              bucketSurface: null,
              entryColor: gradientFromSurface(DEFAULT_SURFACE_STYLE),
              notes: '',
              subtasks: [],
            }
            return {
              entry,
              start: Math.max(startedAt, startMs),
              end: Math.min(endedAt, endMs),
              previewStart: startedAt,
              previewEnd: endedAt,
            }
          }

          const guides: RawEvent[] = []

          // Today’s scheduled occurrence
          for (const rule of repeatingRules) {
            if (!isRuleScheduledForDay(rule, startMs)) continue
            if (!isWithinBoundaries(rule, startMs)) continue
            const ev = buildGuideForDay(rule, startMs)
            if (ev) guides.push(ev)
          }

          // Carryover from previous day if duration crosses midnight
          const prevStartMs = startMs - DAY_DURATION_MS
          for (const rule of repeatingRules) {
            // Only consider rules scheduled on the previous day
            if (!isRuleScheduledForDay(rule, prevStartMs)) continue
            if (!isWithinBoundaries(rule, prevStartMs)) continue
            const durationMin = Math.max(1, (rule.durationMinutes ?? 60))
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            if (timeOfDayMin + durationMin <= 24 * 60) continue // no cross-midnight, nothing to carry
            const ev = buildGuideForDay(rule, prevStartMs)
            if (ev) guides.push(ev)
          }

          return guides
        })()

        const combined: RawEvent[] = [...raw, ...guideRaw].sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start))

        if (combined.length === 0) {
          return []
        }

        const breakpointsSet = new Set<number>([startMs, endMs])
        combined.forEach(({ start, end }) => {
          breakpointsSet.add(start)
          breakpointsSet.add(end)
        })
        const breakpoints = Array.from(breakpointsSet).sort((a, b) => a - b)

        const allEvents = new Map<string, RawEvent>()
        combined.forEach((info) => {
          allEvents.set(info.entry.id, info)
        })

        const eventSlices = new Map<string, Segment[]>()
        const prevAssignments = new Map<string, SliceAssignment>()

        const clampSegment = (segment: Segment): Segment => ({
          start: clamp01(segment.start),
          end: clamp01(segment.end),
          left: clamp01(segment.left),
          right: clamp01(segment.right),
        })

        const approxEqual = (a: number, b: number, epsilon = 1e-6) => Math.abs(a - b) <= epsilon

        const mergeSegments = (segments: Segment[]): Segment[] => {
          if (segments.length === 0) {
            return [{ start: 0, end: 1, left: 0, right: 1 }]
          }
          const sorted = segments
            .map(clampSegment)
            .filter((segment) => segment.end > segment.start)
            .sort((a, b) => a.start - b.start)
          if (sorted.length === 0) {
            return [{ start: 0, end: 1, left: 0, right: 1 }]
          }
          const merged: Segment[] = []
          sorted.forEach((segment) => {
            const current = { ...segment }
            if (merged.length === 0) {
              merged.push(current)
              return
            }
            const last = merged[merged.length - 1]
            if (
              approxEqual(last.right, current.right, 1e-4) &&
              approxEqual(last.left, current.left, 1e-4) &&
              approxEqual(last.end, current.start, 1e-4)
            ) {
              last.end = current.end
            } else {
              merged.push(current)
            }
          })
          // Ensure spans start at 0 and end at 1 for stable clip paths
          merged[0].start = 0
          merged[merged.length - 1].end = 1
          return merged
        }

        const buildClipPath = (segments: Segment[]): string | undefined => {
          if (segments.length === 1) {
            const [segment] = segments
            if (approxEqual(segment.left, 0) && approxEqual(segment.right, 1)) {
              return undefined
            }
          }
          const points: Array<{ x: number; y: number }> = []
          const first = segments[0]
          points.push({ x: clamp01(first.left), y: clamp01(first.start) })
          points.push({ x: clamp01(first.right), y: clamp01(first.start) })
          segments.forEach((segment) => {
            points.push({ x: clamp01(segment.right), y: clamp01(segment.end) })
          })
          const last = segments[segments.length - 1]
          points.push({ x: clamp01(last.left), y: clamp01(last.end) })
          for (let i = segments.length - 1; i >= 0; i -= 1) {
            const segment = segments[i]
            points.push({ x: clamp01(segment.left), y: clamp01(segment.start) })
          }

          const filtered: Array<{ x: number; y: number }> = []
          points.forEach((point, index) => {
            if (index === 0) {
              filtered.push(point)
              return
            }
            const prev = filtered[filtered.length - 1]
            if (!approxEqual(prev.x, point.x, 1e-4) || !approxEqual(prev.y, point.y, 1e-4)) {
              filtered.push(point)
            }
          })
          if (filtered.length > 0) {
            const firstPoint = filtered[0]
            const lastPoint = filtered[filtered.length - 1]
            if (approxEqual(firstPoint.x, lastPoint.x, 1e-4) && approxEqual(firstPoint.y, lastPoint.y, 1e-4)) {
              filtered.pop()
            }
          }
          if (filtered.length < 3) {
            return undefined
          }
          return `polygon(${filtered
            .map((point) => `${(point.x * 100).toFixed(3)}% ${(point.y * 100).toFixed(3)}%`)
            .join(', ')})`
        }

        for (let i = 0; i < breakpoints.length - 1; i += 1) {
          const sliceStart = breakpoints[i]
          const sliceEnd = breakpoints[i + 1]
          if (sliceEnd - sliceStart <= 0) {
            continue
          }

          const active = raw.filter(({ start, end }) => end > sliceStart && start < sliceEnd)
          if (active.length === 0) {
            continue
          }

          const sliceAssignments = new Map<string, SliceAssignment>()
          const continuing = active.filter(({ start }) => start < sliceStart - START_GROUP_EPS)
          const newStarters = active.filter(({ start }) => Math.abs(start - sliceStart) <= START_GROUP_EPS)

          continuing.forEach(({ entry }) => {
            const prev = prevAssignments.get(entry.id)
            if (prev) {
              sliceAssignments.set(entry.id, prev)
            } else {
              sliceAssignments.set(entry.id, { left: 0, right: 1 })
            }
          })

          if (continuing.length === 0) {
            const sorted = active
              .slice()
              .sort((a, b) => (a.start === b.start ? (b.end - b.start) - (a.end - a.start) : a.start - b.start))
            const width = sorted.length > 0 ? 1 / sorted.length : 1
            sorted.forEach((ev, index) => {
              const left = index * width
              sliceAssignments.set(ev.entry.id, { left, right: Math.min(1, left + width) })
            })
          } else if (newStarters.length > 0) {
            const sortedNew = newStarters
              .slice()
              .sort((a, b) => {
                const durationA = a.end - a.start
                const durationB = b.end - b.start
                if (durationA === durationB) {
                  return a.entry.id.localeCompare(b.entry.id)
                }
                return durationA - durationB
              })
            sortedNew.forEach((ev) => {
              sliceAssignments.set(ev.entry.id, { left: 0, right: 1 })
            })
          }

          active.forEach((ev) => {
            if (!sliceAssignments.has(ev.entry.id)) {
              const prev = prevAssignments.get(ev.entry.id) ?? { left: 0, right: 1 }
              sliceAssignments.set(ev.entry.id, prev)
            }
          })

          sliceAssignments.forEach((assignment, entryId) => {
            const info = allEvents.get(entryId)
            if (!info) {
              return
            }
            const clampedStart = Math.max(sliceStart, info.start)
            const clampedEnd = Math.min(sliceEnd, info.end)
            if (clampedEnd - clampedStart <= 0) {
              return
            }
            const duration = Math.max(info.end - info.start, 1)
            const segmentStart = (clampedStart - info.start) / duration
            const segmentEnd = (clampedEnd - info.start) / duration
            const segments = eventSlices.get(entryId) ?? []
            segments.push({
              start: segmentStart,
              end: segmentEnd,
              left: assignment.left,
              right: assignment.right,
            })
            eventSlices.set(entryId, segments)
          })

          prevAssignments.clear()
          sliceAssignments.forEach((assignment, entryId) => {
            prevAssignments.set(entryId, assignment)
          })
        }

        const nowMs = Date.now()
        return combined.map((info, index) => {
          const metadata = resolveGoalMetadata(info.entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
          const gradientCss = metadata.colorInfo?.gradient?.css
          const solidColor = metadata.colorInfo?.solidColor
          const fallbackLabel = deriveEntryTaskName(info.entry)
          const color = gradientCss ?? solidColor ?? getPaletteColorForLabel(fallbackLabel)
          const baseColor = solidColor ?? metadata.colorInfo?.gradient?.start ?? getPaletteColorForLabel(fallbackLabel)

          const segments = mergeSegments(eventSlices.get(info.entry.id) ?? [{ start: 0, end: 1, left: 0, right: 1 }])
          const clipPath = buildClipPath(segments)

          const topPct = ((info.start - startMs) / DAY_DURATION_MS) * 100
          const heightPct = Math.max(((info.end - info.start) / DAY_DURATION_MS) * 100, (MINUTE_MS / DAY_DURATION_MS) * 100)
          const rangeLabel = `${formatTimeOfDay(info.previewStart)} — ${formatTimeOfDay(info.previewEnd)}`

          const duration = Math.max(info.end - info.start, 1)
          const durationScore = Math.max(0, Math.round((DAY_DURATION_MS - duration) / MINUTE_MS))
          const startScore = Math.max(0, Math.round((info.start - startMs) / MINUTE_MS))
          const zIndex = 100000 + durationScore * 1000 - startScore + index

          const durationMinutes = duration / MINUTE_MS
          const showLabel = durationMinutes >= 8
          const showTime = durationMinutes >= 20
          const isGuide = info.entry.id.startsWith('repeat:')
          const isPlanned = !!(info.entry as any).futureSession || info.previewStart > nowMs

          return {
            entry: info.entry,
            topPct: Math.min(Math.max(topPct, 0), 100),
            heightPct: Math.min(Math.max(heightPct, 0.4), 100),
            color,
            gradientCss,
            label: fallbackLabel,
            rangeLabel,
            clipPath,
            zIndex,
            showLabel,
            showTime,
            baseColor,
            isGuide,
            isPlanned,
          }
        })
      }

      // Set CSS var for column count via inline style on container later
      const todayMidnight = (() => {
        const t = new Date()
        t.setHours(0, 0, 0, 0)
        return t.getTime()
      })()

      const handleCalendarEventPointerDown = (
        entry: HistoryEntry,
        entryDayStart: number,
      ) => (ev: ReactPointerEvent<HTMLDivElement>) => {
        if (entry.id === 'active-session') return
        if (ev.button !== 0) return
        const isTouch = (ev as any).pointerType === 'touch'
  const daysRoot = calendarDaysRef.current
        if (!daysRoot) return
        const columnEls = Array.from(daysRoot.querySelectorAll<HTMLDivElement>('.calendar-day-column'))
        if (columnEls.length === 0) return
        const columns = columnEls.map((el, idx) => ({ rect: el.getBoundingClientRect(), dayStart: dayStarts[idx] }))
  const area = calendarDaysAreaRef.current
        // Find the column we started in
        const startColIdx = columns.findIndex((c) => ev.clientX >= c.rect.left && ev.clientX <= c.rect.right)
        const col = startColIdx >= 0 ? columns[startColIdx] : columns[0]
        const colHeight = col.rect.height
        if (!(Number.isFinite(colHeight) && colHeight > 0)) return
        // Determine drag kind by edge proximity (top/bottom = resize, else move)
        const evRect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
        const edgePx = Math.min(12, Math.max(6, evRect.height * 0.2))
  let kind: DragKind = 'move'
        if (ev.clientY - evRect.top <= edgePx) kind = 'resize-start'
        else if (evRect.bottom - ev.clientY <= edgePx) kind = 'resize-end'
  // Mark intended drag kind on the element so CSS can show the right cursor once dragging begins
  const targetEl = ev.currentTarget as HTMLDivElement
  if (kind === 'move') targetEl.dataset.dragKind = 'move'
  else targetEl.dataset.dragKind = 'resize'
        // Compute time-of-day at drag start (use visible edge for resize)
        const clampedStart = Math.max(Math.min(entry.startedAt, entry.endedAt), entryDayStart)
        const clampedEnd = Math.min(Math.max(entry.startedAt, entry.endedAt), entryDayStart + DAY_DURATION_MS)
        const timeOfDayMs0 = (kind === 'resize-end' ? clampedEnd : clampedStart) - entryDayStart
        const state = {
          pointerId: ev.pointerId,
          entryId: entry.id,
          startX: ev.clientX,
          startY: ev.clientY,
          initialStart: entry.startedAt,
          initialEnd: entry.endedAt,
          initialTimeOfDayMs: timeOfDayMs0,
          durationMs: Math.max(entry.endedAt - entry.startedAt, MIN_SESSION_DURATION_DRAG_MS),
          kind,
          columns,
          moved: false,
          activated: false,
        }
        calendarEventDragRef.current = state
        // For mouse/pen: capture immediately. For touch: defer capture until long-press activates drag.
        if (!isTouch) {
          try {
            targetEl.setPointerCapture?.(ev.pointerId)
          } catch {}
        }
        // For touch, require a short hold before activating drag to prevent accidental drags while scrolling
  let touchHoldTimer: number | null = null
  let panningFromEvent = false
        const activateDrag = () => {
          const s = calendarEventDragRef.current
          if (!s || s.activated) return
          s.activated = true
          // If dragging a guide (repeating) entry, materialize it now so all drag/resize semantics match real entries
          if (entry.id.startsWith('repeat:')) {
            try {
              const parts = entry.id.split(':')
              const ruleId = parts[1]
              const dayStart = Number(parts[2])
              const ymd = formatLocalYmd(dayStart)
              const realEntry: HistoryEntry = {
                ...entry,
                id: makeHistoryId(),
                repeatingSessionId: ruleId,
                originalTime: entry.startedAt,
              }
              updateHistory((current) => {
                const next = [...current, realEntry]
                next.sort((a, b) => a.startedAt - b.startedAt)
                return next
              })
              // Persist an exception so future guide synthesis for this occurrence is suppressed even if tags get dropped remotely
              try {
                void upsertRepeatingException({
                  routineId: ruleId,
                  occurrenceDate: ymd,
                  action: 'rescheduled',
                  newStartedAt: realEntry.startedAt,
                  newEndedAt: realEntry.endedAt,
                  notes: null,
                })
                // Attempt to retire the rule if its window is complete
                void evaluateAndMaybeRetireRule(ruleId)
              } catch {}
              // Update the drag state to reference the new real entry id and baseline times
              s.entryId = realEntry.id
              s.initialStart = realEntry.startedAt
              s.initialEnd = realEntry.endedAt
            } catch {}
          }
          // Close any open calendar popover as soon as a drag is activated
          handleCloseCalendarPreview()
          // Lock page scroll on touch while dragging an event
          if (isTouch) setPageScrollLock(true)
          try { targetEl.setPointerCapture?.(ev.pointerId) } catch {}
        }
        const onMove = (e: PointerEvent) => {
          const s = calendarEventDragRef.current
          if (!s || e.pointerId !== s.pointerId) return
          // Movement threshold to preserve click semantics
          const dx = e.clientX - s.startX
          const dy = e.clientY - s.startY
          const threshold = 6
          if (!s.activated) {
            if (isTouch) {
              // If finger moves before hold completes, cancel the long-press activation
              if (Math.hypot(dx, dy) > threshold) {
                if (touchHoldTimer !== null) {
                  try { window.clearTimeout(touchHoldTimer) } catch {}
                  touchHoldTimer = null
                }
                // If horizontal movement dominates, treat this as a calendar pan even though we started on an event
                const absX = Math.abs(dx)
                const absY = Math.abs(dy)
                if (absX > absY && area) {
                  if (!panningFromEvent) {
                    const rect = area.getBoundingClientRect()
                    if (rect.width > 0) {
                      const dayCount = calendarView === '3d'
                        ? Math.max(2, Math.min(multiDayCount, 14))
                        : calendarView === 'week'
                          ? 7
                          : 1
                      stopCalendarPanAnimation()
                      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
                      const daysEl = calendarDaysRef.current
                      const hdrEl = calendarHeadersRef.current
                      const allDayEl = calendarAllDayRef.current
                      if (daysEl) daysEl.style.transition = ''
                      if (hdrEl) hdrEl.style.transition = ''
                      if (allDayEl) allDayEl.style.transition = ''
                      resetCalendarPanTransform()
                      const baseOffset = calendarPanDesiredOffsetRef.current
                      calendarDragRef.current = {
                        pointerId: s.pointerId,
                        startX: s.startX,
                        startY: s.startY,
                        startTime: now,
                        areaWidth: rect.width,
                        dayCount,
                        baseOffset,
                        mode: 'hdrag',
                        isTouch,
                        lastAppliedDx: 0,
                      }
                      try { area.setPointerCapture?.(s.pointerId) } catch {}
                      panningFromEvent = true
                    }
                  }
                  // Perform pan move
                  const state = calendarDragRef.current
                  if (state && state.mode === 'hdrag') {
                    const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
                      if (Number.isFinite(dayWidth) && dayWidth > 0) {
                        try { e.preventDefault() } catch {}
                        const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                        state.lastAppliedDx = constrainedDx
                        const totalPx = calendarBaseTranslateRef.current + constrainedDx
                        const daysEl = calendarDaysRef.current
                        const allDayEl = calendarAllDayRef.current
                        if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                      const hdrEl = calendarHeadersRef.current
                      if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                      if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
                    }
                  }
                  return
                }
                return
              }
              // Not activated yet, and not moved enough — keep waiting for hold
              return
            } else {
              if (Math.hypot(dx, dy) <= threshold) {
                return
              }
              // For mouse/pen, activate the drag using the same path as touch
              // so guide entries materialize consistently on drag start.
              activateDrag()
            }
          }
          // Prevent page/area scrolling while dragging an event
          try { e.preventDefault() } catch {}
          // Base column by X position (nearest if outside bounds)
          const baseIdx = s.columns.findIndex((c) => e.clientX >= c.rect.left && e.clientX <= c.rect.right)
          const nearestIdx = baseIdx >= 0 ? baseIdx : (e.clientX < s.columns[0].rect.left ? 0 : s.columns.length - 1)
          const baseCol = s.columns[nearestIdx]
          const colH = baseCol.rect.height
          if (!(Number.isFinite(colH) && colH > 0)) return
          // Vertical delta to time delta
          const deltaMsRaw = (dy / colH) * DAY_DURATION_MS
          // Snap to minute for stable movement
          const deltaMinutes = Math.round(deltaMsRaw / MINUTE_MS)
          const deltaMs = deltaMinutes * MINUTE_MS
          // Allow crossing midnight by converting overflow into day shifts
          let desiredTimeOfDay = s.initialTimeOfDayMs + deltaMs
          let dayShift = 0
          if (desiredTimeOfDay <= -MINUTE_MS || desiredTimeOfDay >= DAY_DURATION_MS + MINUTE_MS) {
            dayShift = Math.floor(desiredTimeOfDay / DAY_DURATION_MS)
            desiredTimeOfDay = desiredTimeOfDay - dayShift * DAY_DURATION_MS
          }
          // Compute target column after applying vertical overflow
          const targetIdx = Math.min(Math.max(nearestIdx + dayShift, 0), s.columns.length - 1)
          const target = s.columns[targetIdx]
          // Clamp within the day bounds; allow duration to overflow to adjacent day
          const timeOfDay = Math.min(Math.max(desiredTimeOfDay, 0), DAY_DURATION_MS)
          let newStart = s.initialStart
          let newEnd = s.initialEnd
          if (s.kind === 'move') {
            newStart = Math.round(target.dayStart + timeOfDay)
            newEnd = Math.round(newStart + s.durationMs)
          } else if (s.kind === 'resize-start') {
            newStart = Math.round(target.dayStart + timeOfDay)
            // Keep end fixed unless violating minimum duration
            if (newStart > newEnd - MIN_SESSION_DURATION_DRAG_MS) {
              newStart = newEnd - MIN_SESSION_DURATION_DRAG_MS
            }
          } else {
            // resize-end
            newEnd = Math.round(target.dayStart + timeOfDay)
            if (newEnd < newStart + MIN_SESSION_DURATION_DRAG_MS) {
              newEnd = newStart + MIN_SESSION_DURATION_DRAG_MS
            }
          }
          const current = dragPreviewRef.current
          if (current && current.entryId === s.entryId && current.startedAt === newStart && current.endedAt === newEnd) {
            return
          }
          const preview = { entryId: s.entryId, startedAt: newStart, endedAt: newEnd }
          dragPreviewRef.current = preview
          setDragPreview(preview)
          s.moved = true
        }
        const onUp = (e: PointerEvent) => {
          const s = calendarEventDragRef.current
          if (!s || e.pointerId !== s.pointerId) return
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          try { (targetEl as any).releasePointerCapture?.(s.pointerId) } catch {}
          if (panningFromEvent) {
            // Finish calendar pan gesture
            const state = calendarDragRef.current
            if (state && area) {
              try { area.releasePointerCapture?.(state.pointerId) } catch {}
              const dx = e.clientX - state.startX
              const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
              if (Number.isFinite(dayWidth) && dayWidth > 0) {
                const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                state.lastAppliedDx = appliedDx
                const totalPx = calendarBaseTranslateRef.current + appliedDx
                const daysEl = calendarDaysRef.current
                const allDayEl = calendarAllDayRef.current
                if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                const hdrEl = calendarHeadersRef.current
                if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
                const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
                if (snap !== 0) {
                  animateCalendarPan(snap, dayWidth, state.baseOffset)
                } else {
                  animateCalendarPan(0, dayWidth, state.baseOffset)
                }
              } else {
                const base = calendarBaseTranslateRef.current
                const daysEl = calendarDaysRef.current
                const allDayEl = calendarAllDayRef.current
                if (daysEl) daysEl.style.transform = `translateX(${base}px)`
                const hdrEl = calendarHeadersRef.current
                if (hdrEl) hdrEl.style.transform = `translateX(${base}px)`
                if (allDayEl) allDayEl.style.transform = `translateX(${base}px)`
              }
            }
            calendarDragRef.current = null
            // Suppress click opening preview after a pan
            dragPreventClickRef.current = true
            return
          }
          const preview = dragPreviewRef.current
          if (preview && preview.entryId === s.entryId && (preview.startedAt !== s.initialStart || preview.endedAt !== s.initialEnd)) {
            // A drag occurred and resulted in a time change; commit the change and suppress the click
            dragPreventClickRef.current = true
            updateHistory((current) => {
              const idx = current.findIndex((h) => h.id === s.entryId)
              if (idx === -1) return current
              const target = current[idx]
              const next = [...current]
              next[idx] = {
                ...target,
                startedAt: preview.startedAt,
                endedAt: preview.endedAt,
                elapsed: Math.max(preview.endedAt - preview.startedAt, 1),
              }
              return next
            })
          } else {
            // If drag intent was activated (even if it snapped back to original), suppress the click-preview
            if (s.activated) {
              dragPreventClickRef.current = true
            }
          }
          calendarEventDragRef.current = null
          dragPreviewRef.current = null
          setDragPreview(null)
          // Clear drag kind marker so cursor returns to default/hover affordances
          delete targetEl.dataset.dragKind
          // Always release scroll lock at the end of a drag (noop if not locked)
          if (isTouch) setPageScrollLock(false)
        }
        // For touch, arm the hold timer to activate dragging
        if (isTouch) {
          touchHoldTimer = window.setTimeout(() => {
            touchHoldTimer = null
            activateDrag()
          }, 360)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        // Timer is cleared in onMove (when movement occurs) and onUp (when finishing)
      }
      const headers = dayStarts.map((start, i) => {
        const d = new Date(start)
        const dow = d.toLocaleDateString(undefined, { weekday: 'short' })
        const dateNum = d.getDate()
        const isToday = start === todayMidnight
        return (
          <div key={`hdr-${i}`} className={`calendar-day-header${isToday ? ' is-today' : ''}`} aria-label={d.toDateString()}>
            <div className="calendar-day-header__dow">{dow}</div>
            <div className="calendar-day-header__date">
              <span className="calendar-day-header__date-number" aria-current={isToday ? 'date' : undefined}>{dateNum}</span>
            </div>
          </div>
        )
      })

      const hours = Array.from({ length: 25 }).map((_, h) => h) // 0..24 (24 for bottom line)
      const allDayBars = computeAllDayBars()
      const allDayMaxLane = allDayBars.reduce((m, b) => Math.max(m, b.lane), -1)
      const allDayRowCount = Math.max(0, allDayMaxLane + 1)
      const allDayTrackRows = Math.max(1, allDayRowCount)
          const body = (
            <div className="calendar-vertical__body">
              {/* All‑day row inside the body grid so it behaves as an extension of the days area */}
              <div className="calendar-allday-axis">All-day</div>
              <div
                className="calendar-allday-wrapper"
                onPointerDown={handleCalendarAreaPointerDown}
                style={{ touchAction: calendarTouchAction }}
              >
            <div
              className="calendar-alldays"
              ref={calendarAllDayRef}
              style={{ width: `${(dayStarts.length / visibleDayCount) * 100}%`, gridTemplateRows: `repeat(${allDayTrackRows}, 1.1rem)` }}
            >
              {/* Vertical day separators in all-day row (pan with track) */}
              <div className="calendar-allday-gridlines" aria-hidden>
                {dayStarts.map((_, i) => (
                  <div key={`adgl-${i}`} className={`calendar-allday-gridline${i === 0 ? ' is-first' : ''}`} />)
                )}
              </div>
              {allDayBars.map((bar, i) => {
                const backgroundStyle: React.CSSProperties = bar.isGuide
                  ? { background: 'transparent' }
                  : bar.isPlanned
                    ? {
                        background: `color-mix(in srgb, ${bar.baseColor || '#6ee7b7'} 16%, transparent)`,
                      }
                    : { background: bar.colorCss }
                return (
                <div
                  key={`adb-${i}-${bar.entry.id}`}
                  className={`calendar-allday-event${bar.isPlanned ? ' calendar-allday-event--planned' : ''}${bar.isGuide ? ' calendar-allday-event--guide' : ''}`}
                  style={{
                    gridColumn: `${bar.colStart + 1} / ${bar.colEnd + 1}`,
                    gridRow: `${bar.lane + 1}`,
                    ...(bar.isPlanned || bar.isGuide ? { color: bar.baseColor, boxShadow: 'none' } : {}),
                  }}
                  data-entry-id={bar.entry.id}
                  role={'button'}
                  aria-label={`${bar.label} · All-day`}
                  onClick={(e) => {
                    e.preventDefault(); e.stopPropagation()
                    if (dragPreventClickRef.current) { dragPreventClickRef.current = false; return }
                    if (suppressEventOpenRef.current) { suppressEventOpenRef.current = false; return }
                    if (calendarPreview && calendarPreview.entryId === bar.entry.id) { handleCloseCalendarPreview(); return }
                    handleOpenCalendarPreview(bar.entry, e.currentTarget as HTMLElement)
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault(); e.stopPropagation()
                    setSelectedHistoryId(bar.entry.id)
                    setHoveredHistoryId(bar.entry.id)
                    setEditingHistoryId(bar.entry.id)
                    taskNameAutofilledRef.current = false
                    setHistoryDraft(createHistoryDraftFromEntry(bar.entry))
                    openCalendarInspector(bar.entry)
                    handleCloseCalendarPreview()
                  }}
                  onPointerDown={(pev) => {
                    if (pev.button !== 0) return
                    // Start horizontal drag to move all-day block across days
                    pev.preventDefault(); pev.stopPropagation(); handleCloseCalendarPreview()
                    const track = calendarAllDayRef.current
                    if (!track) return
                    const rect = track.getBoundingClientRect()
                    if (!(Number.isFinite(rect.width) && rect.width > 0 && dayStarts.length > 0)) return
                    const pointerId = pev.pointerId
                    let moved = false
                    const startX = pev.clientX
                    const dayWidth = rect.width / Math.max(1, dayStarts.length)
                    const trackLeft = rect.left
                    const clampColumnIndex = (value: number) =>
                      Math.max(0, Math.min(dayStarts.length - 1, Number.isFinite(value) ? value : 0))
                    const pointerStartIndex = clampColumnIndex(Math.floor((startX - trackLeft) / dayWidth))
                    const initialStart = bar.entry.startedAt
                    const initialEnd = bar.entry.endedAt
                    const onMove = (e: PointerEvent) => {
                      if (e.pointerId !== pointerId) return
                      const dx = e.clientX - startX
                      const rawPointerIndex = Math.floor((e.clientX - trackLeft) / dayWidth)
                      const pointerIndex = clampColumnIndex(rawPointerIndex)
                      const deltaDays = pointerIndex - pointerStartIndex
                      if (Math.abs(dx) > 4 && !moved) { moved = true; dragPreventClickRef.current = true }
                      if (!moved) return
                      const nextStart = initialStart + deltaDays * DAY_DURATION_MS
                      const nextEnd = initialEnd + deltaDays * DAY_DURATION_MS
                      const current = dragPreviewRef.current
                      if (current && current.entryId === bar.entry.id && current.startedAt === nextStart && current.endedAt === nextEnd) return
                      const preview = { entryId: bar.entry.id, startedAt: nextStart, endedAt: nextEnd }
                      dragPreviewRef.current = preview
                      setDragPreview(preview)
                      try { e.preventDefault() } catch {}
                    }
                    const onUp = (e: PointerEvent) => {
                      if (e.pointerId !== pointerId) return
                      window.removeEventListener('pointermove', onMove)
                      window.removeEventListener('pointerup', onUp)
                      window.removeEventListener('pointercancel', onUp)
                      try { (pev.currentTarget as any).releasePointerCapture?.(pointerId) } catch {}
                      const preview = dragPreviewRef.current
                      if (moved && preview && preview.entryId === bar.entry.id && (preview.startedAt !== initialStart || preview.endedAt !== initialEnd)) {
                        updateHistory((current) => {
                          const idx = current.findIndex((h) => h.id === bar.entry.id)
                          if (idx === -1) return current
                          const target = current[idx]
                          const next = [...current]
                          next[idx] = { ...target, startedAt: preview.startedAt, endedAt: preview.endedAt, elapsed: Math.max(preview.endedAt - preview.startedAt, 1) }
                          return next
                        })
                      }
                      dragPreviewRef.current = null
                      setDragPreview(null)
                    }
                    try { (pev.currentTarget as any).setPointerCapture?.(pointerId) } catch {}
                    window.addEventListener('pointermove', onMove)
                    window.addEventListener('pointerup', onUp)
                    window.addEventListener('pointercancel', onUp)
                  }}
                >
                  <div className="calendar-allday-event__background" style={backgroundStyle} aria-hidden />
                  <div className="calendar-allday-event__content">
                    <div className="calendar-allday-event__title">{bar.label}</div>
                  </div>
                </div>
              )})}
              {/* Click/creation hit areas per day (span all rows) */}
              {dayStarts.map((start, i) => (
                <button
                  key={`adh-${i}`}
                  type="button"
                  className="calendar-allday-hit"
                  style={{ gridColumn: `${i + 1} / ${i + 2}`, gridRow: `1 / ${allDayTrackRows + 1}` }}
                  onClick={(ev) => {
                    ev.preventDefault(); ev.stopPropagation()
                    const newId = makeHistoryId()
                    const dayStart = start
                    const newEntry: HistoryEntry = {
                      id: newId, taskName: '', elapsed: DAY_DURATION_MS,
                      startedAt: dayStart, endedAt: dayStart + DAY_DURATION_MS,
                      goalName: null, bucketName: null, goalId: null, bucketId: null, taskId: null,
                      goalSurface: DEFAULT_SURFACE_STYLE, bucketSurface: null, notes: '', subtasks: [],
                    }
                    updateHistory((current) => { const next = [...current, newEntry]; next.sort((a, b) => a.startedAt - b.startedAt); return next })
                    setPendingNewHistoryId(newId)
                    setTimeout(() => { openCalendarInspector(newEntry) }, 0)
                  }}
                  aria-label={`Create all-day session for ${new Date(start).toDateString()}`}
                />
              ))}
            </div>
          </div>
          <div className="calendar-time-axis" aria-hidden>
            {hours.map((h) => (
              <div key={`t-${h}`} className="calendar-time-label" style={{ top: `${(h / 24) * 100}%` }}>
                {h > 0 && h < 24 ? formatHourLabel(h) : ''}
              </div>
            ))}
          </div>
          <div
            className="calendar-days-area"
            ref={calendarDaysAreaRef}
            onPointerDown={handleCalendarAreaPointerDown}
            style={{ touchAction: calendarTouchAction }}
          >
            <div className="calendar-gridlines" aria-hidden>
              {hours.map((h) => (
                <div key={`g-${h}`} className="calendar-gridline" style={{ top: `${(h / 24) * 100}%` }} />
              ))}
            </div>
            <div
              className="calendar-days"
              ref={calendarDaysRef}
              style={{ width: `${(dayStarts.length / visibleDayCount) * 100}%` }}
            >
              {dayStarts.map((start, di) => {
                const events = computeDayEvents(start, di)
                const isTodayColumn = start === todayMidnight
                const initialNowTopPct = (() => {
                  if (!isTodayColumn) return null as number | null
                  const now = Date.now()
                  const raw = ((now - start) / DAY_DURATION_MS) * 100
                  return Math.min(Math.max(raw, 0), 100)
                })()
                const handleCalendarColumnPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
                  if (ev.button !== 0) return
                  const targetEl = ev.currentTarget as HTMLDivElement
                  // Ignore if starting on an existing event
                  const rawTarget = ev.target as HTMLElement | null
                  if (rawTarget && rawTarget.closest('.calendar-event')) return
                  const daysRoot = calendarDaysRef.current
                  const area = calendarDaysAreaRef.current
                  if (!daysRoot || !area) return
                  const columnEls = Array.from(daysRoot.querySelectorAll<HTMLDivElement>('.calendar-day-column'))
                  if (columnEls.length === 0) return
                  const columns = columnEls.map((el, idx) => ({ rect: el.getBoundingClientRect(), dayStart: dayStarts[idx] }))
                  // Identify column where drag begins
                  const startColIdx = columns.findIndex((c) => ev.clientX >= c.rect.left && ev.clientX <= c.rect.right)
                  const col = startColIdx >= 0 ? columns[startColIdx] : columns[0]
                  const colHeight = col.rect.height
                  if (!(Number.isFinite(colHeight) && colHeight > 0)) return
                  const yRatio = Math.min(Math.max((ev.clientY - col.rect.top) / colHeight, 0), 1)
                  const timeOfDayMs0 = Math.round(yRatio * DAY_DURATION_MS)
                  const initialStart = Math.round(col.dayStart + timeOfDayMs0)

                  // Intent detection: wait to decide between horizontal pan vs vertical create
                  const pointerId = ev.pointerId
                  const startX = ev.clientX
                  const startY = ev.clientY
                  let startedCreate = false
                  let startedPan = false
                  const isTouch = (ev as any).pointerType === 'touch'
                  let touchHoldTimer: number | null = null

                  const startCreate = () => {
                    if (startedCreate) return
                    startedCreate = true
                    const state: CalendarEventDragState = {
                      pointerId,
                      entryId: 'new-entry',
                      startX,
                      startY,
                      initialStart,
                      initialEnd: initialStart + MIN_SESSION_DURATION_DRAG_MS,
                      initialTimeOfDayMs: timeOfDayMs0,
                      durationMs: MIN_SESSION_DURATION_DRAG_MS,
                      kind: 'resize-end',
                      columns,
                    }
                    calendarEventDragRef.current = state
                    dragPreviewRef.current = { entryId: 'new-entry', startedAt: state.initialStart, endedAt: state.initialEnd }
                    setDragPreview(dragPreviewRef.current)
                    // Lock page scroll while dragging to create (touch only)
                    if (isTouch) setPageScrollLock(true)
                    try { targetEl.setPointerCapture?.(pointerId) } catch {}
                  }

                  const startPan = () => {
                    if (startedPan) return
                    startedPan = true
                    const rect = area.getBoundingClientRect()
                    if (rect.width <= 0) return
                    const dayCount = calendarView === '3d'
                      ? Math.max(2, Math.min(multiDayCount, 14))
                      : calendarView === 'week'
                        ? 7
                        : 1
                    stopCalendarPanAnimation()
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
                    const daysEl = calendarDaysRef.current
                    const hdrEl = calendarHeadersRef.current
                    if (daysEl) daysEl.style.transition = ''
                    if (hdrEl) hdrEl.style.transition = ''
                    resetCalendarPanTransform()
                    const baseOffset = calendarPanDesiredOffsetRef.current
                    calendarDragRef.current = {
                      pointerId,
                      startX,
                      startY,
                      startTime: now,
                      areaWidth: rect.width,
                      dayCount,
                      baseOffset,
                      mode: 'hdrag',
                      lastAppliedDx: 0,
                    }
                    try { area.setPointerCapture?.(pointerId) } catch {}
                  }

                  const onMove = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    const dx = e.clientX - startX
                    const dy = e.clientY - startY
                    const absX = Math.abs(dx)
                    const absY = Math.abs(dy)
                    const threshold = 8
                    if (!startedCreate && !startedPan) {
                      if (isTouch) {
                        // On touch, require a hold before creating; allow horizontal pan if user slides before hold
                        if (absX > threshold && absX > absY) {
                          if (touchHoldTimer !== null) { try { window.clearTimeout(touchHoldTimer) } catch {} ; touchHoldTimer = null }
                          startPan()
                          return
                        }
                        // Vertical movement before hold — do nothing (avoid accidental create)
                        return
                      } else {
                        if (absX > threshold && absX > absY) {
                          startPan()
                        } else if (absY > threshold && absY > absX) {
                          startCreate()
                        } else {
                          return
                        }
                      }
                    }
                    if (startedPan) {
                      // Mirror handleCalendarAreaPointerDown's move behavior
                      const state = calendarDragRef.current
                      if (!state || e.pointerId !== state.pointerId) return
                      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
                      if (!Number.isFinite(dayWidth) || dayWidth <= 0) return
                      try { e.preventDefault() } catch {}
                      const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                      state.lastAppliedDx = constrainedDx
                      const totalPx = calendarBaseTranslateRef.current + constrainedDx
                      const daysEl = calendarDaysRef.current
                      const allDayEl = calendarAllDayRef.current
                      if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                      const hdrEl = calendarHeadersRef.current
                      if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                      if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
                      return
                    }
                    if (startedCreate) {
                      // Prevent page/area scrolling while dragging to create
                      try { e.preventDefault() } catch {}
                      const s = calendarEventDragRef.current
                      if (!s || e.pointerId !== s.pointerId) return
                      const baseIdx = s.columns.findIndex((c: any) => e.clientX >= c.rect.left && e.clientX <= c.rect.right)
                      const nearestIdx = baseIdx >= 0 ? baseIdx : (e.clientX < s.columns[0].rect.left ? 0 : s.columns.length - 1)
                      const baseCol = s.columns[nearestIdx]
                      const colH = baseCol.rect.height
                      if (!(Number.isFinite(colH) && colH > 0)) return
                      const deltaMsRaw = (dy / colH) * DAY_DURATION_MS
                      const deltaMinutes = Math.round(deltaMsRaw / MINUTE_MS)
                      const deltaMs = deltaMinutes * MINUTE_MS
                      let desiredTimeOfDay = s.initialTimeOfDayMs + deltaMs
                      let dayShift = 0
                      if (desiredTimeOfDay <= -MINUTE_MS || desiredTimeOfDay >= DAY_DURATION_MS + MINUTE_MS) {
                        dayShift = Math.floor(desiredTimeOfDay / DAY_DURATION_MS)
                        desiredTimeOfDay = desiredTimeOfDay - dayShift * DAY_DURATION_MS
                      }
                      const targetIdx = Math.min(Math.max(nearestIdx + dayShift, 0), s.columns.length - 1)
                      const target = s.columns[targetIdx]
                      const timeOfDay = Math.min(Math.max(desiredTimeOfDay, 0), DAY_DURATION_MS)
                      const newStart = s.initialStart
                      let newEnd = s.initialEnd
                      newEnd = Math.round(target.dayStart + timeOfDay)
                      if (newEnd < newStart + MIN_SESSION_DURATION_DRAG_MS) {
                        newEnd = newStart + MIN_SESSION_DURATION_DRAG_MS
                      }
                      const current = dragPreviewRef.current
                      if (current && current.entryId === 'new-entry' && current.startedAt === newStart && current.endedAt === newEnd) return
                      const preview = { entryId: 'new-entry', startedAt: newStart, endedAt: newEnd }
                      dragPreviewRef.current = preview
                      setDragPreview(preview)
                      return
                    }
                  }
                  const onUp = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    window.removeEventListener('pointermove', onMove)
                    window.removeEventListener('pointerup', onUp)
                    window.removeEventListener('pointercancel', onUp)
                    if (touchHoldTimer !== null) { try { window.clearTimeout(touchHoldTimer) } catch {} ; touchHoldTimer = null }

                    if (startedPan) {
                      const state = calendarDragRef.current
                      if (state && e.pointerId === state.pointerId) {
                        area.releasePointerCapture?.(state.pointerId)
                        const dx = e.clientX - state.startX
                        const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
                        if (Number.isFinite(dayWidth) && dayWidth > 0) {
                          const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                          state.lastAppliedDx = appliedDx
                          const totalPx = calendarBaseTranslateRef.current + appliedDx
                          const daysEl = calendarDaysRef.current
                          if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                          const hdrEl = calendarHeadersRef.current
                          if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                          const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
                          animateCalendarPan(snap, dayWidth, state.baseOffset)
                        } else {
                          const base = calendarBaseTranslateRef.current
                          const daysEl = calendarDaysRef.current
                          if (daysEl) daysEl.style.transform = `translateX(${base}px)`
                          const hdrEl = calendarHeadersRef.current
                          if (hdrEl) hdrEl.style.transform = `translateX(${base}px)`
                        }
                      }
                      calendarDragRef.current = null
                      return
                    }

                    if (startedCreate) {
                      // Release page scroll lock at the end of create drag (noop if not locked)
                      if (isTouch) setPageScrollLock(false)
                      try { targetEl.releasePointerCapture?.(pointerId) } catch {}
                      const preview = dragPreviewRef.current
                      if (preview && preview.entryId === 'new-entry') {
                        const startedAt = Math.min(preview.startedAt, preview.endedAt)
                        const endedAt = Math.max(preview.startedAt, preview.endedAt)
                        const elapsed = Math.max(endedAt - startedAt, MIN_SESSION_DURATION_DRAG_MS)
                        const newId = makeHistoryId()
                        const newEntry: HistoryEntry = {
                          id: newId,
                          taskName: '',
                          goalName: null,
                          bucketName: null,
                          goalId: null,
                          bucketId: null,
                          taskId: null,
                          elapsed,
                          startedAt,
                          endedAt,
                          goalSurface: DEFAULT_SURFACE_STYLE,
                          bucketSurface: null,
                          notes: '',
                          subtasks: [],
                        }
                        updateHistory((current) => {
                          const next = [...current, newEntry]
                          next.sort((a, b) => a.startedAt - b.startedAt)
                          return next
                        })
                        setPendingNewHistoryId(newId)
                        setTimeout(() => {
                          openCalendarInspector(newEntry)
                        }, 0)
                      }
                      calendarEventDragRef.current = null
                      dragPreviewRef.current = null
                      setDragPreview(null)
                      return
                    }
                    // No intent detected (tap) — do nothing
                  }
                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                  window.addEventListener('pointercancel', onUp)
                  // For touch, require a brief hold to start creation; allow pan to start immediately
                  if (isTouch) {
                    touchHoldTimer = window.setTimeout(() => {
                      touchHoldTimer = null
                      startCreate()
                    }, 360)
                  }
                }
                return (
                  <div key={`col-${di}`} className="calendar-day-column" onPointerDown={handleCalendarColumnPointerDown}>
                    {isTodayColumn ? (
                      <div
                        className="calendar-now-line"
                        ref={(node) => {
                          calendarNowLineRef.current = node
                          if (node) {
                            ;(node as any).dataset.dayStart = String(start)
                            if (typeof initialNowTopPct === 'number') {
                              node.style.top = `${initialNowTopPct}%`
                              node.style.display = ''
                            } else {
                              node.style.display = 'none'
                            }
                          }
                        }}
                        aria-hidden
                      />
                    ) : null}
                    {events.map((ev, idx) => {
                      const isDragging = dragPreview?.entryId === ev.entry.id
                      const dragTime = isDragging ? ev.rangeLabel : undefined
                      const isOutline = !!ev.isGuide || !!ev.isPlanned
                      const backgroundStyle: CSSProperties = ev.isGuide
                        ? { background: 'transparent' }
                        : ev.isPlanned
                          ? { background: `color-mix(in srgb, ${ev.baseColor ?? ev.color} 12%, transparent)` }
                          : { background: ev.gradientCss ?? ev.color }
                      if (ev.clipPath) {
                        backgroundStyle.clipPath = ev.clipPath
                      }
                      return (
                      <div
                        key={`ev-${di}-${idx}-${ev.entry.id}`}
                        className={`calendar-event${isDragging ? ' calendar-event--dragging' : ''}${ev.isGuide ? ' calendar-event--guide' : ''}${ev.isPlanned ? ' calendar-event--planned' : ''}`}
                        style={{
                          top: `${ev.topPct}%`,
                          height: `${ev.heightPct}%`,
                          left: '2px',
                          width: 'calc(100% - 4px)',
                          zIndex: ev.zIndex,
                          ...(isOutline ? { color: ev.baseColor ?? ev.color, boxShadow: 'none' } : {}),
                        }}
                        data-drag-time={dragTime}
                        data-entry-id={ev.entry.id}
                        role={'button'}
                        aria-label={`${ev.label} ${ev.rangeLabel}`}
                        onClick={(e) => {
                          // Only open the preview on genuine clicks; suppress after any drag intent
                          if (dragPreventClickRef.current) {
                            dragPreventClickRef.current = false
                            return
                          }
                          // Suppress the first click if closing/opening race just occurred
                          if (suppressEventOpenRef.current) {
                            suppressEventOpenRef.current = false
                            return
                          }
                          // If clicking the same entry that's already previewed, toggle it closed
                          if (calendarPreview && calendarPreview.entryId === ev.entry.id) {
                            handleCloseCalendarPreview()
                            return
                          }
                          handleOpenCalendarPreview(ev.entry, e.currentTarget)
                        }}
                        onDoubleClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (!ev.isGuide) {
                            // Prepare draft + selection state and open the full editor modal
                            setSelectedHistoryId(ev.entry.id)
                            setHoveredHistoryId(ev.entry.id)
                            setEditingHistoryId(ev.entry.id)
                            taskNameAutofilledRef.current = false
                            setHistoryDraft(createHistoryDraftFromEntry(ev.entry))
                            openCalendarInspector(ev.entry)
                            handleCloseCalendarPreview()
                          } else {
                            // Materialize guide then open editor
                            const parts = ev.entry.id.split(':')
                            const ruleId = parts[1]
                            const dayStart = Number(parts[2])
                            const ymd = formatLocalYmd(dayStart)
                            const newEntry: HistoryEntry = {
                              ...ev.entry,
                              id: makeHistoryId(),
                              repeatingSessionId: ruleId,
                              originalTime: ev.entry.startedAt,
                            }
                            updateHistory((current) => {
                              const next = [...current, newEntry]
                              next.sort((a, b) => a.startedAt - b.startedAt)
                              return next
                            })
                            try {
                              void upsertRepeatingException({
                                routineId: ruleId,
                                occurrenceDate: ymd,
                                action: 'rescheduled',
                                newStartedAt: newEntry.startedAt,
                                newEndedAt: newEntry.endedAt,
                                notes: null,
                              })
                            } catch {}
                            setSelectedHistoryId(newEntry.id)
                            setHoveredHistoryId(newEntry.id)
                            setEditingHistoryId(newEntry.id)
                            taskNameAutofilledRef.current = false
                            setHistoryDraft(createHistoryDraftFromEntry(newEntry))
                            openCalendarInspector(newEntry)
                            handleCloseCalendarPreview()
                          }
                        }}
                        onPointerUp={() => {
                          // No-op: click handler will decide whether to open based on dragPreventClickRef
                        }}
                        onPointerDown={(pev) => {
                          // Clear any hover-set cursor before deciding drag kind
                          delete (pev.currentTarget as HTMLDivElement).dataset.cursor
                          // Start drag logic (for guides, conversion happens only if drag actually activates)
                          handleCalendarEventPointerDown(ev.entry, start)(pev)
                        }}
                        onPointerMove={(pev) => {
                          // Update cursor affordance based on proximity to top/bottom edge
                          const target = pev.currentTarget as HTMLDivElement
                          const rect = target.getBoundingClientRect()
                          const edgePx = Math.min(12, Math.max(6, rect.height * 0.2))
                          const nearTop = pev.clientY - rect.top <= edgePx
                          const nearBottom = rect.bottom - pev.clientY <= edgePx
                          if (nearTop || nearBottom) {
                            if (target.dataset.cursor !== 'ns-resize') {
                              target.dataset.cursor = 'ns-resize'
                            }
                          } else if (target.dataset.cursor) {
                            // Use default arrow when not near edges
                            delete target.dataset.cursor
                          }
                        }}
                        onPointerLeave={(pev) => {
                          // Restore default cursor when leaving the block
                          const target = pev.currentTarget as HTMLDivElement
                          if (target.dataset.cursor) {
                            delete target.dataset.cursor
                          }
                        }}
                      >
                        <div className="calendar-event__background" style={backgroundStyle} aria-hidden />
                        {ev.showLabel ? (
                          <div className="calendar-event__content" style={{ justifyContent: ev.showTime ? 'flex-start' : 'center' }}>
                            <div className="calendar-event__title">{ev.label}</div>
                            {ev.showTime ? <div className="calendar-event__time">{ev.rangeLabel}</div> : null}
                          </div>
                        ) : null}
                      </div>
                    )})}
                    {(() => {
                      // Render creation preview if present and overlapping this day
                      const preview = dragPreview
                      if (!preview || preview.entryId !== 'new-entry') return null
                      const dayStart = start
                      const dayEnd = start + DAY_DURATION_MS
                      const startClamped = Math.max(Math.min(preview.startedAt, preview.endedAt), dayStart)
                      const endClamped = Math.min(Math.max(preview.startedAt, preview.endedAt), dayEnd)
                      if (endClamped <= startClamped) return null
                      const topPct = ((startClamped - dayStart) / DAY_DURATION_MS) * 100
                      const heightPct = Math.max(((endClamped - startClamped) / DAY_DURATION_MS) * 100, (MINUTE_MS / DAY_DURATION_MS) * 100)
                      const label = `${formatTimeOfDay(startClamped)} — ${formatTimeOfDay(endClamped)}`
                      return (
                        <div
                          className="calendar-event calendar-event--dragging"
                          style={{
                            top: `${topPct}%`,
                            height: `${heightPct}%`,
                            left: `0%`,
                            width: `calc(100% - 4px)`,
                            background: 'rgba(104, 124, 255, 0.6)',
                          }}
                          data-drag-kind="resize"
                          aria-hidden
                        >
                          <div className="calendar-event__title">New session</div>
                          <div className="calendar-event__time">{label}</div>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )

      const styleVars = { ['--calendar-day-count' as any]: String(dayStarts.length) } as CSSProperties
      return (
        <div className="calendar-vertical" aria-label="Time grid" style={styleVars}>
          <div className="calendar-vertical__header">
            <div className="calendar-axis-header" />
          <div
            className="calendar-header-wrapper"
            onPointerDown={handleCalendarAreaPointerDown}
            style={{ touchAction: calendarTouchAction }}
          >
              <div
                className="calendar-header-track"
                ref={calendarHeadersRef}
                style={{ width: `${(dayStarts.length / visibleDayCount) * 100}%` }}
              >
                {headers}
              </div>
            </div>
          </div>
          {body}
        </div>
      )
    }

    if (calendarView === 'month') {
      const headers = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const buildMonthPanel = (baseDate: Date) => {
        const firstOfMonth = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1)
        const lastOfMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0)
        // Start from the Sunday on/before the first of the month
        const gridStart = new Date(firstOfMonth)
        const offset = gridStart.getDay()
        gridStart.setDate(gridStart.getDate() - offset)
        // Extend to Saturday on/after the end of the month
        const gridEnd = new Date(lastOfMonth)
        const gridEndDow = gridEnd.getDay()
        gridEnd.setDate(gridEnd.getDate() + (6 - gridEndDow))

        // Build day cells
        const dayCells: ReactElement[] = []
        const iter = new Date(gridStart)
        while (iter <= gridEnd) {
          const current = new Date(iter)
          dayCells.push(
            renderCell(current, current.getMonth() === firstOfMonth.getMonth()),
          )
          iter.setDate(iter.getDate() + 1)
        }

        // Calculate rows (5 or 6) and fix the grid height so rows share space equally
        const totalDays = Math.round((gridEnd.getTime() - gridStart.getTime()) / DAY_DURATION_MS) + 1
        const rows = Math.max(1, Math.ceil(totalDays / 7))
        // Keep overall day-grid height equivalent to 5 rows of 80px plus approx 4 gaps (1rem)
        const gridHeight = 'calc(400px + 1rem)'

        return (
          <div className="calendar-carousel__panel" key={`panel-${firstOfMonth.getFullYear()}-${firstOfMonth.getMonth()}`}>
            <div className="calendar-week-headers">
              {headers.map((h) => (
                <div className="calendar-week-header" key={h} aria-hidden>
                  {h}
                </div>
              ))}
            </div>
            <div
              className="calendar-grid calendar-grid--month"
              style={{ gridTemplateRows: `repeat(${rows}, 1fr)`, height: gridHeight }}
            >
              {dayCells}
            </div>
          </div>
        )
      }

      const center = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1)
      const prev = new Date(center)
      prev.setMonth(prev.getMonth() - 1)
      const next = new Date(center)
      next.setMonth(next.getMonth() + 1)

      const handlePointerDown: any = (ev: ReactPointerEvent<HTMLDivElement>) => {
        const container = ev.currentTarget as HTMLDivElement
        const track = container.querySelector('.calendar-carousel__track') as HTMLDivElement | null
        if (!track) return
        if ((container as any).dataset.animating === '1') return
        if ((container as any).dataset.animating === '1') return
        const startX = ev.clientX
        const startY = ev.clientY
        const pointerId = ev.pointerId
        let engaged = false
        let captured = false
        let raf = 0
        const width = container.clientWidth
        const base = -width
        const thresholdPx = Math.max(24, Math.floor(width * 0.12))
        let lastDx = 0
        track.style.transition = 'none'
        track.style.transform = `translate3d(${base}px, 0, 0)`
        track.style.willChange = 'transform'
        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return
          const dx = e.clientX - startX
          const dy = e.clientY - startY
          if (!engaged) {
            if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.2) {
              engaged = true
              container.classList.add('is-dragging')
              if (!captured) { try { (container as any).setPointerCapture?.(pointerId) } catch {} captured = true }
            } else {
              return
            }
          }
          lastDx = Math.max(-width, Math.min(width, dx))
          if (!raf) {
            raf = window.requestAnimationFrame(() => { raf = 0; track.style.transform = `translate3d(${base + lastDx}px, 0, 0)` })
          }
          e.preventDefault(); e.stopPropagation()
        }
        const stopNextClick = (evt: globalThis.MouseEvent) => { evt.preventDefault(); evt.stopPropagation(); window.removeEventListener('click', stopNextClick, true) }
        const finish = (dir: -1 | 0 | 1) => {
          if (raf) { window.cancelAnimationFrame(raf); raf = 0 }
          ;(container as any).dataset.animating = '1'
          const prevPointer = container.style.pointerEvents
          container.style.pointerEvents = 'none'
          track.style.transition = 'transform 280ms cubic-bezier(0.2, 0, 0, 1)'
          const target = dir === 0 ? base : base + dir * width
          track.style.transform = `translate3d(${target}px, 0, 0)`
          const onEnd = () => {
            track.removeEventListener('transitionend', onEnd)
            // Keep the final transform in place to avoid a visible flash
            track.style.transition = ''
            track.style.willChange = ''
            container.classList.remove('is-dragging')
            if (dir !== 0) {
              // dir -1 (left) => next month; dir +1 (right) => previous month
              const m = new Date(
                anchorDate.getFullYear(),
                anchorDate.getMonth() + (dir < 0 ? 1 : -1),
                1,
              )
              m.setHours(0, 0, 0, 0)
              const today = new Date(); today.setHours(0, 0, 0, 0)
              const deltaDays = Math.round((m.getTime() - today.getTime()) / DAY_DURATION_MS)
              if (typeof flushSync === 'function') {
                flushSync(() => setHistoryDayOffset(deltaDays))
              } else {
                setHistoryDayOffset(deltaDays)
              }
              // Clear title override now that the anchorDate has been updated
              setCalendarTitleOverride(null)
              // After the new content mounts, snap back to the centered base without animation
              requestAnimationFrame(() => {
                track.style.transition = 'none'
                track.style.transform = `translate3d(${base}px, 0, 0)`
                requestAnimationFrame(() => { track.style.transition = '' })
              })
            } else {
              // No commit; reset to base immediately
              track.style.transform = `translate3d(${base}px, 0, 0)`
              setCalendarTitleOverride(null)
            }
            delete (container as any).dataset.animating
            container.style.pointerEvents = prevPointer
          }
          track.addEventListener('transitionend', onEnd, { once: true })
        }
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          if (captured) { try { (container as any).releasePointerCapture?.(pointerId) } catch {} }
          if (!engaged) return
          window.addEventListener('click', stopNextClick, true)
          const commit = Math.abs(lastDx) > thresholdPx ? (lastDx < 0 ? -1 : 1) : 0
          finish(commit)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      return (
        <div className="calendar-carousel" ref={monthYearCarouselRef} onPointerDown={handlePointerDown}>
          <div className="calendar-carousel__track">
            {buildMonthPanel(prev)}
            {buildMonthPanel(center)}
            {buildMonthPanel(next)}
          </div>
        </div>
      )
    }

    if (calendarView === 'year') {
      const year = anchorDate.getFullYear()
      const todayMidnight = (() => {
        const t = new Date()
        t.setHours(0, 0, 0, 0)
        return t.getTime()
      })()

      const buildYearPanel = (yr: number) => {
        const months = Array.from({ length: 12 }).map((_, idx) => {
          const firstOfMonth = new Date(yr, idx, 1)
          const label = firstOfMonth.toLocaleDateString(undefined, { month: 'short' })
          // Build a 6x7 grid of days for consistent height
          const start = new Date(firstOfMonth)
          const startDow = start.getDay() // 0=Sun
          start.setDate(start.getDate() - startDow)
          const cells: ReactElement[] = []
          for (let i = 0; i < 42; i += 1) {
            const d = new Date(start)
            d.setDate(start.getDate() + i)
            d.setHours(0, 0, 0, 0)
            const inMonth = d.getMonth() === idx
            const isToday = d.getTime() === todayMidnight
            const cell = (
              <div
                key={`y-${yr}-${idx}-${i}`}
                className={`calendar-month-day${inMonth ? '' : ' calendar-month-day--muted'}${isToday ? ' calendar-month-day--today' : ''}`}
                aria-hidden={!inMonth}
                role={inMonth ? 'button' : undefined}
                tabIndex={inMonth ? 0 : -1}
                onClick={inMonth ? () => jumpToDateAndShowWeek(d.getTime()) : undefined}
                onKeyDown={inMonth ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    jumpToDateAndShowWeek(d.getTime())
                  }
                } : undefined}
              >
                {d.getDate()}
              </div>
            )
            cells.push(cell)
          }
          return (
            <div key={`m-${yr}-${idx}`} className="calendar-year-cell">
              <div
                className="calendar-year-label"
                role="button"
                tabIndex={0}
                onClick={() => jumpToMonthView(yr, idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToMonthView(yr, idx) }
                }}
                title={`Open ${label} ${yr}`}
              >
                {label}
              </div>
              {/* Mini month weekday headers for clarity */}
              <div className="calendar-month-headers" aria-hidden>
                {['S','M','T','W','T','F','S'].map((ch) => (
                  <div key={`hdr-${label}-${ch}`} className="calendar-month-header">{ch}</div>
                ))}
              </div>
              <div className="calendar-month-grid" role="grid" aria-label={`Calendar for ${label} ${yr}`}>
                {cells}
              </div>
            </div>
          )
        })
        return (
          <div className="calendar-grid calendar-grid--year">{months}</div>
        )
      }

      const prev = buildYearPanel(year - 1)
      const curr = buildYearPanel(year)
      const next = buildYearPanel(year + 1)
      const handlePointerDown: any = (ev: ReactPointerEvent<HTMLDivElement>) => {
        const container = ev.currentTarget as HTMLDivElement
        const track = container.querySelector('.calendar-carousel__track') as HTMLDivElement | null
        if (!track) return
        const width = container.clientWidth
        const base = -width
        const startX = ev.clientX
        const startY = ev.clientY
        const pointerId = ev.pointerId
        let engaged = false
        let lastDx = 0
        let captured = false
        let raf = 0
        const thresholdPx = Math.max(24, Math.floor(width * 0.12))
        track.style.transition = 'none'
        track.style.transform = `translate3d(${base}px, 0, 0)`
        track.style.willChange = 'transform'
        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return
          const dx = e.clientX - startX
          const dy = e.clientY - startY
          if (!engaged) {
            if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.2) {
              engaged = true
              container.classList.add('is-dragging')
              if (!captured) { try { (container as any).setPointerCapture?.(pointerId) } catch {} captured = true }
            } else {
              return
            }
          }
          lastDx = Math.max(-width, Math.min(width, dx))
          if (!raf) { raf = window.requestAnimationFrame(() => { raf = 0; track.style.transform = `translate3d(${base + lastDx}px, 0, 0)` }) }
          e.preventDefault(); e.stopPropagation()
        }
        const stopNextClick = (evt: globalThis.MouseEvent) => { evt.preventDefault(); evt.stopPropagation(); window.removeEventListener('click', stopNextClick, true) }
        const finish = (dir: -1 | 0 | 1) => {
          if (raf) { window.cancelAnimationFrame(raf); raf = 0 }
          ;(container as any).dataset.animating = '1'
          const prevPointer = container.style.pointerEvents
          container.style.pointerEvents = 'none'
          track.style.transition = 'transform 280ms cubic-bezier(0.2, 0, 0, 1)'
          const target = dir === 0 ? base : base + dir * width
          track.style.transform = `translate3d(${target}px, 0, 0)`
          const onEnd = () => {
            track.removeEventListener('transitionend', onEnd)
            // Keep the final transform in place to avoid a visible flash
            track.style.transition = ''
            track.style.willChange = ''
            container.classList.remove('is-dragging')
            if (dir !== 0) {
              // dir -1 (left) => next year; dir +1 (right) => previous year
              const y = year - dir
              const targetDate = new Date(y, 0, 1)
              targetDate.setHours(0, 0, 0, 0)
              const today = new Date(); today.setHours(0, 0, 0, 0)
              const deltaDays = Math.round((targetDate.getTime() - today.getTime()) / DAY_DURATION_MS)
              if (typeof flushSync === 'function') {
                flushSync(() => setHistoryDayOffset(deltaDays))
              } else {
                setHistoryDayOffset(deltaDays)
              }
              // Clear title override now that the anchorDate has been updated
              setCalendarTitleOverride(null)
              // After the new content mounts, snap back to the centered base without animation
              requestAnimationFrame(() => {
                track.style.transition = 'none'
                track.style.transform = `translate3d(${base}px, 0, 0)`
                requestAnimationFrame(() => { track.style.transition = '' })
              })
            } else {
              // No commit; reset to base immediately
              track.style.transform = `translate3d(${base}px, 0, 0)`
              setCalendarTitleOverride(null)
            }
            delete (container as any).dataset.animating
            container.style.pointerEvents = prevPointer
          }
          track.addEventListener('transitionend', onEnd, { once: true })
        }
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          if (captured) { try { (container as any).releasePointerCapture?.(pointerId) } catch {} }
          if (!engaged) return
          window.addEventListener('click', stopNextClick, true)
          const commit = Math.abs(lastDx) > thresholdPx ? (lastDx < 0 ? -1 : 1) : 0
          finish(commit)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      return (
        <div className="calendar-carousel" ref={monthYearCarouselRef} onPointerDown={handlePointerDown}>
          <div className="calendar-carousel__track">
            <div className="calendar-carousel__panel">{prev}</div>
            <div className="calendar-carousel__panel">{curr}</div>
            <div className="calendar-carousel__panel">{next}</div>
          </div>
        </div>
      )
    }

    return null
  }, [
    calendarView,
    anchorDate,
    effectiveHistory,
    dragPreview,
    multiDayCount,
    enhancedGoalLookup,
    goalColorLookup,
    lifeRoutineSurfaceLookup,
    calendarPreview,
    handleOpenCalendarPreview,
    handleCloseCalendarPreview,
    animateCalendarPan,
    resolvePanSnap,
    resetCalendarPanTransform,
    stopCalendarPanAnimation,
    repeatingRules,
    repeatingExceptions,
    setView,
    setHistoryDayOffset,
    navigateByDelta,
    stepSizeByView,
  ])

  // Simple inline icons for popover actions
  const IconEdit = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
  )
  const IconTrash = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"/>
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
    </svg>
  )
  const IconClose = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>
  )

  // Render the popover outside the heavy calendar grid to avoid re-running grid computations on open/close
  const renderCalendarPopover = useCallback(() => {
    if (!calendarPreview || typeof document === 'undefined') return null
  const entry = effectiveHistory.find((h) => h.id === calendarPreview.entryId) || calendarPreview.entrySnapshot || null
    if (!entry) return null
    const dateLabel = (() => {
      if (isAllDayRangeTs(entry.startedAt, entry.endedAt)) {
        // All‑day rendering: same‑day => "Mon, Oct 14 · All day"; multi‑day => "Oct 14 – Oct 16"
        const startD = new Date(entry.startedAt)
        const endD = new Date(entry.endedAt)
        const sameDay =
          startD.getFullYear() === endD.getFullYear() &&
          startD.getMonth() === endD.getMonth() &&
          startD.getDate() === endD.getDate()
        if (sameDay) {
          const dateFmt = startD.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
          return `${dateFmt} · All day`
        }
        // Show end as the day before (since end is exclusive midnight)
        const endMinus = new Date(endD.getTime() - 1)
        const includeYears = startD.getFullYear() !== endMinus.getFullYear()
        const startFmt = startD.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: includeYears ? 'numeric' : undefined })
        const endFmt = endMinus.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: includeYears ? 'numeric' : undefined })
        return `${startFmt} – ${endFmt}`
      }
      const startD = new Date(entry.startedAt)
      const endD = new Date(entry.endedAt)
      const sameDay =
        startD.getFullYear() === endD.getFullYear() &&
        startD.getMonth() === endD.getMonth() &&
        startD.getDate() === endD.getDate()
      if (sameDay) {
        const dateFmt = startD.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        return `${dateFmt} · ${formatTimeOfDay(entry.startedAt)} — ${formatTimeOfDay(entry.endedAt)}`
      }
      return formatDateRange(entry.startedAt, entry.endedAt)
    })()
    const durationLabel = formatDuration(Math.max(entry.endedAt - entry.startedAt, 0))
    const title = deriveEntryTaskName(entry)
    const editingState = calendarPopoverEditing && calendarPopoverEditing.entryId === entry.id ? calendarPopoverEditing : null
    const startValue = entry.taskName ?? ''
    const initialDisplayValue = title || ''
    const duplicateHistoryEntry = (source: HistoryEntry): HistoryEntry => {
      const newEntry: HistoryEntry = {
        ...source,
        id: makeHistoryId(),
        notes: source.notes,
        subtasks: source.subtasks.map((subtask) => ({ ...subtask })),
        // A duplicated entry should not stay linked to a repeating rule
        repeatingSessionId: null,
        originalTime: null,
      }
      updateHistory((current) => {
        const next = [...current, newEntry]
        next.sort((a, b) => a.startedAt - b.startedAt)
        return next
      })
      return newEntry
    }
    const startEditingTitle = (options?: { selectionSnapshot?: EditableSelectionSnapshot | null }) => {
      setCalendarPopoverEditing({
        entryId: entry.id,
        value: initialDisplayValue,
        initialTaskName: startValue,
        initialDisplayValue,
        dirty: false,
        selectionSnapshot: options?.selectionSnapshot ?? null,
      })
    }
    const getCaretSnapshotFromPoint = (clientX: number, clientY: number): EditableSelectionSnapshot | null => {
      const editableEl = calendarPopoverTitleRef.current
      if (!editableEl || typeof document === 'undefined') {
        return null
      }
      const doc = editableEl.ownerDocument || document
      let range: Range | null = null
      const anyDoc = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      if (typeof anyDoc.caretRangeFromPoint === 'function') {
        range = anyDoc.caretRangeFromPoint(clientX, clientY)
      } else if (typeof anyDoc.caretPositionFromPoint === 'function') {
        const pos = anyDoc.caretPositionFromPoint(clientX, clientY)
        if (pos) {
          range = doc.createRange()
          range.setStart(pos.offsetNode, pos.offset)
          range.collapse(true)
        }
      }
      return buildSelectionSnapshotFromRange(editableEl, range)
    }
    const handleTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (editingState) {
        return
      }
      if (event.pointerType === 'mouse') {
        event.preventDefault()
        event.stopPropagation()
      }
      const snapshot =
        event.pointerType === 'mouse'
          ? getCaretSnapshotFromPoint(event.clientX, event.clientY)
          : null
      startEditingTitle({ selectionSnapshot: snapshot })
    }
    const handleTitleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (editingState) {
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        startEditingTitle()
      }
    }
    const handleTitleEditableInput = (event: FormEvent<HTMLDivElement>) => {
      if (!editingState) {
        return
      }
      const value = event.currentTarget.textContent ?? ''
      const nextDirty = value !== editingState.initialDisplayValue
      if (value === editingState.value && nextDirty === editingState.dirty) {
        return
      }
      setCalendarPopoverEditing({
        ...editingState,
        value,
        dirty: nextDirty,
        selectionSnapshot: null,
      })
      const desiredValue = nextDirty ? value : editingState.initialTaskName
      updateHistory((current) => {
        const index = current.findIndex((item) => item.id === entry.id)
        if (index === -1) {
          return current
        }
        const target = current[index]
        if (target.taskName === desiredValue) {
          return current
        }
        const next = [...current]
        next[index] = { ...target, taskName: desiredValue }
        return next
      })
    }
    const commitTitleChange = () => {
      if (!editingState) {
        return
      }
      const nextTrimmed = editingState.value.trim()
      const previousRaw = editingState.initialTaskName
      const previousTrimmed = previousRaw.trim()
      setCalendarPopoverEditing(null)
      updateHistory((current) => {
        const index = current.findIndex((item) => item.id === entry.id)
        if (index === -1) {
          return current
        }
        const target = current[index]
        const desiredValue = editingState.dirty ? nextTrimmed : previousRaw
        if (editingState.dirty && nextTrimmed === previousTrimmed) {
          if (target.taskName === previousRaw) {
            return current
          }
          const next = [...current]
          next[index] = { ...target, taskName: previousRaw }
          return next
        }
        if (target.taskName === desiredValue) {
          return current
        }
        const next = [...current]
        next[index] = { ...target, taskName: desiredValue }
        return next
      })
    }
    const cancelTitleChange = () => {
      setCalendarPopoverEditing(null)
      if (!editingState) {
        return
      }
      const original = editingState.initialTaskName
      updateHistory((current) => {
        const index = current.findIndex((item) => item.id === entry.id)
        if (index === -1) {
          return current
        }
        const target = current[index]
        if (target.taskName === original) {
          return current
        }
        const next = [...current]
        next[index] = { ...target, taskName: original }
        return next
      })
    }
    const handleTitleEditableBlur = () => {
      commitTitleChange()
    }
    const handleTitleEditableKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitTitleChange()
        handleCloseCalendarPreview()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelTitleChange()
        handleCloseCalendarPreview()
      }
    }
    const goal = entry.goalName || 'No goal'
    const bucket = entry.bucketName || 'No bucket'
    const cachedSubtasks = subtasksCache.get(entry.id)
    const summarySubtasks =
      entry.id === selectedHistoryId ? historyDraft.subtasks : cachedSubtasks ?? entry.subtasks
    const subtaskCount = summarySubtasks.length
    const completedSubtasks = summarySubtasks.reduce((count, subtask) => (subtask.completed ? count + 1 : count), 0)
    const hasNotes = entry.notes.trim().length > 0
    const subtasksSummary = subtaskCount > 0 ? `${completedSubtasks}/${subtaskCount} subtasks` : 'No subtasks'
    const notesSummary = hasNotes ? 'Notes added' : 'No notes'
          const isGuide = entry.id.startsWith('repeat:')
  const nowTs = Date.now()
  const isPlanned = Boolean((entry as any).futureSession)
  const isPastPlanned = isPlanned && entry.startedAt <= nowTs
  const isUpcomingPlanned = isPlanned && entry.startedAt > nowTs
    const parsedGuide = (() => {
      if (!isGuide) return null
      const parts = entry.id.split(':')
      if (parts.length < 3) return null
      const ruleId = parts[1]
      const dayStart = Number(parts[2])
      const ymd = formatLocalYmd(dayStart)
      return { ruleId, dayStart, ymd }
    })()
    return createPortal(
      <div
        className="calendar-popover"
        ref={calendarPreviewRef}
        style={{ top: `${calendarPreview.top}px`, left: `${calendarPreview.left}px` }}
        role="dialog"
        aria-label="Session details"
      >
        <div className="calendar-popover__header">
          <div
            ref={calendarPopoverTitleRef}
            className={`calendar-popover__title${editingState ? ' calendar-popover__title--editing' : ' calendar-popover__title--interactive'}`}
            role={editingState ? 'textbox' : 'button'}
            tabIndex={0}
            contentEditable={editingState ? 'true' : undefined}
            suppressContentEditableWarning
            aria-label="Session title"
            aria-multiline={editingState ? 'true' : undefined}
            onPointerDown={editingState ? undefined : handleTitlePointerDown}
            onKeyDown={(event) => {
              if (editingState) {
                handleTitleEditableKeyDown(event)
              } else {
                handleTitleKeyDown(event)
              }
            }}
            onInput={editingState ? handleTitleEditableInput : undefined}
            onBlur={editingState ? handleTitleEditableBlur : undefined}
          >
            {editingState ? undefined : title || 'Untitled session'}
          </div>
          <div className="calendar-popover__actions">
            <button
              type="button"
              className="calendar-popover__action"
              aria-label="Edit session"
              onPointerDown={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                setSelectedHistoryId(entry.id)
                setHoveredHistoryId(entry.id)
                setEditingHistoryId(entry.id)
                taskNameAutofilledRef.current = false
                setHistoryDraft(createHistoryDraftFromEntry(entry))
                openCalendarInspector(entry)
                handleCloseCalendarPreview()
              }}
            >
              <IconEdit />
            </button>
            {isGuide ? null : (
              <>
                <CalendarActionsKebab
                  previewRef={calendarPreviewRef}
                  onDuplicate={() => {
                    const dup = duplicateHistoryEntry(entry)
                    if (!dup) return
                    setHoveredHistoryId(dup.id)
                    setSelectedHistoryId(dup.id)
                    setEditingHistoryId(dup.id)
                    taskNameAutofilledRef.current = false
                    setHistoryDraft(createHistoryDraftFromEntry(dup))
                  }}
                />
                <button
                  type="button"
                  className="calendar-popover__action calendar-popover__action--danger"
                  aria-label="Delete session"
                  onPointerDown={(ev) => {
                    ev.preventDefault()
                    ev.stopPropagation()
                    suppressNextEventOpen()
                    handleDeleteHistoryEntry(entry.id)(ev as any)
                    handleCloseCalendarPreview()
                  }}
                >
                  <IconTrash />
                </button>
              </>
            )}
            <button
              type="button"
              className="calendar-popover__action calendar-popover__action--close"
              aria-label="Close"
              onPointerDown={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                suppressNextEventOpen()
                handleCloseCalendarPreview()
              }}
            >
              <IconClose />
            </button>
          </div>
        </div>
        <div className="calendar-popover__meta">
          <div className="calendar-popover__time">
            {dateLabel}
            {' '}
            <span className="duration-badge" aria-label="Elapsed time">{durationLabel}</span>
          </div>
          <div className="calendar-popover__repeat" aria-label="Repeat">
            <span className="calendar-popover__repeat-label" aria-hidden>
              <span className="calendar-popover__repeat-icon calendar-popover__repeat-icon--loop">⟳</span>
              <span className="calendar-popover__repeat-text">Repeat</span>
              <span className="calendar-popover__repeat-icon calendar-popover__repeat-icon--caret">▸</span>
            </span>
            {(() => {
              const start = new Date(entry.startedAt)
              const minutes = start.getHours() * 60 + start.getMinutes()
              const durMin = Math.max(1, Math.round((entry.endedAt - entry.startedAt) / 60000))
              const dow = start.getDay()
              const dayStartMs = (() => { const d = new Date(entry.startedAt); d.setHours(0,0,0,0); return d.getTime() })()
              const monthDay = monthDayKey(start.getTime())
              const matches = (r: RepeatingSessionRule) =>
                r.isActive &&
                r.timeOfDayMinutes === minutes &&
                r.durationMinutes === durMin &&
                (r.taskName?.trim() || '') === (entry.taskName?.trim() || '') &&
                (r.goalName?.trim() || null) === (entry.goalName?.trim() || null) &&
                (r.bucketName?.trim() || null) === (entry.bucketName?.trim() || null)
              const matchingRules = repeatingRules.filter((r) => matches(r))
              const hasDaily = matchingRules.some((r) => r.frequency === 'daily')
              const hasCustom = matchingRules.some(
                (r) => r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.length > 1,
              )
              const hasWeekly = matchingRules.some(
                (r) => r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(dow),
              )
              const hasMonthly = matchingRules.some((r) => r.frequency === 'monthly' && matchesMonthlyDay(r, dayStartMs))
              const hasAnnual = matchingRules.some((r) => r.frequency === 'annually' && ruleMonthDayKey(r) === monthDay)
              const currentVal: 'none' | 'daily' | 'weekly' | 'monthly' | 'annually' | 'custom' =
                hasCustom
                  ? 'custom'
                  : hasDaily
                    ? 'daily'
                    : hasWeekly
                      ? 'weekly'
                      : hasMonthly
                        ? 'monthly'
                        : hasAnnual
                          ? 'annually'
                          : 'none'
              return (
                <HistoryDropdown
                  id={`repeat-${entry.id}`}
                  value={currentVal}
                  placeholder="None"
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'monthly', label: 'Monthly' },
                    { value: 'annually', label: 'Annually' },
                    { value: 'custom', label: 'Custom...' },
                  ]}
                  onChange={async (v) => {
                    const val = (v as 'none' | 'daily' | 'weekly' | 'monthly' | 'annually' | 'custom')
                    if (val === 'custom') {
                      openCustomRecurrence(entry)
                      return
                    }
                    if (val === 'none') {
                      // If this entry is a guide from a repeating rule, cut the series after this instance
                      if (isGuide) {
                        // parsedGuide contains ruleId and ymd for this guide
                        if (parsedGuide) {
                          const guideMinutes = start.getHours() * 60 + start.getMinutes()
                          const guideDay = new Date(entry.startedAt)
                          guideDay.setHours(0, 0, 0, 0)
                          const scheduledStart = guideDay.getTime() + guideMinutes * 60000
                          const preciseStart = Math.max(entry.startedAt, scheduledStart)
                          await setRepeatToNoneAfterTimestamp(parsedGuide.ruleId, preciseStart)
                          // Update local cache to reflect new end boundary but keep the rule so this occurrence remains
                          setRepeatingRules((prev) => {
                            const found = prev.find((r) => r.id === parsedGuide.ruleId)
                            if (!found) return prev
                            const nextEnd = Math.max(0, preciseStart)
                            return prev.map((r) => (r.id === parsedGuide.ruleId ? { ...r, endAtMs: nextEnd } : r))
                          })
                        }
                      } else {
                        // Non-guide: if this entry is the seed (rule start), delete by rule id; else fall back to shape deletion
                        const start = new Date(entry.startedAt)
                        const minutes = start.getHours() * 60 + start.getMinutes()
                        const durMin = Math.max(1, Math.round((entry.endedAt - entry.startedAt) / 60000))
                        const dow = start.getDay()
                        const labelTask = (entry.taskName?.trim() || '')
                        const labelGoal = (entry.goalName?.trim() || null)
                        const labelBucket = (entry.bucketName?.trim() || null)
                        // Compute scheduled start (truncate seconds/ms) to match how rules store startAtMs
                        const dayStart = new Date(entry.startedAt)
                        dayStart.setHours(0, 0, 0, 0)
                        const scheduledStart = dayStart.getTime() + minutes * 60000
                        const seedRules = repeatingRules.filter((r) => {
                          const labelMatch = (r.taskName?.trim() || '') === labelTask && (r.goalName?.trim() || null) === labelGoal && (r.bucketName?.trim() || null) === labelBucket
                          const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durMin
                          const freqMatch =
                            r.frequency === 'daily' ||
                            (r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(dow)) ||
                            (r.frequency === 'monthly' && matchesMonthlyDay(r, dayStart.getTime())) ||
                            (r.frequency === 'annually' && ruleMonthDayKey(r) === monthDay)
                          const startAt = (r as any).startAtMs as number | undefined
                          const startMatch = Number.isFinite(startAt as number) && (startAt as number) === scheduledStart
                          return labelMatch && timeMatch && freqMatch && startMatch
                        })
                        if (seedRules.length > 0) {
                          for (const r of seedRules) {
                            await deleteRepeatingRuleById(r.id)
                          }
                          setRepeatingRules((prev) => prev.filter((r) => !seedRules.some((s) => s.id === r.id)))
                          return
                        }
                        // Fallback: delete any matching rules via backend shape matcher
                        const ids = await deleteMatchingRulesForEntry(entry)
                        if (Array.isArray(ids) && ids.length > 0) {
                          setRepeatingRules((prev) => prev.filter((r) => !ids.includes(r.id)))
                        } else {
                          // Fallback: remove locally by matching shape
                          setRepeatingRules((prev) => prev.filter((r) => {
                            const labelMatch = (r.taskName?.trim() || '') === (entry.taskName?.trim() || '') && (r.goalName?.trim() || null) === (entry.goalName?.trim() || null) && (r.bucketName?.trim() || null) === (entry.bucketName?.trim() || null)
                            const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durMin
                            const freqMatch =
                              r.frequency === 'daily' ||
                              (r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(dow)) ||
                              (r.frequency === 'monthly' && matchesMonthlyDay(r, dayStart.getTime())) ||
                              (r.frequency === 'annually' && ruleMonthDayKey(r) === monthDay)
                            return !(labelMatch && timeMatch && freqMatch)
                          }))
                        }
                      }
                      return
                    }
                    const created = await createRepeatingRuleForEntry(entry, val)
                    if (created) {
                      setRepeatingRules((prev) => [...prev, created])
                      const scheduledStart = computeEntryScheduledStart(entry)
                      updateHistory((current) => current.map((h) => (h.id === entry.id ? { ...h, repeatingSessionId: created.id, originalTime: scheduledStart } : h)))
                    }
                  }}
                />
              )
            })()}
          </div>
          <div className="calendar-popover__goal">{goal}{bucket ? ` → ${bucket}` : ''}</div>
          <div
            className="calendar-popover__summary"
            aria-label={`Subtasks ${subtasksSummary}; ${notesSummary}`}
          >
            <span className="calendar-popover__summary-item">{subtasksSummary}</span>
            <span className="calendar-popover__summary-separator" aria-hidden="true">•</span>
            <span className="calendar-popover__summary-item">{notesSummary}</span>
          </div>
            {isGuide ? (
              <div className="calendar-popover__cta-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem' }}>
                <button
                  type="button"
                  className="history-timeline__action-button history-timeline__action-button--primary"
                  onClick={() => {
                    if (!parsedGuide) return
                    const newEntry: HistoryEntry = {
                      ...entry,
                      id: makeHistoryId(),
                      repeatingSessionId: parsedGuide.ruleId,
                      originalTime: entry.startedAt,
                    }
                    updateHistory((current) => {
                      const next = [...current, newEntry]
                      next.sort((a, b) => a.startedAt - b.startedAt)
                      return next
                    })
                    try {
                      void upsertRepeatingException({
                        routineId: parsedGuide.ruleId,
                        occurrenceDate: parsedGuide.ymd,
                        action: 'rescheduled',
                        newStartedAt: newEntry.startedAt,
                        newEndedAt: newEntry.endedAt,
                        notes: null,
                      })
                      void evaluateAndMaybeRetireRule(parsedGuide.ruleId)
                    } catch {}
                    handleCloseCalendarPreview()
                  }}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="history-timeline__action-button"
                  onClick={async () => {
                    if (!parsedGuide) return
                    // Create a zero-duration entry to mark this occurrence as resolved without rendering
                    const zeroEntry: HistoryEntry = {
                      ...entry,
                      id: makeHistoryId(),
                      endedAt: entry.startedAt,
                      elapsed: 0,
                      repeatingSessionId: parsedGuide.ruleId,
                      originalTime: entry.startedAt,
                    }
                    updateHistory((current) => {
                      const next = [...current, zeroEntry]
                      next.sort((a, b) => a.startedAt - b.startedAt)
                      return next
                    })
                    try {
                      // Keep exception for backward compatibility
                      await upsertRepeatingException({
                        routineId: parsedGuide.ruleId,
                        occurrenceDate: parsedGuide.ymd,
                        action: 'skipped',
                        newStartedAt: null,
                        newEndedAt: null,
                        notes: null,
                      })
                    } catch {}
                    void evaluateAndMaybeRetireRule(parsedGuide.ruleId)
                    handleCloseCalendarPreview()
                  }}
                >
                  Skip
                </button>
              </div>
            ) : null}
            {!isGuide && isPastPlanned ? (
              <div className="calendar-popover__cta-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem' }}>
                <button
                  type="button"
                  className="history-timeline__action-button history-timeline__action-button--primary"
                  onClick={() => {
                    // Confirm: convert planned entry into a real session (clear future flag) and close.
                    updateHistory((current) => {
                      const idx = current.findIndex((e) => e.id === entry.id)
                      if (idx === -1) return current
                      const next = [...current]
                      next[idx] = { ...next[idx], futureSession: false }
                      return next
                    })
                    handleCloseCalendarPreview()
                  }}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="history-timeline__action-button"
                  onClick={() => {
                    // Skip: delete the planned entry.
                    try {
                      const handler = handleDeleteHistoryEntry(entry.id)
                      ;(handler as any)({ preventDefault: () => {}, stopPropagation: () => {} })
                    } catch {
                      updateHistory((current) => current.filter((e) => e.id !== entry.id))
                    }
                    handleCloseCalendarPreview()
                  }}
                >
                  Skip
                </button>
              </div>
            ) : null}
            {!isGuide && isUpcomingPlanned ? (
              <div className="calendar-popover__cta-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem' }}>
                <button
                  type="button"
                  className="history-timeline__action-button history-timeline__action-button--primary"
                  onClick={() => {
                    // Start now: launch as focus task and switch to the Focus page (App listens to focus events).
                    const taskLabel = deriveEntryTaskName(entry)
                    const broadcastSubtasks = (entry.subtasks || []).map((s) => ({
                      id: s.id,
                      text: s.text,
                      completed: s.completed,
                      sortIndex: (s as any).sortIndex ?? undefined,
                    }))
                    broadcastFocusTask({
                      goalId: entry.goalId ?? '',
                      goalName: entry.goalName ?? '',
                      bucketId: entry.bucketId ?? '',
                      bucketName: entry.bucketName ?? '',
                      taskId: entry.taskId ?? '',
                      taskName: taskLabel,
                      goalSurface: entry.goalSurface ?? undefined,
                      bucketSurface: entry.bucketSurface ?? undefined,
                      autoStart: true,
                      notes: entry.notes ?? '',
                      subtasks: broadcastSubtasks,
                    })
                    handleCloseCalendarPreview()
                  }}
                >
                  Start now
                </button>
              </div>
            ) : null}
        </div>
      </div>,
      document.body,
    )
  }, [
    calendarPreview,
    calendarPopoverEditing,
    effectiveHistory,
    handleCloseCalendarPreview,
    handleDeleteHistoryEntry,
    handleStartEditingHistoryEntry,
    subtasksCache,
    historyDraft.subtasks,
    selectedHistoryId,
    updateHistory,
    repeatingRules,
  ])

  // Calendar editor modal
  useEffect(() => {
    if (!calendarEditorEntryId) return
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = (e.target as HTMLElement | null) || (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null)
        const isEditingField =
          target?.closest('.goal-task-details__subtask-input') !== null ||
          target?.closest('.calendar-inspector__notes') !== null ||
          target?.closest('.history-timeline__field-input') !== null
        if (isEditingField) {
          return
        }
        e.preventDefault()
        // Cancel editing, reset draft
        handleCancelHistoryEdit()
        setCalendarEditorEntryId(null)
      }
    }
    document.addEventListener('keydown', onKeyDown as EventListener)
    return () => document.removeEventListener('keydown', onKeyDown as EventListener)
  }, [calendarEditorEntryId, handleCancelHistoryEdit])

  // When opening the calendar editor, if this is a freshly created (pending) entry,
  // focus the session name input and place the caret at the end.
  useEffect(() => {
    if (!calendarEditorEntryId) return
    if (!pendingNewHistoryId || pendingNewHistoryId !== calendarEditorEntryId) return
    const focusLater = () => {
      const input = calendarEditorNameInputRef.current
      if (input) {
        try {
          input.focus()
          const len = input.value?.length ?? 0
          input.setSelectionRange(len, len)
        } catch {}
      }
    }
    const raf = window.requestAnimationFrame(focusLater)
    return () => window.cancelAnimationFrame(raf)
  }, [calendarEditorEntryId, pendingNewHistoryId])

  const renderCalendarEditor = useCallback(() => {
    if (!calendarEditorEntryId || typeof document === 'undefined') return null
    const entry = history.find((h) => h.id === calendarEditorEntryId) || null
    if (!entry) return null
    // Resolve current values
    const startBase = entry.startedAt
    const endBase = entry.endedAt
    const resolvedStart = resolveTimestamp(historyDraft.startedAt, startBase)
    const resolvedEnd = resolveTimestamp(historyDraft.endedAt, endBase)
    const isDraftAllDay = isAllDayRangeTs(resolvedStart, resolvedEnd)
  // Using inspector pickers for date/time in the editor panel; input-formatted strings no longer needed here

    return createPortal(
      <div
        className="calendar-editor-backdrop"
        role="dialog"
        aria-label="Edit session"
        onClick={() => {
          handleCancelHistoryEdit()
          setCalendarEditorEntryId(null)
        }}
      >
        <div
          className="calendar-editor"
          ref={calendarEditorRef}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="calendar-editor__header">
            <h4 className="calendar-editor__title">Edit session</h4>
            <button
              type="button"
              className="calendar-popover__action"
              title="Close"
              onClick={() => {
                handleCancelHistoryEdit()
                setCalendarEditorEntryId(null)
              }}
            >
              ×
            </button>
          </div>
          <div className="calendar-editor__body">
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">Session name</span>
              <input
                className="history-timeline__field-input"
                type="text"
                ref={calendarEditorNameInputRef}
                value={historyDraft.taskName}
                placeholder="Describe the focus block"
                onChange={handleHistoryFieldChange('taskName')}
                onKeyDown={handleHistoryFieldKeyDown}
              />
            </label>
            {/* All-day toggle removed per request; preserve read-only all-day state via isDraftAllDay to hide time pickers */}
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">Start</span>
              <div className="calendar-inspector__schedule-inputs">
                <InspectorDateInput
                  value={resolvedStart}
                  onChange={(timestamp) => {
                    setHistoryDraft((draft) => ({ ...draft, startedAt: timestamp }))
                  }}
                  ariaLabel="Select start date"
                />
                {isDraftAllDay ? null : (
                  <InspectorTimeInput
                    value={resolvedStart}
                    onChange={(timestamp) => {
                      setHistoryDraft((draft) => ({ ...draft, startedAt: timestamp }))
                    }}
                    ariaLabel="Select start time"
                  />
                )}
              </div>
            </label>
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">End</span>
              <div className="calendar-inspector__schedule-inputs">
                <InspectorDateInput
                  value={resolvedEnd}
                  onChange={(timestamp) => {
                    setHistoryDraft((draft) => ({ ...draft, endedAt: timestamp }))
                  }}
                  ariaLabel="Select end date"
                />
                {isDraftAllDay ? null : (
                  <InspectorTimeInput
                    value={resolvedEnd}
                    onChange={(timestamp) => {
                      setHistoryDraft((draft) => ({ ...draft, endedAt: timestamp }))
                    }}
                    ariaLabel="Select end time"
                  />
                )}
              </div>
            </label>
                            <div className="history-timeline__field">
                              <label className="history-timeline__field-text" htmlFor={goalDropdownId} id={goalDropdownLabelId}>
                                Goal
                              </label>
                              <HistoryDropdown
                                id={goalDropdownId}
                                labelId={goalDropdownLabelId}
                                value={historyDraft.goalName}
                                placeholder="Select goal"
                                options={goalDropdownOptions}
                                onChange={(nextValue) => updateHistoryDraftField('goalName', nextValue)}
                              />
                            </div>
                            <div className="history-timeline__field">
                              <label className="history-timeline__field-text" htmlFor={bucketDropdownId} id={bucketDropdownLabelId}>
                                Bucket
                              </label>
                              <HistoryDropdown
                                id={bucketDropdownId}
                                labelId={bucketDropdownLabelId}
                                value={historyDraft.bucketName}
                                placeholder={availableBucketOptions.length ? 'Select bucket' : 'No buckets available'}
                                options={bucketDropdownOptions}
                                onChange={handleBucketDropdownChange}
                                disabled={availableBucketOptions.length === 0}
                              />
                            </div>
                            <div className="history-timeline__field">
                              <label className="history-timeline__field-text" htmlFor={taskDropdownId} id={taskDropdownLabelId}>
                                Task
                              </label>
                              <HistoryDropdown
                                id={taskDropdownId}
                                labelId={taskDropdownLabelId}
                                value={historyDraft.taskName}
                                placeholder={availableTaskOptions.length ? 'Select task' : 'No tasks available'}
                                options={taskDropdownOptions}
                                onChange={handleTaskDropdownChange}
                                disabled={taskDropdownOptions.length === 0}
                              />
                            </div>
            <div className="history-timeline__extras">
              <button
                type="button"
                className="history-timeline__extras-toggle"
                onClick={() => setShowEditorExtras((value) => !value)}
                aria-expanded={showEditorExtras}
                aria-controls="history-details-extras-editor"
              >
                {showEditorExtras ? 'Hide subtasks & notes' : 'Show subtasks & notes'}
              </button>
              <div
                id="history-details-extras-editor"
                className={`history-timeline__extras-panel${showEditorExtras ? ' is-open' : ''}`}
              >
                {renderHistorySubtasksEditor()}
                <label className="history-timeline__field">
                  <span className="history-timeline__field-text">Notes</span>
                      <textarea
                        className="calendar-inspector__notes"
                        value={historyDraft.notes}
                        placeholder="Capture context, outcomes, or follow-ups"
                        onChange={handleHistoryNotesChange}
                        onKeyDown={handleHistoryNotesKeyDown}
                      />
                </label>
              </div>
            </div>
          </div>
          <div className="calendar-editor__footer">
            <button
              type="button"
              className="history-timeline__action-button history-timeline__action-button--primary"
              onClick={() => {
                handleSaveHistoryDraft()
                setCalendarEditorEntryId(null)
              }}
            >
              Save changes
            </button>
            <button
              type="button"
              className="history-timeline__action-button"
              onClick={() => {
                handleCancelHistoryEdit()
                setCalendarEditorEntryId(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }, [
    calendarEditorEntryId,
    history,
    historyDraft.bucketName,
    historyDraft.goalName,
    historyDraft.taskName,
    historyDraft.notes,
    historyDraft.subtasks,
    availableBucketOptions.length,
    bucketDropdownId,
    bucketDropdownOptions,
    goalDropdownId,
    goalDropdownOptions,
    handleAddHistorySubtask,
    handleCancelHistoryEdit,
    handleHistoryFieldChange,
    handleHistoryFieldKeyDown,
    handleHistoryNotesChange,
    handleSaveHistoryDraft,
    handleToggleHistorySubtaskCompletion,
    handleUpdateHistorySubtaskText,
    revealedHistoryDeleteKey,
    setShowEditorExtras,
    showEditorExtras,
    sortedSubtasks,
    updateHistoryDraftField,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const area = calendarDaysAreaRef.current
    if (!area) {
      let lastWindowWidth = window.innerWidth
      let lastWindowHeight = window.innerHeight
      const handleWindowResize = () => {
        const nextWidth = window.innerWidth
        const nextHeight = window.innerHeight
        if (nextWidth === lastWindowWidth && nextHeight === lastWindowHeight) {
          return
        }
        lastWindowWidth = nextWidth
        lastWindowHeight = nextHeight
        setCalendarViewportVersion((value) => value + 1)
      }
      window.addEventListener('resize', handleWindowResize)
      handleWindowResize()
      return () => {
        window.removeEventListener('resize', handleWindowResize)
      }
    }
    let frame: number | null = null
    let lastWidth = area.clientWidth
    let lastHeight = area.clientHeight
    const scheduleMeasurement = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      frame = window.requestAnimationFrame(() => {
        frame = null
        const target = calendarDaysAreaRef.current
        if (!target) {
          return
        }
        const nextWidth = target.clientWidth
        const nextHeight = target.clientHeight
        if (nextWidth !== lastWidth || nextHeight !== lastHeight) {
          lastWidth = nextWidth
          lastHeight = nextHeight
          setCalendarViewportVersion((value) => value + 1)
        }
      })
    }
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleMeasurement()) : null
    if (resizeObserver) {
      resizeObserver.observe(area)
    } else {
      window.addEventListener('resize', scheduleMeasurement)
    }
    scheduleMeasurement()
    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect()
      } else {
        window.removeEventListener('resize', scheduleMeasurement)
      }
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [calendarView])

  // Keep the buffered track centered on the visible window (apply base translate)
  useLayoutEffect(() => {
    if (!(calendarView === 'day' || calendarView === '3d' || calendarView === 'week')) return
    const area = calendarDaysAreaRef.current
    const daysEl = calendarDaysRef.current
    const hdrEl = calendarHeadersRef.current
    const allDayEl = calendarAllDayRef.current
    if (!area || !daysEl || !hdrEl) return
    const visibleDayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
    const bufferDays = getCalendarBufferDays(visibleDayCount)
    const dayWidth = area.clientWidth / Math.max(1, visibleDayCount)
    if (!Number.isFinite(dayWidth) || dayWidth <= 0) {
      // Skip transform until measured via ResizeObserver
      return
    }
    const base = -bufferDays * dayWidth
    calendarBaseTranslateRef.current = base
    daysEl.style.transform = `translateX(${base}px)`
    hdrEl.style.transform = `translateX(${base}px)`
    if (allDayEl) allDayEl.style.transform = `translateX(${base}px)`
    // ready by default
  }, [anchorDate, calendarInspectorEntryId, calendarView, multiDayCount, calendarViewportVersion])

  useEffect(() => {
    return () => {
      stopCalendarPanAnimation({ commit: false })
    }
  }, [stopCalendarPanAnimation])

  const handleWindowPointerMove = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current
      if (!state || event.pointerId !== state.pointerId || state.rectWidth <= 0) {
        return
      }

      const deltaPx = event.clientX - state.startX
      const deltaMsRaw = (deltaPx / state.rectWidth) * DAY_DURATION_MS
      if (!Number.isFinite(deltaMsRaw)) {
        return
      }
      const deltaMinutes = Math.round(deltaMsRaw / MINUTE_MS)
      const deltaMs = deltaMinutes * MINUTE_MS

      let nextStart = state.initialStart
      let nextEnd = state.initialEnd

      if (state.type === 'move') {
        nextStart = state.initialStart + deltaMs
        nextEnd = state.initialEnd + deltaMs
      } else if (state.type === 'resize-start') {
        nextStart = Math.min(state.initialEnd - state.minDurationMs, state.initialStart + deltaMs)
        nextEnd = state.initialEnd
      } else {
        nextStart = state.initialStart
        nextEnd = Math.max(state.initialStart + state.minDurationMs, state.initialEnd + deltaMs)
      }

      if (nextEnd - nextStart < state.minDurationMs) {
        if (state.type === 'resize-start') {
          nextStart = nextEnd - state.minDurationMs
        } else {
          nextEnd = nextStart + state.minDurationMs
        }
      }

      const movedEnough = Math.abs(deltaPx) >= DRAG_DETECTION_THRESHOLD_PX
      if (movedEnough && !state.hasMoved) {
        state.hasMoved = true
        dragPreventClickRef.current = true
      }

      if (!state.hasMoved) {
        return
      }

      event.preventDefault()

      const nextStartRounded = Math.round(nextStart)
      const nextEndRounded = Math.round(nextEnd)
      const currentPreview = dragPreviewRef.current
      if (
        currentPreview &&
        currentPreview.entryId === state.entryId &&
        currentPreview.startedAt === nextStartRounded &&
        currentPreview.endedAt === nextEndRounded
      ) {
        return
      }

      const nextPreview = { entryId: state.entryId, startedAt: nextStartRounded, endedAt: nextEndRounded }
      dragPreviewRef.current = nextPreview
      setDragPreview(nextPreview)
      setHoveredDuringDragId(state.entryId)
    },
    [],
  )

  const handleWindowPointerUp = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current
      if (!state || event.pointerId !== state.pointerId) {
        return
      }

      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerUp)
      const bar = timelineBarRef.current
      if (bar?.hasPointerCapture?.(state.pointerId)) {
        bar.releasePointerCapture(state.pointerId)
      }

      const preview = dragPreviewRef.current
      if (state.hasMoved && preview) {
        if (state.entryId === 'new-entry') {
          const startedAt = Math.min(preview.startedAt, preview.endedAt)
          const endedAt = Math.max(preview.startedAt, preview.endedAt)
          const elapsed = Math.max(endedAt - startedAt, MIN_SESSION_DURATION_DRAG_MS)
          const newEntry: HistoryEntry = {
            id: makeHistoryId(),
            taskName: '',
            goalName: null,
            bucketName: null,
            goalId: null,
            bucketId: null,
            taskId: null,
            elapsed,
            startedAt,
            endedAt,
            goalSurface: DEFAULT_SURFACE_STYLE,
            bucketSurface: null,
            notes: '',
            subtasks: [],
          }
          updateHistory((current) => {
            const next = [...current, newEntry]
            next.sort((a, b) => a.startedAt - b.startedAt)
            return next
          })
          setPendingNewHistoryId(newEntry.id)
          setTimeout(() => {
            handleStartEditingHistoryEntry(newEntry)
          }, 0)
        } else {
          updateHistory((current) => {
            const index = current.findIndex((entry) => entry.id === preview.entryId)
            if (index === -1) {
              return current
            }
            const target = current[index]
            if (target.startedAt === preview.startedAt && target.endedAt === preview.endedAt) {
              return current
            }
            const next = [...current]
            next[index] = {
              ...target,
              startedAt: preview.startedAt,
              endedAt: preview.endedAt,
              elapsed: Math.max(preview.endedAt - preview.startedAt, 1),
            }
            return next
          })
          if (selectedHistoryIdRef.current === state.entryId) {
            setHistoryDraft((draft) => ({
              ...draft,
              startedAt: preview.startedAt,
              endedAt: preview.endedAt,
            }))
          }
        }
      }

      dragStateRef.current = null
      dragPreviewRef.current = null
      setDragPreview(null)
      dragPreventClickRef.current = state.hasMoved
      setHoveredDuringDragId(null)
    },
    [handleWindowPointerMove, setHistoryDraft, updateHistory],
  )

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerUp)
    },
    [handleWindowPointerMove, handleWindowPointerUp],
  )

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, segment: TimelineSegment, type: DragKind) => {
      if (segment.entry.id === 'active-session') {
        return
      }
      if (event.button !== 0) {
        return
      }
      if (dragStateRef.current) {
        return
      }
      const bar = timelineBarRef.current
      if (!bar) {
        return
      }
      try {
        event.preventDefault()
        bar.setPointerCapture?.(event.pointerId)
      } catch {}
      // Close any open calendar popover when starting a drag from timeline blocks
      handleCloseCalendarPreview()
      const rect = bar.getBoundingClientRect()
      if (!rect || rect.width <= 0) {
        return
      }
      dragStateRef.current = {
        entryId: segment.entry.id,
        type,
        pointerId: event.pointerId,
        rectWidth: rect.width,
        startX: event.clientX,
        initialStart: segment.entry.startedAt,
        initialEnd: segment.entry.endedAt,
        dayStart,
        dayEnd,
        minDurationMs: MIN_SESSION_DURATION_DRAG_MS,
        hasMoved: false,
      }
      dragPreventClickRef.current = false
      dragPreviewRef.current = null
      setDragPreview(null)
      setHoveredDuringDragId(segment.entry.id)
      event.stopPropagation()
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp)
      window.addEventListener('pointercancel', handleWindowPointerUp)
    },
    [dayStart, dayEnd, handleWindowPointerMove, handleWindowPointerUp],
  )

  // Start drag from native pointer event (used after mouse moves beyond threshold)
  const startDragFromPointer = useCallback(
    (nativeEvent: PointerEvent, segment: TimelineSegment, type: DragKind) => {
      if (segment.entry.id === 'active-session') {
        return
      }
      // Ensure primary button is pressed for mouse
      if (nativeEvent.pointerType === 'mouse' && (nativeEvent.buttons & 1) !== 1) {
        return
      }
      if (dragStateRef.current) {
        return
      }
      const bar = timelineBarRef.current
      if (!bar) {
        return
      }
      const rect = bar.getBoundingClientRect()
      if (!rect || rect.width <= 0) {
        return
      }
      try {
        nativeEvent.preventDefault()
        bar.setPointerCapture?.(nativeEvent.pointerId)
      } catch {}
      // Close any open calendar popover when starting a drag via native pointer (timeline)
      handleCloseCalendarPreview()
      dragStateRef.current = {
        entryId: segment.entry.id,
        type,
        pointerId: nativeEvent.pointerId,
        rectWidth: rect.width,
        startX: nativeEvent.clientX,
        initialStart: segment.entry.startedAt,
        initialEnd: segment.entry.endedAt,
        dayStart,
        dayEnd,
        minDurationMs: MIN_SESSION_DURATION_DRAG_MS,
        hasMoved: false,
      }
      dragPreventClickRef.current = false
      dragPreviewRef.current = null
      setDragPreview(null)
      setHoveredDuringDragId(segment.entry.id)
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp)
      window.addEventListener('pointercancel', handleWindowPointerUp)
    },
    [dayStart, dayEnd, handleWindowPointerMove, handleWindowPointerUp],
  )

  const startCreateDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, startTimestamp: number) => {
      if (event.button !== 0) {
        return
      }
      if (dragStateRef.current) {
        return
      }
      const bar = timelineBarRef.current
      if (!bar) {
        return
      }
      const rect = bar.getBoundingClientRect()
      if (!rect || rect.width <= 0) {
        return
      }
      dragStateRef.current = {
        entryId: 'new-entry',
        type: 'resize-end',
        pointerId: event.pointerId,
        rectWidth: rect.width,
        startX: event.clientX,
        initialStart: startTimestamp,
        initialEnd: startTimestamp + MIN_SESSION_DURATION_DRAG_MS,
        dayStart,
        dayEnd,
        minDurationMs: MIN_SESSION_DURATION_DRAG_MS,
        hasMoved: false,
      }
      dragPreviewRef.current = {
        entryId: 'new-entry',
        startedAt: startTimestamp,
        endedAt: startTimestamp + MIN_SESSION_DURATION_DRAG_MS,
      }
      setDragPreview(dragPreviewRef.current)
      dragPreventClickRef.current = false
      setHoveredDuringDragId('new-entry')
      event.currentTarget.setPointerCapture?.(event.pointerId)
      event.preventDefault()
      event.stopPropagation()
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp)
      window.addEventListener('pointercancel', handleWindowPointerUp)
    },
    [dayStart, dayEnd, handleWindowPointerMove, handleWindowPointerUp],
  )

  const inspectorEntry =
    calendarInspectorEntryId ? history.find((entry) => entry.id === calendarInspectorEntryId) ?? null : null

  let calendarInspectorPanel: ReactElement | null = null
  if (calendarInspectorEntryId !== null) {
    if (inspectorEntry) {
      const startBase = inspectorEntry.startedAt
      const endBase = inspectorEntry.endedAt
      const resolvedStart = resolveTimestamp(historyDraft.startedAt, startBase)
      const resolvedEnd = resolveTimestamp(historyDraft.endedAt, endBase)
      const inspectorDateLabel = (() => {
        const startD = new Date(resolvedStart)
        const endD = new Date(resolvedEnd)
        const sameDay =
          startD.getFullYear() === endD.getFullYear() &&
          startD.getMonth() === endD.getMonth() &&
          startD.getDate() === endD.getDate()
        if (sameDay) {
          const dateFmt = startD.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
          return `${dateFmt} · ${formatTimeOfDay(resolvedStart)} — ${formatTimeOfDay(resolvedEnd)}`
        }
        return formatDateRange(resolvedStart, resolvedEnd)
      })()
      const inspectorDurationLabel = formatDuration(Math.max(resolvedEnd - resolvedStart, 0))

      const inspectorRepeatControl = (() => {
        const start = new Date(inspectorEntry.startedAt)
        const minutes = start.getHours() * 60 + start.getMinutes()
        const durMin = Math.max(1, Math.round((inspectorEntry.endedAt - inspectorEntry.startedAt) / 60000))
        const dow = start.getDay()
        const dayStartMs = (() => { const d = new Date(inspectorEntry.startedAt); d.setHours(0,0,0,0); return d.getTime() })()
        const matches = (r: RepeatingSessionRule) =>
          r.isActive &&
          r.timeOfDayMinutes === minutes &&
          r.durationMinutes === durMin &&
          (r.taskName?.trim() || '') === (inspectorEntry.taskName?.trim() || '') &&
          (r.goalName?.trim() || null) === (inspectorEntry.goalName?.trim() || null) &&
          (r.bucketName?.trim() || null) === (inspectorEntry.bucketName?.trim() || null)
        const hasDaily = repeatingRules.some((r) => matches(r) && r.frequency === 'daily')
        const hasCustom = repeatingRules.some(
          (r) => matches(r) && r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.length > 1,
        )
        const hasWeekly = repeatingRules.some(
          (r) => matches(r) && r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(dow),
        )
        const hasMonthly = repeatingRules.some((r) => matches(r) && r.frequency === 'monthly' && matchesMonthlyDay(r, dayStartMs))
        const monthDay = monthDayKey(inspectorEntry.startedAt)
        const hasAnnual = repeatingRules.some((r) => matches(r) && r.frequency === 'annually' && ruleMonthDayKey(r) === monthDay)
        const currentVal: 'none' | 'daily' | 'weekly' | 'monthly' | 'annually' | 'custom' =
          hasCustom
            ? 'custom'
            : hasDaily
              ? 'daily'
              : hasWeekly
                ? 'weekly'
                : hasMonthly
                  ? 'monthly'
                  : hasAnnual
                    ? 'annually'
                    : 'none'
        return (
          <div className="calendar-inspector__repeat" aria-label="Repeat schedule">
            <span className="calendar-inspector__repeat-label" aria-hidden>
              <span className="calendar-inspector__repeat-icon calendar-inspector__repeat-icon--loop">⟳</span>
              <span className="calendar-inspector__repeat-text">Repeat</span>
              <span className="calendar-inspector__repeat-icon calendar-inspector__repeat-icon--caret">▸</span>
            </span>
            <HistoryDropdown
              id={`repeat-inspector-${inspectorEntry.id}`}
              value={currentVal}
              placeholder="None"
              options={[
                { value: 'none', label: 'None' },
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
                { value: 'annually', label: 'Annually' },
                { value: 'custom', label: 'Custom...' },
              ]}
              onChange={async (v) => {
                const val = v as 'none' | 'daily' | 'weekly' | 'monthly' | 'annually' | 'custom'
                if (val === 'custom') {
                  openCustomRecurrence(inspectorEntry)
                  return
                }
                if (val === 'none') {
                  const ids = await deactivateMatchingRulesForEntry(inspectorEntry)
                  if (Array.isArray(ids) && ids.length > 0) {
                    setRepeatingRules((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, isActive: false } : r)))
                  } else {
                    setRepeatingRules((prev) =>
                      prev.map((r) => {
                        const labelMatch =
                          (r.taskName?.trim() || '') === (inspectorEntry.taskName?.trim() || '') &&
                          (r.goalName?.trim() || null) === (inspectorEntry.goalName?.trim() || null) &&
                          (r.bucketName?.trim() || null) === (inspectorEntry.bucketName?.trim() || null)
                        const timeMatch = r.timeOfDayMinutes === minutes && r.durationMinutes === durMin
                        const freqMatch =
                          r.frequency === 'daily' ||
                          (r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(dow)) ||
                          (r.frequency === 'monthly' && matchesMonthlyDay(r, dayStartMs)) ||
                          (r.frequency === 'annually' && ruleMonthDayKey(r) === monthDay)
                        return labelMatch && timeMatch && freqMatch ? { ...r, isActive: false } : r
                      }),
                    )
                  }
                  return
                }
                const created = await createRepeatingRuleForEntry(inspectorEntry, val)
                if (created) {
                  setRepeatingRules((prev) => [...prev, created])
                  const scheduledStart = computeEntryScheduledStart(inspectorEntry)
                  updateHistory((current) =>
                    current.map((h) => (h.id === inspectorEntry.id ? { ...h, repeatingSessionId: created.id, originalTime: scheduledStart } : h)),
                  )
                }
              }}
            />
          </div>
        )
      })()

      if (ENABLE_HISTORY_INSPECTOR_PANEL) {
        calendarInspectorPanel = (
          <aside className="calendar-inspector" aria-label="Session inspector">
            <div className="calendar-inspector__inner" ref={calendarInspectorRef}>
              <div className="calendar-inspector__header">
                <div className="calendar-inspector__heading">
                  <h3 className="calendar-inspector__title">
                    {deriveEntryTaskName(inspectorEntry) || 'Untitled session'}
                  </h3>
                <p className="calendar-inspector__subtitle">
                  {inspectorDateLabel}
                  {' '}
                  <span className="duration-badge" aria-label="Elapsed time">{inspectorDurationLabel}</span>
                </p>
                </div>
                <button
                  type="button"
                  className="calendar-inspector__close"
                  aria-label="Close inspector"
                  onClick={handleCancelHistoryEdit}
                >
                  ×
                </button>
              </div>
              <div className="calendar-inspector__content">
                <div className="calendar-inspector__body">
                  <label className="history-timeline__field">
                    <span className="history-timeline__field-text">Session name</span>
                    <input
                      className="history-timeline__field-input"
                      type="text"
                      value={historyDraft.taskName}
                      placeholder="Describe the focus block"
                      onChange={handleHistoryFieldChange('taskName')}
                      onKeyDown={handleHistoryFieldKeyDown}
                    />
                  </label>
                  <div className="calendar-inspector__schedule">
                    <div className="calendar-inspector__schedule-row">
                      <label className="calendar-inspector__schedule-group">
                        <span className="calendar-inspector__schedule-heading">Start</span>
                        <div className="calendar-inspector__schedule-inputs">
                          <InspectorDateInput
                            value={resolvedStart}
                            onChange={(timestamp) => {
                              setHistoryDraft((draft) => ({ ...draft, startedAt: timestamp }))
                            }}
                            ariaLabel="Select start date"
                          />
                          <InspectorTimeInput
                            value={resolvedStart}
                            onChange={(timestamp) => {
                              setHistoryDraft((draft) => ({ ...draft, startedAt: timestamp }))
                            }}
                            ariaLabel="Select start time"
                          />
                        </div>
                      </label>
                      <label className="calendar-inspector__schedule-group">
                        <span className="calendar-inspector__schedule-heading">End</span>
                        <div className="calendar-inspector__schedule-inputs">
                          <InspectorDateInput
                            value={resolvedEnd}
                            onChange={(timestamp) => {
                              setHistoryDraft((draft) => ({ ...draft, endedAt: timestamp }))
                            }}
                            ariaLabel="Select end date"
                          />
                          <InspectorTimeInput
                            value={resolvedEnd}
                            onChange={(timestamp) => {
                              setHistoryDraft((draft) => ({ ...draft, endedAt: timestamp }))
                            }}
                            ariaLabel="Select end time"
                          />
                        </div>
                      </label>
                    </div>
                  </div>
                  {inspectorRepeatControl}
                  <div className="history-timeline__field">
                    <label className="history-timeline__field-text" htmlFor={goalDropdownId} id={goalDropdownLabelId}>
                      Goal
                    </label>
                    <HistoryDropdown
                      id={goalDropdownId}
                      labelId={goalDropdownLabelId}
                      value={historyDraft.goalName}
                      placeholder="Select goal"
                      options={goalDropdownOptions}
                      onChange={(nextValue) => updateHistoryDraftField('goalName', nextValue)}
                    />
                  </div>
                  <div className="history-timeline__field">
                    <label className="history-timeline__field-text" htmlFor={bucketDropdownId} id={bucketDropdownLabelId}>
                      Bucket
                    </label>
                    <HistoryDropdown
                      id={bucketDropdownId}
                      labelId={bucketDropdownLabelId}
                      value={historyDraft.bucketName}
                      placeholder={availableBucketOptions.length ? 'Select bucket' : 'No buckets available'}
                      options={bucketDropdownOptions}
                      onChange={handleBucketDropdownChange}
                      disabled={availableBucketOptions.length === 0}
                    />
                  </div>
                  <div className="history-timeline__field">
                    <label className="history-timeline__field-text" htmlFor={taskDropdownId} id={taskDropdownLabelId}>
                      Task
                    </label>
                    <HistoryDropdown
                      id={taskDropdownId}
                      labelId={taskDropdownLabelId}
                      value={historyDraft.taskName}
                      placeholder={availableTaskOptions.length ? 'Select task' : 'No tasks available'}
                      options={taskDropdownOptions}
                      onChange={handleTaskDropdownChange}
                      disabled={taskDropdownOptions.length === 0}
                    />
                  </div>
                  <div className="history-timeline__extras">
                    <button
                      type="button"
                      className="history-timeline__extras-toggle"
                      onClick={() => setShowInspectorExtras((value) => !value)}
                      aria-expanded={showInspectorExtras}
                      aria-controls="history-details-extras-inspector"
                    >
                      {showInspectorExtras ? 'Hide subtasks & notes' : 'Show subtasks & notes'}
                    </button>
                    <div
                      id="history-details-extras-inspector"
                      className={`history-timeline__extras-panel${showInspectorExtras ? ' is-open' : ''}`}
                    >
                      {renderHistorySubtasksEditor()}
                      <label className="history-timeline__field">
                        <span className="history-timeline__field-text">Notes</span>
                          <textarea
                            className="calendar-inspector__notes"
                            value={historyDraft.notes}
                            placeholder="Capture context, outcomes, or follow-ups"
                            onChange={handleHistoryNotesChange}
                            onKeyDown={handleHistoryNotesKeyDown}
                          />
                      </label>
                    </div>
                  </div>
                </div>
                <div className="calendar-inspector__footer">
                  <button
                    type="button"
                    className="history-timeline__action-button calendar-inspector__delete-button"
                    onClick={handleDeleteHistoryEntry(inspectorEntry.id)}
                  >
                    Delete session
                  </button>
                </div>
              </div>
            </div>
          </aside>
        )
      } else {
        calendarInspectorPanel = (
          <aside className="legacy-editor-panel" ref={calendarInspectorRef} aria-label="Session details">
            <div className="legacy-editor-panel__header">
              <div className="legacy-editor-panel__heading">
                <h3 className="legacy-editor-panel__title">{deriveEntryTaskName(inspectorEntry) || 'Untitled session'}</h3>
                <p className="legacy-editor-panel__subtitle">
                  {inspectorDateLabel}
                  {' '}
                  <span className="duration-badge" aria-label="Elapsed time">{inspectorDurationLabel}</span>
                </p>
              </div>
              <button
                type="button"
                className="legacy-editor-panel__close"
                aria-label="Close inspector"
                onClick={handleCancelHistoryEdit}
              >
                ×
              </button>
            </div>
            <div className="legacy-editor-panel__body">
              <label className="history-timeline__field">
                <span className="history-timeline__field-text">Session name</span>
                <input
                  className="history-timeline__field-input"
                  type="text"
                  value={historyDraft.taskName}
                  placeholder="Describe the focus block"
                  onChange={handleHistoryFieldChange('taskName')}
                  onKeyDown={handleHistoryFieldKeyDown}
                />
              </label>
              <div className="calendar-inspector__schedule legacy-editor-panel__schedule">
                <div className="calendar-inspector__schedule-row">
                  <label className="calendar-inspector__schedule-group">
                    <span className="calendar-inspector__schedule-heading">Start</span>
                    <div className="calendar-inspector__schedule-inputs">
                      <InspectorDateInput
                        value={resolvedStart}
                        onChange={(timestamp) => {
                          setHistoryDraft((draft) => ({ ...draft, startedAt: timestamp }))
                        }}
                        ariaLabel="Select start date"
                      />
                      <InspectorTimeInput
                        value={resolvedStart}
                        onChange={(timestamp) => {
                          setHistoryDraft((draft) => ({ ...draft, startedAt: timestamp }))
                        }}
                        ariaLabel="Select start time"
                      />
                    </div>
                  </label>
                  <label className="calendar-inspector__schedule-group">
                    <span className="calendar-inspector__schedule-heading">End</span>
                    <div className="calendar-inspector__schedule-inputs">
                      <InspectorDateInput
                        value={resolvedEnd}
                        onChange={(timestamp) => {
                          setHistoryDraft((draft) => ({ ...draft, endedAt: timestamp }))
                        }}
                        ariaLabel="Select end date"
                      />
                      <InspectorTimeInput
                        value={resolvedEnd}
                        onChange={(timestamp) => {
                          setHistoryDraft((draft) => ({ ...draft, endedAt: timestamp }))
                        }}
                        ariaLabel="Select end time"
                      />
                    </div>
                  </label>
                </div>
              </div>
              {inspectorRepeatControl}
              <div className="legacy-editor-panel__row">
                <div className="history-timeline__field legacy-editor-panel__field">
                  <label className="history-timeline__field-text" htmlFor={goalDropdownId} id={goalDropdownLabelId}>
                    Goal
                  </label>
                  <HistoryDropdown
                    id={goalDropdownId}
                    labelId={goalDropdownLabelId}
                    value={historyDraft.goalName}
                    placeholder="Select goal"
                    options={goalDropdownOptions}
                    onChange={(nextValue) => updateHistoryDraftField('goalName', nextValue)}
                  />
                </div>
                <div className="history-timeline__field legacy-editor-panel__field">
                  <label className="history-timeline__field-text" htmlFor={bucketDropdownId} id={bucketDropdownLabelId}>
                    Bucket
                  </label>
                  <HistoryDropdown
                    id={bucketDropdownId}
                    labelId={bucketDropdownLabelId}
                    value={historyDraft.bucketName}
                    placeholder={availableBucketOptions.length ? 'Select bucket' : 'No buckets available'}
                    options={bucketDropdownOptions}
                    onChange={handleBucketDropdownChange}
                    disabled={availableBucketOptions.length === 0}
                  />
                </div>
              </div>
              <div className="history-timeline__field">
                <label className="history-timeline__field-text" htmlFor={taskDropdownId} id={taskDropdownLabelId}>
                  Task
                </label>
                <HistoryDropdown
                  id={taskDropdownId}
                  labelId={taskDropdownLabelId}
                  value={historyDraft.taskName}
                  placeholder={availableTaskOptions.length ? 'Select task' : 'No tasks available'}
                  options={taskDropdownOptions}
                  onChange={handleTaskDropdownChange}
                  disabled={taskDropdownOptions.length === 0}
                />
              </div>
              <div className="history-timeline__extras">
                <button
                  type="button"
                  className="history-timeline__extras-toggle"
                  onClick={() => setShowInspectorExtras((value) => !value)}
                  aria-expanded={showInspectorExtras}
                  aria-controls="history-details-extras-legacy"
                >
                  {showInspectorExtras ? 'Hide subtasks & notes' : 'Show subtasks & notes'}
                </button>
                <div
                  id="history-details-extras-legacy"
                  className={`history-timeline__extras-panel${showInspectorExtras ? ' is-open' : ''}`}
                >
                  {renderHistorySubtasksEditor()}
                  <label className="history-timeline__field">
                    <span className="history-timeline__field-text">Notes</span>
                          <textarea
                            className="calendar-inspector__notes"
                            value={historyDraft.notes}
                            placeholder="Capture context, outcomes, or follow-ups"
                            onChange={handleHistoryNotesChange}
                            onKeyDown={handleHistoryNotesKeyDown}
                          />
                  </label>
                </div>
              </div>
            </div>
          </aside>
        )
      }
    } else if (inspectorFallbackMessage) {
      if (ENABLE_HISTORY_INSPECTOR_PANEL) {
        calendarInspectorPanel = (
          <aside className="calendar-inspector" aria-label="Session inspector">
            <div className="calendar-inspector__inner" ref={calendarInspectorRef}>
              <div className="calendar-inspector__header">
                <div className="calendar-inspector__heading">
                  <h3 className="calendar-inspector__title">Session details</h3>
                  <p className="calendar-inspector__subtitle">No session selected</p>
                </div>
                <button
                  type="button"
                  className="calendar-inspector__close"
                  aria-label="Close inspector"
                  onClick={handleCancelHistoryEdit}
                >
                  ×
                </button>
              </div>
              <div className="calendar-inspector__content">
                <div className="calendar-inspector__empty" role="status" aria-live="polite">
                  <p>{inspectorFallbackMessage}</p>
                </div>
              </div>
            </div>
          </aside>
        )
      } else {
        calendarInspectorPanel = (
          <aside className="legacy-editor-panel" ref={calendarInspectorRef} aria-label="Session details">
            <div className="legacy-editor-panel__header">
              <div className="legacy-editor-panel__heading">
                <h3 className="legacy-editor-panel__title">Session details</h3>
              </div>
              <button
                type="button"
                className="legacy-editor-panel__close"
                aria-label="Close inspector"
                onClick={handleCancelHistoryEdit}
              >
                ×
              </button>
            </div>
            <div className="legacy-editor-panel__body legacy-editor-panel__empty" role="status" aria-live="polite">
              <p>{inspectorFallbackMessage}</p>
            </div>
          </aside>
        )
      }
    }
  }

  const customRecurrenceModal =
    customRecurrenceOpen && typeof document !== 'undefined'
      ? createPortal(
        (() => {
          const draft = customRecurrenceDraft
          const baseDate = Number.isFinite(customRecurrenceBaseMs as number) ? new Date(customRecurrenceBaseMs as number) : new Date()
          // UI uses 1–7 semantics (Sunday=1 ... Saturday=7); normalize to JS 0–6 internally.
          const weekdayFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
          // Display and store using JS encoding: 0=Sunday .. 6=Saturday
          const WEEKDAY_META = [
            { jsValue: 0, label: 'S', full: weekdayFull[0] },
            { jsValue: 1, label: 'M', full: weekdayFull[1] },
            { jsValue: 2, label: 'T', full: weekdayFull[2] },
            { jsValue: 3, label: 'W', full: weekdayFull[3] },
            { jsValue: 4, label: 'T', full: weekdayFull[4] },
            { jsValue: 5, label: 'F', full: weekdayFull[5] },
            { jsValue: 6, label: 'S', full: weekdayFull[6] },
          ]
          const clampInterval = (value: number) => Math.max(1, Math.min(365, Math.round(value)))
          const clampOccurrences = (value: number) => Math.max(1, Math.min(999, Math.round(value)))
          const incrementInterval = (delta: number) => {
            setCustomRecurrenceDraft((prev) => ({ ...prev, interval: clampInterval((prev.interval || 1) + delta) }))
          }
          const incrementOccurrences = (delta: number) => {
            setCustomRecurrenceDraft((prev) => ({ ...prev, occurrences: clampOccurrences((prev.occurrences || 1) + delta) }))
          }
          const toggleWeeklyDay = (dayValue: number) => {
            setCustomRecurrenceDraft((prev) => {
              const next = new Set(prev.weeklyDays)
              if (next.has(dayValue)) next.delete(dayValue)
              else next.add(dayValue)
              return { ...prev, weeklyDays: next }
            })
          }
          const handleUnitChange = (unit: CustomRecurrenceUnit) => {
            setCustomRecurrenceDraft((prev) => ({
              ...prev,
              unit,
              weeklyDays: unit === 'week' ? new Set(prev.weeklyDays.size > 0 ? prev.weeklyDays : [baseDate.getDay()]) : prev.weeklyDays,
              monthlyDay: unit === 'month' ? (prev.monthlyDay || baseDate.getDate()) : prev.monthlyDay,
            }))
          }
          const handleEndChange = (ends: CustomRecurrenceEnds) => {
            setCustomRecurrenceDraft((prev) => ({ ...prev, ends }))
          }
          const handleModalClick = (e: MouseEvent) => {
            e.stopPropagation()
          }
          const isFirstWeekdayOfMonth = (date: Date): boolean => {
            const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1)
            const offset = (date.getDay() - firstOfMonth.getDay() + 7) % 7
            const firstOccurrence = 1 + offset
            return date.getDate() === firstOccurrence
          }
          const isLastWeekdayOfMonth = (date: Date): boolean => {
            const lastOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0)
            const offset = (lastOfMonth.getDay() - date.getDay() + 7) % 7
            const lastOccurrence = lastOfMonth.getDate() - offset
            return date.getDate() === lastOccurrence
          }
          const monthlyOptions = (() => {
            const opts: Array<{ value: CustomRecurrenceDraft['monthlyPattern']; label: string }> = [
              { value: 'day', label: `Monthly on day ${draft.monthlyDay}` },
            ]
            const weekdayLabel = weekdayFull[baseDate.getDay()]
            const qualifiesFirst = isFirstWeekdayOfMonth(baseDate)
            const qualifiesLast = isLastWeekdayOfMonth(baseDate)
            if (qualifiesFirst) {
              opts.push({ value: 'first', label: `Monthly on the first ${weekdayLabel}` })
            } else if (qualifiesLast) {
              opts.push({ value: 'last', label: `Monthly on the last ${weekdayLabel}` })
            }
            return opts
          })()
          const resolvedMonthlyPattern =
            monthlyOptions.some((opt) => opt.value === draft.monthlyPattern) ? draft.monthlyPattern : monthlyOptions[0].value
          const selectedMonthlyLabel =
            monthlyOptions.find((opt) => opt.value === resolvedMonthlyPattern)?.label ?? monthlyOptions[0].label
          const endDateValueMs = (() => {
            const parsed = parseLocalDateInput(draft.endDate)
            if (Number.isFinite(parsed as number)) return parsed as number
            const fallback = new Date(baseDate)
            fallback.setHours(0, 0, 0, 0)
            return fallback.getTime()
          })()
          const handleCustomSave = async () => {
            if (!customRecurrenceEntry) {
              closeCustomRecurrence()
              return
            }
    const DAY_MS = 24 * 60 * 60 * 1000
    const createOptions: {
      weeklyDays?: number[]
      monthlyPattern?: 'day' | 'first' | 'last'
      endDateMs?: number
      endAfterOccurrences?: number
      repeatEvery?: number
    } = {}
    createOptions.repeatEvery = draft.interval
    if (draft.ends === 'on') {
      const endMs = parseLocalDateInput(draft.endDate)
      if (Number.isFinite(endMs as number)) {
        createOptions.endDateMs = (endMs as number) + DAY_MS
      }
    } else if (draft.ends === 'after') {
      createOptions.endAfterOccurrences = draft.occurrences
            }
            let frequency: 'daily' | 'weekly' | 'monthly' | 'annually' = 'daily'
            if (draft.unit === 'week') {
              frequency = 'weekly'
              createOptions.weeklyDays = Array.from(draft.weeklyDays)
            } else if (draft.unit === 'month') {
              frequency = 'monthly'
              if (resolvedMonthlyPattern === 'first' || resolvedMonthlyPattern === 'last') {
                createOptions.monthlyPattern = resolvedMonthlyPattern
              } else {
                createOptions.monthlyPattern = 'day'
              }
            } else if (draft.unit === 'year') {
              frequency = 'annually'
            } else {
              frequency = 'daily'
            }
            const created = await createRepeatingRuleForEntry(customRecurrenceEntry, frequency, createOptions)
            if (created) {
              setRepeatingRules((prev) => {
                const next = [...prev, created]
                storeRepeatingRulesLocal(next)
                return next
              })
              const scheduledStart = computeEntryScheduledStart(customRecurrenceEntry)
              updateHistory((current) =>
                current.map((h) => (h.id === customRecurrenceEntry.id ? { ...h, repeatingSessionId: created.id, originalTime: scheduledStart } : h)),
              )
            }
            closeCustomRecurrence()
          }
          return (
            <div className="custom-recur__backdrop" role="presentation" onClick={closeCustomRecurrence}>
              <div className="custom-recur" role="dialog" aria-modal="true" aria-label="Custom recurrence" onClick={handleModalClick}>
                <header className="custom-recur__header">
                  <h3 className="custom-recur__title">Custom recurrence</h3>
                </header>
                <div className="custom-recur__body">
                  <div className="custom-recur__row">
                    <span className="custom-recur__label">Repeat every</span>
                    <div className="custom-recur__controls">
                      <div className="custom-recur__stepper">
                        <input
                          type="number"
                          min={1}
                          className="custom-recur__number"
                          value={draft.interval}
                          aria-label="Repeat interval"
                          onChange={(e) => {
                            const next = clampInterval(Number(e.target.value) || 1)
                            setCustomRecurrenceDraft((prev) => ({ ...prev, interval: next }))
                          }}
                        />
                        <div className="custom-recur__stepper-arrows" aria-hidden="true">
                          <button type="button" onClick={() => incrementInterval(1)}>▲</button>
                          <button type="button" onClick={() => incrementInterval(-1)}>▼</button>
                        </div>
                      </div>
                      <div className="custom-recur__select-wrap" data-open={customUnitMenuOpen} ref={customUnitMenuRef}>
                        <button
                          type="button"
                          className={`custom-recur__select${customUnitMenuOpen ? ' is-open' : ''}`}
                          aria-label="Repeat unit"
                          aria-haspopup="listbox"
                          aria-expanded={customUnitMenuOpen}
                          onClick={() => setCustomUnitMenuOpen((prev) => !prev)}
                        >
                          <span className="custom-recur__select-label">{draft.unit}</span>
                          <span className="custom-recur__chevron" aria-hidden="true">▾</span>
                        </button>
                        {customUnitMenuOpen ? (
                          <div className="custom-recur__menu" role="listbox" aria-label="Repeat unit options">
                            {(['day', 'week', 'month', 'year'] as CustomRecurrenceUnit[]).map((opt) => (
                              <button
                                key={opt}
                                type="button"
                                role="option"
                                aria-selected={draft.unit === opt}
                                className={`custom-recur__option${draft.unit === opt ? ' is-selected' : ''}`}
                                onClick={() => {
                                  handleUnitChange(opt)
                                  setCustomUnitMenuOpen(false)
                                }}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                    {draft.unit === 'week' ? (
                    <div className="custom-recur__row">
                      <span className="custom-recur__label">Repeat on</span>
                      <div className="custom-recur__weekdays" role="group" aria-label="Repeat on days of week">
                        {WEEKDAY_META.map((day) => {
                          const active = draft.weeklyDays.has(day.jsValue)
                          return (
                            <button
                              key={day.jsValue}
                              type="button"
                              className={`custom-recur__weekday${active ? ' custom-recur__weekday--active' : ''}`}
                              title={day.full}
                              aria-label={day.full}
                              onClick={() => toggleWeeklyDay(day.jsValue)}
                              aria-pressed={active}
                            >
                              {day.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                  {draft.unit === 'month' ? (
                    <div className="custom-recur__row custom-recur__row--full">
                      <div className="custom-recur__select-wrap custom-recur__select-wrap--menu" data-open={customMonthlyMenuOpen} ref={customMonthlyMenuRef}>
                        <button
                          type="button"
                          className={`custom-recur__select${customMonthlyMenuOpen ? ' is-open' : ''}`}
                          aria-label="Monthly pattern"
                          aria-haspopup="listbox"
                          aria-expanded={customMonthlyMenuOpen}
                          onClick={() => setCustomMonthlyMenuOpen((prev) => !prev)}
                        >
                          <span className="custom-recur__select-label">
                            {selectedMonthlyLabel}
                          </span>
                          <span className="custom-recur__chevron" aria-hidden="true">▾</span>
                        </button>
                        {customMonthlyMenuOpen ? (
                          <div className="custom-recur__menu" role="listbox" aria-label="Monthly pattern options">
                            {monthlyOptions.map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                role="option"
                                aria-selected={resolvedMonthlyPattern === opt.value}
                                className={`custom-recur__option${resolvedMonthlyPattern === opt.value ? ' is-selected' : ''}`}
                                onClick={() => {
                                  setCustomRecurrenceDraft((prev) => ({ ...prev, monthlyPattern: opt.value }))
                                  setCustomMonthlyMenuOpen(false)
                                }}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <div className="custom-recur__row custom-recur__ends">
                    <span className="custom-recur__label">Ends</span>
                    <div className="custom-recur__ends-options" role="radiogroup" aria-label="Recurrence end">
                      <label className="custom-recur__radio">
                        <input
                          type="radio"
                          name="custom-recur-end"
                          checked={draft.ends === 'never'}
                          onChange={() => handleEndChange('never')}
                        />
                        <span>Never</span>
                      </label>
                      <label className="custom-recur__radio">
                        <input
                          type="radio"
                          name="custom-recur-end"
                          checked={draft.ends === 'on'}
                          onChange={() => handleEndChange('on')}
                        />
                        <span>On</span>
                        <div className="custom-recur__date-picker">
                          <InspectorDateInput
                            value={endDateValueMs}
                            onChange={(nextTs) => {
                              setCustomRecurrenceDraft((prev) => ({ ...prev, endDate: formatLocalDateYmd(nextTs) }))
                              if (draft.ends !== 'on') {
                                handleEndChange('on')
                              }
                            }}
                            ariaLabel="Recurrence end date"
                          />
                        </div>
                      </label>
                      <label className="custom-recur__radio">
                        <input
                          type="radio"
                          name="custom-recur-end"
                          checked={draft.ends === 'after'}
                          onChange={() => handleEndChange('after')}
                        />
                        <span>After</span>
                        <div className="custom-recur__occurrence-wrap">
                          <div className="custom-recur__stepper custom-recur__stepper--compact">
                            <input
                              type="number"
                              min={1}
                              className="custom-recur__number"
                          value={draft.occurrences}
                          disabled={draft.ends !== 'after'}
                          onChange={(e) => {
                                const next = clampOccurrences(Number(e.target.value) || 1)
                                setCustomRecurrenceDraft((prev) => ({ ...prev, occurrences: next }))
                              }}
                            />
                            <div className="custom-recur__stepper-arrows" aria-hidden="true">
                              <button type="button" disabled={draft.ends !== 'after'} onClick={() => incrementOccurrences(1)}>▲</button>
                              <button type="button" disabled={draft.ends !== 'after'} onClick={() => incrementOccurrences(-1)}>▼</button>
                            </div>
                          </div>
                          <span className="custom-recur__occurrences-label">occurrences</span>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
                <footer className="custom-recur__footer">
                  <button type="button" className="custom-recur__ghost" onClick={closeCustomRecurrence}>Cancel</button>
                  <button type="button" className="custom-recur__primary" onClick={handleCustomSave}>Done</button>
                </footer>
              </div>
            </div>
          )
        })(),
        document.body,
      )
      : null

  return (
    <>
      <section className="site-main__inner reflection-page" aria-label="Reflection">
      <div className="reflection-intro">
        <h1 className="reflection-title">Reflection</h1>
        {/* Subtitle removed for cleaner header */}
      </div>

      <div className="history-block" ref={historyBlockRef}>
        <div className="history-section__heading">
          <h2 className="reflection-section__title">Session History Calendar</h2>
          {/* History section description removed */}
        </div>
        <div className="history-layout">
          <div className="history-layout__primary">
            <div className="calendar-toolbar">
              <div className="calendar-toolbar__left">
                <button
                  type="button"
                  className="calendar-nav-button"
                  onClick={handlePrevWindow}
                  aria-label="Previous"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="calendar-nav-button"
                  onClick={handleNextWindow}
                  aria-label="Next"
                >
                  ›
                </button>
                <h2 className="calendar-title" aria-live="polite">{monthAndYearLabel}</h2>
              </div>
              <div className="calendar-toolbar__right">
                <button
                  type="button"
                  className="calendar-today-button"
                  onClick={handleJumpToToday}
                  aria-label="Jump to today"
                >
                  <span className="calendar-toggle__label calendar-toggle__label--full">Today</span>
                  <span className="calendar-toggle__label calendar-toggle__label--short" aria-hidden>T</span>
                </button>
                <div className="calendar-toggle-group" role="tablist" aria-label="Calendar views">
                  {(() => {
                    const nDays = Math.max(2, Math.min(multiDayCount, 14))
                    const options: Array<{
                      key: CalendarViewMode
                      full: string
                      short: string
                    }> = [
                      { key: 'day', full: 'Day', short: 'D' },
                      { key: '3d', full: `${nDays} days`, short: `${nDays}D` },
                      { key: 'week', full: 'Week', short: 'W' },
                      { key: 'month', full: 'Month', short: 'M' },
                      { key: 'year', full: 'Year', short: 'Y' },
                    ]
                    return options.map((opt) => {
                      const button = (
                        <button
                          key={opt.key}
                          type="button"
                          role="tab"
                          aria-selected={calendarView === opt.key}
                          aria-label={opt.full}
                          className={`calendar-toggle${calendarView === opt.key ? ' calendar-toggle--active' : ''}`}
                          onClick={() => setView(opt.key)}
                          onDoubleClick={opt.key === '3d' ? handleMultiDayDoubleClick : undefined}
                        >
                          <span className="calendar-toggle__label calendar-toggle__label--full">{opt.full}</span>
                          <span className="calendar-toggle__label calendar-toggle__label--short" aria-hidden>
                            {opt.short}
                          </span>
                        </button>
                      )
                      if (opt.key !== '3d') {
                        return button
                      }
                      // Wrap the 3-day toggle so the chooser anchors under this button
                      return (
                        <div key={opt.key} className="calendar-toggle-wrap">
                          {button}
                          {calendarView === '3d' && showMultiDayChooser ? (
                            <div
                              className="calendar-multi-day-chooser"
                              ref={multiChooserRef}
                              role="dialog"
                              aria-label="Choose day count"
                            >
                              {Array.from(MULTI_DAY_OPTIONS).map((n) => (
                                <button
                                  key={`chooser-${n}`}
                                  type="button"
                                  className={`calendar-multi-day-chooser__option${multiDayCount === n ? ' is-active' : ''}`}
                                  data-day-count={n}
                                  onClick={() => {
                                    setMultiDayCount(n)
                                    setShowMultiDayChooser(false)
                                  }}
                                >
                                  {n}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>
            </div>
            {/*
              Force a remount when switching views to avoid stale inline
              transforms/styles carrying over from the month/year carousels
              into the day/3d/week header track. This ensures headers always
              render after navigating from month/year views.
            */}
            <div
              key={calendarView}
              className="history-calendar"
              aria-label="Calendar display"
              ref={historyCalendarRef}
            >
              {renderCalendarContent()}
            </div>
            {renderCalendarPopover()}
          </div>
          {calendarInspectorPanel}
        </div>
        {!ENABLE_HISTORY_INSPECTOR_PANEL ? renderCalendarEditor() : null}

  {false ? (
  <section className={`history-section${dayEntryCount > 0 ? '' : ' history-section--empty'}`} aria-label="Session History">
          <div className="history-controls history-controls--floating">
            <button
              type="button"
              className="history-controls__button history-controls__button--primary"
              onClick={handleAddHistoryEntry}
              aria-label="Add a new history session"
            >
              Add history
            </button>
          </div>
          <div className="history-section__header">
            <h3 className="history-section__date">{dayLabel}</h3>
          </div>

          <div
            className="history-timeline"
            style={timelineStyle}
            ref={timelineRef}
            onClick={handleTimelineBackgroundClick}
          >
            <div
              className="history-timeline__bar"
              ref={timelineBarRef}
              onDoubleClick={(event) => {
                event.stopPropagation()
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return
                }
                const bar = timelineBarRef.current
                if (!bar) {
                  return
                }
                if (event.nativeEvent.button !== 0) {
                  return
                }
                const rect = bar.getBoundingClientRect()
                if (rect.width <= 0) {
                  return
                }
                const ratio = (event.clientX - rect.left) / rect.width
                const clampedRatio = Math.min(Math.max(ratio, 0), 1)
                const startTimestamp = Math.round(dayStart + clampedRatio * DAY_DURATION_MS)
                startCreateDrag(event, startTimestamp)
              }}
            >
            {showCurrentTimeIndicator ? (
              <div
                className="history-timeline__current-time"
                style={{ left: `${currentTimePercent}%` }}
                aria-hidden="true"
              />
            ) : null}
            {daySegments.map((segment) => {
              const isSelected = segment.entry.id === selectedHistoryId
              const isActiveSegment = segment.entry.id === 'active-session'
              const isEditing = editingHistoryId === segment.entry.id
              const isActiveSessionSegment = segment.entry.id === 'active-session'
              const isDragging = dragPreview?.entryId === segment.entry.id
              const isNewEntryEditing = isEditing && selectedHistoryId === pendingNewHistoryId
              const trimmedTaskDraft = historyDraft.taskName.trim()
              const displayTask = isSelected
                ? trimmedTaskDraft.length > 0
                  ? trimmedTaskDraft
                  : segment.tooltipTask
                : segment.tooltipTask
              const baseStartedAt = segment.entry.startedAt
              const baseEndedAt = segment.entry.endedAt
              const draggedStartedAt = isDragging && dragPreview ? dragPreview.startedAt : baseStartedAt
              const draggedEndedAt = isDragging && dragPreview ? dragPreview.endedAt : baseEndedAt
              const shouldUseLiveStart = isActiveSessionSegment && activeSession?.isRunning && historyDraft.startedAt === null && !isDragging
              const resolvedStartedAt = isSelected
                ? isDragging
                  ? draggedStartedAt
                  : shouldUseLiveStart
                    ? baseStartedAt
                    : resolveTimestamp(historyDraft.startedAt, baseStartedAt)
                : draggedStartedAt
              const shouldUseLiveEnd = isActiveSessionSegment && activeSession?.isRunning && historyDraft.endedAt === null && !isDragging
              const resolvedEndedAt = isSelected
                ? isDragging
                  ? draggedEndedAt
                  : shouldUseLiveEnd
                    ? baseEndedAt
                    : resolveTimestamp(historyDraft.endedAt, baseEndedAt)
                : draggedEndedAt
              const trimmedGoalDraft = historyDraft.goalName.trim()
              const trimmedBucketDraft = historyDraft.bucketName.trim()
              const resolvedDurationMs = Math.max(resolvedEndedAt - resolvedStartedAt, 0)
              const displayGoal = trimmedGoalDraft.length > 0 ? trimmedGoalDraft : segment.goalLabel
              const displayBucket = trimmedBucketDraft.length > 0 ? trimmedBucketDraft : segment.bucketLabel
              const timeRangeLabel = (() => {
                const startDate = new Date(resolvedStartedAt)
                const endDate = new Date(resolvedEndedAt)
                const sameDay =
                  startDate.getFullYear() === endDate.getFullYear() &&
                  startDate.getMonth() === endDate.getMonth() &&
                  startDate.getDate() === endDate.getDate()
                if (sameDay) {
                  return `${formatTimeOfDay(resolvedStartedAt)} — ${formatTimeOfDay(resolvedEndedAt)}`
                }
                return formatDateRange(resolvedStartedAt, resolvedEndedAt)
              })()
              const durationLabel = formatDuration(resolvedDurationMs)
              const overlayTitleId = !isEditing ? `history-tooltip-title-${segment.id}` : undefined
              // Using inspector pickers; no need for separate formatted date strings here
              const durationMinutesValue = Math.max(1, Math.round(resolvedDurationMs / MINUTE_MS)).toString()
              const handleDurationInputChange = (event: ChangeEvent<HTMLInputElement>) => {
                const minutes = Number(event.target.value)
                setHistoryDraft((draft) => {
                  if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                  if (!Number.isFinite(minutes) || minutes <= 0) return draft
                  const normalizedMinutes = Math.max(1, Math.round(minutes))
                  const baseStart = resolveTimestamp(draft.startedAt, baseStartedAt)
                  return { ...draft, endedAt: baseStart + normalizedMinutes * MINUTE_MS }
                })
              }
              const handleBlockPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                const isTouch = (event as any).pointerType === 'touch'
                if (isTouch) {
                  // Enable long-press to move on touch; short tap will select (handled by onClick)
                  event.persist?.()
                  clearLongPressWatch()
                  longPressPointerIdRef.current = event.pointerId
                  longPressStartRef.current = { x: event.clientX, y: event.clientY }

                  const threshold = 8
                  const handleMove = (e: PointerEvent) => {
                    if (e.pointerId !== longPressPointerIdRef.current || !longPressStartRef.current) return
                    const dx = e.clientX - longPressStartRef.current.x
                    const dy = e.clientY - longPressStartRef.current.y
                    if (Math.hypot(dx, dy) > threshold) {
                      clearLongPressWatch()
                    }
                  }
                  const handleUpOrCancel = (e: PointerEvent) => {
                    if (e.pointerId !== longPressPointerIdRef.current) return
                    clearLongPressWatch()
                  }

                  window.addEventListener('pointermove', handleMove, { passive: true })
                  window.addEventListener('pointerup', handleUpOrCancel, { passive: true })
                  window.addEventListener('pointercancel', handleUpOrCancel, { passive: true })
                  longPressCancelHandlersRef.current = { move: handleMove, up: handleUpOrCancel, cancel: handleUpOrCancel }

                  longPressTimerRef.current = window.setTimeout(() => {
                    // Start move-drag after long press
                    try {
                      if (typeof (event as any).preventDefault === 'function') {
                        (event as any).preventDefault()
                      }
                      ;(event.currentTarget as any)?.setPointerCapture?.(event.pointerId)
                    } catch {}
                    clearLongPressWatch()
                    startDrag(event, segment, 'move')
                  }, 360)
                  return
                }
                // For mouse/pen: defer starting drag until movement exceeds threshold to preserve click/dblclick
                if ((event as any).pointerType === 'mouse' || (event as any).pointerType === 'pen') {
                  mousePreDragRef.current = { pointerId: event.pointerId, startX: event.clientX, segment }
                  const handleMove = (e: PointerEvent) => {
                    const pending = mousePreDragRef.current
                    if (!pending || e.pointerId !== pending.pointerId) return
                    const dx = e.clientX - pending.startX
                    if (Math.abs(dx) >= DRAG_DETECTION_THRESHOLD_PX) {
                      // Begin drag and stop pre-drag listeners
                      mousePreDragRef.current = null
                      if (mousePreDragHandlersRef.current) {
                        window.removeEventListener('pointermove', mousePreDragHandlersRef.current.move)
                        window.removeEventListener('pointerup', mousePreDragHandlersRef.current.up)
                        mousePreDragHandlersRef.current = null
                      }
                      startDragFromPointer(e, segment, 'move')
                    }
                  }
                  const handleUp = (e: PointerEvent) => {
                    const pending = mousePreDragRef.current
                    if (pending && e.pointerId === pending.pointerId) {
                      mousePreDragRef.current = null
                      if (mousePreDragHandlersRef.current) {
                        window.removeEventListener('pointermove', mousePreDragHandlersRef.current.move)
                        window.removeEventListener('pointerup', mousePreDragHandlersRef.current.up)
                        mousePreDragHandlersRef.current = null
                      }
                    }
                  }
                  mousePreDragHandlersRef.current = { move: handleMove, up: handleUp }
                  window.addEventListener('pointermove', handleMove, { passive: true })
                  window.addEventListener('pointerup', handleUp, { passive: true })
                  return
                }
                // Fallback: start drag immediately
                startDrag(event, segment, 'move')
              }
              const handleResizeStartPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-start')
              }
              const handleResizeEndPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-end')
              }
              const handleBlockPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
                const isTouch = (event as any).pointerType === 'touch'
                if (!isTouch) {
                  return
                }
                // If a drag is active, ignore
                if (dragStateRef.current && dragStateRef.current.entryId === segment.entry.id) {
                  return
                }
                const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
                const prev = lastTapRef.current
                const x = event.clientX
                const y = event.clientY
                const id = segment.entry.id
                if (
                  prev &&
                  prev.id === id &&
                  now - prev.time <= DOUBLE_TAP_DELAY_MS &&
                  Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_DISTANCE_PX
                ) {
                  // Double-tap detected: open inspector (if not active session)
                  lastTapRef.current = null
                  if (!isActiveSessionSegment) {
                    // Prevent following click from toggling selection
                    dragPreventClickRef.current = true
                    event.preventDefault()
                    event.stopPropagation()
                    clearLongPressWatch()
                    openCalendarInspector(segment.entry)
                  }
                  return
                }
                lastTapRef.current = { time: now, id, x, y }
                if (lastTapTimeoutRef.current !== null) {
                  try { window.clearTimeout(lastTapTimeoutRef.current) } catch {}
                }
                lastTapTimeoutRef.current = window.setTimeout(() => {
                  lastTapRef.current = null
                  lastTapTimeoutRef.current = null
                }, DOUBLE_TAP_DELAY_MS + 40)
              }
              const isPreviewEntry = segment.entry.id === 'new-entry'
              const isDragHover = hoveredDuringDragId === segment.entry.id
              const showDragBadge = isDragHover || (isPreviewEntry && dragPreview?.entryId === 'new-entry')
              const blockClassName = [
                'history-timeline__block',
                isActiveSegment ? 'history-timeline__block--active' : '',
                isSelected ? 'history-timeline__block--selected' : '',
                isDragging ? 'history-timeline__block--dragging' : '',
                isDragHover ? 'history-timeline__block--drag-hover' : '',
                // Treat anything scheduled in the future as a planned session, regardless of stored flag
                (segment.entry.futureSession || resolvedStartedAt > nowTick) ? 'history-timeline__block--future' : '',
              ]
                .filter(Boolean)
                .join(' ')
              const isAnchoredTooltip = segment.entry.id === anchoredTooltipId
              const shouldSuppressTooltip = Boolean(dragStateRef.current)
              const tooltipClassName = `history-timeline__tooltip${isSelected ? ' history-timeline__tooltip--pinned' : ''}${
                isEditing ? ' history-timeline__tooltip--editing' : ''
              }${isAnchoredTooltip && !isEditing && activeTooltipPlacement === 'below' ? ' history-timeline__tooltip--below' : ''}`
              const tooltipContent = (
                <div className="history-timeline__tooltip-content">
                  {!isEditing ? (
                    <>
                      <p className="history-timeline__tooltip-task" id={overlayTitleId}>
                        {displayTask}
                      </p>
                      <p className="history-timeline__tooltip-time">{timeRangeLabel}</p>
                      <p className="history-timeline__tooltip-meta">
                        {displayGoal}
                        {displayBucket && displayBucket !== displayGoal ? ` → ${displayBucket}` : ''}
                      </p>
                      <p className="history-timeline__tooltip-duration">{durationLabel}</p>
                    </>
                  ) : null}
                  {isSelected ? (
                    <>
                      {isEditing ? (
                        <>
                          <div className="history-timeline__tooltip-form">
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">Session name</span>
                              <input
                                className="history-timeline__field-input"
                                type="text"
                                value={historyDraft.taskName}
                                placeholder="Describe the focus block"
                                onChange={handleHistoryFieldChange('taskName')}
                                onKeyDown={handleHistoryFieldKeyDown}
                              />
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">Start</span>
                              <div className="calendar-inspector__schedule-inputs">
                                <InspectorDateInput
                                  value={resolvedStartedAt}
                                  onChange={(timestamp) => {
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      return { ...draft, startedAt: timestamp }
                                    })
                                  }}
                                  ariaLabel="Select start date"
                                />
                                <InspectorTimeInput
                                  value={resolvedStartedAt}
                                  onChange={(timestamp) => {
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      return { ...draft, startedAt: timestamp }
                                    })
                                  }}
                                  ariaLabel="Select start time"
                                />
                              </div>
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">End</span>
                              <div className="calendar-inspector__schedule-inputs">
                                <InspectorDateInput
                                  value={resolvedEndedAt}
                                  onChange={(timestamp) => {
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      return { ...draft, endedAt: timestamp }
                                    })
                                  }}
                                  ariaLabel="Select end date"
                                />
                                <InspectorTimeInput
                                  value={resolvedEndedAt}
                                  onChange={(timestamp) => {
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      return { ...draft, endedAt: timestamp }
                                    })
                                  }}
                                  ariaLabel="Select end time"
                                />
                              </div>
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">Duration (minutes)</span>
                              <input
                                className="history-timeline__field-input history-timeline__field-input--compact"
                                type="number"
                                min={1}
                                inputMode="numeric"
                                value={durationMinutesValue}
                                onChange={handleDurationInputChange}
                                onKeyDown={handleHistoryFieldKeyDown}
                              />
                            </label>
                            <div className="history-timeline__field">
                              <label className="history-timeline__field-text" htmlFor={goalDropdownId} id={goalDropdownLabelId}>
                                Goal
                              </label>
                              <HistoryDropdown
                                id={goalDropdownId}
                                labelId={goalDropdownLabelId}
                                value={historyDraft.goalName}
                                placeholder="Select goal"
                                options={goalDropdownOptions}
                                onChange={(nextValue) => updateHistoryDraftField('goalName', nextValue)}
                              />
                            </div>
                            <div className="history-timeline__field">
                              <label className="history-timeline__field-text" htmlFor={bucketDropdownId} id={bucketDropdownLabelId}>
                                Bucket
                              </label>
                              <HistoryDropdown
                                id={bucketDropdownId}
                                labelId={bucketDropdownLabelId}
                                value={historyDraft.bucketName}
                                placeholder={availableBucketOptions.length ? 'Select bucket' : 'No buckets available'}
                                options={bucketDropdownOptions}
                                onChange={handleBucketDropdownChange}
                                disabled={availableBucketOptions.length === 0}
                              />
                            </div>
                            <div className="history-timeline__field">
                              <label className="history-timeline__field-text" htmlFor={taskDropdownId} id={taskDropdownLabelId}>
                                Task
                              </label>
                              <HistoryDropdown
                                id={taskDropdownId}
                                labelId={taskDropdownLabelId}
                                value={historyDraft.taskName}
                                placeholder={availableTaskOptions.length ? 'Select task' : 'No tasks available'}
                                options={taskDropdownOptions}
                                onChange={handleTaskDropdownChange}
                                disabled={taskDropdownOptions.length === 0}
                              />
                            </div>
                            <div className="history-timeline__extras">
                              <button
                                type="button"
                                className="history-timeline__extras-toggle"
                                onClick={() => setShowInlineExtras((value) => !value)}
                                aria-expanded={showInlineExtras}
                                aria-controls="history-details-extras-inline"
                              >
                                {showInlineExtras ? 'Hide subtasks & notes' : 'Show subtasks & notes'}
                              </button>
                              <div
                                id="history-details-extras-inline"
                                className={`history-timeline__extras-panel${showInlineExtras ? ' is-open' : ''}`}
                              >
                                {renderHistorySubtasksEditor()}
                                <label className="history-timeline__field">
                                  <span className="history-timeline__field-text">Notes</span>
                                  <textarea
                                    className="calendar-inspector__notes"
                                    value={historyDraft.notes}
                                    placeholder="Capture context, outcomes, or follow-ups"
                                    onChange={handleHistoryNotesChange}
                                  />
                                </label>
                              </div>
                            </div>
                          </div>
                          <div className="history-timeline__actions">
                            <button
                              type="button"
                              className="history-timeline__action-button history-timeline__action-button--primary"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleSaveHistoryDraft()
                              }}
                            >
                              Save changes
                            </button>
                            <button
                              type="button"
                              className="history-timeline__action-button"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleCancelHistoryEdit()
                              }}
                            >
                              Cancel
                            </button>
                            {!isNewEntryEditing && segment.deletable ? (
                              <button
                                type="button"
                                className="history-timeline__action-button"
                                onClick={handleDeleteHistoryEntry(segment.entry.id)}
                              >
                                Delete session
                              </button>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <div className="history-timeline__actions">
                          <button
                            type="button"
                            className="history-timeline__action-button history-timeline__action-button--primary"
                            onClick={(event) => {
                              event.stopPropagation()
                              if (!isActiveSessionSegment) {
                                openCalendarInspector(segment.entry)
                              }
                            }}
                            disabled={isActiveSessionSegment}
                          >
                            Edit details
                          </button>
                          {!isNewEntryEditing ? (
                            <button
                              type="button"
                              className="history-timeline__action-button"
                              onClick={handleDeleteHistoryEntry(segment.entry.id)}
                            >
                              Delete session
                            </button>
                          ) : null}
                        </div>
                      )}
                      {isActiveSessionSegment ? (
                        <p className="history-timeline__tooltip-note">Active session updates live; finish to edit details.</p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              )
              const tooltipCommonProps: HTMLAttributes<HTMLDivElement> = {
                className: tooltipClassName,
                role: 'presentation',
                onClick: (event) => event.stopPropagation(),
                onMouseDown: (event) => event.stopPropagation(),
                onPointerDown: (event) => event.stopPropagation(),
              }

              const inlineTooltip =
                shouldSuppressTooltip && showDragBadge
                  ? null
                  : (
                    <div
                      {...tooltipCommonProps}
                      ref={isAnchoredTooltip && !isEditing ? setActiveTooltipNode : null}
                      style={
                        isAnchoredTooltip && !isEditing
                          ? ({
                              '--history-tooltip-shift-x': `${activeTooltipOffsets.x}px`,
                              '--history-tooltip-shift-y': `${activeTooltipOffsets.y}px`,
                            } as CSSProperties)
                          : undefined
                      }
                    >
                      {tooltipContent}
                    </div>
                  )

              const renderedTooltip =
                (isEditing && typeof document !== 'undefined' && !(shouldSuppressTooltip && showDragBadge))
                  ? createPortal(
                      <div ref={setEditingTooltipNode} {...tooltipCommonProps} className={`${tooltipClassName} history-timeline__tooltip--portal`}>
                        {tooltipContent}
                      </div>,
                      document.body,
                    )
                  : inlineTooltip

              return (
                <div
                  key={`${segment.id}-${segment.start}-${segment.end}`}
                  className={blockClassName}
                  style={{
                    left: `${segment.leftPercent}%`,
                    width: `${segment.widthPercent}%`,
                    top: `calc(${segment.lane} * var(--history-timeline-row-height))`,
                    background: segment.gradientCss ?? segment.color,
                  }}
                  data-drag-time={
                    showDragBadge
                      ? `${formatTimeOfDay(resolvedStartedAt)} — ${formatTimeOfDay(resolvedEndedAt)}`
                      : undefined
                  }
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={`${segment.tooltipTask} from ${formatTimeOfDay(resolvedStartedAt)} to ${formatTimeOfDay(resolvedEndedAt)}`}
                  onPointerDown={handleBlockPointerDown}
                  onPointerUp={handleBlockPointerUp}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (dragPreventClickRef.current) {
                      dragPreventClickRef.current = false
                      return
                    }
                    // If this is the second click in a double-click sequence, open edit immediately (desktop reliability)
                    if (event.detail === 2) {
                      if (!isActiveSessionSegment) {
                        openCalendarInspector(segment.entry)
                      }
                      return
                    }
                    if (event.detail > 1) {
                      return
                    }
                    handleSelectHistorySegment(segment.entry)
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    if (dragPreventClickRef.current) {
                      dragPreventClickRef.current = false
                    }
                    if (!isActiveSessionSegment) {
                      openCalendarInspector(segment.entry)
                    }
                  }}
                  onMouseEnter={() =>
                    setHoveredHistoryId((current) => (current === segment.entry.id ? current : segment.entry.id))
                  }
                  onMouseLeave={() =>
                    setHoveredHistoryId((current) => (current === segment.entry.id ? null : current))
                  }
                  onFocus={() => setHoveredHistoryId(segment.entry.id)}
                  onBlur={() =>
                    setHoveredHistoryId((current) => (current === segment.entry.id ? null : current))
                  }
                  onKeyDown={handleTimelineBlockKeyDown(segment.entry)}
                >
                  <div
                    className="history-timeline__block-label"
                    title={`${displayTask} · ${formatTimeOfDay(resolvedStartedAt)} — ${formatTimeOfDay(resolvedEndedAt)}`}
                    aria-hidden
                  >
                    <div className="history-timeline__block-title">{displayTask}</div>
                    <div className="history-timeline__block-time">
                      {formatTimeOfDay(resolvedStartedAt)} — {formatTimeOfDay(resolvedEndedAt)}
                    </div>
                  </div>
                  <div
                    className="history-timeline__block-handle history-timeline__block-handle--start"
                    role="presentation"
                    aria-hidden="true"
                    onPointerDown={handleResizeStartPointerDown}
                  />
                  <div
                    className="history-timeline__block-handle history-timeline__block-handle--end"
                    role="presentation"
                    aria-hidden="true"
                    onPointerDown={handleResizeEndPointerDown}
                  />
                  {renderedTooltip}
                </div>
              )
            })}
          </div>
          <div className="history-timeline__axis">
            {timelineTicks.map((tick, index) => {
              const isFirstTick = index === 0
              const isLastTick = index === timelineTicks.length - 1
              const { hour, showLabel } = tick
              const tickClassName = [
                'history-timeline__tick',
                isFirstTick ? 'history-timeline__tick--first' : '',
                isLastTick ? 'history-timeline__tick--last' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <div
                  key={`tick-${hour}`}
                  className={tickClassName}
                  style={{ left: `${(hour / 24) * 100}%` }}
                >
                  <span
                    className={`history-timeline__tick-line${showLabel ? ' history-timeline__tick-line--major' : ''}`}
                  />
                  <span
                    className={`history-timeline__tick-label${showLabel ? '' : ' history-timeline__tick-label--hidden'}`}
                    aria-hidden={!showLabel}
                  >
                    {formatHourLabel(hour)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </section>
        ) : null}
    </div>

      <section className="reflection-section reflection-section--overview">
        <h2 className="reflection-section__title">Time Overview</h2>
        <div className="reflection-tabs" role="tablist" aria-label="Reflection time ranges">
          {RANGE_KEYS.map((key) => {
            const config = RANGE_DEFS[key]
            const isActive = key === activeRange
            const tabShortLabel = key === 'all' ? config.shortLabel : `Last ${config.shortLabel}`
            return (
              <button
                key={key}
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                aria-controls={tabPanelId}
                className={`reflection-tab${isActive ? ' reflection-tab--active' : ''}`}
                aria-label={config.label}
                onClick={() => setActiveRange(key)}
              >
                <span className="reflection-tab__label reflection-tab__label--full">{config.label}</span>
                <span className="reflection-tab__label reflection-tab__label--short">{tabShortLabel}</span>
              </button>
            )
          })}
        </div>

        <div
          className="reflection-overview"
          role="tabpanel"
          id={tabPanelId}
          aria-live="polite"
          aria-label={`${activeRangeConfig.label} chart`}
        >
          {overviewBlockedMessage ? (
            <div className="reflection-overview__empty" role="status" aria-live="polite">
              {overviewBlockedMessage}
            </div>
          ) : (
            <>
              <div className="reflection-pie">
                {supportsConicGradient ? (
                  <canvas
                    ref={pieCanvasRef}
                    className="reflection-pie__canvas"
                    width={PIE_VIEWBOX_SIZE}
                    height={PIE_VIEWBOX_SIZE}
                    aria-hidden="true"
                  />
                ) : (
                  <svg
                    className="reflection-pie__chart"
                    viewBox={`0 0 ${PIE_VIEWBOX_SIZE} ${PIE_VIEWBOX_SIZE}`}
                    aria-hidden="true"
                    focusable="false"
                  >
                    {pieArcs.length === 0 ? (
                      <path
                        className="reflection-pie__slice reflection-pie__slice--unlogged"
                        d={FULL_DONUT_PATH}
                        fill="var(--reflection-chart-unlogged-soft)"
                        stroke="var(--reflection-chart-unlogged-stroke)"
                        strokeWidth="1.1"
                        strokeLinejoin="round"
                        fillRule="evenodd"
                        clipRule="evenodd"
                      />
                    ) : (
                      pieArcs.map((arc) => {
                        if (arc.isUnlogged) {
                          return (
                            <path
                              key={arc.id}
                              className="reflection-pie__slice reflection-pie__slice--unlogged"
                              d={arc.path}
                              fill={arc.fill}
                              fillRule="evenodd"
                              clipRule="evenodd"
                            />
                          )
                        }
                        const slices = buildArcLoopSlices(arc)
                        if (slices.length <= 1) {
                          const slice = slices[0]
                          return (
                            <path
                              key={arc.id}
                              className="reflection-pie__slice"
                              d={arc.path}
                              fill={slice?.color ?? arc.fill}
                              fillRule="evenodd"
                              clipRule="evenodd"
                            />
                          )
                        }
                        return (
                          <g key={arc.id}>
                            {slices.map((slice) => (
                              <path
                                key={slice.key}
                                className="reflection-pie__slice"
                                d={slice.path}
                                fill={slice.color}
                                fillRule="evenodd"
                                clipRule="evenodd"
                              />
                            ))}
                          </g>
                        )
                      })
                    )}
                  </svg>
                )}
                <div className="reflection-pie__center">
                  <span className="reflection-pie__range">{activeRangeConfig.shortLabel}</span>
                  <span className="reflection-pie__value">{formatDuration(loggedMs)}</span>
                  <span className="reflection-pie__caption">logged</span>
                </div>
              </div>

              <div className="reflection-legend" aria-label={`${activeRangeConfig.label} breakdown`}>
                {legendSegments.map((segment) => (
                  <div
                    key={segment.id}
                    className={`reflection-legend__item${segment.isUnlogged ? ' reflection-legend__item--unlogged' : ''}`}
                  >
                    <span className="reflection-legend__swatch" style={{ background: segment.swatch }} aria-hidden="true" />
                    <div className="reflection-legend__meta">
                      <span className="reflection-legend__label">{segment.label}</span>
                      <span className="reflection-legend__value">{formatDuration(segment.durationMs)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {overviewBlockedMessage ? null : (
          <div className="reflection-stats">
            <div className="reflection-stats__item">
              <span className="reflection-stats__label">Logged</span>
              <span className="reflection-stats__value">{formatDuration(loggedMs)}</span>
            </div>
            <div className="reflection-stats__item">
              <span className="reflection-stats__label">Unlogged</span>
              <span className="reflection-stats__value">{formatDuration(unloggedMs)}</span>
            </div>
            <div className="reflection-stats__item">
              <span className="reflection-stats__label">Window</span>
              <span className="reflection-stats__value">{formatDuration(windowMs)}</span>
            </div>
          </div>
        )}
      </section>

      {/* Snap Back Overview */}
      <section className="reflection-section reflection-section--overview">
        <div className="reflection-overview__header">
          <div className="reflection-overview__titles">
            <h2 className="reflection-section__title">Snap Back Overview</h2>
            {/* Overview description removed */}
          </div>
          {/* snap-tabs removed: always showing all-time triggers */}
        </div>

        <div className="snapback-overview" role="tabpanel" id={snapbackPanelId} aria-live="polite" aria-label={`${snapActiveRangeConfig.label} snap backs`}>
          <div className="snapback-triggers">
            <div className="snapback-list__head">
              <h3 className="snapback-list__title">Triggers</h3>
              <button
                type="button"
                className="snapback-list__add"
                onClick={startAddTrigger}
              >
                + Add Trigger
              </button>
            </div>
            {combinedLegend.length === 0 ? (
              <div className="snapback-empty">No recorded triggers yet.</div>
            ) : (
            <div className="snapback-list snapback-list--stack">
              {combinedLegend.map((item) => {
                const isActive = item.id === selectedTriggerKey
                const isCustom = customTriggers.some((ct) => ct.id === item.id)
                const isEditing = isCustom && editingTriggerId === item.id
              return (
                <div
                  key={item.id}
                  className={`snapback-item snapback-item--row${isActive ? ' snapback-item--active' : ''}`}
                  onClick={() => setSelectedTriggerKey(item.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    const t = e.target as HTMLElement
                    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedTriggerKey(item.id)
                    }
                  }}
                >
                  <div className="snapback-item__row">
                    <div className="snapback-item__left">
                      <span className="snapback-item__dot" style={{ background: item.swatch }} aria-hidden="true" />
                      {isEditing ? (
                        <input
                          ref={editTriggerInputRef}
                          type="text"
                          defaultValue={item.label}
                          onBlur={() => commitEditTrigger()}
                          onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter') { e.preventDefault(); commitEditTrigger() }
                            if (e.key === 'Escape') { e.preventDefault(); setEditingTriggerId(null) }
                          }}
                          className="snapback-item__title-input"
                          aria-label="Edit trigger name"
                        />
                      ) : (
                        <span className="snapback-item__title">{item.label}</span>
                      )}
                    </div>
                    <div className="snapback-item__meta">{item.count}x • {formatDuration(item.durationMs)}</div>
                    {isCustom ? (
                      <button
                        type="button"
                        className="snapback-item__delete"
                        aria-label={`Delete trigger ${item.label}`}
                        title="Delete trigger"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          apiDeleteSnapbackById(item.id).then((ok) => {
                            if (ok) setSnapDbRows((cur) => cur.filter((r) => r.id !== item.id))
                          })
                          if (editingTriggerId === item.id) setEditingTriggerId(null)
                        }}
                      >
                        <svg className="snapback-item__delete-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M3 6h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M10 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                          <path d="M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
            </div>
            )}
          </div>
          

          <div className="snapback-drawer">
            <div className="snapback-drawer__header">
              <div className="snapback-drawer__titles">
                <SnapbackEditableTitle
                  item={selectedItem ? { id: selectedItem.id, label: selectedItem.label } : null}
                  isCustom={Boolean(selectedItem && customTriggers.some((ct) => ct.id === selectedItem.id))}
                  onRename={async (id, label) => {
                    const trimmed = label.trim()
                    if (!trimmed) return
                    const ok = await apiUpdateSnapbackNameById(id, trimmed)
                    if (ok) setSnapDbRows((cur) => cur.map((r) => (r.id === id ? { ...r, trigger_name: trimmed } as DbSnapbackOverview : r)))
                  }}
                  onAlias={async (id, label) => {
                    const trimmed = label.trim()
                    if (!trimmed) return
                    if (!id.startsWith('snap-')) return
                    const baseKey = id.slice(5)
                    const row = await apiUpsertSnapbackByKey({ base_key: baseKey, trigger_name: trimmed })
                    if (row) {
                      setSnapDbRows((cur) => {
                        const idx = cur.findIndex((r) => r.base_key === baseKey)
                        if (idx >= 0) { const copy = cur.slice(); copy[idx] = row; return copy }
                        return [...cur, row]
                      })
                    }
                  }}
                />
                {selectedItem ? (
                  <p className="snapback-drawer__subtitle">Occurred {selectedItem.count}× ({formatDuration(selectedItem.durationMs)}) total.</p>
                ) : null}
                {/* privacy note removed per request */}
              </div>
              <div className="snapback-drawer__badge">Last recorded: {selectedTriggerLastAtLabel}</div>
            </div>
            {selectedItem ? (
              <SnapbackPlanForm
                key={selectedItem.id}
                idKey={selectedItem.id}
                initialPlan={selectedPlan}
                onScheduleSave={schedulePersistPlan}
              />
            ) : null}

            {/* Auto-saves on change; no explicit save button */}
          </div>
        </div>
      </section>

      {/* Daily reflection section removed */}
    </section>
      {customRecurrenceModal}
    </>
  )
}
