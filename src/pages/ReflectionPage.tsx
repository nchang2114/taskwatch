import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useDeferredValue,
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
import { readStoredGoalsSnapshot, subscribeToGoalsSnapshot, publishGoalsSnapshot, createGoalsSnapshot, syncGoalsSnapshotFromSupabase, readGoalsSnapshotOwner, GOALS_GUEST_USER_ID, type GoalSnapshot } from '../lib/goalsSync'
import { SCHEDULE_EVENT_TYPE, type ScheduleBroadcastEvent } from '../lib/scheduleChannel'
import { broadcastPauseFocus } from '../lib/focusChannel'
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
  subscribeToRepeatingRulesChange,
  isRepeatingRuleId,
  type RepeatingSessionRule,
} from '../lib/repeatingSessions'
import { evaluateAndMaybeRetireRule, setRepeatToNoneAfterTimestamp, deleteRepeatingRuleById } from '../lib/repeatingSessions'
import {
  fetchSnapbackOverviewRows as apiFetchSnapbackRows,
  createSnapbackTrigger as apiCreateSnapbackTrigger,
  getOrCreateTriggerByName as apiGetOrCreateTrigger,
  deleteSnapbackRowById as apiDeleteSnapbackById,
  updateSnapbackTriggerNameById as apiRenameSnapbackTrigger,
  upsertSnapbackPlanById as apiUpsertSnapbackPlanById,
  type DbSnapbackOverview,
} from '../lib/snapbackApi'
import { broadcastSnapbackUpdate, subscribeToSnapbackSync } from '../lib/snapbackChannel'
import { supabase } from '../lib/supabaseClient'
import { logWarn } from '../lib/logging'
import { isRecentlyFullSynced } from '../lib/bootstrap'
import { ensureQuickListRemoteStructures, QUICK_LIST_GOAL_NAME } from '../lib/quickListRemote'
import { readStoredQuickList, subscribeQuickList, type QuickItem } from '../lib/quickList'

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

// Simple threshold check - has user moved enough to start an interaction?
const hasMovedPastThreshold = (dx: number, dy: number, threshold: number = 8): boolean => {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold
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
  timezoneFrom: string
  timezoneTo: string
}

const cloneHistorySubtasks = (subtasks: HistorySubtask[]): HistorySubtask[] =>
  subtasks.map((subtask) => ({ ...subtask }))

const createHistoryDraftFromEntry = (entry?: HistoryEntry | null): HistoryDraftState => ({
  taskName: entry?.taskName ?? '',
  goalName: entry?.goalName ?? '',
  bucketName: entry?.bucketName ?? '',
  // Keep timestamps as null - they are derived from the entry with timezone adjustment at render time
  // Only set when user explicitly changes via picker
  startedAt: null,
  endedAt: null,
  notes: entry?.notes ?? '',
  subtasks: entry ? cloneHistorySubtasks(entry.subtasks) : [],
  timezoneFrom: entry?.timezoneFrom ?? '',
  timezoneTo: entry?.timezoneTo ?? '',
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
    a.timezoneFrom === b.timezoneFrom &&
    a.timezoneTo === b.timezoneTo &&
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
const LIFE_ROUTINES_GOAL_ID = 'life-routines'
const LIFE_ROUTINES_SURFACE: SurfaceStyle = 'linen'
const TIMEZONE_CHANGE_MARKER = 'Timezone Change marker'

// Helper to extract city name from "City, Country" format
const extractCityName = (fullLocation: string): string => {
  if (!fullLocation) return ''
  const commaIndex = fullLocation.indexOf(',')
  return commaIndex > 0 ? fullLocation.substring(0, commaIndex).trim() : fullLocation.trim()
}

// Generate timezone change session name from From and To cities
const generateTimezoneSessionName = (fromCity: string, toCity: string): string => {
  const from = extractCityName(fromCity)
  const to = extractCityName(toCity)
  if (from && to) {
    return `Timezone Change: ${from} to ${to}`
  }
  if (from) {
    return `Timezone Change: ${from} to ...`
  }
  if (to) {
    return `Timezone Change: ... to ${to}`
  }
  return 'Timezone Change'
}

// Parse timezone cities from session name like "Timezone Change: Sydney to Tokyo"
// Returns { from: "Sydney, Australia", to: "Tokyo, Japan" } by matching city names to TIMEZONE_CITIES
const parseTimezoneFromSessionName = (sessionName: string): { from: string; to: string } => {
  const result = { from: '', to: '' }
  if (!sessionName.startsWith('Timezone Change')) return result
  
  // Extract the part after "Timezone Change: "
  const match = sessionName.match(/^Timezone Change:\s*(.+?)\s+to\s+(.+)$/i)
  if (!match) return result
  
  const [, fromCity, toCity] = match
  
  // Try to find matching cities in TIMEZONE_CITIES (defined below)
  // We'll do a simple case-insensitive match on city name
  const findCity = (cityName: string): string => {
    if (!cityName || cityName === '...') return ''
    const normalizedSearch = cityName.toLowerCase().trim()
    // First try exact city name match
    const exactMatch = TIMEZONE_CITIES.find(c => 
      extractCityName(c.value).toLowerCase() === normalizedSearch
    )
    if (exactMatch) return exactMatch.value
    // Fallback: try partial match
    const partialMatch = TIMEZONE_CITIES.find(c =>
      c.searchTerms.some(term => term === normalizedSearch)
    )
    return partialMatch?.value ?? ''
  }
  
  result.from = findCity(fromCity)
  result.to = findCity(toCity)
  return result
}

// Timezone city options for the timezone change marker
type TimezoneCity = {
  value: string
  label: string
  searchTerms: string[]
}
const TIMEZONE_CITIES: TimezoneCity[] = [
  { value: 'Sydney, Australia', label: 'Sydney, Australia', searchTerms: ['sydney', 'australia', 'syd', 'aus'] },
  { value: 'Melbourne, Australia', label: 'Melbourne, Australia', searchTerms: ['melbourne', 'australia', 'mel', 'aus'] },
  { value: 'Brisbane, Australia', label: 'Brisbane, Australia', searchTerms: ['brisbane', 'australia', 'aus'] },
  { value: 'Perth, Australia', label: 'Perth, Australia', searchTerms: ['perth', 'australia', 'aus'] },
  { value: 'Auckland, New Zealand', label: 'Auckland, New Zealand', searchTerms: ['auckland', 'new zealand', 'nz'] },
  { value: 'Wellington, New Zealand', label: 'Wellington, New Zealand', searchTerms: ['wellington', 'new zealand', 'nz'] },
  { value: 'Tokyo, Japan', label: 'Tokyo, Japan', searchTerms: ['tokyo', 'japan', 'jp'] },
  { value: 'Seoul, South Korea', label: 'Seoul, South Korea', searchTerms: ['seoul', 'south korea', 'korea', 'kr'] },
  { value: 'Shanghai, China', label: 'Shanghai, China', searchTerms: ['shanghai', 'china', 'cn'] },
  { value: 'Beijing, China', label: 'Beijing, China', searchTerms: ['beijing', 'china', 'cn', 'peking'] },
  { value: 'Hong Kong', label: 'Hong Kong', searchTerms: ['hong kong', 'hk'] },
  { value: 'Singapore', label: 'Singapore', searchTerms: ['singapore', 'sg'] },
  { value: 'Kuala Lumpur, Malaysia', label: 'Kuala Lumpur, Malaysia', searchTerms: ['kuala lumpur', 'malaysia', 'kl', 'my'] },
  { value: 'Bangkok, Thailand', label: 'Bangkok, Thailand', searchTerms: ['bangkok', 'thailand', 'th'] },
  { value: 'Jakarta, Indonesia', label: 'Jakarta, Indonesia', searchTerms: ['jakarta', 'indonesia', 'id'] },
  { value: 'Manila, Philippines', label: 'Manila, Philippines', searchTerms: ['manila', 'philippines', 'ph'] },
  { value: 'Mumbai, India', label: 'Mumbai, India', searchTerms: ['mumbai', 'india', 'bombay', 'in'] },
  { value: 'Delhi, India', label: 'Delhi, India', searchTerms: ['delhi', 'india', 'new delhi', 'in'] },
  { value: 'Bangalore, India', label: 'Bangalore, India', searchTerms: ['bangalore', 'india', 'bengaluru', 'in'] },
  { value: 'Dubai, UAE', label: 'Dubai, UAE', searchTerms: ['dubai', 'uae', 'emirates'] },
  { value: 'Abu Dhabi, UAE', label: 'Abu Dhabi, UAE', searchTerms: ['abu dhabi', 'uae', 'emirates'] },
  { value: 'Tel Aviv, Israel', label: 'Tel Aviv, Israel', searchTerms: ['tel aviv', 'israel', 'il'] },
  { value: 'Istanbul, Turkey', label: 'Istanbul, Turkey', searchTerms: ['istanbul', 'turkey', 'tr', 'türkiye'] },
  { value: 'Moscow, Russia', label: 'Moscow, Russia', searchTerms: ['moscow', 'russia', 'ru'] },
  { value: 'London, UK', label: 'London, UK', searchTerms: ['london', 'uk', 'england', 'britain', 'gb'] },
  { value: 'Paris, France', label: 'Paris, France', searchTerms: ['paris', 'france', 'fr'] },
  { value: 'Berlin, Germany', label: 'Berlin, Germany', searchTerms: ['berlin', 'germany', 'de'] },
  { value: 'Munich, Germany', label: 'Munich, Germany', searchTerms: ['munich', 'germany', 'de', 'münchen'] },
  { value: 'Frankfurt, Germany', label: 'Frankfurt, Germany', searchTerms: ['frankfurt', 'germany', 'de'] },
  { value: 'Amsterdam, Netherlands', label: 'Amsterdam, Netherlands', searchTerms: ['amsterdam', 'netherlands', 'nl', 'holland'] },
  { value: 'Brussels, Belgium', label: 'Brussels, Belgium', searchTerms: ['brussels', 'belgium', 'be'] },
  { value: 'Zurich, Switzerland', label: 'Zurich, Switzerland', searchTerms: ['zurich', 'switzerland', 'ch', 'zürich'] },
  { value: 'Vienna, Austria', label: 'Vienna, Austria', searchTerms: ['vienna', 'austria', 'at', 'wien'] },
  { value: 'Rome, Italy', label: 'Rome, Italy', searchTerms: ['rome', 'italy', 'it', 'roma'] },
  { value: 'Milan, Italy', label: 'Milan, Italy', searchTerms: ['milan', 'italy', 'it', 'milano'] },
  { value: 'Madrid, Spain', label: 'Madrid, Spain', searchTerms: ['madrid', 'spain', 'es'] },
  { value: 'Barcelona, Spain', label: 'Barcelona, Spain', searchTerms: ['barcelona', 'spain', 'es'] },
  { value: 'Lisbon, Portugal', label: 'Lisbon, Portugal', searchTerms: ['lisbon', 'portugal', 'pt', 'lisboa'] },
  { value: 'Dublin, Ireland', label: 'Dublin, Ireland', searchTerms: ['dublin', 'ireland', 'ie'] },
  { value: 'Edinburgh, UK', label: 'Edinburgh, UK', searchTerms: ['edinburgh', 'uk', 'scotland', 'gb'] },
  { value: 'Stockholm, Sweden', label: 'Stockholm, Sweden', searchTerms: ['stockholm', 'sweden', 'se'] },
  { value: 'Oslo, Norway', label: 'Oslo, Norway', searchTerms: ['oslo', 'norway', 'no'] },
  { value: 'Copenhagen, Denmark', label: 'Copenhagen, Denmark', searchTerms: ['copenhagen', 'denmark', 'dk'] },
  { value: 'Helsinki, Finland', label: 'Helsinki, Finland', searchTerms: ['helsinki', 'finland', 'fi'] },
  { value: 'Warsaw, Poland', label: 'Warsaw, Poland', searchTerms: ['warsaw', 'poland', 'pl'] },
  { value: 'Prague, Czech Republic', label: 'Prague, Czech Republic', searchTerms: ['prague', 'czech', 'cz', 'praha'] },
  { value: 'Athens, Greece', label: 'Athens, Greece', searchTerms: ['athens', 'greece', 'gr'] },
  { value: 'Cairo, Egypt', label: 'Cairo, Egypt', searchTerms: ['cairo', 'egypt', 'eg'] },
  { value: 'Cape Town, South Africa', label: 'Cape Town, South Africa', searchTerms: ['cape town', 'south africa', 'za'] },
  { value: 'Johannesburg, South Africa', label: 'Johannesburg, South Africa', searchTerms: ['johannesburg', 'south africa', 'za', 'joburg'] },
  { value: 'Lagos, Nigeria', label: 'Lagos, Nigeria', searchTerms: ['lagos', 'nigeria', 'ng'] },
  { value: 'Nairobi, Kenya', label: 'Nairobi, Kenya', searchTerms: ['nairobi', 'kenya', 'ke'] },
  { value: 'New York, USA', label: 'New York, USA', searchTerms: ['new york', 'usa', 'us', 'nyc', 'america'] },
  { value: 'Los Angeles, USA', label: 'Los Angeles, USA', searchTerms: ['los angeles', 'usa', 'us', 'la', 'america'] },
  { value: 'San Francisco, USA', label: 'San Francisco, USA', searchTerms: ['san francisco', 'usa', 'us', 'sf', 'america'] },
  { value: 'Seattle, USA', label: 'Seattle, USA', searchTerms: ['seattle', 'usa', 'us', 'america'] },
  { value: 'Chicago, USA', label: 'Chicago, USA', searchTerms: ['chicago', 'usa', 'us', 'america'] },
  { value: 'Boston, USA', label: 'Boston, USA', searchTerms: ['boston', 'usa', 'us', 'america'] },
  { value: 'Miami, USA', label: 'Miami, USA', searchTerms: ['miami', 'usa', 'us', 'america', 'florida'] },
  { value: 'Denver, USA', label: 'Denver, USA', searchTerms: ['denver', 'usa', 'us', 'america', 'colorado'] },
  { value: 'Austin, USA', label: 'Austin, USA', searchTerms: ['austin', 'usa', 'us', 'america', 'texas'] },
  { value: 'Honolulu, USA', label: 'Honolulu, USA', searchTerms: ['honolulu', 'usa', 'us', 'america', 'hawaii'] },
  { value: 'Toronto, Canada', label: 'Toronto, Canada', searchTerms: ['toronto', 'canada', 'ca'] },
  { value: 'Vancouver, Canada', label: 'Vancouver, Canada', searchTerms: ['vancouver', 'canada', 'ca'] },
  { value: 'Montreal, Canada', label: 'Montreal, Canada', searchTerms: ['montreal', 'canada', 'ca', 'montréal'] },
  { value: 'Mexico City, Mexico', label: 'Mexico City, Mexico', searchTerms: ['mexico city', 'mexico', 'mx', 'cdmx'] },
  { value: 'São Paulo, Brazil', label: 'São Paulo, Brazil', searchTerms: ['sao paulo', 'brazil', 'br', 'são paulo'] },
  { value: 'Rio de Janeiro, Brazil', label: 'Rio de Janeiro, Brazil', searchTerms: ['rio', 'brazil', 'br', 'rio de janeiro'] },
  { value: 'Buenos Aires, Argentina', label: 'Buenos Aires, Argentina', searchTerms: ['buenos aires', 'argentina', 'ar'] },
  { value: 'Santiago, Chile', label: 'Santiago, Chile', searchTerms: ['santiago', 'chile', 'cl'] },
  { value: 'Lima, Peru', label: 'Lima, Peru', searchTerms: ['lima', 'peru', 'pe'] },
  { value: 'Bogota, Colombia', label: 'Bogota, Colombia', searchTerms: ['bogota', 'colombia', 'co', 'bogotá'] },
]

// City to IANA timezone mapping for timezone change markers
const CITY_TO_IANA_TIMEZONE: Record<string, string> = {
  'Sydney, Australia': 'Australia/Sydney',
  'Melbourne, Australia': 'Australia/Melbourne',
  'Brisbane, Australia': 'Australia/Brisbane',
  'Perth, Australia': 'Australia/Perth',
  'Auckland, New Zealand': 'Pacific/Auckland',
  'Wellington, New Zealand': 'Pacific/Auckland',
  'Tokyo, Japan': 'Asia/Tokyo',
  'Seoul, South Korea': 'Asia/Seoul',
  'Shanghai, China': 'Asia/Shanghai',
  'Beijing, China': 'Asia/Shanghai',
  'Hong Kong': 'Asia/Hong_Kong',
  'Singapore': 'Asia/Singapore',
  'Kuala Lumpur, Malaysia': 'Asia/Kuala_Lumpur',
  'Bangkok, Thailand': 'Asia/Bangkok',
  'Jakarta, Indonesia': 'Asia/Jakarta',
  'Manila, Philippines': 'Asia/Manila',
  'Mumbai, India': 'Asia/Kolkata',
  'Delhi, India': 'Asia/Kolkata',
  'Bangalore, India': 'Asia/Kolkata',
  'Dubai, UAE': 'Asia/Dubai',
  'Abu Dhabi, UAE': 'Asia/Dubai',
  'Tel Aviv, Israel': 'Asia/Jerusalem',
  'Istanbul, Turkey': 'Europe/Istanbul',
  'Moscow, Russia': 'Europe/Moscow',
  'London, UK': 'Europe/London',
  'Paris, France': 'Europe/Paris',
  'Berlin, Germany': 'Europe/Berlin',
  'Munich, Germany': 'Europe/Berlin',
  'Frankfurt, Germany': 'Europe/Berlin',
  'Amsterdam, Netherlands': 'Europe/Amsterdam',
  'Brussels, Belgium': 'Europe/Brussels',
  'Zurich, Switzerland': 'Europe/Zurich',
  'Vienna, Austria': 'Europe/Vienna',
  'Rome, Italy': 'Europe/Rome',
  'Milan, Italy': 'Europe/Rome',
  'Madrid, Spain': 'Europe/Madrid',
  'Barcelona, Spain': 'Europe/Madrid',
  'Lisbon, Portugal': 'Europe/Lisbon',
  'Dublin, Ireland': 'Europe/Dublin',
  'Edinburgh, UK': 'Europe/London',
  'Stockholm, Sweden': 'Europe/Stockholm',
  'Oslo, Norway': 'Europe/Oslo',
  'Copenhagen, Denmark': 'Europe/Copenhagen',
  'Helsinki, Finland': 'Europe/Helsinki',
  'Warsaw, Poland': 'Europe/Warsaw',
  'Prague, Czech Republic': 'Europe/Prague',
  'Athens, Greece': 'Europe/Athens',
  'Cairo, Egypt': 'Africa/Cairo',
  'Cape Town, South Africa': 'Africa/Johannesburg',
  'Johannesburg, South Africa': 'Africa/Johannesburg',
  'Lagos, Nigeria': 'Africa/Lagos',
  'Nairobi, Kenya': 'Africa/Nairobi',
  'New York, USA': 'America/New_York',
  'Los Angeles, USA': 'America/Los_Angeles',
  'San Francisco, USA': 'America/Los_Angeles',
  'Seattle, USA': 'America/Los_Angeles',
  'Chicago, USA': 'America/Chicago',
  'Boston, USA': 'America/New_York',
  'Miami, USA': 'America/New_York',
  'Denver, USA': 'America/Denver',
  'Austin, USA': 'America/Chicago',
  'Honolulu, USA': 'Pacific/Honolulu',
  'Toronto, Canada': 'America/Toronto',
  'Vancouver, Canada': 'America/Vancouver',
  'Montreal, Canada': 'America/Toronto',
  'Mexico City, Mexico': 'America/Mexico_City',
  'São Paulo, Brazil': 'America/Sao_Paulo',
  'Rio de Janeiro, Brazil': 'America/Sao_Paulo',
  'Buenos Aires, Argentina': 'America/Argentina/Buenos_Aires',
  'Santiago, Chile': 'America/Santiago',
  'Lima, Peru': 'America/Lima',
  'Bogota, Colombia': 'America/Bogota',
}

// App timezone override - stored in localStorage
const APP_TIMEZONE_STORAGE_KEY = 'taskwatch_app_timezone'

// Get IANA timezone from city name (full "City, Country" format)
const getIanaTimezoneForCity = (cityFullName: string): string | null => {
  return CITY_TO_IANA_TIMEZONE[cityFullName] ?? null
}

// Get current system timezone
const getCurrentSystemTimezone = (): string => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// Read app timezone override from localStorage
const readStoredAppTimezone = (): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(APP_TIMEZONE_STORAGE_KEY)
  } catch {
    return null
  }
}

// Save app timezone override to localStorage
const storeAppTimezone = (timezone: string | null): void => {
  if (typeof localStorage === 'undefined') return
  try {
    if (timezone) {
      localStorage.setItem(APP_TIMEZONE_STORAGE_KEY, timezone)
    } else {
      localStorage.removeItem(APP_TIMEZONE_STORAGE_KEY)
    }
    // Dispatch custom event to notify components in the same tab (e.g., settings panel)
    window.dispatchEvent(new CustomEvent('taskwatch-timezone-changed', { detail: { timezone } }))
  } catch {
    // ignore
  }
}

// Get effective timezone (app override if set, otherwise system)
const getEffectiveTimezone = (appTimezoneOverride: string | null): string => {
  return appTimezoneOverride || getCurrentSystemTimezone()
}

// Check if a city's timezone matches the effective app timezone
const isCityInEffectiveTimezone = (cityFullName: string, appTimezoneOverride: string | null): boolean => {
  const cityTimezone = getIanaTimezoneForCity(cityFullName)
  if (!cityTimezone) return false
  const effectiveTimezone = getEffectiveTimezone(appTimezoneOverride)
  return cityTimezone === effectiveTimezone
}

// ========== TIMEZONE UTILITIES (Option C: Google/Apple approach) ==========
// Instead of calculating offsets between timezones, we ask the browser
// "what time is this UTC timestamp in timezone X?" and use that directly.

// Reusable DateTimeFormat instances per timezone (much cheaper than creating new ones)
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>()
const getDateTimeFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = dateTimeFormatCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    dateTimeFormatCache.set(timeZone, formatter)
  }
  return formatter
}

// Reusable formatter for extracting time parts (reuses dateTimeFormatCache)
const getTimePartsInTimezone = (utcMs: number, tz: string): {
  year: number
  month: number  // 1-indexed (1-12)
  day: number
  hour: number
  minute: number
  second: number
} => {
  const formatter = getDateTimeFormatter(tz)
  const parts = formatter.formatToParts(new Date(utcMs))
  
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0
  for (const part of parts) {
    switch (part.type) {
      case 'year': year = parseInt(part.value, 10); break
      case 'month': month = parseInt(part.value, 10); break
      case 'day': day = parseInt(part.value, 10); break
      case 'hour': hour = parseInt(part.value, 10); break
      case 'minute': minute = parseInt(part.value, 10); break
      case 'second': second = parseInt(part.value, 10); break
    }
  }
  
  return { year, month, day, hour, minute, second }
}

// Returns "YYYY-MM-DD" date key for a UTC timestamp in the given timezone
const getDateKeyInTimezone = (utcMs: number, tz: string): string => {
  const { year, month, day } = getTimePartsInTimezone(utcMs, tz)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Returns 0-100 position on the day timeline for a UTC timestamp in the given timezone
const getPositionPercentInTimezone = (utcMs: number, tz: string): number => {
  const { hour, minute, second } = getTimePartsInTimezone(utcMs, tz)
  return ((hour + minute / 60 + second / 3600) / 24) * 100
}

// Get minutes from midnight (0-1439) for a UTC timestamp in the given timezone
// This is useful for extracting the wall-clock time for repeating rule creation
const getMinutesFromMidnightInTimezone = (utcMs: number, tz: string): number => {
  const { hour, minute } = getTimePartsInTimezone(utcMs, tz)
  return hour * 60 + minute
}

// Get the UTC timestamp for midnight on a given date in a given timezone
// dateKey is "YYYY-MM-DD" format
const getMidnightUtcForDateInTimezone = (dateKey: string, tz: string): number => {
  // Parse the date key
  const [year, month, day] = dateKey.split('-').map(Number)
  
  // Create a date string that represents midnight in the target timezone
  // We use a binary search approach to find the exact UTC time
  // Start with a rough estimate assuming UTC
  const roughEstimate = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  
  // Check what date this rough estimate shows in the target timezone
  const checkDate = getDateKeyInTimezone(roughEstimate, tz)
  
  if (checkDate === dateKey) {
    // We're on the right day, now find exact midnight
    const parts = getTimePartsInTimezone(roughEstimate, tz)
    // Subtract the hours/minutes/seconds to get to midnight
    const msToSubtract = (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000
    return roughEstimate - msToSubtract
  }
  
  // If the date is different, we need to adjust
  // The target timezone is ahead or behind UTC
  if (checkDate < dateKey) {
    // We're behind the target date, add hours
    let adjusted = roughEstimate + 14 * 60 * 60 * 1000 // Add up to 14 hours (max TZ offset)
    const parts = getTimePartsInTimezone(adjusted, tz)
    const adjustedDateKey = getDateKeyInTimezone(adjusted, tz)
    if (adjustedDateKey === dateKey) {
      const msToSubtract = (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000
      return adjusted - msToSubtract
    }
  } else {
    // We're ahead of the target date, subtract hours
    let adjusted = roughEstimate - 14 * 60 * 60 * 1000
    const parts = getTimePartsInTimezone(adjusted, tz)
    const adjustedDateKey = getDateKeyInTimezone(adjusted, tz)
    if (adjustedDateKey === dateKey) {
      const msToSubtract = (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000
      return adjusted - msToSubtract
    }
  }
  
  // Fallback: just return the rough estimate (shouldn't happen in practice)
  return roughEstimate
}

// Add N days to a date key, returning the new date key
const addDaysToDateKey = (dateKey: string, days: number): string => {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Calculate the number of days between two date keys (targetKey - baseKey)
// Returns positive if targetKey is after baseKey, negative if before
const daysBetweenDateKeys = (baseKey: string, targetKey: string): number => {
  const [by, bm, bd] = baseKey.split('-').map(Number)
  const [ty, tm, td] = targetKey.split('-').map(Number)
  const baseDate = new Date(by, bm - 1, bd)
  const targetDate = new Date(ty, tm - 1, td)
  return Math.round((targetDate.getTime() - baseDate.getTime()) / DAY_DURATION_MS)
}

// Get day of week (0=Sunday, 6=Saturday) from a date key string
const getDayOfWeekFromDateKey = (dateKey: string): number => {
  const [year, month, day] = dateKey.split('-').map(Number)
  // Use UTC to avoid local timezone shifting the date
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

// Get date parts (year, month 1-12, day 1-31) from a date key string
const getDatePartsFromDateKey = (dateKey: string): { year: number; month: number; day: number } => {
  const [year, month, day] = dateKey.split('-').map(Number)
  return { year, month, day }
}

// Get "month-day" key (e.g., "12-10") from a date key string for annual matching
const monthDayKeyFromDateKey = (dateKey: string): string => {
  const { month, day } = getDatePartsFromDateKey(dateKey)
  return `${month}-${day}`
}

// Check if a date key matches a monthly rule (date-key aware version)
const matchesMonthlyDayWithDateKey = (rule: RepeatingSessionRule, dateKey: string): boolean => {
  const { year, month, day } = getDatePartsFromDateKey(dateKey)
  const pattern = ruleMonthlyPattern(rule)
  if (pattern === 'day') {
    const anchorDay = ruleDayOfMonth(rule)
    if (!Number.isFinite(anchorDay as number)) return false
    // Use UTC to avoid timezone issues when calculating last day of month
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const expectedDay = Math.min(anchorDay as number, lastDay)
    return day === expectedDay
  }
  const weekday = ruleMonthlyWeekday(rule)
  if (!Number.isFinite(weekday as number)) return false
  if (pattern === 'first') {
    // First day of month in UTC
    const firstOfMonth = new Date(Date.UTC(year, month - 1, 1))
    const offset = ((weekday as number) - firstOfMonth.getUTCDay() + 7) % 7
    const firstOccurrence = 1 + offset
    return day === firstOccurrence
  }
  // Last occurrence pattern
  const lastOfMonth = new Date(Date.UTC(year, month, 0))
  const offset = (lastOfMonth.getUTCDay() - (weekday as number) + 7) % 7
  const lastOccurrence = lastOfMonth.getUTCDate() - offset
  return day === lastOccurrence
}

// Convert a percentage position (0-100) on a day to a UTC timestamp
// Uses the day's midnight UTC as the base
const percentToUtcTimestamp = (percent: number, dayMidnightUtc: number): number => {
  return dayMidnightUtc + (percent / 100) * DAY_DURATION_MS
}

// Generate an array of midnight UTC timestamps for a range of days in a timezone
// anchorDateKey is "YYYY-MM-DD", startOffset is days before anchor (negative), count is total days
const getDayStartsInTimezone = (anchorDateKey: string, startOffset: number, count: number, tz: string): number[] => {
  const startDateKey = addDaysToDateKey(anchorDateKey, startOffset)
  const dayStarts: number[] = []
  for (let i = 0; i < count; i++) {
    const dateKey = addDaysToDateKey(startDateKey, i)
    dayStarts.push(getMidnightUtcForDateInTimezone(dateKey, tz))
  }
  return dayStarts
}

// Snapback virtual goal
// Session History: use orange→crimson gradient
// Time Overview: we render Snapback arcs with reversed sampling (crimson→orange)
const SNAPBACK_NAME = 'Snapback'
const SNAPBACK_SURFACE: SurfaceStyle = 'ember'
const SNAPBACK_COLOR_INFO: GoalColorInfo = {
  gradient: {
    css: 'linear-gradient(315deg, #fc9842 0%, #fe5f75 74%)',
    start: '#fc9842',
    end: '#fe5f75',
    angle: 315,
    stops: [
      { color: '#fc9842', position: 0 },
      { color: '#fe5f75', position: 0.74 },
    ],
  },
  solidColor: '#fe5f75',
}

// Quick List virtual goal
const QUICK_LIST_NAME = 'Quick List'
const QUICK_LIST_BUCKET_NAME = 'Quick List'
const QUICK_LIST_COLOR_INFO: GoalColorInfo = {
  gradient: {
    css: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)',
    start: '#38bdf8',
    end: '#6366f1',
    angle: 135,
    stops: [
      { color: '#38bdf8', position: 0 },
      { color: '#6366f1', position: 1 },
    ],
  },
  solidColor: '#6366f1',
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

// Searchable timezone dropdown component
type TimezoneSearchDropdownProps = {
  id?: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  labelId?: string
}

const TimezoneSearchDropdown = ({ id, value, placeholder, onChange, labelId }: TimezoneSearchDropdownProps) => {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 })
  const [menuPositionReady, setMenuPositionReady] = useState(false)

  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) {
      return TIMEZONE_CITIES
    }
    const query = searchQuery.toLowerCase().trim()
    return TIMEZONE_CITIES.filter((city) =>
      city.label.toLowerCase().includes(query) ||
      city.searchTerms.some((term) => term.includes(query))
    )
  }, [searchQuery])

  const selectedCity = useMemo(() => TIMEZONE_CITIES.find((c) => c.value === value) ?? null, [value])

  const updateMenuPosition = useCallback(() => {
    const input = inputRef.current
    const menu = menuRef.current
    if (!input || !menu) {
      return
    }
    const inputRect = input.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const spacing = 8
    
    let left = inputRect.left
    let top = inputRect.bottom + spacing
    const width = inputRect.width
    
    // Ensure menu doesn't go off-screen horizontally
    if (left + width > window.innerWidth - 16) {
      left = window.innerWidth - width - 16
    }
    if (left < 16) {
      left = 16
    }
    
    // If menu would go below viewport, show it above the input instead
    if (top + menuRect.height > window.innerHeight - 16) {
      top = inputRect.top - menuRect.height - spacing
    }
    
    setMenuPosition({ top, left, width })
    setMenuPositionReady(true)
  }, [])

  useEffect(() => {
    if (!open) {
      setMenuPositionReady(false)
      return
    }
    
    updateMenuPosition()
    
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
      
      if (container && event.target instanceof Node && container.contains(event.target)) {
        return
      }
      
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return
      }
      
      setOpen(false)
      setSearchQuery('')
    }
    document.addEventListener('click', handleClickOutside, true)
    return () => {
      document.removeEventListener('click', handleClickOutside, true)
    }
  }, [open])

  const handleInputFocus = useCallback(() => {
    setOpen(true)
    setSearchQuery('')
  }, [])

  const handleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value)
    setFocusedIndex(0)
    if (!open) {
      setOpen(true)
    }
  }, [open])

  const handleOptionSelect = useCallback(
    (nextValue: string) => {
      onChange(nextValue)
      setOpen(false)
      setSearchQuery('')
      inputRef.current?.blur()
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (!open) {
          setOpen(true)
          setFocusedIndex(0)
        } else {
          setFocusedIndex((prev) => Math.min(prev + 1, filteredOptions.length - 1))
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setFocusedIndex((prev) => Math.max(prev - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const option = filteredOptions[focusedIndex]
        if (option) {
          handleOptionSelect(option.value)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        setSearchQuery('')
        inputRef.current?.blur()
      }
    },
    [filteredOptions, focusedIndex, handleOptionSelect, open],
  )

  useEffect(() => {
    if (open && focusedIndex >= 0 && optionRefs.current[focusedIndex]) {
      optionRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex, open])

  const displayValue = open ? searchQuery : (selectedCity?.label ?? '')

  return (
    <div className="timezone-search-dropdown" ref={containerRef}>
      <input
        type="text"
        id={id}
        ref={inputRef}
        className="history-timeline__field-input timezone-search-dropdown__input"
        value={displayValue}
        placeholder={placeholder}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onKeyDown={handleKeyDown}
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-haspopup="listbox"
        autoComplete="off"
      />
      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              aria-labelledby={labelId ?? id}
              className="history-dropdown__menu"
              style={{
                position: 'fixed',
                top: menuPosition.top,
                left: menuPosition.left,
                width: menuPosition.width,
                visibility: menuPositionReady ? 'visible' : 'hidden',
                zIndex: 10000,
              }}
            >
              {filteredOptions.length === 0 ? (
                <div className="history-dropdown__empty">No cities found</div>
              ) : (
                filteredOptions.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={[
                      'history-dropdown__option',
                      option.value === value ? 'history-dropdown__option--selected' : '',
                      index === focusedIndex ? 'history-dropdown__option--focused' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => handleOptionSelect(option.value)}
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
      left.notes !== right.notes ||
      !areHistorySubtasksEqual(left.subtasks, right.subtasks) ||
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

const computePieValueFontSize = (label: string): string => {
  const length = typeof label === 'string' ? label.length : 0
  const maxBase = 1.8
  const min = 0.78
  const startShrinkAt = 6
  const dropPerChar = 0.09
  const drop = Math.max(0, length - startShrinkAt) * dropPerChar
  const maxAfterLength = Math.max(min + 0.1, maxBase - drop)
  const vwScale = 4
  return `clamp(${min}rem, ${vwScale}vw, ${maxAfterLength}rem)`
}

const formatTimeOfDay = (timestamp: number, timezone?: string | null, use24Hour: boolean = false) => {
  const date = new Date(timestamp)
  if (timezone) {
    // Use Intl.DateTimeFormat for timezone-aware formatting
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: !use24Hour,
      timeZone: timezone,
    })
    return formatter.format(date).replace(' ', '') // Remove space before AM/PM to match original format
  }
  // Fallback to local time if no timezone specified
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  
  if (use24Hour) {
    return `${hours24.toString().padStart(2, '0')}:${minutes}`
  }
  
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return `${hours12}:${minutes}${period}`
}

const formatHourLabel = (hour24: number, use24Hour: boolean = false) => {
  const normalized = ((hour24 % 24) + 24) % 24
  
  if (use24Hour) {
    return `${normalized.toString().padStart(2, '0')}:00`
  }
  
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

// Snap a timestamp to the nearest interval (in minutes). 0 = no snapping.
const snapToNearestInterval = (timestamp: number, intervalMinutes: number): number => {
  if (intervalMinutes <= 0) return timestamp
  const intervalMs = intervalMinutes * MINUTE_MS
  return Math.round(timestamp / intervalMs) * intervalMs
}

// All‑day helpers (shared across calendar + popover/editor)
// Get UTC date string "YYYY-MM-DD" from a UTC midnight timestamp
const getUtcDateKey = (utcMidnightMs: number): string => {
  const d = new Date(utcMidnightMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
// Convert a date string "YYYY-MM-DD" to UTC midnight timestamp
const dateKeyToUtcMidnight = (dateKey: string): number => {
  const [year, month, day] = dateKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

// Legacy local midnight helpers (for backwards compatibility during migration)
const toLocalMidnightTs = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const isLocalMidnightTs = (ms: number): boolean => {
  const d = new Date(ms)
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
}
// Legacy all-day detection by timestamps (for entries without isAllDay flag)
const isAllDayRangeTs = (start: number, end: number): boolean => {
  if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) return false
  if (!isLocalMidnightTs(start) || !isLocalMidnightTs(end)) return false
  const startMid = toLocalMidnightTs(start)
  const endMid = toLocalMidnightTs(end)
  const days = Math.round((endMid - startMid) / DAY_DURATION_MS)
  return days >= 1
}

// Check if an entry is all-day (prefer isAllDay flag, fallback to timestamp detection)
const isEntryAllDay = (entry: { isAllDay?: boolean; startedAt: number; endedAt: number }): boolean => {
  if (typeof entry.isAllDay === 'boolean') return entry.isAllDay
  // Fallback for entries without the flag
  return isAllDayRangeTs(entry.startedAt, entry.endedAt)
}

// Check if an entry is a skipped session (zero-elapsed entry created when skipping a repeating guide)
// These should not be displayed in the calendar as visible events
const isSkippedSession = (entry: { elapsed: number; repeatingSessionId?: string | null }): boolean => {
  return entry.elapsed === 0 && typeof entry.repeatingSessionId === 'string' && entry.repeatingSessionId.length > 0
}

const DRAG_DETECTION_THRESHOLD_PX = 3
const MIN_SESSION_DURATION_DRAG_MS = MINUTE_MS
const DRAG_HOLD_DURATION_MS = 300 // Hold duration required to start dragging/extending sessions

// Calendar interaction mode - single source of truth for pan vs create vs drag
// This ensures only one interaction can be active at a time
type CalendarInteractionMode =
  | null           // No interaction active
  | 'pending'      // Touch down, waiting to determine intent (hold timer running)
  | 'panning'      // Horizontal pan in progress
  | 'creating'     // Drag-to-create session in progress
  | 'dragging'     // Moving/resizing existing event

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
      // Swallow the outside click so underlying pickers/buttons don't auto-open
      try { event.preventDefault() } catch {}
      try { event.stopPropagation() } catch {}
      // Prevent adjacent date pickers from opening on the same click after closing time picker
      try {
        SUPPRESS_DATE_OPEN_UNTIL = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 300
      } catch {
        SUPPRESS_DATE_OPEN_UNTIL = Date.now() + 300
      }
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
    // Get the midnight of the selected date (in system timezone, as the calendar operates in system TZ)
    const selectedDayMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    // Get the midnight of the current value's day (using system TZ interpretation)
    const currentDate = new Date(value)
    const currentDayMidnight = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime()
    // Calculate the time-of-day offset from midnight (this works in display coordinates)
    const timeOfDayOffset = value - currentDayMidnight
    // Apply the same time offset to the new day
    const nextTs = selectedDayMidnight + timeOfDayOffset
    onChange(nextTs)
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
  // Optional: snap the selected option (highlight/scroll) to the nearest interval (in minutes)
  snapMinutes?: number
  // Optional: align the dropdown so the first option is this time-of-day (in minutes)
  alignFromMinutes?: number
  // Optional: anchor timestamp for aligned lists (used to compute day rollovers)
  alignAnchorTimestamp?: number
  // Optional: maximum span (in minutes) to list beyond the aligned start (default 24h)
  maxSpanMinutes?: number
  // Optional: append a relative duration label compared to this time-of-day (in minutes, modulo 24h)
  relativeToMinutes?: number
  // Optional: use 24-hour time format
  use24HourTime?: boolean
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

/**
 * Parses a user-typed time string into minutes since midnight.
 * Supports formats like: "3:45pm", "3:45 PM", "15:45", "3pm", "3 pm", "345pm", "1545"
 * Returns null if the string cannot be parsed.
 */
const parseTimeString = (input: string): number | null => {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null

  // Check for AM/PM suffix
  const isPm = /pm$/.test(trimmed) || /p\.?m\.?$/.test(trimmed)
  const isAm = /am$/.test(trimmed) || /a\.?m\.?$/.test(trimmed)
  const cleaned = trimmed.replace(/\s*(a\.?m\.?|p\.?m\.?)$/i, '').trim()

  let hours = 0
  let minutes = 0

  // Try HH:MM or H:MM format
  const colonMatch = cleaned.match(/^(\d{1,2}):(\d{2})$/)
  if (colonMatch) {
    hours = parseInt(colonMatch[1], 10)
    minutes = parseInt(colonMatch[2], 10)
  } else {
    // Try HHMM format (e.g., "1545" or "345")
    const numericMatch = cleaned.match(/^(\d{1,4})$/)
    if (numericMatch) {
      const num = numericMatch[1]
      if (num.length <= 2) {
        // Just hours (e.g., "3" or "15")
        hours = parseInt(num, 10)
        minutes = 0
      } else if (num.length === 3) {
        // H:MM (e.g., "345" -> 3:45)
        hours = parseInt(num[0], 10)
        minutes = parseInt(num.slice(1), 10)
      } else if (num.length === 4) {
        // HH:MM (e.g., "1545" -> 15:45)
        hours = parseInt(num.slice(0, 2), 10)
        minutes = parseInt(num.slice(2), 10)
      }
    } else {
      return null
    }
  }

  // Validate ranges
  if (minutes < 0 || minutes > 59) return null
  if (hours < 0 || hours > 23) {
    // Allow 12-hour format hours (1-12)
    if (hours < 1 || hours > 12) return null
  }

  // Convert 12-hour to 24-hour if AM/PM specified
  if (isPm || isAm) {
    if (hours > 12) return null // Invalid: "15pm" doesn't make sense
    if (isPm && hours !== 12) hours += 12
    if (isAm && hours === 12) hours = 0
  }

  // Final validation
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

  return hours * 60 + minutes
}

const InspectorTimeInput = ({
  value,
  onChange,
  ariaLabel,
  snapMinutes,
  alignFromMinutes,
  alignAnchorTimestamp,
  maxSpanMinutes = 24 * 60,
  relativeToMinutes,
  use24HourTime = false,
}: InspectorTimeInputProps) => {
  const [open, setOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      // Swallow the outside click so underlying pickers/buttons don't auto-open
      try { event.preventDefault() } catch {}
      try { event.stopPropagation() } catch {}
      try {
        SUPPRESS_DATE_OPEN_UNTIL = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 300
      } catch {
        SUPPRESS_DATE_OPEN_UNTIL = Date.now() + 300
      }
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

  const snapInterval = typeof snapMinutes === 'number' && Number.isFinite(snapMinutes) ? Math.max(1, Math.round(snapMinutes)) : null
  const date = new Date(value)
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const label = formatTimeOfDay(value, undefined, use24HourTime)
  const currentMinutes = hours * 60 + minutes
  const highlightedMinutes = Math.min(23 * 60 + 45, Math.max(0, Math.round(currentMinutes / 15) * 15))

  const baseAnchorTimestamp = typeof alignAnchorTimestamp === 'number' && Number.isFinite(alignAnchorTimestamp)
    ? alignAnchorTimestamp
    : value
  const rawAlignMinutes = typeof alignFromMinutes === 'number' && Number.isFinite(alignFromMinutes)
    ? Math.max(0, Math.min(1439, Math.round(alignFromMinutes)))
    : null
  const alignMinutes = rawAlignMinutes === null
    ? null
    : (() => {
        if (!snapInterval) return rawAlignMinutes
        const snapped = Math.round(rawAlignMinutes / snapInterval) * snapInterval
        // Normalize to 0-1439 to avoid 1440 edge
        return ((snapped % 1440) + 1440) % 1440
      })()
  const relMinutes = typeof relativeToMinutes === 'number' && Number.isFinite(relativeToMinutes)
    ? Math.max(0, Math.min(1439, Math.round(relativeToMinutes)))
    : null

  const alignedAnchorTimestamp = (() => {
    if (alignMinutes === null) return baseAnchorTimestamp
    const d = new Date(baseAnchorTimestamp)
    d.setHours(Math.floor(alignMinutes / 60), alignMinutes % 60, 0, 0)
    return d.getTime()
  })()

  const orderedOptions = (() => {
    if (alignMinutes === null) {
      // Generate labels dynamically based on use24HourTime setting
      return TIME_OPTIONS.map((opt) => {
        const sample = new Date(2020, 0, 1, 0, 0)
        sample.setMinutes(opt.minutes)
        const label = formatTimeOfDay(sample.getTime(), undefined, use24HourTime)
        return { ...opt, label, offsetMinutes: opt.minutes, dayOffset: 0 }
      })
    }
    const span = Math.max(0, Math.min(24 * 60, Math.round(maxSpanMinutes / 15) * 15))
    const steps = Math.round(span / 15)
    const result: Array<{ label: string; minutes: number; offsetMinutes: number; dayOffset: number }> = []
    for (let step = 0; step <= steps; step += 1) {
      const offsetMinutes = step * 15
      const totalMinutes = alignMinutes + offsetMinutes
      const minutesOfDay = ((totalMinutes % 1440) + 1440) % 1440
      const dayOffset = Math.floor(totalMinutes / 1440)
      const sample = new Date(2020, 0, 1, 0, 0)
      sample.setMinutes(minutesOfDay)
      const label = formatTimeOfDay(sample.getTime(), undefined, use24HourTime)
      result.push({ label, minutes: minutesOfDay, offsetMinutes, dayOffset })
    }
    return result
  })()

  const selectedOffsetMinutes = (() => {
    if (alignMinutes === null) return null
    const delta = Math.round((value - alignedAnchorTimestamp) / 60000)
    const clamped = Math.max(0, Math.min(maxSpanMinutes, delta))
    if (snapInterval === null) return clamped
    const snapped = Math.round(clamped / snapInterval) * snapInterval
    return Math.max(0, Math.min(maxSpanMinutes, snapped))
  })()

  // Double-click to edit time
  const handleDoubleClick = () => {
    setEditValue(label)
    setIsEditing(true)
  }

  // Ref callback to focus and select when input mounts (only on first mount)
  const hasSelectedRef = useRef(false)
  const handleInputRef = (el: HTMLInputElement | null) => {
    inputRef.current = el
    if (el && !hasSelectedRef.current) {
      hasSelectedRef.current = true
      // Focus immediately
      el.focus()
      // Select all text - try multiple times to handle touch keyboard delays
      el.setSelectionRange(0, el.value.length)
      requestAnimationFrame(() => {
        el.setSelectionRange(0, el.value.length)
      })
    }
  }

  // Reset the selection flag when editing ends
  useEffect(() => {
    if (!isEditing) {
      hasSelectedRef.current = false
    }
  }, [isEditing])

  const commitEditRef = useRef<() => void>(() => {})
  commitEditRef.current = () => {
    const parsed = parseTimeString(editValue)
    if (parsed !== null) {
      // Apply the parsed time to the current day
      const dayStart = new Date(value)
      dayStart.setHours(0, 0, 0, 0)
      const nextTs = dayStart.getTime() + parsed * 60000
      onChange(nextTs)
    }
    setIsEditing(false)
  }

  const commitEdit = () => commitEditRef.current()

  // Handle clicking outside when editing - commit the edit
  useEffect(() => {
    if (!isEditing) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (inputRef.current?.contains(target)) return
      // Click was outside - commit the edit
      commitEditRef.current()
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [isEditing])

  const cancelEdit = () => {
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  const handleSelect = (option: { minutes: number; offsetMinutes: number }) => {
    const { minutes, offsetMinutes } = option
    // For aligned lists, respect day rollover by using the anchor timestamp plus offset minutes
    if (alignMinutes !== null) {
      const nextTs = alignedAnchorTimestamp + offsetMinutes * 60000
      onChange(nextTs)
    } else {
      // Compute day start in display coordinates and add selected minutes.
      // This avoids timezone issues with setHours() which uses system timezone.
      const dayStart = new Date(value)
      dayStart.setHours(0, 0, 0, 0)
      const nextTs = dayStart.getTime() + minutes * 60000
      onChange(nextTs)
    }
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
      {isEditing ? (
        <input
          ref={handleInputRef}
          type="text"
          inputMode="text"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          className="inspector-picker__button history-timeline__field-input history-timeline__field-input--editing"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleEditKeyDown}
          style={{ width: '100%', textAlign: 'center' }}
        />
      ) : (
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
          onDoubleClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            handleDoubleClick()
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
        >
          {label}
        </button>
      )}
      {open ? (
        <div className="inspector-picker__popover inspector-picker__popover--time" ref={popoverRef} role="listbox">
          <ul className="inspector-time-picker">
            {orderedOptions.map((option) => {
              const selected =
                alignMinutes === null
                  ? option.minutes === highlightedMinutes
                  : selectedOffsetMinutes !== null && option.offsetMinutes === selectedOffsetMinutes
              const itemClass = [
                'inspector-time-picker__option',
                selected ? 'inspector-time-picker__option--selected' : '',
              ]
                .filter(Boolean)
                .join(' ')
              const deltaForLabel = (() => {
                if (alignMinutes !== null) {
                  return option.offsetMinutes
                }
                if (relMinutes !== null) {
                  const diff = option.minutes - relMinutes
                  return diff < 0 ? diff + 1440 : diff
                }
                return null
              })()
              const relativeLabel =
                deltaForLabel === null
                  ? null
                  : (() => {
                      const delta = deltaForLabel
                      if (delta === 0) return '0 mins'
                      if (delta === 1440) return '24 hrs'
                      const hours = Math.floor(delta / 60)
                      const minutesRemain = delta % 60
                      if (minutesRemain === 0) {
                        return `${hours} hr${hours === 1 ? '' : 's'}`
                      }
                      if (hours === 0) return `${minutesRemain} mins`
                      return `${hours} hr${hours === 1 ? '' : 's'} ${minutesRemain} min${minutesRemain === 1 ? '' : 's'}`
                    })()
              return (
                <li key={`${option.minutes}-${option.dayOffset}`}>
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
                      handleSelect(option)
                      try { triggerRef.current?.focus() } catch {}
                    }}
                    onClick={(e) => {
                      // Keyboard or fallback click
                      try { e.preventDefault() } catch {}
                      try { e.stopPropagation() } catch {}
                      handleSelect(option)
                      try { triggerRef.current?.focus() } catch {}
                    }}
                  >
                    {relativeLabel ? `${option.label} (${relativeLabel})` : option.label}
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

const formatDatePart = (timestamp: number, use24Hour: boolean = false) => {
  const date = new Date(timestamp)
  const day = date.getDate()
  const month = date.toLocaleString(undefined, { month: 'short' })
  const year = date.getFullYear()
  const hours24 = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  
  if (use24Hour) {
    return {
      dateLabel: `${day}/${month}/${year}`,
      timeLabel: `${hours24.toString().padStart(2, '0')}:${minutes}`,
    }
  }
  
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  return {
    dateLabel: `${day}/${month}/${year}`,
    timeLabel: `${hours12}:${minutes}${period}`,
  }
}

const formatDateRange = (start: number, end: number, use24Hour: boolean = false) => {
  const startPart = formatDatePart(start, use24Hour)
  const endPart = formatDatePart(end, use24Hour)

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
  purple: 'linear-gradient(135deg, #5A00B8 0%, #C66BFF 100%)',
  green: 'linear-gradient(135deg, #34d399 0%, #10b981 45%, #0ea5e9 100%)',
  magenta: 'linear-gradient(-225deg, #A445B2 0%, #D41872 52%, #FF0066 100%)',
  blue: 'linear-gradient(135deg, #005bea 0%, #00c6fb 100%)',
  orange: 'linear-gradient(135deg, #ff5b14 0%, #ffc64d 100%)',
}

const cssColorRegex = /(#(?:[0-9a-fA-F]{3}){1,2}|rgba?\([^)]+\)|hsla?\([^)]+\))/gi

const parseCssColor = (value: string): { r: number; g: number; b: number } | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#')) {
    const normalized = normalizeHexColor(trimmed)
    return normalized ? hexToRgb(normalized) : null
  }
  const rgbMatch = trimmed.match(/^rgba?\(\s*([^)]+)\s*\)$/i)
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((p) => p.trim())
    if (parts.length >= 3) {
      const [r, g, b] = parts.slice(0, 3).map((p) => Number(p))
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        return { r, g, b }
      }
    }
  }
  const hslMatch = trimmed.match(/^hsla?\(\s*([^)]+)\s*\)$/i)
  if (hslMatch) {
    const parts = hslMatch[1].split(',').map((p) => p.trim())
    if (parts.length >= 3) {
      const h = Number(parts[0])
      const s = Number(parts[1].replace('%', '')) / 100
      const l = Number(parts[2].replace('%', '')) / 100
      if ([h, s, l].every((n) => Number.isFinite(n))) {
        const c = (1 - Math.abs(2 * l - 1)) * s
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
        const m = l - c / 2
        let r1 = 0
        let g1 = 0
        let b1 = 0
        if (h >= 0 && h < 60) {
          r1 = c
          g1 = x
        } else if (h >= 60 && h < 120) {
          r1 = x
          g1 = c
        } else if (h >= 120 && h < 180) {
          g1 = c
          b1 = x
        } else if (h >= 180 && h < 240) {
          g1 = x
          b1 = c
        } else if (h >= 240 && h < 300) {
          r1 = x
          b1 = c
        } else if (h >= 300 && h < 360) {
          r1 = c
          b1 = x
        }
        return {
          r: (r1 + m) * 255,
          g: (g1 + m) * 255,
          b: (b1 + m) * 255,
        }
      }
    }
  }
  return null
}

const parseGoalGradient = (gradient: string): GoalGradientInfo | null => {
  const trimmed = gradient.trim()
  if (!trimmed.includes('gradient(')) {
    return null
  }
  const colorMatches = Array.from(trimmed.matchAll(cssColorRegex)).map((m) => m[0])
  const pctMatches = Array.from(trimmed.matchAll(/(\d+(?:\.\d+)?)%/g)).map((m) => Number(m[1]))
  if (colorMatches.length === 0) {
    return null
  }
  const stops: GradientStop[] = []
  for (let i = 0; i < colorMatches.length; i += 1) {
    const rgb = parseCssColor(colorMatches[i])
    if (!rgb) continue
    const pct =
      pctMatches.length === colorMatches.length
        ? pctMatches[i] / 100
        : i / Math.max(1, colorMatches.length - 1)
    stops.push({ color: rgbToHex(rgb.r, rgb.g, rgb.b), position: clamp01(pct) })
  }
  if (stops.length < 2) {
    return null
  }
  stops.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const angleMatch = trimmed.match(/(-?\d+(?:\.\d+)?)deg/)
  return {
    css: gradient,
    start: stops[0].color,
    end: stops[stops.length - 1].color,
    angle: angleMatch ? Number.parseFloat(angleMatch[1]) : undefined,
    stops,
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

  // If we can't parse colors, return undefined so surfaces can fall back gracefully.
  return undefined
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
  // ID of the placeholder history entry currently being recorded (hidden from UI)
  activeSessionEntryId?: string | null
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
  const rawActiveSessionEntryId = typeof candidate.activeSessionEntryId === 'string' ? candidate.activeSessionEntryId.trim() : ''
  const activeSessionEntryId = rawActiveSessionEntryId.length > 0 ? rawActiveSessionEntryId : null
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
    activeSessionEntryId,
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

/**
 * Splits concurrent history entries into non-overlapping time slices.
 * When events overlap, the shorter event takes priority during the overlap period.
 * 
 * Example: If "eat" runs from 2-3pm and "run" runs from 2:30-2:45pm:
 * - eat: 2:00-2:30pm
 * - run: 2:30-2:45pm (takes priority as it's shorter)
 * - eat: 2:45-3:00pm
 */
type TimeSlice = {
  entry: HistoryEntry
  start: number
  end: number
  originalDuration: number
}

const splitConcurrentEvents = (
  history: HistoryEntry[],
  windowStart: number,
  windowEnd: number,
): TimeSlice[] => {
  // Create time slices for each entry, clamped to the window
  const entries = history
    .map((entry) => {
      const start = Math.min(entry.startedAt, entry.endedAt)
      const end = Math.max(entry.startedAt, entry.endedAt)
      const originalDuration = end - start
      
      // Skip if completely outside window
      if (end <= windowStart || start >= windowEnd) {
        return null
      }
      
      const clampedStart = Math.max(start, windowStart)
      const clampedEnd = Math.min(end, windowEnd)
      
      if (clampedEnd <= clampedStart) {
        return null
      }
      
      return {
        entry,
        start: clampedStart,
        end: clampedEnd,
        originalDuration,
      }
    })
    .filter((e): e is TimeSlice => e !== null)
  
  if (entries.length === 0) {
    return []
  }
  
  // Collect all unique time points (boundaries)
  const timePoints = new Set<number>()
  entries.forEach(({ start, end }) => {
    timePoints.add(start)
    timePoints.add(end)
  })
  
  const sortedTimes = Array.from(timePoints).sort((a, b) => a - b)
  
  if (sortedTimes.length < 2) {
    return entries
  }
  
  const resultSlices: TimeSlice[] = []
  
  // For each time interval, find which entry should be active
  for (let i = 0; i < sortedTimes.length - 1; i++) {
    const intervalStart = sortedTimes[i]
    const intervalEnd = sortedTimes[i + 1]
    
    if (intervalEnd <= intervalStart) {
      continue
    }
    
    // Find all entries active during this interval
    const activeEntries = entries.filter(
      (e) => e.start <= intervalStart && e.end >= intervalEnd
    )
    
    if (activeEntries.length === 0) {
      continue
    }
    
    // If only one entry, use it directly
    if (activeEntries.length === 1) {
      resultSlices.push({
        entry: activeEntries[0].entry,
        start: intervalStart,
        end: intervalEnd,
        originalDuration: activeEntries[0].originalDuration,
      })
      continue
    }
    
    // Multiple entries overlap - pick the one with shortest original duration
    const winner = activeEntries.reduce((shortest, current) =>
      current.originalDuration < shortest.originalDuration ? current : shortest
    )
    
    resultSlices.push({
      entry: winner.entry,
      start: intervalStart,
      end: intervalEnd,
      originalDuration: winner.originalDuration,
    })
  }
  
  return resultSlices
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

  // Filter out all-day blocks before splitting (they distort time-of-day breakdown)
  const filteredHistory = history.filter((entry) => {
    const start = Math.min(entry.startedAt, entry.endedAt)
    const end = Math.max(entry.startedAt, entry.endedAt)
    return !isAllDayRangeTs(start, end)
  })

  // Split concurrent events - shorter events take priority during overlaps
  const slices = splitConcurrentEvents(filteredHistory, windowStart, now)

  slices.forEach((slice) => {
    const overlapMs = Math.max(0, slice.end - slice.start)
    if (overlapMs <= 0) {
      return
    }
    const metadata = resolveGoalMetadata(slice.entry, taskLookup, goalColorLookup, lifeRoutineSurfaceLookup)
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

type ReflectionPageProps = {
  use24HourTime?: boolean
  weekStartDay?: 0 | 1 // 0 = Sunday, 1 = Monday
  defaultCalendarView?: 2 | 3 | 4 | 5 | 6 | 'week'
  snapToInterval?: 0 | 5 | 10 | 15 // 0 = none, or minutes
}

export default function ReflectionPage({ use24HourTime = false, weekStartDay = 0, defaultCalendarView = 6, snapToInterval = 0 }: ReflectionPageProps) {
  // App timezone override - allows user to switch timezones without changing system settings
  const [appTimezone, setAppTimezone] = useState<string | null>(() => readStoredAppTimezone())
  // Deferred timezone for heavy computations (calendar/timeline) - avoids blocking UI
  const deferredAppTimezone = useDeferredValue(appTimezone)
  
  // Handler to update app timezone and persist to localStorage + DB
  // Wrapped in startTransition to avoid blocking UI during heavy calendar re-renders
  const updateAppTimezone = useCallback((timezone: string | null) => {
    storeAppTimezone(timezone)
    startTransition(() => {
      setAppTimezone(timezone)
    })
    
    // Save to DB if signed in
    const ownerId = readHistoryOwnerId()
    if (ownerId && ownerId !== HISTORY_GUEST_USER_ID && supabase) {
      void (async () => {
        try {
          await supabase
            .from('profiles')
            .update({ app_timezone: timezone })
            .eq('id', ownerId)
        } catch {
          // Ignore errors - localStorage is the source of truth for UI
        }
      })()
    }
  }, [appTimezone])
  
  // Listen for timezone being cleared (e.g., on sign-out) and reset in-memory state
  useEffect(() => {
    // Handle cross-tab storage changes
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === APP_TIMEZONE_STORAGE_KEY) {
        // Timezone was changed or removed - sync in-memory state
        const newValue = event.newValue
        if (!newValue || newValue === '') {
          // Timezone was cleared (sign-out) - reset to system default
          startTransition(() => {
            setAppTimezone(null)
          })
        } else if (newValue !== appTimezone) {
          // Timezone was changed from another tab - sync
          startTransition(() => {
            setAppTimezone(newValue)
          })
        }
      }
    }
    
    // Handle same-tab timezone reset (custom event from App.tsx on sign-in/sign-out)
    const handleTimezoneReset = () => {
      startTransition(() => {
        setAppTimezone(null)
      })
    }

    // Handle same-tab timezone changes (from settings panel)
    const handleTimezoneChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ timezone: string | null }>
      if (customEvent.detail) {
        const newTimezone = customEvent.detail.timezone
        if (newTimezone !== appTimezone) {
          startTransition(() => {
            setAppTimezone(newTimezone)
          })
        }
      }
    }
    
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('taskwatch-timezone-reset', handleTimezoneReset)
    window.addEventListener('taskwatch-timezone-changed', handleTimezoneChanged)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('taskwatch-timezone-reset', handleTimezoneReset)
      window.removeEventListener('taskwatch-timezone-changed', handleTimezoneChanged)
    }
  }, [appTimezone])
  
  // Timezone-aware time formatter for RAW UTC timestamps
  // This applies timezone conversion during display formatting
  const formatTime = useCallback((timestamp: number) => {
    return formatTimeOfDay(timestamp, deferredAppTimezone, use24HourTime)
  }, [deferredAppTimezone, use24HourTime])
  
  // Get display name for current effective timezone (uses immediate value for UI)
  const effectiveTimezoneDisplay = useMemo(() => {
    const effective = appTimezone || getCurrentSystemTimezone()
    // Try to find a friendly city name for this timezone
    const cityEntry = Object.entries(CITY_TO_IANA_TIMEZONE).find(([, tz]) => tz === effective)
    if (cityEntry) {
      return extractCityName(cityEntry[0]) // Just the city name
    }
    // Fallback to IANA timezone formatted nicely
    return effective.replace(/_/g, ' ').split('/').pop() || effective
  }, [appTimezone])
  
  // Check if app timezone differs from system timezone (uses immediate value for UI)
  const isUsingCustomTimezone = useMemo(() => {
    if (!appTimezone) return false
    return appTimezone !== getCurrentSystemTimezone()
  }, [appTimezone])
  
  type CalendarViewMode = 'day' | '3d' | 'week' | 'month' | 'year'
  const [calendarView, setCalendarView] = useState<CalendarViewMode>(() => 
    defaultCalendarView === 'week' ? 'week' : '3d'
  )
  const calendarViewRef = useRef<CalendarViewMode>(calendarView)
  
  useEffect(() => {
    calendarViewRef.current = calendarView
  }, [calendarView])
  // No explicit visibility gating; transforms are guarded until measured
  const [multiDayCount, setMultiDayCount] = useState<number>(() => 
    typeof defaultCalendarView === 'number' ? defaultCalendarView : 6
  )
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
  // Single source of truth for calendar interaction mode - prevents pan/create conflicts
  const calendarInteractionModeRef = useRef<CalendarInteractionMode>(null)
  // Timer ref for the hold-to-create delay
  const calendarHoldTimerRef = useRef<number | null>(null)
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
  } | null>(null)
  const calendarPanCleanupRef = useRef<((shouldCommit: boolean) => void) | null>(null)
  const calendarPanFallbackTimeoutRef = useRef<number | null>(null)
  const calendarPanDesiredOffsetRef = useRef<number>(historyDayOffset)
  // Repeating sessions (rules fetched from backend)
  const [repeatingRules, setRepeatingRules] = useState<RepeatingSessionRule[]>(() => readLocalRepeatingRules())
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
      state: { baseOffset: number; startTime: number; dayCount: number; mode?: 'pending' | 'hdrag' },
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
      const absRaw = Math.abs(effectiveRaw)
      const direction = effectiveRaw >= 0 ? 1 : -1

      if (view !== '3d') {
        // Day/week: always page by at least one chunk based on swipe direction (no half-threshold)
        const steps = Math.max(1, Math.round(absRaw + 0.1))
        const snap = direction * steps * snapUnitSpan
        const targetOffset = state.baseOffset - snap
        return { snap, targetOffset }
      }

      // For 3d (X day) view: free-form panning with no minimum snap
      // Just snap to the nearest day based on where the user dragged
      const snapUnits = Math.round(rawDays)
      const snap = snapUnits
      const targetOffset = state.baseOffset - snap
      return { snap, targetOffset }
    },
    [],
  )
  const [activeRange, setActiveRange] = useState<ReflectionRangeKey>('24h')
  // Snapback overview uses its own range and defaults to All Time
  const [snapActiveRange] = useState<SnapRangeKey>('all')
  const [history, setHistory] = useState<HistoryEntry[]>(() => readPersistedHistory())
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
  // Quick List state
  const [quickListItems, setQuickListItems] = useState<QuickItem[]>(() => readStoredQuickList())
  // Quick List remote IDs (goalId, bucketId) for Supabase - fetched on mount
  const [_quickListRemoteIds, setQuickListRemoteIds] = useState<{ goalId: string; bucketId: string } | null>(null)
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
  // Use touch-action: none so JS has full control over gestures (no browser race condition)
  const calendarTouchAction = 'none'
  // Ref to the session name input inside the calendar editor modal (for autofocus on new entries)
  const calendarEditorNameInputRef = useRef<HTMLInputElement | null>(null)
  // Track when we should auto-focus the name input (for touch devices that need immediate focus)
  const pendingNameInputFocusRef = useRef(false)
  
  // Callback ref for the name input that focuses immediately on mount when pending
  const calendarEditorNameInputCallbackRef = useCallback((node: HTMLInputElement | null) => {
    calendarEditorNameInputRef.current = node
    if (node && pendingNameInputFocusRef.current) {
      pendingNameInputFocusRef.current = false
      // Focus synchronously - critical for touch devices to show keyboard
      try {
        node.focus()
        const len = node.value?.length ?? 0
        node.setSelectionRange(len, len)
      } catch {}
    }
  }, [])

  const isInspectorInteractiveTarget = useCallback((target: HTMLElement | null) => {
    if (!target) return false
    return Boolean(
      target.closest(
        'button, input, select, textarea, [role="option"], [role="listbox"], [role="menu"], .inspector-picker__button, .inspector-picker__popover, .history-dropdown__button, .history-dropdown__menu, .history-timeline__field-input',
      ),
    )
  }, [])

  const handleInspectorSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null
      if (isInspectorInteractiveTarget(target)) {
        return
      }
      try { event.preventDefault() } catch {}
      try { event.stopPropagation() } catch {}
    },
    [isInspectorInteractiveTarget],
  )

  const handleInspectorSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null
      if (isInspectorInteractiveTarget(target)) {
        return
      }
      try { event.preventDefault() } catch {}
      try { event.stopPropagation() } catch {}
    },
    [isInspectorInteractiveTarget],
  )

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
  // Helper: toggle global scroll lock (prevents page scroll during active event drags)
  // mode: 'full' = block all scrolling (for event drag), 'vertical' = block only vertical (for calendar pan)
  const setPageScrollLock = (locked: boolean, mode: 'full' | 'vertical' = 'full') => {
    if (typeof document === 'undefined') return
    const body = document.body as HTMLBodyElement & { dataset: DOMStringMap }
    if (locked) {
      // If already locked, no-op
      if (body.dataset.scrollLockActive === '1') return
      body.dataset.scrollLockActive = '1'
      
      // Use touch-action based on mode
      const originalTouchAction = body.style.touchAction
      const originalOverscrollBehavior = body.style.overscrollBehavior
      ;(window as any).__scrollLockOriginalTouchAction = originalTouchAction
      ;(window as any).__scrollLockOriginalOverscrollBehavior = originalOverscrollBehavior
      body.style.touchAction = mode === 'full' ? 'none' : 'pan-x'
      body.style.overscrollBehavior = 'none'
      
      // Prevent wheel events based on mode
      const wheelPreventer: EventListener = (e: Event) => {
        const wheelEvent = e as WheelEvent
        if (mode === 'full') {
          // Block all wheel scrolling
          try { e.preventDefault() } catch {}
        } else {
          // Only prevent vertical scrolling, allow horizontal
          if (Math.abs(wheelEvent.deltaY) > Math.abs(wheelEvent.deltaX)) {
            try { e.preventDefault() } catch {}
          }
        }
      }
      // Prevent touchmove as a stronger fallback for touch devices
      const touchPreventer: EventListener = (e: Event) => {
        // Always prevent default to stop scrolling during drag
        try { e.preventDefault() } catch {}
      }
      ;(window as any).__scrollLockWheelPreventer = wheelPreventer
      ;(window as any).__scrollLockTouchPreventer = touchPreventer
      try { 
        window.addEventListener('wheel', wheelPreventer, { passive: false })
        // Add touchmove preventer with capture phase to catch it early
        window.addEventListener('touchmove', touchPreventer, { passive: false, capture: true })
      } catch {}
    } else {
      // If not locked, no-op
      if (body.dataset.scrollLockActive !== '1') return
      delete body.dataset.scrollLockActive
      
      // Restore original touch-action and overscroll-behavior
      const originalTouchAction = (window as any).__scrollLockOriginalTouchAction
      const originalOverscrollBehavior = (window as any).__scrollLockOriginalOverscrollBehavior
      if (typeof originalTouchAction === 'string') {
        body.style.touchAction = originalTouchAction
      } else {
        body.style.touchAction = ''
      }
      if (typeof originalOverscrollBehavior === 'string') {
        body.style.overscrollBehavior = originalOverscrollBehavior
      } else {
        body.style.overscrollBehavior = ''
      }
      delete (window as any).__scrollLockOriginalTouchAction
      delete (window as any).__scrollLockOriginalOverscrollBehavior
      
      // Remove event preventers
      const wheelPreventer = (window as any).__scrollLockWheelPreventer as EventListener | undefined
      const touchPreventer = (window as any).__scrollLockTouchPreventer as EventListener | undefined
      if (wheelPreventer) {
        try { window.removeEventListener('wheel', wheelPreventer) } catch {}
        delete (window as any).__scrollLockWheelPreventer
      }
      if (touchPreventer) {
        try { window.removeEventListener('touchmove', touchPreventer, { capture: true } as any) } catch {}
        delete (window as any).__scrollLockTouchPreventer
      }
    }
  }

  // Release scroll lock when user switches tabs or navigates away
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // User switched away - release any scroll lock
        setPageScrollLock(false)
        // Also reset interaction mode to prevent stuck state
        calendarInteractionModeRef.current = null
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      // Also release lock on unmount (page navigation)
      setPageScrollLock(false)
    }
  }, [])

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

  // Fetch Quick List remote IDs on mount
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ids = await ensureQuickListRemoteStructures()
      if (!cancelled && ids) {
        setQuickListRemoteIds(ids)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Subscribe to Quick List updates
  useEffect(() => {
    const unsubscribe = subscribeQuickList((items) => setQuickListItems(items))
    return () => {
      unsubscribe?.()
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
    // Clear interaction mode and hold timer when day offset changes
    calendarInteractionModeRef.current = null
    if (calendarHoldTimerRef.current !== null) {
      try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
      calendarHoldTimerRef.current = null
    }
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
  const refetchSnapDbRows = useCallback(async () => {
    try {
      const rows = await apiFetchSnapbackRows()
      if (Array.isArray(rows)) setSnapDbRows(rows)
    } catch (err) {
      logWarn('[Snapback] Failed to refetch overview rows', err)
    }
  }, [])
  
  // Initial load
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
  
  // Cross-tab sync subscription
  useEffect(() => {
    const unsubscribe = subscribeToSnapbackSync(() => {
      refetchSnapDbRows()
    })
    return unsubscribe
  }, [refetchSnapDbRows])

  // Local triggers for guest users (stored in localStorage) - defined early for snapbackTriggerOptions
  const LOCAL_TRIGGERS_KEY = 'nc-taskwatch-local-snapback-triggers'
  type LocalTrigger = { id: string; label: string; cue: string; deconstruction: string; plan: string }
  const [localTriggers, setLocalTriggers] = useState<LocalTrigger[]>(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_TRIGGERS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed as LocalTrigger[]
      }
    } catch {}
    return []
  })
  // Persist local triggers to localStorage and broadcast for cross-tab sync
  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_TRIGGERS_KEY, JSON.stringify(localTriggers))
      broadcastSnapbackUpdate()
    } catch {}
  }, [localTriggers])
  
  // Storage listener for localTriggers moved to after snapPlans is defined (for proper sync)
  
  const isGuestUser = !historyOwnerId || historyOwnerId === HISTORY_GUEST_USER_ID

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

  const snapbackTriggerOptions = useMemo(() => {
    const titles = new Set<string>()
    // Add all triggers from DB
    snapDbRows.forEach((row) => {
      const label = (row.trigger_name ?? '').trim()
      if (label) titles.add(label)
    })
    // Include local triggers (guest users)
    localTriggers.forEach((lt) => {
      const label = (lt.label ?? '').trim()
      if (label) titles.add(label)
    })
    // Include triggers from history (for guest users with sample data)
    history.forEach((entry) => {
      const goalLower = (entry.goalName ?? '').trim().toLowerCase()
      if (goalLower === 'snapback') {
        const bucket = (entry.bucketName ?? '').trim()
        if (bucket) titles.add(bucket)
      }
    })
    return Array.from(titles).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [snapDbRows, localTriggers, history])

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

  const computeEntryScheduledStart = useCallback((entry: HistoryEntry, tz: string): number => {
    // Use provided timezone for wall-clock time extraction
    const minutes = getMinutesFromMidnightInTimezone(entry.startedAt, tz)
    const dateKey = getDateKeyInTimezone(entry.startedAt, tz)
    const dayStart = getMidnightUtcForDateInTimezone(dateKey, tz)
    return dayStart + minutes * 60000
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

  // Sync goals snapshot from Supabase when user is logged in
  // This ensures gradient colors are available immediately without waiting for GoalsPage
  useEffect(() => {
    const owner = readGoalsSnapshotOwner()
    if (!owner || owner === GOALS_GUEST_USER_ID) {
      return
    }
    // Skip fetch if we just did a full sync (e.g. after auth callback)
    if (isRecentlyFullSynced()) {
      return
    }
    let cancelled = false
    void (async () => {
      const synced = await syncGoalsSnapshotFromSupabase()
      if (cancelled || !synced) {
        return
      }
      const signature = JSON.stringify(synced)
      if (goalsSnapshotSignatureRef.current !== signature) {
        goalsSnapshotSignatureRef.current = signature
        setGoalsSnapshot(synced)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [historyOwnerSignal])

  const goalLookup = useMemo(() => createGoalTaskMap(goalsSnapshot), [goalsSnapshot])
  const goalColorLookup = useMemo(() => {
    const map = createGoalColorMap(goalsSnapshot)
    // Add Quick List color
    map.set(QUICK_LIST_NAME.toLowerCase(), QUICK_LIST_COLOR_INFO)
    return map
  }, [goalsSnapshot])
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
      // Compute a start time one hour from now, snapped to minute
      const now = Date.now()
      const start = Math.max(now + 60 * 60 * 1000, now + 60 * 1000)
      // Navigate calendar so today is in the second column of the 6-day view
      // Offset by -1 means the first column is yesterday, second column is today
      const dayOffsetForScheduled = -1
      setHistoryDayOffset(dayOffsetForScheduled)
      historyDayOffsetRef.current = dayOffsetForScheduled
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
    const normalizedQuickList = QUICK_LIST_NAME.toLowerCase()
    const normalizedQuickListHidden = QUICK_LIST_GOAL_NAME.toLowerCase()
    const seen = new Set<string>()
    const ordered: string[] = []
    goalsSnapshot.forEach((goal) => {
      const trimmed = goal.name?.trim()
      if (!trimmed || goal.archived) {
        return
      }
      const normalized = trimmed.toLowerCase()
      // Skip special goals
      if (normalized === normalizedLifeRoutines || normalized === normalizedSnapback || normalized === normalizedQuickList || normalized === normalizedQuickListHidden) {
        return
      }
      if (seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      ordered.push(trimmed)
    })
    // Insert special options: Daily Life, Quick List, Snapback, then regular goals
    return [LIFE_ROUTINES_NAME, QUICK_LIST_NAME, SNAPBACK_NAME, ...ordered]
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
    map.set(SNAPBACK_NAME, snapbackTriggerOptions)
    // Quick List has a single bucket
    map.set(QUICK_LIST_NAME, [QUICK_LIST_BUCKET_NAME])
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
  const isSnapbackGoalSelected = trimmedDraftGoal.toLowerCase() === SNAPBACK_NAME.toLowerCase()
  const isLifeRoutineGoalSelected = trimmedDraftGoal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()
  const isQuickListGoalSelected = trimmedDraftGoal.toLowerCase() === QUICK_LIST_NAME.toLowerCase()

  const availableBucketOptions = useMemo(() => {
    const normalizedGoal = trimmedDraftGoal.toLowerCase()
    if (trimmedDraftGoal.length > 0) {
      const match = bucketOptionsByGoal.get(trimmedDraftGoal)
      const isSnapback = normalizedGoal === SNAPBACK_NAME.toLowerCase()
      if (match && (match.length > 0 || isSnapback)) {
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
    // For Quick List: show quick list items as task options
    if (isQuickListGoalSelected) {
      return quickListItems
        .filter((item) => !item.completed)
        .map((item) => item.text)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    }
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
  }, [trimmedDraftGoal, trimmedDraftBucket, tasksByGoalBucket, allTaskOptions, isQuickListGoalSelected, quickListItems])

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
    const normalizedQuickList = QUICK_LIST_NAME.toLowerCase()
    const optionsWithoutSpecial = resolvedGoalOptions.filter((option) => {
      const lower = option.trim().toLowerCase()
      return lower !== normalizedLifeRoutines && lower !== normalizedSnapback && lower !== normalizedQuickList
    })
    const hasLifeOption =
      resolvedGoalOptions.some((option) => option.trim().toLowerCase() === normalizedLifeRoutines) ||
      lifeRoutineBucketOptions.length > 0
    const next: HistoryDropdownOption[] = [{ value: '', label: 'No goal' }]
    // System Layers section
    next.push({ value: '__hdr_system_layers__', label: 'System Layers', disabled: true })
    if (hasLifeOption) {
      next.push({ value: LIFE_ROUTINES_NAME, label: LIFE_ROUTINES_NAME })
    }
    // Include Quick List after Daily Life, before Snapback
    next.push({ value: QUICK_LIST_NAME, label: QUICK_LIST_NAME })
    // Include Snapback
    next.push({ value: SNAPBACK_NAME, label: SNAPBACK_NAME })
    // Your Goals section
    if (optionsWithoutSpecial.length > 0) {
      next.push({ value: '__hdr_your_goals__', label: 'Your Goals', disabled: true })
      optionsWithoutSpecial.forEach((option) => {
        next.push({ value: option, label: option })
      })
    }
    return next
  }, [lifeRoutineBucketOptions, resolvedGoalOptions])

  const bucketDropdownOptions = useMemo<HistoryDropdownOption[]>(
    () => {
      const emptyLabel =
        isSnapbackGoalSelected && snapbackTriggerOptions.length === 0 ? 'No triggers yet' : 'No bucket'
      const options: HistoryDropdownOption[] = isSnapbackGoalSelected || isLifeRoutineGoalSelected || isQuickListGoalSelected ? [] : [{ value: '', label: emptyLabel }]
      
      // For Quick List: bucket is locked to "Quick List"
      if (isQuickListGoalSelected) {
        options.push({ value: QUICK_LIST_BUCKET_NAME, label: QUICK_LIST_BUCKET_NAME })
        return options
      }
      
      // For Daily Life: show existing routines section and other options
      if (isLifeRoutineGoalSelected) {
        if (resolvedBucketOptions.length > 0) {
          options.push({ value: '__hdr_existing_routines__', label: 'Existing Daily Life Routines', disabled: true })
          options.push(...resolvedBucketOptions.map((option) => ({ value: option, label: option })))
        }
        options.push({ value: '__hdr_other_options__', label: 'Other Options', disabled: true })
        options.push({ value: TIMEZONE_CHANGE_MARKER, label: TIMEZONE_CHANGE_MARKER })
        return options
      }
      
      // For Snapback: offer to create a new trigger from the session name if it doesn't already exist
      if (isSnapbackGoalSelected) {
        const name = historyDraft.taskName.trim()
        const triggerExistsAlready = name.length > 0 && snapbackTriggerOptions.some(
          (opt) => opt.toLowerCase() === name.toLowerCase()
        )
        if (name.length > 0 && !triggerExistsAlready) {
          options.push({ value: '__hdr_create_trigger__', label: 'Create from session', disabled: true })
          const label = `➕ Add as new trigger: "${name}"`
          options.push({ value: '__add_snapback_trigger__', label })
          if (resolvedBucketOptions.length > 0) {
            options.push({ value: '__hdr_existing_triggers__', label: 'Existing triggers', disabled: true })
          }
        }
      }
      
      options.push(...resolvedBucketOptions.map((option) => ({ value: option, label: option })))
      return options
    },
    [resolvedBucketOptions, isSnapbackGoalSelected, isLifeRoutineGoalSelected, isQuickListGoalSelected, snapbackTriggerOptions, historyDraft.taskName],
  )

  const bucketDropdownPlaceholder = useMemo(() => {
    if (isSnapbackGoalSelected && snapbackTriggerOptions.length === 0) {
      return 'No triggers yet'
    }
    if (isLifeRoutineGoalSelected) {
      return availableBucketOptions.length > 0 ? 'Select routine' : 'Select an option'
    }
    if (isQuickListGoalSelected) {
      return QUICK_LIST_BUCKET_NAME
    }
    return availableBucketOptions.length > 0 ? 'Select bucket' : 'No buckets available'
  }, [isSnapbackGoalSelected, isLifeRoutineGoalSelected, isQuickListGoalSelected, availableBucketOptions.length, snapbackTriggerOptions.length])
  const bucketDropdownDisabled = useMemo(() => {
    // Quick List bucket is locked and cannot be changed
    if (isQuickListGoalSelected) return true
    // Daily Life and Snapback always have options (at minimum, the special actions)
    if (isLifeRoutineGoalSelected || isSnapbackGoalSelected) return false
    return availableBucketOptions.length === 0
  }, [isSnapbackGoalSelected, isLifeRoutineGoalSelected, isQuickListGoalSelected, availableBucketOptions.length])
  const taskDropdownDisabled = useMemo(() => {
    // Daily Life and Snapback don't have tasks - the "task" is really the routine/trigger selected in bucket
    if (isLifeRoutineGoalSelected || isSnapbackGoalSelected) return true
    return taskDropdownOptions.length === 0
  }, [isLifeRoutineGoalSelected, isSnapbackGoalSelected, taskDropdownOptions.length])

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
        updateHistory((current) => {
          const next = current.filter((e) => e.id !== entryId)
          return next
        })
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
    const entry: HistoryEntry = {
      id: makeHistoryId(),
      taskName: 'New session',
      goalName: LIFE_ROUTINES_NAME,
      bucketName: null,
      goalId: LIFE_ROUTINES_GOAL_ID,
      bucketId: null,
      taskId: null,
      elapsed,
      startedAt,
      endedAt,
      goalSurface: LIFE_ROUTINES_SURFACE,
      bucketSurface: null,
      entryColor: gradientFromSurface(LIFE_ROUTINES_SURFACE),
      notes: '',
      subtasks: [],
      futureSession: true,
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
        
        // Handle goal changes
        if (field === 'goalName') {
          const nextGoal = nextValue.trim().toLowerCase()
          const prevGoal = draft.goalName.trim().toLowerCase()
          const isQuickList = nextGoal === QUICK_LIST_NAME.toLowerCase()
          
          // When goal changes, reset bucket (but preserve task name)
          if (nextGoal !== prevGoal) {
            if (isQuickList) {
              // Quick List: auto-set the bucket, preserve task name
              base = { ...base, bucketName: QUICK_LIST_BUCKET_NAME }
            } else {
              // All other goals: reset bucket only, preserve task name
              base = { ...base, bucketName: '' }
            }
          }
        }
        
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
          // For timezone markers, set duration to 1 minute
          if (nextBucket === TIMEZONE_CHANGE_MARKER) {
            // Use draft's startedAt if available, otherwise fall back to entry's startedAt
            const startTs = base.startedAt ?? selectedHistoryEntryRef.current?.startedAt ?? null
            if (startTs !== null) {
              const endTs = startTs + MINUTE_MS
              base = { ...base, startedAt: startTs, endedAt: endTs }
            }
          }
          // For Life Routines: auto-fill task name with bucket name only if task name is empty
          // or was previously auto-filled (not manually typed by the user)
          const effectiveGoal = base.goalName.trim()
          const isLifeRoutine = effectiveGoal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()
          if (isLifeRoutine && nextBucket.length > 0) {
            const currentTaskName = base.taskName.trim()
            const shouldAutofill = currentTaskName.length === 0 || taskNameAutofilledRef.current
            if (shouldAutofill) {
              taskNameAutofilledRef.current = true
              return { ...base, taskName: nextBucket }
            }
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
      // When user manually changes task name, mark it as no longer auto-filled
      if (field === 'taskName') {
        taskNameAutofilledRef.current = false
      }
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
      // Handle special action to create a new Snapback trigger from session name
      if (nextValue === '__add_snapback_trigger__') {
        const name = historyDraft.taskName.trim()
        if (name.length === 0) return
        ;(async () => {
          // Check for existing plan data under history-derived ID
          const historyDerivedId = `trigger-${name}`
          const existingPlan = snapPlansRef.current[historyDerivedId] ?? localSnapPlansRef.current[historyDerivedId]
          
          if (isGuestUser) {
            // Guest user: create local trigger with existing plan data if available
            const newId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const newTrigger: LocalTrigger = { 
              id: newId, 
              label: name, 
              cue: existingPlan?.cue ?? '', 
              deconstruction: existingPlan?.deconstruction ?? '', 
              plan: existingPlan?.plan ?? '' 
            }
            setLocalTriggers((cur) => [...cur, newTrigger])
            // Set the bucket to the new trigger name
            updateHistoryDraftField('bucketName', name)
          } else {
            // Authenticated user: create via API
            const row = await apiCreateSnapbackTrigger(name)
            if (row) {
              // If there was existing plan data, update the new row
              if (existingPlan && (existingPlan.cue || existingPlan.deconstruction || existingPlan.plan)) {
                const updated = await apiUpsertSnapbackPlanById(row.id, {
                  cue_text: existingPlan.cue,
                  deconstruction_text: existingPlan.deconstruction,
                  plan_text: existingPlan.plan,
                })
                if (updated) {
                  setSnapDbRows((cur) => [...cur, updated])
                } else {
                  setSnapDbRows((cur) => [...cur, row])
                }
              } else {
                setSnapDbRows((cur) => [...cur, row])
              }
              broadcastSnapbackUpdate()
              // Set the bucket to the new trigger name
              updateHistoryDraftField('bucketName', name)
            }
          }
        })()
        return
      }

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
    [bucketIdLookup, bucketOptionsByGoal, bucketToGoals, historyDraft.bucketName, historyDraft.goalName, historyDraft.taskName, isGuestUser, moveTaskToBucket, taskIdLookup, taskToOwners, updateHistoryDraftField],
  )

  const getSubtaskParent = useCallback(() => {
    const entry = selectedHistoryEntryRef.current
    if (!entry) return null
    if (entry.taskId) return { taskId: entry.taskId }
    return entry.id ? { sessionId: entry.id } : null
  }, [])

  const publishLocalGoalsSnapshot = useCallback((snapshot: GoalSnapshot[], options?: { allowWhileEditing?: boolean }) => {
    if (editorOpenRef.current && !options?.allowWhileEditing) {
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
          publishLocalGoalsSnapshot(updated, { allowWhileEditing: true })
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
          publishLocalGoalsSnapshot(updated, { allowWhileEditing: true })
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
          publishLocalGoalsSnapshot(updated, { allowWhileEditing: true })
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
    
    // Draft timestamps are now in UTC (since dayStarts uses display timezone bounds).
    // If draft.startedAt is null, we fall back to entry's existing timestamp.
    const draftStartedAt = draft.startedAt !== null ? draft.startedAt : selectedHistoryEntry.startedAt
    const draftEndedAt = draft.endedAt !== null ? draft.endedAt : selectedHistoryEntry.endedAt
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
    // Timezone change markers are always 1 minute in duration
    if (nextBucketName === TIMEZONE_CHANGE_MARKER) {
      nextEndedAt = nextStartedAt + MINUTE_MS
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
    const normalizedTaskName = nextTaskName.toLowerCase()
    const taskLookupKey = `${goalKey}::${bucketKey}::${normalizedTaskName}`
    const matchesExistingTask =
      prevTaskId &&
      (selectedHistoryEntry.goalName ?? '').trim().toLowerCase() === goalKey &&
      (selectedHistoryEntry.bucketName ?? '').trim().toLowerCase() === bucketKey &&
      selectedHistoryEntry.taskName.trim().toLowerCase() === normalizedTaskName
    const resolvedTaskId =
      hasGoalName && hasBucketName && nextTaskName.length > 0
        ? taskIdLookup.get(taskLookupKey) ?? (matchesExistingTask ? prevTaskId : null)
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
        areHistorySubtasksEqual(target.subtasks, nextSubtasks) &&
        (target.timezoneFrom ?? '') === draft.timezoneFrom &&
        (target.timezoneTo ?? '') === draft.timezoneTo
      ) {
        return current
      }
      const next = [...current]
      // Evaluate futureSession changes based on start time and current state
      const nowTs = Date.now()
      const wasInPast = target.startedAt <= nowTs
      const nowInPast = nextStartedAt <= nowTs
      const crossedBoundary = wasInPast !== nowInPast
      const computedFutureSession = (() => {
        // Newly created sessions always stay as future until explicitly confirmed
        if (pendingNewHistoryId && target.id === pendingNewHistoryId) {
          return true
        }
        // If start time crossed to future: become unconfirmed
        if (crossedBoundary && !nowInPast) {
          return true
        }
        // If start time crossed to past: become confirmed
        if (crossedBoundary && nowInPast) {
          return false
        }
        // Stale unconfirmed session (futureSession=true but start in past):
        // Any edit confirms it, since user is interacting with it
        if (target.futureSession && nowInPast) {
          return false
        }
        // Otherwise preserve current state
        return target.futureSession
      })()
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
        futureSession: computedFutureSession,
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
        timezoneFrom: draft.timezoneFrom || null,
        timezoneTo: draft.timezoneTo || null,
      }
      didUpdateHistory = true
      return next
    })
    // After saving, reset draft timestamps to null so future saves read from the entry
    // (which has the canonical storage-space values). This prevents double-unadjusting
    // if save is called multiple times.
    const normalizedDraft: HistoryDraftState = {
      taskName: nextTaskName,
      goalName: normalizedGoalName,
      bucketName: normalizedBucketName,
      startedAt: null,
      endedAt: null,
      notes: nextNotes,
      subtasks: cloneHistorySubtasks(nextSubtasks),
      timezoneFrom: draft.timezoneFrom,
      timezoneTo: draft.timezoneTo,
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
    // For existing entries, commit any pending draft changes (notes, etc.) before closing.
    // Flip the editor flag off so goal snapshots can publish to other tabs.
    editorOpenRef.current = false
    commitHistoryDraft()
    setCalendarInspectorEntryId(null)
    setEditingHistoryId(null)
  }, [
    commitHistoryDraft,
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
    // Allow timezone change marker for Daily Life goal
    const isLifeRoutine = goalName.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase()
    if (isLifeRoutine && bucketName === TIMEZONE_CHANGE_MARKER) {
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
      if (event.key?.startsWith(HISTORY_STORAGE_KEY)) {
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

  // Subscribe to repeating rules changes for real-time cross-tab sync
  useEffect(() => {
    const unsubscribe = subscribeToRepeatingRulesChange((rules) => {
      setRepeatingRules(rules)
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
      // Still filter out the placeholder entry even if no effective elapsed
      const placeholderEntryId = activeSession.activeSessionEntryId
      if (placeholderEntryId) {
        return baseHistory.filter((entry) => entry.id !== placeholderEntryId)
      }
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
    // Filter out the synthetic active-session entry and the placeholder entry being recorded
    const placeholderEntryId = activeSession.activeSessionEntryId
    const filteredHistory = baseHistory.filter(
      (entry) => entry.id !== activeEntry.id && entry.id !== placeholderEntryId,
    )
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
  const pieValueLabel = useMemo(() => formatDuration(loggedMs), [loggedMs])
  const pieValueFontSize = useMemo(() => computePieValueFontSize(pieValueLabel), [pieValueLabel])
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

  // Snap Back Overview data (counts + duration by trigger_name within active range)
  const snapbackOverview = useMemo(() => {
    const now = Date.now()
    const windowMs = SNAP_RANGE_DEFS[snapActiveRange].durationMs
    const windowStart = now - windowMs
    const totals = new Map<string, { count: number; label: string; durationMs: number }>()

    // Build trigger_name lookup from DB rows
    const triggerNames = new Set<string>()
    snapDbRows.forEach((row) => {
      const name = (row.trigger_name ?? '').trim()
      if (name) triggerNames.add(name)
    })

    effectiveHistory.forEach((entry) => {
      const start = Math.min(entry.startedAt, entry.endedAt)
      const end = Math.max(entry.startedAt, entry.endedAt)
      if (end <= windowStart || start >= now) return
      const clampedStart = Math.max(start, windowStart)
      const clampedEnd = Math.min(end, now)
      const overlapMs = Math.max(0, clampedEnd - clampedStart)
      if (overlapMs <= 0) return
      const goalLower = (entry.goalName ?? '').trim().toLowerCase()
      // Only match entries with explicit Snapback goal — use bucket name as trigger
      if (goalLower !== SNAPBACK_NAME.toLowerCase()) return
      const bucket = (entry.bucketName ?? '').trim()
      if (!bucket) return
      const existing = totals.get(bucket)
      if (existing) {
        existing.count += 1
        existing.durationMs += overlapMs
      } else {
        totals.set(bucket, { count: 1, label: bucket, durationMs: overlapMs })
      }
    })

    const items = Array.from(totals.entries())
      .map(([triggerName, info]) => ({ triggerName, count: info.count, label: info.label, durationMs: info.durationMs }))
      .sort((a, b) => (b.count === a.count ? b.durationMs - a.durationMs : b.count - a.count))

    // Match to DB rows or local triggers to get the ID, or use trigger- prefix for history-derived triggers
    const legend = items.map((item) => {
      const dbRow = snapDbRows.find((r) => r.trigger_name.toLowerCase() === item.triggerName.toLowerCase())
      const localTrigger = localTriggers.find((lt) => lt.label.toLowerCase() === item.triggerName.toLowerCase())
      const id = dbRow?.id ?? localTrigger?.id ?? `trigger-${item.triggerName}`
      const color = getPaletteColorForLabel(item.label)
      return { id, label: item.label, count: item.count, durationMs: item.durationMs, swatch: color }
    })

    const total = items.reduce((sum, it) => sum + it.count, 0)
    const maxDurationMs = legend.reduce((max, it) => Math.max(max, it.durationMs), 0)
    return { legend, total, windowMs, maxDurationMs }
  }, [effectiveHistory, snapActiveRange, snapDbRows, localTriggers])

  // Auto-create DB rows for orphaned triggers (history has sessions but no DB row)
  const autoCreatedTriggersRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (isGuestUser) return // Guests use localStorage, not DB
    const orphanedItems = snapbackOverview.legend.filter(
      (item) => item.id.startsWith('trigger-') && !autoCreatedTriggersRef.current.has(item.label)
    )
    if (orphanedItems.length === 0) return

    const createMissing = async () => {
      for (const item of orphanedItems) {
        try {
          autoCreatedTriggersRef.current.add(item.label)
          
          // Check for existing plan data under the history-derived ID
          const historyDerivedId = `trigger-${item.label}`
          const existingPlan = snapPlansRef.current[historyDerivedId] ?? localSnapPlansRef.current[historyDerivedId]
          
          const row = await apiGetOrCreateTrigger(item.label)
          if (row) {
            // If there was existing plan data, update the new row with it
            if (existingPlan && (existingPlan.cue || existingPlan.deconstruction || existingPlan.plan)) {
              const updated = await apiUpsertSnapbackPlanById(row.id, {
                cue_text: existingPlan.cue,
                deconstruction_text: existingPlan.deconstruction,
                plan_text: existingPlan.plan,
              })
              if (updated) {
                setSnapDbRows((prev) => {
                  if (prev.some((r) => r.id === updated.id)) return prev
                  return [...prev, updated]
                })
              } else {
                setSnapDbRows((prev) => {
                  if (prev.some((r) => r.id === row.id)) return prev
                  return [...prev, row]
                })
              }
            } else {
              setSnapDbRows((prev) => {
                if (prev.some((r) => r.id === row.id)) return prev
                return [...prev, row]
              })
            }
            broadcastSnapbackUpdate()
          }
        } catch (err) {
          logWarn('[Snapback] Failed to auto-create trigger for orphan:', item.label, err)
        }
      }
    }
    createMissing()
  }, [snapbackOverview.legend, isGuestUser])

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

  // Local plans for guest users (history-derived snap-* triggers)
  const LOCAL_SNAP_PLANS_KEY = 'nc-taskwatch-local-snap-plans'
  const [localSnapPlans, setLocalSnapPlans] = useState<Record<string, { cue: string; deconstruction: string; plan: string }>>(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_SNAP_PLANS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null) return parsed
      }
    } catch {}
    return {}
  })
  // Ref to access localSnapPlans in callbacks without stale closures
  const localSnapPlansRef = useRef<Record<string, { cue: string; deconstruction: string; plan: string }>>({})
  useEffect(() => { localSnapPlansRef.current = localSnapPlans }, [localSnapPlans])
  
  // Persist local plans to localStorage and broadcast for cross-tab sync
  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_SNAP_PLANS_KEY, JSON.stringify(localSnapPlans))
      broadcastSnapbackUpdate()
    } catch {}
  }, [localSnapPlans])
  
  // Listen for localStorage changes from other tabs (guest mode plan sync)
  // We need to update both localSnapPlans AND snapPlans when another tab changes
  const localSnapPlansStorageRef = useRef<Record<string, { cue: string; deconstruction: string; plan: string }>>({})
  useEffect(() => {
    localSnapPlansStorageRef.current = localSnapPlans
  }, [localSnapPlans])
  
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LOCAL_SNAP_PLANS_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue)
          if (typeof parsed === 'object' && parsed !== null) {
            setLocalSnapPlans(parsed)
            // Also update snapPlans for UI to reflect changes
            setSnapPlans((cur) => {
              const updated = { ...cur }
              Object.entries(parsed as Record<string, { cue: string; deconstruction: string; plan: string }>).forEach(([key, plan]) => {
                updated[key] = { cue: plan.cue, deconstruction: plan.deconstruction, plan: plan.plan }
              })
              return updated
            })
          }
        } catch {}
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // Snapback plans (DB-backed); initialize empty and hydrate from DB rows
  type SnapbackPlan = { cue: string; deconstruction: string; plan: string }
  type SnapbackPlanState = Record<string, SnapbackPlan>
  const [snapPlans, setSnapPlans] = useState<SnapbackPlanState>({})
  const snapPlansRef = useRef<SnapbackPlanState>({})
  useEffect(() => { snapPlansRef.current = snapPlans }, [snapPlans])
  
  // Listen for localStorage changes from other tabs (guest mode localTriggers sync)
  // This is here because setSnapPlans needs to be defined first
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LOCAL_TRIGGERS_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue)
          if (Array.isArray(parsed)) {
            const triggers = parsed as LocalTrigger[]
            setLocalTriggers(triggers)
            // Also update snapPlans with the plan data from triggers
            setSnapPlans((cur) => {
              const updated = { ...cur }
              triggers.forEach((t) => {
                updated[t.id] = { cue: t.cue, deconstruction: t.deconstruction, plan: t.plan }
              })
              return updated
            })
          }
        } catch {}
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])
  
  const saveTimersRef = useRef<Map<string, number>>(new Map())
  // Ref to access localTriggers in persistPlanForId without causing re-renders
  const localTriggersRef = useRef<LocalTrigger[]>([])
  const setLocalTriggersRef = useRef<React.Dispatch<React.SetStateAction<LocalTrigger[]>>>(() => {})
  const persistPlanForId = useCallback(async (idKey: string, planOverride?: { cue: string; deconstruction: string; plan: string }) => {
    const plan = planOverride ?? (snapPlansRef.current[idKey] ?? { cue: '', deconstruction: '', plan: '' })
    if (!plan) return
    // Check if this is a local trigger (guest user)
    const localTrigger = localTriggersRef.current.find((t) => t.id === idKey)
    if (localTrigger) {
      // Update local trigger in state (which will persist to localStorage)
      setLocalTriggersRef.current((cur) => cur.map((t) => 
        t.id === idKey ? { ...t, cue: plan.cue, deconstruction: plan.deconstruction, plan: plan.plan } : t
      ))
      setSnapPlans((cur) => ({ ...cur, [idKey]: { ...plan } }))
      return
    }
    // Check if we have a DB row for this trigger
    const row = snapDbRows.find((r) => r.id === idKey)
    // For triggers without a DB row (history-derived or guest), save to local storage
    if (!row) {
      setLocalSnapPlans((cur) => ({ ...cur, [idKey]: { cue: plan.cue, deconstruction: plan.deconstruction, plan: plan.plan } }))
      setSnapPlans((cur) => ({ ...cur, [idKey]: { ...plan } }))
      return
    }
    // For DB-backed triggers, update by row ID
    const updated = await apiUpsertSnapbackPlanById(row.id, {
      cue_text: plan.cue,
      deconstruction_text: plan.deconstruction,
      plan_text: plan.plan,
    })
    if (updated) {
      startTransition(() => {
        setSnapDbRows((cur) => {
          const idx = cur.findIndex((r) => r.id === updated.id)
          if (idx >= 0) { const copy = cur.slice(); copy[idx] = updated; return copy }
          return [...cur, updated]
        })
        setSnapPlans((cur) => ({ ...cur, [idKey]: { ...plan } }))
      })
      broadcastSnapbackUpdate()
    }
  }, [snapDbRows])
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
      const prevIdKeyRef = useRef(idKey)
      const prevInitialPlanRef = useRef(initialPlan)
      const hasUserEditedRef = useRef(false)
      const draftRef = useRef(draft)
      useEffect(() => { draftRef.current = draft }, [draft])
      
      // Reset draft when switching triggers OR when initialPlan changes externally
      useEffect(() => {
        // If idKey changed, always reset
        if (prevIdKeyRef.current !== idKey) {
          setDraft(initialPlan)
          prevIdKeyRef.current = idKey
          prevInitialPlanRef.current = initialPlan
          hasUserEditedRef.current = false
          return
        }
        // Check if initialPlan changed
        const prevPlan = prevInitialPlanRef.current
        const planChanged = prevPlan.cue !== initialPlan.cue || 
                           prevPlan.deconstruction !== initialPlan.deconstruction || 
                           prevPlan.plan !== initialPlan.plan
        if (!planChanged) return
        
        // Check if this is an external change (from another tab)
        // External change: initialPlan is different from current draft
        const currentDraft = draftRef.current
        const isExternalChange = (
          initialPlan.cue !== currentDraft.cue ||
          initialPlan.deconstruction !== currentDraft.deconstruction ||
          initialPlan.plan !== currentDraft.plan
        )
        
        // Always update for external changes (cross-tab sync)
        // Also update if user hasn't edited yet
        if (isExternalChange || !hasUserEditedRef.current) {
          setDraft(initialPlan)
          prevInitialPlanRef.current = initialPlan
          // Reset edit flag for external changes so user can keep editing
          if (isExternalChange) {
            hasUserEditedRef.current = false
          }
        }
      }, [idKey, initialPlan])
      
      const handleChange = (next: { cue: string; deconstruction: string; plan: string }) => {
        hasUserEditedRef.current = true
        setDraft(next)
        onScheduleSave(idKey, next)
      }
      
      return (
        <>
          <div className="snapback-drawer__group">
            <label className="snapback-drawer__label">Why is this happening?</label>
            {/* Hint removed */}
            <input
              type="text"
              className="snapback-drawer__input"
              placeholder="Any lead-ups or triggers?"
              value={draft.cue}
              onChange={(e) => {
                handleChange({ cue: e.target.value, deconstruction: draft.deconstruction, plan: draft.plan })
              }}
            />
          </div>

          <div className="snapback-drawer__group">
            <label className="snapback-drawer__label">Is it aligned with who you want to be? What's the reward, is it sustainable?</label>
            {/* Hint removed */}
            <textarea
              className="snapback-drawer__textarea"
              placeholder="What is the short-term reward and the long-term cost?"
              value={draft.deconstruction}
              onChange={(e) => {
                handleChange({ cue: draft.cue, deconstruction: e.target.value, plan: draft.plan })
              }}
            />
          </div> 

          <div className="snapback-drawer__group">
            <label className="snapback-drawer__label">How do you change it next time?</label>
            {/* Hint removed */}
            <textarea
              className="snapback-drawer__textarea"
              placeholder="Write one small thing you’ll try..."
              value={draft.plan}
              onChange={(e) => {
                handleChange({ cue: draft.cue, deconstruction: draft.deconstruction, plan: e.target.value })
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

  // Keep refs in sync for use in persistPlanForId callback
  useEffect(() => { localTriggersRef.current = localTriggers }, [localTriggers])
  useEffect(() => { setLocalTriggersRef.current = setLocalTriggers }, [])

  // DEPRECATED: snapbackAliases removed - renaming now updates trigger_name directly
  const LOCAL_ALIASES_KEY = 'nc-taskwatch-local-snap-aliases'
  // DEPRECATED: no longer using aliases, but keep for local storage cleanup
  useEffect(() => {
    // Clean up old aliases localStorage key
    try { window.localStorage.removeItem(LOCAL_ALIASES_KEY) } catch {}
  }, [])

  

  // Hydrate snapPlans from DB rows and local triggers
  useEffect(() => {
    const mergedPlans: SnapbackPlanState = {}
    // From DB rows
    snapDbRows.forEach((row) => {
      mergedPlans[row.id] = {
        cue: row.cue_text ?? '',
        deconstruction: row.deconstruction_text ?? '',
        plan: row.plan_text ?? '',
      }
    })
    // From local triggers (guest users)
    localTriggers.forEach((lt) => {
      mergedPlans[lt.id] = {
        cue: lt.cue ?? '',
        deconstruction: lt.deconstruction ?? '',
        plan: lt.plan ?? '',
      }
    })
    // From localSnapPlans (guest users with history-derived triggers)
    for (const [idKey, planData] of Object.entries(localSnapPlans)) {
      mergedPlans[idKey] = {
        cue: planData.cue ?? '',
        deconstruction: planData.deconstruction ?? '',
        plan: planData.plan ?? '',
      }
    }
    setSnapPlans((cur) => {
      const next: SnapbackPlanState = { ...cur }
      // Update existing plans with fresh data from DB/localStorage
      // This ensures cross-tab sync works for authenticated users
      for (const [k, v] of Object.entries(mergedPlans)) {
        next[k] = v
      }
      return next
    })
  }, [snapDbRows, localTriggers, localSnapPlans])

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
    if (isGuestUser) {
      // Guest user: create local trigger
      const newId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newTrigger: LocalTrigger = { id: newId, label: 'New Trigger', cue: '', deconstruction: '', plan: '' }
      setLocalTriggers((cur) => [...cur, newTrigger])
      setSelectedTriggerKey(newId)
      setEditingTriggerId(newId)
      return
    }
    // Authenticated user: create via API
    const row = await apiCreateSnapbackTrigger('New Trigger')
    if (!row) return
    setSnapDbRows((cur) => [...cur, row])
    broadcastSnapbackUpdate()
    setSelectedTriggerKey(row.id)
    setEditingTriggerId(row.id)
  }, [isGuestUser])
  const commitEditTrigger = useCallback(async () => {
    if (!editingTriggerId) return
    const raw = editTriggerInputRef.current?.value ?? ''
    const trimmed = raw.trim()
    const newLabel = trimmed.length === 0 ? 'New Trigger' : trimmed
    // Check if this is a local trigger (guest user)
    const isLocalTrigger = localTriggers.some((t) => t.id === editingTriggerId)
    if (isLocalTrigger) {
      setLocalTriggers((cur) => cur.map((t) => (t.id === editingTriggerId ? { ...t, label: newLabel } : t)))
      setEditingTriggerId(null)
      return
    }
    // Authenticated user: update via API
    const currentRow = snapDbRows.find((r) => r.id === editingTriggerId)
    const oldName = currentRow?.trigger_name ?? ''
    const ok = await apiRenameSnapbackTrigger(editingTriggerId, newLabel, oldName)
    if (ok) {
      setSnapDbRows((cur) => cur.map((r) => (r.id === editingTriggerId ? { ...r, trigger_name: newLabel } as DbSnapbackOverview : r)))
      broadcastSnapbackUpdate()
    }
    setEditingTriggerId(null)
  }, [editingTriggerId, localTriggers, snapDbRows])

  const combinedLegend = useMemo(() => {
    // Base legend comes from session history stats
    const base = snapbackOverview.legend
    // Track which trigger names are already represented
    const existingNames = new Set(base.map((it) => it.label.toLowerCase().trim()))
    
    // Add DB triggers that have no session history (count=0)
    const dbExtras = snapDbRows
      .filter((row) => !existingNames.has(row.trigger_name.toLowerCase().trim()))
      .map((row) => ({ 
        id: row.id, 
        label: row.trigger_name, 
        count: 0, 
        durationMs: 0, 
        swatch: getPaletteColorForLabel(row.trigger_name) 
      }))
    
    // Add local triggers (guest users) that aren't already represented
    const dbExtraNames = new Set(dbExtras.map((e) => e.label.toLowerCase().trim()))
    const localExtras = localTriggers
      .filter((lt) => !existingNames.has(lt.label.toLowerCase().trim()) && !dbExtraNames.has(lt.label.toLowerCase().trim()))
      .map((lt) => ({ id: lt.id, label: lt.label, count: 0, durationMs: 0, swatch: getPaletteColorForLabel(lt.label) }))
    
    return [...base, ...dbExtras, ...localExtras]
  }, [snapbackOverview.legend, snapDbRows, localTriggers])

  // Compute all-time session counts per trigger (for delete eligibility)
  const allTimeSessionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of effectiveHistory) {
      const goalLower = (entry.goalName ?? '').trim().toLowerCase()
      if (goalLower !== SNAPBACK_NAME.toLowerCase()) continue
      const bucket = (entry.bucketName ?? '').trim().toLowerCase()
      if (!bucket) continue
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    return counts
  }, [effectiveHistory])

  // Persist current overview trigger labels for the Snapback panel to mirror
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const labels = combinedLegend.map((i) => i.label)
      window.localStorage.setItem('nc-taskwatch-overview-triggers', JSON.stringify(labels))
    } catch {}
  }, [combinedLegend.map((i) => i.label).join('|')])

  const [selectedTriggerKey, setSelectedTriggerKey] = useState<string | null>(null)
  // Stable handler for trigger selection - uses data-id attribute to avoid inline closures
  const handleTriggerSelect = useCallback((e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
    const id = (e.currentTarget as HTMLElement).dataset.id
    if (id) {
      flushSync(() => setSelectedTriggerKey(id))
    }
  }, [])
  const handleTriggerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleTriggerSelect(e)
    }
  }, [handleTriggerSelect])
  useEffect(() => {
    // Only set initial selection if null, on range change, or if current selection is no longer valid
    setSelectedTriggerKey((cur) => {
      const isValid = cur !== null && combinedLegend.some((i) => i.id === cur)
      if (isValid) return cur
      return combinedLegend[0]?.id ?? null
    })
  }, [snapActiveRange, combinedLegend.map((i) => i.id).join('|')])

  const selectedItem = useMemo(() => combinedLegend.find((i) => i.id === selectedTriggerKey) ?? combinedLegend[0] ?? null, [selectedTriggerKey, combinedLegend])
  // Use deferred value for expensive computation to keep selection feeling instant
  const deferredSelectedItem = useDeferredValue(selectedItem)

  // Compute last time the selected Snapback trigger was recorded (across all time)
  const selectedTriggerLastAtLabel = useMemo(() => {
    if (!deferredSelectedItem) return { full: 'Never', short: 'Never' }
    // Match by trigger name (the label)
    const targetName = deferredSelectedItem.label.toLowerCase().trim()
    let lastAt: number | null = null
    for (const entry of effectiveHistory) {
      const goalLower = (entry.goalName ?? '').trim().toLowerCase()
      // Only match entries with explicit Snapback goal
      if (goalLower !== SNAPBACK_NAME.toLowerCase()) continue
      const bucket = (entry.bucketName ?? '').trim().toLowerCase()
      if (bucket === targetName) {
        const when = Math.max(entry.startedAt, entry.endedAt)
        if (lastAt === null || when > lastAt) lastAt = when
      }
    }
    if (!lastAt) return { full: 'Never', short: 'Never' }
    const now = Date.now()
    const diff = Math.max(0, now - lastAt)
    const days = Math.floor(diff / (24 * 60 * 60 * 1000))
    if (days <= 0) return { full: 'Today', short: 'Today' }
    if (days < 7) return days === 1 ? { full: '1 day ago', short: '1D ago' } : { full: `${days} days ago`, short: `${days}D ago` }
    const weeks = Math.floor(days / 7)
    if (weeks < 8) return weeks === 1 ? { full: '1 week ago', short: '1W ago' } : { full: `${weeks} weeks ago`, short: `${weeks}W ago` }
    const months = Math.floor(days / 30)
    if (months < 24) return months === 1 ? { full: '1 month ago', short: '1M ago' } : { full: `${months} months ago`, short: `${months}M ago` }
    const years = Math.floor(days / 365)
    return years === 1 ? { full: '1 year ago', short: '1Y ago' } : { full: `${years} years ago`, short: `${years}Y ago` }
  }, [deferredSelectedItem, effectiveHistory])
  const selectedPlan = useMemo(() => {
    if (!selectedItem) return { cue: '', deconstruction: '', plan: '' }
    const key = selectedItem.id
    return snapPlans[key] ?? { cue: '', deconstruction: '', plan: '' }
  }, [selectedItem, snapPlans])
  // Lightweight editable title to avoid re-rendering the whole page on each keystroke
  const SnapbackEditableTitle = useMemo(() => {
    function Component({
      item,
      onRename,
    }: {
      item: { id: string; label: string } | null
      onRename: (id: string, label: string) => void
    }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      // Track committed label to show instant feedback
      const [committedLabel, setCommittedLabel] = useState<string | null>(null)
      const inputRef = useRef<HTMLInputElement | null>(null)
      useEffect(() => {
        setDraft(item?.label ?? '')
        setCommittedLabel(null)
        setEditing(false)
      }, [item?.id])
      // Sync draft with item label when it changes externally (after API update)
      useEffect(() => {
        if (!editing && item?.label && committedLabel === null) {
          setDraft(item.label)
        }
      }, [item?.label, editing, committedLabel])
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
        // Set committed label immediately for instant feedback
        setCommittedLabel(next)
        setDraft(next)
        // Call the handler for rename
        onRename(item.id, next)
        setEditing(false)
      }, [draft, item, onRename])
      // Use committed label first, then draft, then item label
      const displayLabel = committedLabel ?? (draft || item?.label || '—')
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
            if (e.key === 'Escape') { e.preventDefault(); setDraft(item.label); setCommittedLabel(null); setEditing(false) }
          }}
          aria-label="Edit trigger title"
        />
      ) : (
        <h3
          className="snapback-drawer__title snapback-drawer__title--editable"
          onDoubleClick={() => { setCommittedLabel(null); setEditing(true) }}
          title="Double-click to edit"
        >
          {displayLabel}
        </h3>
      )
    }
    return Component
  }, [])
  
  // Get the effective display timezone (user-selected or system default)
  const displayTimezone = deferredAppTimezone ?? getCurrentSystemTimezone()
  
  // Track previous timezone to compensate historyDayOffset when timezone changes
  // Use appTimezone (not deferred) so offset updates immediately when user changes TZ
  // Use useLayoutEffect to update offset synchronously before paint
  const effectiveAppTimezone = appTimezone ?? getCurrentSystemTimezone()
  const prevAppTimezoneRef = useRef<string>(effectiveAppTimezone)
  useLayoutEffect(() => {
    const prevTz = prevAppTimezoneRef.current
    if (prevTz !== effectiveAppTimezone) {
      // Timezone changed - adjust historyDayOffset to keep the same date visible
      // Get the currently viewed date key in the OLD timezone
      const oldTodayKey = getDateKeyInTimezone(Date.now(), prevTz)
      const currentDateKey = historyDayOffsetRef.current === 0 
        ? oldTodayKey 
        : addDaysToDateKey(oldTodayKey, historyDayOffsetRef.current)
      
      // Get what "today" is in the NEW timezone
      const newTodayKey = getDateKeyInTimezone(Date.now(), effectiveAppTimezone)
      
      // Calculate the new offset needed to show the same date
      const newOffset = daysBetweenDateKeys(newTodayKey, currentDateKey)
      
      // Update offset synchronously to prevent visual glitch
      if (newOffset !== historyDayOffsetRef.current) {
        historyDayOffsetRef.current = newOffset
        flushSync(() => {
          setHistoryDayOffset(newOffset)
        })
      }
      
      prevAppTimezoneRef.current = effectiveAppTimezone
    }
  }, [effectiveAppTimezone])
  
  // Get today's date key in the display timezone, then apply offset
  const selectedDateKey = useMemo(() => {
    const todayKey = getDateKeyInTimezone(nowTick, displayTimezone)
    if (historyDayOffset === 0) return todayKey
    return addDaysToDateKey(todayKey, historyDayOffset)
  }, [nowTick, historyDayOffset, displayTimezone])
  
  // Get UTC timestamps for the start and end of the selected day in display timezone
  const dayStart = useMemo(() => {
    return getMidnightUtcForDateInTimezone(selectedDateKey, displayTimezone)
  }, [selectedDateKey, displayTimezone])
  const dayEnd = dayStart + DAY_DURATION_MS
  const anchorDate = useMemo(() => new Date(dayStart), [dayStart])
  
  // Current time indicator position (0-100%)
  const currentTimePercent = useMemo(() => {
    // Check if current time is on the selected day in display timezone
    const nowDateKey = getDateKeyInTimezone(nowTick, displayTimezone)
    if (nowDateKey !== selectedDateKey) return null
    return getPositionPercentInTimezone(nowTick, displayTimezone)
  }, [nowTick, selectedDateKey, displayTimezone])
  
  const daySegments = useMemo(() => {
    const preview = dragPreview
    const entries = effectiveHistory
      .filter((entry) => !isSkippedSession(entry)) // Exclude skipped sessions from calendar
      .map((entry) => {
        const isPreviewed = preview && preview.entryId === entry.id
        const rawStartedAt = isPreviewed ? preview.startedAt : entry.startedAt
        const rawEndedAt = isPreviewed ? preview.endedAt : entry.endedAt
        
        // Check if this entry overlaps with the selected day in display timezone
        const startDateKey = getDateKeyInTimezone(rawStartedAt, displayTimezone)
        const endDateKey = getDateKeyInTimezone(rawEndedAt, displayTimezone)
        const overlapsSelectedDay = startDateKey === selectedDateKey || endDateKey === selectedDateKey ||
          (startDateKey < selectedDateKey && endDateKey > selectedDateKey)
        
        if (!overlapsSelectedDay) return null
        
        // Get position percentages in display timezone
        const startsOnSelectedDay = startDateKey === selectedDateKey
        const endsOnSelectedDay = endDateKey === selectedDateKey
        
        const startPercent = startsOnSelectedDay 
          ? getPositionPercentInTimezone(rawStartedAt, displayTimezone) 
          : 0
        const endPercent = endsOnSelectedDay 
          ? getPositionPercentInTimezone(rawEndedAt, displayTimezone) 
          : 100
        
        // Skip if no visible portion
        if (endPercent <= startPercent) return null
        
        // For the entry object, keep original timestamps (used for duration display etc)
        const previewedEntry = isPreviewed
          ? {
              ...entry,
              startedAt: rawStartedAt,
              endedAt: rawEndedAt,
              elapsed: Math.max(rawEndedAt - rawStartedAt, 1),
            }
          : entry
        
        return { 
          entry: previewedEntry, 
          startPercent, 
          endPercent,
          // Keep start/end as UTC timestamps for sorting
          start: rawStartedAt,
          end: rawEndedAt,
        }
      })
      .filter((segment): segment is { entry: HistoryEntry; startPercent: number; endPercent: number; start: number; end: number } => Boolean(segment))

    if (preview && preview.entryId === 'new-entry') {
      // For new entry preview, preview.startedAt/endedAt are already in display space (percent-based)
      // Convert back to check if it's valid
      const minPercent = Math.min(preview.startedAt, preview.endedAt)
      const maxPercent = Math.max(preview.startedAt, preview.endedAt)
      const startPercent = Math.max(minPercent, 0)
      const endPercent = Math.min(maxPercent, 100)
      
      if (endPercent > startPercent) {
        // Convert percentages to UTC timestamps for the synthetic entry
        const syntheticStartedAt = percentToUtcTimestamp(startPercent, dayStart)
        const syntheticEndedAt = percentToUtcTimestamp(endPercent, dayStart)
        
        const syntheticEntry: HistoryEntry = {
          id: 'new-entry',
          taskName: '',
          goalName: LIFE_ROUTINES_NAME,
          bucketName: null,
          goalId: LIFE_ROUTINES_GOAL_ID,
          bucketId: null,
          taskId: null,
          elapsed: Math.max(syntheticEndedAt - syntheticStartedAt, MIN_SESSION_DURATION_DRAG_MS),
          startedAt: syntheticStartedAt,
          endedAt: syntheticEndedAt,
          goalSurface: LIFE_ROUTINES_SURFACE,
          bucketSurface: null,
          notes: '',
          subtasks: [],
        }
        entries.push({ 
          entry: syntheticEntry, 
          startPercent, 
          endPercent,
          start: syntheticStartedAt,
          end: syntheticEndedAt,
        })
      }
    }

    entries.sort((a, b) => a.start - b.start)
    const lanes: number[] = []
    return entries.map(({ entry, startPercent, endPercent, start }) => {
      // Lane assignment based on overlap (using percentages)
      let lane = lanes.findIndex((laneEndPercent) => startPercent >= laneEndPercent - 0.5)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(endPercent)
      } else {
        lanes[lane] = endPercent
      }
      
      const safeLeft = Math.min(Math.max(startPercent, 0), 100)
      const rawWidth = endPercent - startPercent
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
      const originalRangeLabel = formatDateRange(entry.startedAt, entry.endedAt, use24HourTime)
      const tooltipTask =
        entry.taskName.trim().length > 0 ? entry.taskName : goalLabel !== UNCATEGORISED_LABEL ? goalLabel : 'Focus Session'
      return {
        id: entry.id,
        entry,
        start,
        end: entry.endedAt,
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
  }, [effectiveHistory, selectedDateKey, dayStart, displayTimezone, enhancedGoalLookup, goalColorLookup, dragPreview, use24HourTime])
  
  // Separate timezone markers from regular segments
  const { regularSegments, timezoneMarkers } = useMemo(() => {
    const regular: typeof daySegments = []
    const markers: typeof daySegments = []
    daySegments.forEach((segment) => {
      const bucket = segment.entry.bucketName?.trim() ?? ''
      if (bucket === TIMEZONE_CHANGE_MARKER) {
        markers.push(segment)
      } else {
        regular.push(segment)
      }
    })
    return { regularSegments: regular, timezoneMarkers: markers }
  }, [daySegments])
  
  const timelineRowCount = regularSegments.length > 0 ? regularSegments.reduce((max, segment) => Math.max(max, segment.lane), 0) + 1 : 1
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

  // --- Month cell overview panel ---
  const [monthCellOverview, setMonthCellOverview] = useState<{
    dateKey: string
    dateLabel: string
    entries: HistoryEntry[]
  } | null>(null)
  const monthCellOverviewRef = useRef<HTMLDivElement | null>(null)

  // --- Fixed month cell max events ---
  const monthCellMaxEvents = 2
  const monthCellMoreFontSize = '0.6rem'

  // Add data attribute to body when modal is open to block pointer events via CSS
  // Also lock body scroll when modal is open
  useEffect(() => {
    if (monthCellOverview) {
      document.body.setAttribute('data-month-cell-overview-open', 'true')
      document.body.style.overflow = 'hidden'
    } else {
      document.body.removeAttribute('data-month-cell-overview-open')
      document.body.style.overflow = ''
    }
    return () => {
      document.body.removeAttribute('data-month-cell-overview-open')
      document.body.style.overflow = ''
    }
  }, [monthCellOverview])

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
        const evEl = (node.closest('.calendar-event') || node.closest('.calendar-allday-event') || node.closest('.calendar-timezone-marker')) as HTMLElement | null
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
      // Abort if the node was removed before the frame executes to avoid Range errors.
      if (!editableEl.isConnected || !editableEl.parentNode) {
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
          // Guard against detached nodes to avoid InvalidNodeTypeError from selectNodeContents.
          if (!editableEl.parentNode) {
            return
          }
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
    const currentView = calendarViewRef.current
    if (!(currentView === 'day' || currentView === '3d' || currentView === 'week')) {
      return
    }
    if (event.button !== 0) return
    // If a non-pending interaction is already active (panning/creating/dragging), don't interfere
    // But if it's 'pending' (from event handler waiting for hold), we can still set up pan detection
    const currentMode = calendarInteractionModeRef.current
    if (currentMode === 'panning' || currentMode === 'creating' || currentMode === 'dragging') return
    let scrollLocked = false
    let prevTouchAction: string | null = null
    const target = event.target as HTMLElement | null
    // Allow panning from anywhere, including over events
    // Events have their own handlers that will set up drag after hold detection
    if (target && target.closest('button')) {
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
    const dayCount = currentView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : currentView === 'week' ? 7 : 1
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
    }
    // Set interaction mode to pending - will transition to panning if horizontal movement detected
    calendarInteractionModeRef.current = 'pending'
    // Don't capture or preventDefault yet; wait until we detect horizontal intent
    const handleMove = (e: PointerEvent) => {
      // Don't pan if an event drag is active or we're in a different mode
      const currentMode = calendarInteractionModeRef.current
      if (currentMode === 'creating' || currentMode === 'dragging') return
      const eventDragState = calendarEventDragRef.current
      if (eventDragState && eventDragState.activated) return
      const state = calendarDragRef.current
      if (!state || e.pointerId !== state.pointerId) return
      const dy = e.clientY - state.startY
      const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
      if (!Number.isFinite(dayWidth) || dayWidth <= 0) return
      const dx = e.clientX - state.startX
      // Threshold detection - start panning once user has moved enough
      if (state.mode === 'pending') {
        if (!hasMovedPastThreshold(dx, dy, 8)) {
          return
        }
        // Movement confirmed: capture and prevent default
        // Cancel any pending hold timer for create mode
        if (calendarHoldTimerRef.current !== null) {
          try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
          calendarHoldTimerRef.current = null
        }
        try { e.preventDefault() } catch {}
        try { area.setPointerCapture?.(e.pointerId) } catch {}
        state.mode = 'hdrag'
        calendarInteractionModeRef.current = 'panning'
        if (prevTouchAction === null) {
          prevTouchAction = area.style.touchAction
          area.style.touchAction = 'none'
        }
        if (!scrollLocked) {
          setPageScrollLock(true)
          scrollLocked = true
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
        const { snap } = resolvePanSnap(state, dx, dayWidth, calendarViewRef.current, appliedDx)
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
      // Only clear interaction mode if we were panning (not if column handler took over)
      if (calendarInteractionModeRef.current === 'panning' || calendarInteractionModeRef.current === 'pending') {
        calendarInteractionModeRef.current = null
      }
      if (scrollLocked) {
        setPageScrollLock(false)
        scrollLocked = false
      }
      if (prevTouchAction !== null) {
        area.style.touchAction = prevTouchAction
      }
      // Always release scroll lock as safety (no-op if not locked)
      setPageScrollLock(false)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }, [multiDayCount, resetCalendarPanTransform, stopCalendarPanAnimation, resolvePanSnap, animateCalendarPan])

  // Build minimal calendar content for non-day views
  const renderCalendarContent = useCallback(() => {
    const entries = effectiveHistory

    // Get ALL entries for a date (both all-day and timed sessions) for month view
    const getAllEntriesForDate = (dateKey: string) => {
      const [year, month, day] = dateKey.split('-').map(Number)
      const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
      const dayEnd = dayStart + DAY_DURATION_MS
      
      return entries.filter((e) => {
        if (isSkippedSession(e)) return false
        
        if (e.isAllDay) {
          // For entries with isAllDay flag, use UTC date key matching
          const startDateKey = getUtcDateKey(e.startedAt)
          const endDateKey = getUtcDateKey(e.endedAt)
          return dateKey >= startDateKey && dateKey < endDateKey
        } else {
          // Check if entry overlaps with this day
          return Math.min(e.endedAt, dayEnd) > Math.max(e.startedAt, dayStart)
        }
      }).sort((a, b) => {
        // Sort all-day entries first, then by start time
        const aIsAllDay = isEntryAllDay(a)
        const bIsAllDay = isEntryAllDay(b)
        if (aIsAllDay && !bIsAllDay) return -1
        if (!aIsAllDay && bIsAllDay) return 1
        return a.startedAt - b.startedAt
      })
    }

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

    // Use display timezone for today detection
    const todayDateKeyInDisplayTz = getDateKeyInTimezone(Date.now(), displayTimezone)

    const renderCell = (date: Date, isCurrentMonth: boolean) => {
      const start = new Date(date)
      start.setHours(0, 0, 0, 0)
      // Build date key for this cell
      const cellDateKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
      const cellEntries = getAllEntriesForDate(cellDateKey)
      const isToday = cellDateKey === todayDateKeyInDisplayTz
      const dateLabel = start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      const maxVisibleEvents = monthCellMaxEvents
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
          {cellEntries.length > 0 && (
            <div
              className="calendar-cell__events"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                setMonthCellOverview({ dateKey: cellDateKey, dateLabel, entries: cellEntries })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setMonthCellOverview({ dateKey: cellDateKey, dateLabel, entries: cellEntries })
                }
              }}
            >
              {cellEntries.slice(0, maxVisibleEvents).map((entry) => {
                const meta = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
                const label = deriveEntryTaskName(entry)
                const colorCss = meta.colorInfo?.gradient?.css ?? meta.colorInfo?.solidColor ?? getPaletteColorForLabel(label)
                const isPlanned = !!entry.futureSession
                const baseColor = meta.colorInfo?.solidColor ?? meta.colorInfo?.gradient?.start ?? getPaletteColorForLabel(label)
                const entryIsAllDay = isEntryAllDay(entry)
                
                // All-day events render as full-width colored bars (original style)
                // Timed events render with marker + title
                if (entryIsAllDay) {
                  return (
                    <div
                      key={entry.id}
                      className={`calendar-cell__event calendar-cell__event--allday${isPlanned ? ' calendar-cell__event--planned' : ''}`}
                      style={isPlanned ? { color: baseColor, borderColor: baseColor } : { background: colorCss }}
                      title={label}
                    >
                      <span className="calendar-cell__event-title">{label}</span>
                    </div>
                  )
                }
                
                return (
                  <div
                    key={entry.id}
                    className={`calendar-cell__event${isPlanned ? ' calendar-cell__event--planned' : ''}`}
                    title={label}
                  >
                    <span
                      className="calendar-cell__event-marker"
                      style={{ background: baseColor }}
                    />
                    <span className="calendar-cell__event-title">{label}</span>
                  </div>
                )
              })}
              {cellEntries.length > maxVisibleEvents && (
                <div className="calendar-cell__more" style={{ fontSize: monthCellMoreFontSize }}>+{cellEntries.length - maxVisibleEvents} more</div>
              )}
            </div>
          )}
        </div>
      )
    }

    if (calendarView === 'day' || calendarView === '3d' || calendarView === 'week') {
      const visibleDayCount = calendarView === '3d' ? Math.max(2, Math.min(multiDayCount, 14)) : calendarView === 'week' ? 7 : 1
      const bufferDays = getCalendarBufferDays(visibleDayCount)
      const totalCount = visibleDayCount + bufferDays * 2
      
      // Calculate the anchor date key and apply week-start adjustment if needed
      let anchorDateKey = selectedDateKey
      if (calendarView === 'week') {
        // Get day-of-week in display timezone (0=Sun, 1=Mon, etc.)
        const anchorParts = getTimePartsInTimezone(dayStart, displayTimezone)
        const anchorDateObj = new Date(anchorParts.year, anchorParts.month - 1, anchorParts.day)
        const dow = anchorDateObj.getDay()
        // Calculate days to go back to reach weekStartDay (0=Sunday, 1=Monday)
        const daysBack = (dow - weekStartDay + 7) % 7
        anchorDateKey = addDaysToDateKey(selectedDateKey, -daysBack)
      }
      
      // Generate dayStarts using display timezone
      const dayStarts = getDayStartsInTimezone(anchorDateKey, -bufferDays, totalCount, displayTimezone)
      
      // Generate dateKeys for each day (used for filtering entries)
      const dayDateKeys: string[] = []
      for (let i = 0; i < totalCount; i++) {
        dayDateKeys.push(addDaysToDateKey(anchorDateKey, i - bufferDays))
      }

      // All-day detection uses SYSTEM local time (not display timezone)
      // because all-day events are stored with local midnight timestamps
      // and represent calendar days in the user's local context.
      // Switching display timezone shouldn't change whether something is "all-day".
      // We use the top-level isAllDayRangeTs function for this.

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
          // Skip sessions that were skipped (zero-elapsed entries from guide skip)
          if (isSkippedSession(entry)) continue
          const isPreviewed = dragPreview && dragPreview.entryId === entry.id
          const startAt = isPreviewed ? dragPreview.startedAt : entry.startedAt
          const endAt = isPreviewed ? dragPreview.endedAt : entry.endedAt
          if (!isEntryAllDay(entry)) continue
          
          // For entries with isAllDay flag, use UTC date matching (timestamps are UTC midnight)
          // For legacy entries, use local midnight detection
          let colStart: number
          let colEnd: number
          
          if (entry.isAllDay) {
            // When previewing (dragging), the timestamps are display-timezone midnights
            // When not previewing, the timestamps are UTC midnights
            // Use appropriate date key extraction for each case
            const startDateKey = isPreviewed 
              ? getDateKeyInTimezone(startAt, displayTimezone)
              : getUtcDateKey(startAt)
            const endDateKey = isPreviewed 
              ? getDateKeyInTimezone(endAt, displayTimezone)
              : getUtcDateKey(endAt)
            colStart = dayDateKeys.indexOf(startDateKey)
            // End is exclusive, so find the end date column
            const endColIdx = dayDateKeys.indexOf(endDateKey)
            colEnd = endColIdx >= 0 ? endColIdx : dayDateKeys.length
            // If start date not found in window, try to find overlap
            if (colStart < 0) {
              // Check if event overlaps with window at all
              const windowFirstDate = dayDateKeys[0]
              const windowLastDate = dayDateKeys[dayDateKeys.length - 1]
              if (startDateKey > windowLastDate || endDateKey <= windowFirstDate) continue
              colStart = 0
            }
          } else {
            // Legacy: local midnight timestamps
            const startMid = toLocalMidnightTs(startAt)
            const endMid = toLocalMidnightTs(endAt)
            if (endMid <= windowStartMs || startMid >= windowEndMs) continue
            const clampedStart = Math.max(startMid, windowStartMs)
            const clampedEnd = Math.min(endMid, windowEndMs)
            colStart = Math.floor((clampedStart - windowStartMs) / DAY_DURATION_MS)
            colEnd = Math.ceil((clampedEnd - windowStartMs) / DAY_DURATION_MS)
          }
          
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
          // Use display timezone to get date key (must match guide's occurrence key)
          const confirmedKeySet = (() => {
            const set = new Set<string>()
            effectiveHistory.forEach((h) => {
              const rid = (h as any).repeatingSessionId as string | undefined | null
              const ot = (h as any).originalTime as number | undefined | null
              if (rid && Number.isFinite(ot as number)) set.add(`${rid}:${getDateKeyInTimezone(ot as number, displayTimezone)}`)
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
          // Use display timezone for occurrence key to match confirmedKeySet
          const makeOccurrenceKey = (ruleId: string, baseMs: number) => `${ruleId}:${getDateKeyInTimezone(baseMs, displayTimezone)}`
          
          // For all-day rules, check boundaries by DATE not timestamp
          // This properly handles the case where an all-day entry spawned the rule
          const isAllDayWithinBoundaries = (rule: RepeatingSessionRule, columnIndex: number) => {
            // Use the same date key that all-day entries use for column matching
            const columnDateKey = dayDateKeys[columnIndex]
            const startAtMs = (rule as any).startAtMs as number | undefined
            const createdMs = (rule as any).createdAtMs as number | undefined
            const anchorMs = Number.isFinite(startAtMs as number) ? (startAtMs as number) : (Number.isFinite(createdMs as number) ? (createdMs as number) : null)
            
            if (Number.isFinite(anchorMs as number)) {
              // Get the anchor date using UTC (same as how all-day entries compute their date key)
              const anchorDateKey = getUtcDateKey(anchorMs as number)
              
              // For all-day rules, the first guide should appear on the day AFTER the anchor
              // because the anchor day already has the original entry
              if (columnDateKey === anchorDateKey) {
                return false
              }
              // Also check if the column is before the anchor
              if (columnDateKey < anchorDateKey) {
                return false
              }
            }
            
            const endAtMs = (rule as any).endAtMs as number | undefined
            if (Number.isFinite(endAtMs as number)) {
              const endDateKey = getUtcDateKey(endAtMs as number)
              if (columnDateKey > endDateKey) return false
            }
            return true
          }
          
          const isAllDayRule = (rule: RepeatingSessionRule) => {
            // Check explicit isAllDay flag first
            if (rule.isAllDay === true) return true
            // Legacy detection: timeOfDayMinutes=0 and duration >= 24 hours
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            const durationMinutes = Math.max(1, rule.durationMinutes ?? 60)
            if (timeOfDayMin === 0 && durationMinutes >= 1440) return true
            // Heuristic: very short duration (< 5 min) suggests malformed all-day conversion
            // Also check if duration is exactly 1440 (24 hours)
            if (durationMinutes >= 1440) return true
            return false
          }
          
          // For all-day rules, use date-based interval matching (not weekday matching)
          // E.g., if set on the 7th, weekly repeat means 7th → 14th → 21st (not "every Monday")
          const isAllDayRuleScheduledForDay = (rule: RepeatingSessionRule, dayStart: number): boolean => {
            if (!rule.isActive) return false
            const dateKey = getDateKeyInTimezone(dayStart, displayTimezone)
            const { year, month, day } = getDatePartsFromDateKey(dateKey)
            
            // Get anchor date (startAtMs or createdAtMs)
            const anchorMs = getRuleAnchorDayStart(rule)
            if (!Number.isFinite(anchorMs as number)) return true // No anchor, allow all days
            const anchorDateKey = getDateKeyInTimezone(anchorMs as number, displayTimezone)
            const anchorParts = getDatePartsFromDateKey(anchorDateKey)
            
            const interval = Math.max(1, Number.isFinite((rule as any).repeatEvery as number) ? Math.floor((rule as any).repeatEvery as number) : 1)
            
            if (rule.frequency === 'daily') {
              // Every N days from anchor
              const DAY_MS = 24 * 60 * 60 * 1000
              const diffDays = Math.floor((dayStart - (anchorMs as number)) / DAY_MS)
              if (diffDays < 0) return false
              return diffDays % interval === 0
            }
            
            if (rule.frequency === 'weekly') {
              // If dayOfWeek is specified and not empty, use weekday matching (user explicitly chose days)
              if (Array.isArray(rule.dayOfWeek) && rule.dayOfWeek.length > 0) {
                const dow = getDayOfWeekFromDateKey(dateKey)
                if (!rule.dayOfWeek.includes(dow)) return false
                // Also check week interval
                const DAY_MS = 24 * 60 * 60 * 1000
                const diffDays = Math.floor((dayStart - (anchorMs as number)) / DAY_MS)
                if (diffDays < 0) return false
                const diffWeeks = Math.floor(diffDays / 7)
                return diffWeeks % interval === 0
              }
              // No dayOfWeek specified: repeat every 7*interval days from anchor
              const DAY_MS = 24 * 60 * 60 * 1000
              const diffDays = Math.floor((dayStart - (anchorMs as number)) / DAY_MS)
              if (diffDays < 0) return false
              return diffDays % (7 * interval) === 0
            }
            
            if (rule.frequency === 'monthly') {
              // Same day-of-month, every N months
              // Handle month-end clamping: if anchor was 31st, in Feb it becomes 28th/29th
              const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
              const expectedDay = Math.min(anchorParts.day, lastDayOfMonth)
              if (day !== expectedDay) return false
              // Check month interval
              const anchorMonthIndex = anchorParts.year * 12 + (anchorParts.month - 1)
              const currentMonthIndex = year * 12 + (month - 1)
              const diffMonths = currentMonthIndex - anchorMonthIndex
              if (diffMonths < 0) return false
              return diffMonths % interval === 0
            }
            
            if (rule.frequency === 'annually') {
              // Same month-day, every N years
              if (month !== anchorParts.month || day !== anchorParts.day) {
                // Handle Feb 29 → Feb 28 in non-leap years
                if (anchorParts.month === 2 && anchorParts.day === 29 && month === 2 && day === 28) {
                  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0)
                  if (!isLeapYear) {
                    // Allow Feb 28 as fallback for Feb 29 anchor in non-leap year
                  } else {
                    return false
                  }
                } else {
                  return false
                }
              }
              const diffYears = year - anchorParts.year
              if (diffYears < 0) return false
              return diffYears % interval === 0
            }
            
            return false
          }
          
          // Deduplicate rules by ID (in case the same rule appears multiple times)
          const uniqueRules = Array.from(new Map(repeatingRules.map((r) => [r.id, r])).values())
          
          uniqueRules.forEach((rule) => {
            if (!isAllDayRule(rule)) return
            // All-day guides use date-based scheduling (not weekday matching)
            dayStarts.forEach((dayStart, columnIndex) => {
              if (!isAllDayRuleScheduledForDay(rule, dayStart)) return
              // Use date-based boundary check for all-day rules
              if (!isAllDayWithinBoundaries(rule, columnIndex)) return
              const occKey = makeOccurrenceKey(rule.id, dayStart)
              if (confirmedKeySet.has(occKey)) return
              const guideEntryId = `repeat:${rule.id}:${dayStart}:allday`
              
              // Check if this guide is being dragged
              const isBeingDragged = dragPreview && dragPreview.entryId === guideEntryId
              
              // Use preview position if dragging, otherwise use scheduled position
              const startedAt = isBeingDragged ? dragPreview.startedAt : dayStart
              const endedAt = isBeingDragged ? dragPreview.endedAt : dayStart + DAY_DURATION_MS
              
              // Skip this iteration if not dragged and already covered
              if (!isBeingDragged && coveredOriginalSet.has(`${rule.id}:${dayStart}`)) return
              
              // Get the date key for this column - use the same dayDateKeys array
              // that real all-day entries use for column matching
              const columnDateKey = dayDateKeys[columnIndex]
              const taskName = rule.taskName?.trim() || 'Session'
              const goalName = rule.goalName?.trim() || null
              const bucketName = rule.bucketName?.trim() || null
              
              // Check for duplicate: match by date key + task name for all-day entries
              // OR match by repeatingSessionId + originalTime for confirmed/skipped guides
              const duplicateReal = effectiveHistory.some((h) => {
                // Check for repeatingSessionId match first (for guide suppression)
                const hRid = (h as any).repeatingSessionId as string | undefined | null
                const hOt = (h as any).originalTime as number | undefined | null
                if (hRid === rule.id && Number.isFinite(hOt as number)) {
                  // For all-day entries, originalTime is stored as UTC midnight
                  // Use getUtcDateKey for timezone-agnostic comparison
                  if (isEntryAllDay(h)) {
                    const entryDateKey = getUtcDateKey(hOt as number)
                    if (entryDateKey === columnDateKey) {
                      return true
                    }
                  } else {
                    // For time-based entries, use timezone-aware comparison
                    const otDateKey = getDateKeyInTimezone(hOt as number, displayTimezone)
                    const guideOccDateKey = getDateKeyInTimezone(dayStart, displayTimezone)
                    if (otDateKey === guideOccDateKey) {
                      return true
                    }
                  }
                }
                
                // Fallback: check by all-day entry date + task match for MANUALLY CREATED entries only
                // If the entry has a repeatingSessionId, it should only suppress via the originalTime check above
                // (so dragging a linked entry to another date doesn't suppress that date's guide)
                if (hRid) return false
                
                if (!isEntryAllDay(h)) return false
                
                // Get entry's date key the same way it's used for column placement
                const entryDateKey = getUtcDateKey(h.startedAt)
                if (entryDateKey !== columnDateKey) return false
                
                // Same date - now check if it's the same task
                const sameTask = (h.taskName?.trim() || 'Session') === taskName
                const sameGoal = (h.goalName ?? null) === goalName
                const sameBucket = (h.bucketName ?? null) === bucketName
                return sameTask && sameGoal && sameBucket
              })
              if (duplicateReal) return
              const entry: HistoryEntry = {
                id: guideEntryId,
                taskName,
                elapsed: Math.max(endedAt - startedAt, 1),
                startedAt,
                endedAt,
                isAllDay: true,
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
                repeatingSessionId: rule.id,
              }
              const meta = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
              const label = deriveEntryTaskName(entry)
              const colorCss = meta.colorInfo?.gradient?.css ?? meta.colorInfo?.solidColor ?? getPaletteColorForLabel(label)
              const baseColor = meta.colorInfo?.solidColor ?? meta.colorInfo?.gradient?.start ?? getPaletteColorForLabel(label)
              // Skip if we already have a guide with the same entry ID (dedup safety)
              if (raws.some((r) => r.entry.id === entry.id)) return
              
              // Calculate column position based on actual timestamps (handles drag preview)
              let guideColStart: number
              let guideColEnd: number
              if (isBeingDragged) {
                // For drag preview, use display-timezone date key since dayDateKeys uses local dates
                // and preview timestamps are display-timezone midnights
                const previewStartDateKey = getDateKeyInTimezone(startedAt, displayTimezone)
                const previewEndDateKey = getDateKeyInTimezone(endedAt, displayTimezone)
                guideColStart = dayDateKeys.indexOf(previewStartDateKey)
                const endColIdx = dayDateKeys.indexOf(previewEndDateKey)
                guideColEnd = endColIdx >= 0 ? endColIdx : dayDateKeys.length
                // If start not found, clamp to visible range
                if (guideColStart < 0) guideColStart = 0
              } else {
                guideColStart = columnIndex
                guideColEnd = Math.min(dayStarts.length, columnIndex + 1)
              }
              
              raws.push({
                entry,
                colStart: guideColStart,
                colEnd: guideColEnd,
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
        leftPct: number
        widthPct: number
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
          .filter((entry) => !isSkippedSession(entry)) // Exclude skipped sessions from calendar
          .map((entry) => {
            // Exclude all‑day entries from the time grid; they render in the all‑day lane
            if (isEntryAllDay(entry)) return null
            const isPreviewed = dragPreview && dragPreview.entryId === entry.id
            const rawStart = isPreviewed ? dragPreview.startedAt : entry.startedAt
            const rawEnd = isPreviewed ? dragPreview.endedAt : entry.endedAt
            
            // Guide tasks use their scheduled time directly (already in display timezone local time)
            // Real sessions: since dayStarts are now UTC bounds for the display timezone,
            // we can use UTC timestamps directly without adjustment
            const previewStart = rawStart
            const previewEnd = rawEnd
            
            const clampedStart = Math.max(Math.min(previewStart, previewEnd), startMs)
            const clampedEnd = Math.min(Math.max(previewStart, previewEnd), endMs)
            // Timezone markers should have 1 minute duration
            const isTimezoneMarkerEntry = entry.bucketName?.trim() === TIMEZONE_CHANGE_MARKER
            if (clampedEnd < clampedStart) {
              return null
            }
            return {
              entry,
              start: clampedStart,
              end: isTimezoneMarkerEntry ? Math.min(clampedStart + MINUTE_MS, endMs) : clampedEnd,
              previewStart,
              previewEnd,
            }
          })
          .filter((v): v is RawEvent => Boolean(v))
          .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start))

        // Build lookup for confirmed occurrences to suppress guides
        // Use display timezone to get date key (must match guide's occurrence key)
        const confirmedKeySet = (() => {
          const set = new Set<string>()
          effectiveHistory.forEach((h) => {
            const rid = (h as any).repeatingSessionId as string | undefined | null
            const ot = (h as any).originalTime as number | undefined | null
            if (rid && Number.isFinite(ot as number)) set.add(`${rid}:${getDateKeyInTimezone(ot as number, displayTimezone)}`)
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
        // SIMPLE APPROACH: Guides always render at their set time in the DISPLAY timezone.
        // If a guide is set for 11 PM, it shows at 11 PM regardless of what timezone you view in.
        const guideRaw: RawEvent[] = (() => {
          if (!Array.isArray(repeatingRules) || repeatingRules.length === 0) return []

          // Get the date key for this column in the display timezone
          const displayDateKey = getDateKeyInTimezone(startMs, displayTimezone)

          // Check if a rule is scheduled for a given date key (uses date directly, no timezone conversion)
          const isRuleScheduledForDateKey = (rule: RepeatingSessionRule, dateKey: string) => {
            if (!rule.isActive) return false
            // For interval checking, use display timezone midnight
            const dayStartForInterval = getMidnightUtcForDateInTimezone(dateKey, displayTimezone)
            if (rule.frequency === 'daily') {
              return ruleIntervalAllowsDay(rule, dayStartForInterval)
            }
            if (rule.frequency === 'weekly') {
              const dow = getDayOfWeekFromDateKey(dateKey)
              return Array.isArray(rule.dayOfWeek) && rule.dayOfWeek.includes(dow) && ruleIntervalAllowsDay(rule, dayStartForInterval)
            }
            if (rule.frequency === 'monthly') {
              return matchesMonthlyDayWithDateKey(rule, dateKey) && ruleIntervalAllowsDay(rule, dayStartForInterval)
            }
            if (rule.frequency === 'annually') {
              const dayKey = monthDayKeyFromDateKey(dateKey)
              const ruleKey = ruleMonthDayKey(rule)
              return ruleKey !== null && ruleKey === dayKey && ruleIntervalAllowsDay(rule, dayStartForInterval)
            }
            return false
          }

          const isWithinBoundariesForDateKey = (rule: RepeatingSessionRule, dateKey: string) => {
            // Compute the scheduled startedAt using DISPLAY timezone (guide shows at set time in display tz)
            const displayDayStart = getMidnightUtcForDateInTimezone(dateKey, displayTimezone)
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            const scheduledStart = displayDayStart + timeOfDayMin * MINUTE_MS
            // Start boundary
            const startAtMs = (rule as any).startAtMs as number | undefined
            if (Number.isFinite(startAtMs as number)) {
              if (scheduledStart < (startAtMs as number)) return false
            } else {
              const createdMs = (rule as any).createdAtMs as number | undefined
              if (Number.isFinite(createdMs as number)) {
                if (scheduledStart <= (createdMs as number)) return false
              }
            }
            // End boundary
            const endAtMs = (rule as any).endAtMs as number | undefined
            if (Number.isFinite(endAtMs as number)) {
              if (scheduledStart > (endAtMs as number)) return false
            }
            return true
          }
          
          // Helper to check if a rule is all-day (for time grid exclusion)
          const isAllDayRuleForTimeGrid = (rule: RepeatingSessionRule): boolean => {
            if (rule.isAllDay === true) return true
            const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
            const durationMinutes = Math.max(1, rule.durationMinutes ?? 60)
            if (timeOfDayMin === 0 && durationMinutes >= 1440) return true
            // Heuristic: duration >= 24 hours means all-day regardless of start time
            if (durationMinutes >= 1440) return true
            return false
          }

          // Build a guide using DISPLAY timezone - guide shows at its set wall-clock time
          // (e.g., a 2pm rule always shows at 2pm in whatever timezone you're viewing)
          const buildGuideForDateKey = (rule: RepeatingSessionRule, dateKey: string): RawEvent | null => {
            // Skip all-day rules - they render in the all-day section, not time grid
            if (isAllDayRuleForTimeGrid(rule)) return null
            
            // Use DISPLAY timezone for computing guide position
            // timeOfDayMinutes is the wall-clock time (e.g., 840 = 2pm), applied to display timezone
            const displayDayStart = getMidnightUtcForDateInTimezone(dateKey, displayTimezone)
            
            // Suppression by confirmed entry for this occurrence date
            const occKey = `${rule.id}:${dateKey}`
            if (confirmedKeySet.has(occKey)) return null
            
            // Compute start time: display timezone midnight + timeOfDayMinutes
            const startedAt = displayDayStart + Math.max(0, Math.min(1439, rule.timeOfDayMinutes)) * MINUTE_MS
            // Suppress if this occurrence has been linked already
            if (coveredOriginalSet.has(`${rule.id}:${startedAt}`)) return null
            
            const durationMs = Math.max(1, (rule.durationMinutes ?? 60) * MINUTE_MS)
            const endedAt = startedAt + durationMs
            
            if (isAllDayRangeTs(startedAt, endedAt)) return null
            
            const task = rule.taskName?.trim() || 'Session'
            const goal = rule.goalName?.trim() || null
            const bucket = rule.bucketName?.trim() || null
            
            // Check for duplicate real sessions
            const TOL = 60 * 1000
            const duplicateReal = effectiveHistory.some((h) => {
              const sameLabel = (h.taskName?.trim() || 'Session') === task && (h.goalName ?? null) === goal && (h.bucketName ?? null) === bucket
              const startMatch = Math.abs(h.startedAt - startedAt) <= TOL
              const endMatch = Math.abs(h.endedAt - endedAt) <= TOL
              return sameLabel && startMatch && endMatch
            })
            if (duplicateReal) return null
            
            // Entry ID uses displayDayStart for consistent identification
            const entryId = `repeat:${rule.id}:${displayDayStart}`
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
              repeatingSessionId: rule.id,
            }
            
            // Handle drag preview
            const isPreviewed = dragPreview && dragPreview.entryId === entry.id
            const previewStart = isPreviewed ? dragPreview.startedAt : startedAt
            const previewEnd = isPreviewed ? dragPreview.endedAt : endedAt
            
            if (isPreviewed) {
              const overlapsThisColumn = previewStart < endMs && previewEnd > startMs
              if (!overlapsThisColumn) return null
            }
            
            // Check if guide overlaps this column's time range
            if (!isPreviewed && (startedAt >= endMs || endedAt <= startMs)) return null
            
            return {
              entry,
              start: Math.max(previewStart, startMs),
              end: Math.min(previewEnd, endMs),
              previewStart,
              previewEnd,
            }
          }

          const guides: RawEvent[] = []

          // Check today's date and previous day (for overnight carryover)
          for (const rule of repeatingRules) {
            // Check current day
            if (isRuleScheduledForDateKey(rule, displayDateKey) && isWithinBoundariesForDateKey(rule, displayDateKey)) {
              const ev = buildGuideForDateKey(rule, displayDateKey)
              if (ev && !guides.some(g => g.entry.id === ev.entry.id)) {
                guides.push(ev)
              }
            }
            
            // Check previous day for overnight carryover
            const prevDateKey = addDaysToDateKey(displayDateKey, -1)
            if (isRuleScheduledForDateKey(rule, prevDateKey) && isWithinBoundariesForDateKey(rule, prevDateKey)) {
              const durationMin = Math.max(1, rule.durationMinutes ?? 60)
              const timeOfDayMin = Math.max(0, Math.min(1439, rule.timeOfDayMinutes))
              // Only check carryover if the rule crosses midnight
              if (timeOfDayMin + durationMin > 24 * 60) {
                const ev = buildGuideForDateKey(rule, prevDateKey)
                if (ev && !guides.some(g => g.entry.id === ev.entry.id)) {
                  guides.push(ev)
                }
              }
            }
          }

          // Handle dragged guide appearing in a different column than its original day
          // When a guide is dragged to another day, we need to render it in the target column
          // NOTE: Skip all-day guides - they should only render in the all-day section, not the time grid
          if (dragPreview && dragPreview.entryId.startsWith('repeat:') && !dragPreview.entryId.endsWith(':allday')) {
            const previewStart = dragPreview.startedAt
            const previewEnd = dragPreview.endedAt
            // Check if the dragged guide overlaps with this column's day range
            const overlapsThisColumn = previewStart < endMs && previewEnd > startMs
            // Check if we already have this guide in the guides array (same entry ID)
            const alreadyInGuides = guides.some((g) => g.entry.id === dragPreview.entryId)
            if (overlapsThisColumn && !alreadyInGuides) {
              // Parse the guide entry ID to reconstruct the entry
              const parts = dragPreview.entryId.split(':')
              const ruleId = parts[1]
              // parts[2] is the original day start (not needed here, just for ID parsing)
              const rule = repeatingRules.find((r) => r.id === ruleId)
              if (rule) {
                // Build a synthetic guide entry for this column at the preview position
                const task = rule.taskName?.trim() || 'Session'
                const goal = rule.goalName?.trim() || null
                const bucket = rule.bucketName?.trim() || null
                const entry: HistoryEntry = {
                  id: dragPreview.entryId,
                  taskName: task,
                  elapsed: Math.max(previewEnd - previewStart, 1),
                  startedAt: previewStart,
                  endedAt: previewEnd,
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
                guides.push({
                  entry,
                  start: Math.max(previewStart, startMs),
                  end: Math.min(previewEnd, endMs),
                  previewStart,
                  previewEnd,
                })
              }
            }
          }

          return guides
        })()

        const combined: RawEvent[] = [...raw, ...guideRaw].sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start))

        if (combined.length === 0) {
          return []
        }

        // Group events with similar timing (within 15 min on both start AND end) for side-by-side stacking
        // This includes dragged events at their preview position so the preview shows accurate stacking
        // NOTE: Only group REAL events (from raw), not guides. Guides should render at full width
        // and overlay real events rather than sharing horizontal space with other guides.
        const STACK_TOLERANCE_MS = 15 * MINUTE_MS
        const stackingGroups = new Map<string, { left: number; width: number }>()
        
        // Find groups of events with nearly identical timing (real events only)
        const processed = new Set<string>()
        for (let i = 0; i < raw.length; i++) {
          const ev = raw[i]
          if (processed.has(ev.entry.id)) continue
          
          // Find all real events with similar start AND end times
          const group = [ev]
          for (let j = i + 1; j < raw.length; j++) {
            const other = raw[j]
            if (processed.has(other.entry.id)) continue
            const startDiff = Math.abs(ev.start - other.start)
            const endDiff = Math.abs(ev.end - other.end)
            if (startDiff <= STACK_TOLERANCE_MS && endDiff <= STACK_TOLERANCE_MS) {
              group.push(other)
            }
          }
          
          // If multiple events in group, assign side-by-side positions
          if (group.length > 1) {
            const width = 1 / group.length
            group.forEach((member, idx) => {
              stackingGroups.set(member.entry.id, { left: idx * width, width })
              processed.add(member.entry.id)
            })
          } else {
            processed.add(ev.entry.id)
          }
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

        return combined.map((info, index) => {
          const metadata = resolveGoalMetadata(info.entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
          const gradientCss = metadata.colorInfo?.gradient?.css
          const solidColor = metadata.colorInfo?.solidColor
          const fallbackLabel = deriveEntryTaskName(info.entry)
          const color = gradientCss ?? solidColor ?? getPaletteColorForLabel(fallbackLabel)
          const baseColor = solidColor ?? metadata.colorInfo?.gradient?.start ?? getPaletteColorForLabel(fallbackLabel)

          const segments = mergeSegments(eventSlices.get(info.entry.id) ?? [{ start: 0, end: 1, left: 0, right: 1 }])
          const clipPath = buildClipPath(segments)
          
          // Use stacking groups for events with similar timing (within 10 min tolerance)
          // Otherwise, use full width and rely on clipPath for overlaps
          const stackInfo = stackingGroups.get(info.entry.id)
          const leftPct = stackInfo ? stackInfo.left * 100 : 0
          const widthPct = stackInfo ? stackInfo.width * 100 : 100

          const topPct = ((info.start - startMs) / DAY_DURATION_MS) * 100
          const heightPct = Math.max(((info.end - info.start) / DAY_DURATION_MS) * 100, (MINUTE_MS / DAY_DURATION_MS) * 100)
          
          // Determine if this is a guide/planned task BEFORE formatting time
          const isGuide = info.entry.id.startsWith('repeat:')
          const isPlanned = !!(info.entry as any).futureSession
          
          // Both guides and real sessions show times in the display timezone
          const rangeLabel = `${formatTimeOfDay(info.previewStart, displayTimezone, use24HourTime)} — ${formatTimeOfDay(info.previewEnd, displayTimezone, use24HourTime)}`

          const duration = Math.max(info.end - info.start, 1)
          const durationScore = Math.max(0, Math.round((DAY_DURATION_MS - duration) / MINUTE_MS))
          const startScore = Math.max(0, Math.round((info.start - startMs) / MINUTE_MS))
          const zIndex = 100000 + durationScore * 1000 - startScore + index

          const durationMinutes = duration / MINUTE_MS
          const showLabel = durationMinutes >= 8
          const showTime = durationMinutes >= 20

          return {
            entry: info.entry,
            topPct: Math.min(Math.max(topPct, 0), 100),
            heightPct: Math.min(Math.max(heightPct, 0.4), 100),
            leftPct,
            widthPct,
            color,
            gradientCss,
            label: fallbackLabel,
            rangeLabel,
            // Only use clipPath for events NOT in a stacking group (they use full width and need clipping)
            clipPath: stackInfo ? undefined : clipPath,
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
      // Use display timezone for today detection to match dayStarts
      const todayMidnight = getMidnightUtcForDateInTimezone(getDateKeyInTimezone(Date.now(), displayTimezone), displayTimezone)

      const handleCalendarEventPointerDown = (
        entry: HistoryEntry,
        entryDayStart: number,
        forceMoveOnly?: boolean,
      ) => (ev: ReactPointerEvent<HTMLDivElement>) => {
        if (entry.id === 'active-session') return
        if (ev.button !== 0) return
        // Check if another interaction is already active
        const currentMode = calendarInteractionModeRef.current
        if (currentMode === 'panning' || currentMode === 'creating' || currentMode === 'dragging') return
        
        // Stop propagation - we handle both panning and dragging ourselves (like column handler)
        ev.stopPropagation()
        
        const daysRoot = calendarDaysRef.current
        const area = calendarDaysAreaRef.current
        if (!daysRoot || !area) return
        const columnEls = Array.from(daysRoot.querySelectorAll<HTMLDivElement>('.calendar-day-column'))
        if (columnEls.length === 0) return
        const columns = columnEls.map((el, idx) => ({ rect: el.getBoundingClientRect(), dayStart: dayStarts[idx] }))
        // Find the column we started in
        const startColIdx = columns.findIndex((c) => ev.clientX >= c.rect.left && ev.clientX <= c.rect.right)
        const col = startColIdx >= 0 ? columns[startColIdx] : columns[0]
        const colHeight = col.rect.height
        if (!(Number.isFinite(colHeight) && colHeight > 0)) return
        // Determine drag kind by edge proximity (top/bottom = resize, else move)
        const evRect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
        const edgePx = Math.min(12, Math.max(6, evRect.height * 0.2))
        let kind: DragKind = 'move'
        if (!forceMoveOnly) {
          if (ev.clientY - evRect.top <= edgePx) kind = 'resize-start'
          else if (evRect.bottom - ev.clientY <= edgePx) kind = 'resize-end'
        }
        const targetEl = ev.currentTarget as HTMLDivElement
        if (kind === 'move') targetEl.dataset.dragKind = 'move'
        else targetEl.dataset.dragKind = 'resize'
        
        // Set interaction mode to pending - waiting for hold timer or pan detection
        calendarInteractionModeRef.current = 'pending'
        
        const pointerId = ev.pointerId
        const startX = ev.clientX
        const startY = ev.clientY
        
        // Compute time-of-day at drag start
        const clampedStart = Math.max(Math.min(entry.startedAt, entry.endedAt), entryDayStart)
        const clampedEnd = Math.min(Math.max(entry.startedAt, entry.endedAt), entryDayStart + DAY_DURATION_MS)
        const timeOfDayMs0 = (kind === 'resize-end' ? clampedEnd : clampedStart) - entryDayStart
        
        // Track guide materialization info
        let guideMaterialization: { realEntry: HistoryEntry; ruleId: string; ymd: string } | null = null
        
        const startDrag = () => {
          // Only start drag if still in pending mode
          if (calendarInteractionModeRef.current !== 'pending') return
          calendarInteractionModeRef.current = 'dragging'
          
          const state = {
            pointerId,
            entryId: entry.id,
            startX,
            startY,
            initialStart: entry.startedAt,
            initialEnd: entry.endedAt,
            initialTimeOfDayMs: timeOfDayMs0,
            durationMs: Math.max(entry.endedAt - entry.startedAt, MIN_SESSION_DURATION_DRAG_MS),
            kind,
            columns,
            moved: false,
            activated: true,
          }
          calendarEventDragRef.current = state
          calendarDragRef.current = null
          setPageScrollLock(true, 'full')
          
          // Prepare guide materialization if needed
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
                futureSession: true,
              }
              guideMaterialization = { realEntry, ruleId, ymd }
            } catch {}
          }
          
          handleCloseCalendarPreview()
          try { targetEl.setPointerCapture?.(pointerId) } catch {}
        }
        
        const startPan = () => {
          // Only start pan if still in pending mode
          if (calendarInteractionModeRef.current !== 'pending') return
          calendarInteractionModeRef.current = 'panning'
          
          // Clear hold timer
          if (calendarHoldTimerRef.current !== null) {
            try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
            calendarHoldTimerRef.current = null
          }
          
          const rect = area.getBoundingClientRect()
          if (rect.width <= 0) return
          const dayCount = calendarView === '3d'
            ? Math.max(2, Math.min(multiDayCount, 14))
            : calendarView === 'week' ? 7 : 1
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
          calendarEventDragRef.current = null
          delete targetEl.dataset.dragKind
          try { area.setPointerCapture?.(pointerId) } catch {}
          setPageScrollLock(true)
        }
        
        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return
          const dx = e.clientX - startX
          const dy = e.clientY - startY
          const currentInteraction = calendarInteractionModeRef.current
          
          if (currentInteraction === 'pending') {
            // Still waiting - check if we should transition to pan or stay pending
            if (hasMovedPastThreshold(dx, dy, 8)) {
              startPan()
              try { e.preventDefault() } catch {}
            }
            // Not enough movement yet - wait for hold timer or more movement
            return
          }
          
          if (currentInteraction === 'panning') {
            // Handle pan move
            const state = calendarDragRef.current
            if (!state || e.pointerId !== state.pointerId) return
            const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
            if (!Number.isFinite(dayWidth) || dayWidth <= 0) return
            try { e.preventDefault() } catch {}
            const constrainedDx = clampPanDelta(dx, dayWidth, state.dayCount)
            state.lastAppliedDx = constrainedDx
            const totalPx = calendarBaseTranslateRef.current + constrainedDx
            const daysEl = calendarDaysRef.current
            const hdrEl = calendarHeadersRef.current
            const allDayEl = calendarAllDayRef.current
            if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
            if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
            if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
            return
          }
          
          if (currentInteraction === 'dragging') {
            // Handle drag move
            const s = calendarEventDragRef.current
            if (!s || e.pointerId !== s.pointerId) return
            try { e.preventDefault() } catch {}
            const baseIdx = s.columns.findIndex((c) => e.clientX >= c.rect.left && e.clientX <= c.rect.right)
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
            let newStart = s.initialStart
            let newEnd = s.initialEnd
            if (s.kind === 'move') {
              newStart = snapToNearestInterval(Math.round(target.dayStart + timeOfDay), snapToInterval)
              newEnd = Math.round(newStart + s.durationMs)
            } else if (s.kind === 'resize-start') {
              newStart = snapToNearestInterval(Math.round(target.dayStart + timeOfDay), snapToInterval)
              if (newStart > newEnd - MIN_SESSION_DURATION_DRAG_MS) {
                newStart = newEnd - MIN_SESSION_DURATION_DRAG_MS
              }
            } else {
              newEnd = snapToNearestInterval(Math.round(target.dayStart + timeOfDay), snapToInterval)
              if (newEnd < newStart + MIN_SESSION_DURATION_DRAG_MS) {
                newEnd = newStart + MIN_SESSION_DURATION_DRAG_MS
              }
            }
            const current = dragPreviewRef.current
            if (current && current.entryId === s.entryId && current.startedAt === newStart && current.endedAt === newEnd) return
            const preview = { entryId: s.entryId, startedAt: newStart, endedAt: newEnd }
            dragPreviewRef.current = preview
            setDragPreview(preview)
            s.moved = true
            return
          }
        }
        
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          
          // Clear hold timer
          if (calendarHoldTimerRef.current !== null) {
            try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
            calendarHoldTimerRef.current = null
          }
          
          const finalMode = calendarInteractionModeRef.current
          
          if (finalMode === 'panning') {
            // Finish pan
            const state = calendarDragRef.current
            if (state && e.pointerId === state.pointerId) {
              try { area.releasePointerCapture?.(state.pointerId) } catch {}
              const dx = e.clientX - state.startX
              const dayWidth = state.areaWidth / Math.max(1, state.dayCount)
              if (Number.isFinite(dayWidth) && dayWidth > 0) {
                const appliedDx = clampPanDelta(dx, dayWidth, state.dayCount)
                state.lastAppliedDx = appliedDx
                const totalPx = calendarBaseTranslateRef.current + appliedDx
                const daysEl = calendarDaysRef.current
                const hdrEl = calendarHeadersRef.current
                const allDayEl = calendarAllDayRef.current
                if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
                const { snap } = resolvePanSnap(state, dx, dayWidth, calendarView, appliedDx)
                animateCalendarPan(snap, dayWidth, state.baseOffset)
              } else {
                const base = calendarBaseTranslateRef.current
                const daysEl = calendarDaysRef.current
                const hdrEl = calendarHeadersRef.current
                if (daysEl) daysEl.style.transform = `translateX(${base}px)`
                if (hdrEl) hdrEl.style.transform = `translateX(${base}px)`
              }
            }
            calendarDragRef.current = null
            setPageScrollLock(false)
            calendarInteractionModeRef.current = null
            // Don't set dragPreventClickRef here - panning doesn't generate a click event,
            // so there's nothing to suppress. Setting it would block the next intentional click.            
            return
          }
          
          if (finalMode === 'dragging') {
            // Finish drag
            const s = calendarEventDragRef.current
            try { targetEl.releasePointerCapture?.(pointerId) } catch {}
            const preview = dragPreviewRef.current
            if (s && preview && preview.entryId === s.entryId && (preview.startedAt !== s.initialStart || preview.endedAt !== s.initialEnd)) {
              dragPreventClickRef.current = true
              // Since dayStarts are now computed in display timezone (UTC bounds),
              // preview timestamps are already in UTC - no conversion needed
              if (guideMaterialization) {
                const { realEntry, ruleId } = guideMaterialization
                const storedStartedAt = preview.startedAt
                const storedEndedAt = preview.endedAt
                flushSync(() => {
                  updateHistory((current) => {
                    const materialized = {
                      ...realEntry,
                      startedAt: storedStartedAt,
                      endedAt: storedEndedAt,
                      elapsed: Math.max(storedEndedAt - storedStartedAt, 1),
                    }
                    const next = [...current, materialized]
                    next.sort((a, b) => a.startedAt - b.startedAt)
                    return next
                  })
                })
                try {
                  void evaluateAndMaybeRetireRule(ruleId)
                } catch {}
              } else if (s) {
                // Existing real entry - preview values are already UTC
                const finalStartedAt = preview.startedAt
                const finalEndedAt = preview.endedAt
                flushSync(() => {
                  updateHistory((current) => {
                    const idx = current.findIndex((h) => h.id === s.entryId)
                    if (idx === -1) return current
                    const target = current[idx]
                    const next = [...current]
                    const nowTs = Date.now()
                    const wasInPast = target.startedAt <= nowTs
                    const nowInPast = finalStartedAt <= nowTs
                    const crossedBoundary = wasInPast !== nowInPast
                    const isFuture =
                      pendingNewHistoryId && target.id === pendingNewHistoryId ? true
                      : crossedBoundary && !nowInPast ? true
                      : crossedBoundary && nowInPast ? false
                      : target.futureSession && nowInPast ? false
                      : target.futureSession
                    const isTimezoneMarkerEntry = target.bucketName?.trim() === TIMEZONE_CHANGE_MARKER
                    const finalEnd = isTimezoneMarkerEntry ? finalStartedAt + MINUTE_MS : finalEndedAt
                    next[idx] = { ...target, startedAt: finalStartedAt, endedAt: finalEnd, elapsed: Math.max(finalEnd - finalStartedAt, 1), futureSession: isFuture }
                    return next
                  })
                })
              }
            } else if (guideMaterialization && s) {
              // Guide held but not moved - materialize at same visual position
              // Guide timestamps are already UTC in the new system
              const { realEntry, ruleId } = guideMaterialization
              const storedStartedAt = realEntry.startedAt
              const storedEndedAt = realEntry.endedAt
              const materializedEntry = {
                ...realEntry,
                startedAt: storedStartedAt,
                endedAt: storedEndedAt,
                elapsed: Math.max(storedEndedAt - storedStartedAt, 1),
                // originalTime must match the guide's time for suppression lookup to work
                originalTime: realEntry.startedAt,
              }
              flushSync(() => {
                updateHistory((current) => {
                  const next = [...current, materializedEntry]
                  next.sort((a, b) => a.startedAt - b.startedAt)
                  return next
                })
              })
              try {
                void evaluateAndMaybeRetireRule(ruleId)
              } catch {}
              dragPreventClickRef.current = true
            } else if (s) {
              dragPreventClickRef.current = true
            }
            calendarEventDragRef.current = null
            dragPreviewRef.current = null
            setDragPreview(null)
            delete targetEl.dataset.dragKind
            setPageScrollLock(false)
            calendarInteractionModeRef.current = null
            return
          }
          
          // Mode was still 'pending' - just a click, do nothing special
          delete targetEl.dataset.dragKind
          calendarInteractionModeRef.current = null
          // Always release scroll lock as safety (no-op if not locked)
          setPageScrollLock(false)
        }
        
        // Arm hold timer for drag activation
        calendarHoldTimerRef.current = window.setTimeout(() => {
          calendarHoldTimerRef.current = null
          startDrag()
        }, DRAG_HOLD_DURATION_MS)
        
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
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
      // Limit visible lanes to 1 (only show lane 0)
      const MAX_VISIBLE_LANES = 1
      const visibleAllDayBars = allDayBars.filter((b) => b.lane < MAX_VISIBLE_LANES)
      const hiddenAllDayBars = allDayBars.filter((b) => b.lane >= MAX_VISIBLE_LANES)
      // Count hidden bars per day column
      const hiddenCountPerDay: number[] = new Array(dayStarts.length).fill(0)
      for (const bar of hiddenAllDayBars) {
        for (let col = bar.colStart; col < bar.colEnd; col++) {
          if (col >= 0 && col < dayStarts.length) {
            hiddenCountPerDay[col]++
          }
        }
      }
      const allDayTrackRows = MAX_VISIBLE_LANES + (hiddenAllDayBars.length > 0 ? 1 : 0) // +1 row for "+N more" indicators
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
              {visibleAllDayBars.map((bar, i) => {
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
                    // Check if another interaction is already active
                    const currentMode = calendarInteractionModeRef.current
                    if (currentMode === 'panning' || currentMode === 'creating' || currentMode === 'dragging') return
                    // Start horizontal drag to move all-day block across days (after hold)
                    pev.stopPropagation(); handleCloseCalendarPreview()
                    const track = calendarAllDayRef.current
                    const area = calendarDaysAreaRef.current
                    if (!track || !area) return
                    const rect = track.getBoundingClientRect()
                    if (!(Number.isFinite(rect.width) && rect.width > 0 && dayStarts.length > 0)) return
                    const pointerId = pev.pointerId
                    let mode: 'pending' | 'dragging' | 'panning' = 'pending'
                    let moved = false
                    const startX = pev.clientX
                    const startY = pev.clientY
                    const dayWidth = rect.width / Math.max(1, dayStarts.length)
                    const trackLeft = rect.left
                    const clampColumnIndex = (value: number) =>
                      Math.max(0, Math.min(dayStarts.length - 1, Number.isFinite(value) ? value : 0))
                    const pointerStartIndex = clampColumnIndex(Math.floor((startX - trackLeft) / dayWidth))
                    const initialStart = bar.entry.startedAt
                    const initialEnd = bar.entry.endedAt
                    let holdTimer: number | null = null
                    
                    const activateDrag = () => {
                      if (mode !== 'pending') return
                      mode = 'dragging'
                      calendarInteractionModeRef.current = 'dragging'
                      try { (pev.currentTarget as any).setPointerCapture?.(pointerId) } catch {}
                    }
                    
                    const startPan = () => {
                      if (mode !== 'pending') return
                      mode = 'panning'
                      calendarInteractionModeRef.current = 'panning'
                      // Clear hold timer
                      if (holdTimer !== null) {
                        try { window.clearTimeout(holdTimer) } catch {}
                        holdTimer = null
                      }
                      const areaRect = area.getBoundingClientRect()
                      if (areaRect.width <= 0) return
                      const dayCount = calendarView === '3d'
                        ? Math.max(2, Math.min(multiDayCount, 14))
                        : calendarView === 'week' ? 7 : 1
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
                        pointerId,
                        startX,
                        startY,
                        startTime: now,
                        areaWidth: areaRect.width,
                        dayCount,
                        baseOffset,
                        mode: 'hdrag',
                        lastAppliedDx: 0,
                      }
                      calendarEventDragRef.current = null
                      try { area.setPointerCapture?.(pointerId) } catch {}
                      setPageScrollLock(true)
                    }
                    
                    const onMove = (e: PointerEvent) => {
                      if (e.pointerId !== pointerId) return
                      const dx = e.clientX - startX
                      const dy = e.clientY - startY
                      
                      if (mode === 'pending') {
                        // Still waiting - check if we should transition to pan
                        if (hasMovedPastThreshold(dx, dy, 8)) {
                          startPan()
                          try { e.preventDefault() } catch {}
                        }
                        return
                      }
                      
                      if (mode === 'panning') {
                        // Handle pan move
                        const state = calendarDragRef.current
                        if (!state || e.pointerId !== state.pointerId) return
                        const panDayWidth = state.areaWidth / Math.max(1, state.dayCount)
                        if (!Number.isFinite(panDayWidth) || panDayWidth <= 0) return
                        try { e.preventDefault() } catch {}
                        const constrainedDx = clampPanDelta(dx, panDayWidth, state.dayCount)
                        state.lastAppliedDx = constrainedDx
                        const totalPx = calendarBaseTranslateRef.current + constrainedDx
                        const daysEl = calendarDaysRef.current
                        const hdrEl = calendarHeadersRef.current
                        const allDayEl = calendarAllDayRef.current
                        if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                        if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                        if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
                        return
                      }
                      
                      if (mode === 'dragging') {
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
                    }
                    const onUp = (e: PointerEvent) => {
                      if (e.pointerId !== pointerId) return
                      if (holdTimer !== null) {
                        try { window.clearTimeout(holdTimer) } catch {}
                        holdTimer = null
                      }
                      window.removeEventListener('pointermove', onMove)
                      window.removeEventListener('pointerup', onUp)
                      window.removeEventListener('pointercancel', onUp)
                      
                      if (mode === 'panning') {
                        // Finish pan
                        const state = calendarDragRef.current
                        try { area.releasePointerCapture?.(pointerId) } catch {}
                        if (state && state.pointerId === pointerId) {
                          const dx = e.clientX - state.startX
                          const panDayWidth = state.areaWidth / Math.max(1, state.dayCount)
                          if (Number.isFinite(panDayWidth) && panDayWidth > 0) {
                            const appliedDx = clampPanDelta(dx, panDayWidth, state.dayCount)
                            state.lastAppliedDx = appliedDx
                            const totalPx = calendarBaseTranslateRef.current + appliedDx
                            const daysEl = calendarDaysRef.current
                            const hdrEl = calendarHeadersRef.current
                            const allDayEl = calendarAllDayRef.current
                            if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                            if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                            if (allDayEl) allDayEl.style.transform = `translateX(${totalPx}px)`
                            const { snap } = resolvePanSnap(state, dx, panDayWidth, calendarView, appliedDx)
                            animateCalendarPan(snap, panDayWidth, state.baseOffset)
                          }
                        }
                        calendarDragRef.current = null
                        calendarInteractionModeRef.current = null
                        setPageScrollLock(false)
                        return
                      }
                      
                      try { (pev.currentTarget as any).releasePointerCapture?.(pointerId) } catch {}
                      const preview = dragPreviewRef.current
                      if (moved && preview && preview.entryId === bar.entry.id && (preview.startedAt !== initialStart || preview.endedAt !== initialEnd)) {
                        // For all-day entries, convert display-timezone midnight to UTC midnight
                        // (dayStarts contains display-timezone midnight, but all-day entries should use UTC midnight)
                        let finalStartedAt = preview.startedAt
                        let finalEndedAt = preview.endedAt
                        if (bar.entry.isAllDay) {
                          // Convert from display-timezone midnight to UTC midnight
                          const startDateKey = getDateKeyInTimezone(preview.startedAt, displayTimezone)
                          const endDateKey = getDateKeyInTimezone(preview.endedAt, displayTimezone)
                          finalStartedAt = dateKeyToUtcMidnight(startDateKey)
                          finalEndedAt = dateKeyToUtcMidnight(endDateKey)
                        }
                        
                        // Check if this is a guide (synthetic entry from repeating rule)
                        if (bar.isGuide && bar.entry.id.startsWith('repeat:')) {
                          // For guides, create a new future session entry instead of updating
                          // Extract rule ID and original dayStart from guide ID format: repeat:${ruleId}:${dayStart}:allday
                          const guideParts = bar.entry.id.split(':')
                          const guideRuleId = guideParts[1] ?? null
                          const guideOriginalDayStart = guideParts[2] ? Number(guideParts[2]) : null
                          const isAllDayGuide = guideParts.length >= 4 && guideParts[3] === 'allday'
                          // For all-day guides, convert to UTC midnight for timezone-agnostic suppression
                          let originalTimeForStorage = guideOriginalDayStart
                          if (isAllDayGuide && guideOriginalDayStart != null) {
                            const ymd = getDateKeyInTimezone(guideOriginalDayStart, displayTimezone)
                            originalTimeForStorage = dateKeyToUtcMidnight(ymd)
                          }
                          const newEntry: HistoryEntry = {
                            ...bar.entry,
                            id: makeHistoryId(),
                            startedAt: finalStartedAt,
                            endedAt: finalEndedAt,
                            elapsed: Math.max(finalEndedAt - finalStartedAt, 1),
                            futureSession: true,
                            // Link to repeating rule so the original guide date gets suppressed
                            repeatingSessionId: guideRuleId,
                            originalTime: originalTimeForStorage,
                          }
                          flushSync(() => {
                            updateHistory((current) => {
                              const next = [...current, newEntry]
                              next.sort((a, b) => a.startedAt - b.startedAt)
                              return next
                            })
                          })
                        } else {
                          // For real entries, update in place
                          flushSync(() => {
                            updateHistory((current) => {
                              const idx = current.findIndex((h) => h.id === bar.entry.id)
                              if (idx === -1) return current
                              const target = current[idx]
                              const next = [...current]
                              next[idx] = { ...target, startedAt: finalStartedAt, endedAt: finalEndedAt, elapsed: Math.max(finalEndedAt - finalStartedAt, 1) }
                              return next
                            })
                          })
                        }
                      }
                      dragPreviewRef.current = null
                      setDragPreview(null)
                      calendarInteractionModeRef.current = null
                    }
                    holdTimer = window.setTimeout(() => {
                      holdTimer = null
                      activateDrag()
                    }, DRAG_HOLD_DURATION_MS)
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
              {/* "+N more" indicators for each day column with hidden all-day events */}
              {hiddenCountPerDay.map((count, colIndex) => {
                if (count === 0) return null
                // Get all entries for this day (both visible and hidden) for the overlay
                const dayDateKey = dayDateKeys[colIndex]
                const dayStart = dayStarts[colIndex]
                const dayDate = new Date(dayStart)
                const dateLabel = dayDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                const entriesForDay = allDayBars
                  .filter((b) => b.colStart <= colIndex && b.colEnd > colIndex)
                  .map((b) => b.entry)
                return (
                  <div
                    key={`allday-more-${colIndex}`}
                    className="calendar-allday-more"
                    style={{ gridColumn: `${colIndex + 1}`, gridRow: `${MAX_VISIBLE_LANES + 1}` }}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      setMonthCellOverview({ dateKey: dayDateKey, dateLabel, entries: entriesForDay })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setMonthCellOverview({ dateKey: dayDateKey, dateLabel, entries: entriesForDay })
                      }
                    }}
                  >
                    +{count} more
                  </div>
                )
              })}
              {/* Hold-to-create hit area for all-day sessions (single element spanning all days) */}
              <div
                className="calendar-allday-hit-area"
                style={{ gridColumn: `1 / ${dayStarts.length + 1}`, gridRow: `1 / ${allDayTrackRows + 1}` }}
                onPointerDown={(pev) => {
                  if (pev.button !== 0) return
                  // Check if another interaction is already active
                  const currentMode = calendarInteractionModeRef.current
                  if (currentMode === 'panning' || currentMode === 'creating' || currentMode === 'dragging') return
                  // Ignore if starting on an existing all-day event
                  const rawTarget = pev.target as HTMLElement | null
                  if (rawTarget && rawTarget.closest('.calendar-allday-event')) return
                  pev.stopPropagation()

                  const track = calendarAllDayRef.current
                  const area = calendarDaysAreaRef.current
                  if (!track || !area) return
                  const rect = track.getBoundingClientRect()
                  if (!(Number.isFinite(rect.width) && rect.width > 0 && dayStarts.length > 0)) return

                  const pointerId = pev.pointerId
                  const startX = pev.clientX
                  const startY = pev.clientY
                  const dayWidth = rect.width / Math.max(1, dayStarts.length)
                  const trackLeft = rect.left
                  const clampColumnIndex = (value: number) =>
                    Math.max(0, Math.min(dayStarts.length - 1, Number.isFinite(value) ? value : 0))
                  const pointerStartIndex = clampColumnIndex(Math.floor((startX - trackLeft) / dayWidth))

                  // Set interaction mode to pending
                  calendarInteractionModeRef.current = 'pending'

                  let creatingNewAllDay = false
                  let newEntryId: string | null = null
                  let initialColIndex = pointerStartIndex
                  let currentColIndex = pointerStartIndex

                  const startCreate = () => {
                    if (calendarInteractionModeRef.current !== 'pending') return
                    calendarInteractionModeRef.current = 'creating'
                    creatingNewAllDay = true
                    newEntryId = makeHistoryId()
                    // Initial preview: single day
                    const dateKey = dayDateKeys[initialColIndex]
                    const utcMidnight = dateKeyToUtcMidnight(dateKey)
                    const preview = { entryId: 'new-allday', startedAt: utcMidnight, endedAt: utcMidnight + DAY_DURATION_MS }
                    dragPreviewRef.current = preview
                    setDragPreview(preview)
                    setPageScrollLock(true)
                    try { (pev.currentTarget as any).setPointerCapture?.(pointerId) } catch {}
                  }

                  const startPan = () => {
                    if (calendarInteractionModeRef.current !== 'pending') return
                    calendarInteractionModeRef.current = 'panning'
                    if (calendarHoldTimerRef.current !== null) {
                      try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
                      calendarHoldTimerRef.current = null
                    }
                    const areaRect = area.getBoundingClientRect()
                    if (areaRect.width <= 0) return
                    const dayCount = calendarView === '3d'
                      ? Math.max(2, Math.min(multiDayCount, 14))
                      : calendarView === 'week' ? 7 : 1
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
                      areaWidth: areaRect.width,
                      dayCount,
                      baseOffset,
                      mode: 'hdrag',
                      lastAppliedDx: 0,
                    }
                    try { area.setPointerCapture?.(pointerId) } catch {}
                    setPageScrollLock(true)
                  }

                  const onMove = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    const dx = e.clientX - startX
                    const dy = e.clientY - startY
                    const mode = calendarInteractionModeRef.current

                    if (mode === 'pending') {
                      // Movement before hold timer - start panning
                      if (hasMovedPastThreshold(dx, dy, 8)) {
                        startPan()
                        try { e.preventDefault() } catch {}
                        return
                      }
                      return
                    }

                    if (mode === 'panning') {
                      const state = calendarDragRef.current
                      if (!state || e.pointerId !== state.pointerId) return
                      const panDayWidth = state.areaWidth / Math.max(1, state.dayCount)
                      if (!Number.isFinite(panDayWidth) || panDayWidth <= 0) return
                      try { e.preventDefault() } catch {}
                      const constrainedDx = clampPanDelta(dx, panDayWidth, state.dayCount)
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

                    if (mode === 'creating' && creatingNewAllDay) {
                      try { e.preventDefault() } catch {}
                      const rawPointerIndex = Math.floor((e.clientX - trackLeft) / dayWidth)
                      const pointerIndex = clampColumnIndex(rawPointerIndex)
                      if (pointerIndex === currentColIndex) return
                      currentColIndex = pointerIndex
                      // Calculate start and end columns (can drag left or right)
                      const startCol = Math.min(initialColIndex, currentColIndex)
                      const endCol = Math.max(initialColIndex, currentColIndex)
                      const startDateKey = dayDateKeys[startCol]
                      const endDateKey = dayDateKeys[endCol]
                      const startUtc = dateKeyToUtcMidnight(startDateKey)
                      const endUtc = dateKeyToUtcMidnight(endDateKey) + DAY_DURATION_MS
                      const preview = { entryId: 'new-allday', startedAt: startUtc, endedAt: endUtc }
                      dragPreviewRef.current = preview
                      setDragPreview(preview)
                      return
                    }
                  }

                  const onUp = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    if (calendarHoldTimerRef.current !== null) {
                      try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
                      calendarHoldTimerRef.current = null
                    }
                    window.removeEventListener('pointermove', onMove)
                    window.removeEventListener('pointerup', onUp)
                    window.removeEventListener('pointercancel', onUp)
                    try { (pev.currentTarget as any).releasePointerCapture?.(pointerId) } catch {}

                    const finalMode = calendarInteractionModeRef.current

                    if (finalMode === 'panning') {
                      const state = calendarDragRef.current
                      if (state && e.pointerId === state.pointerId) {
                        area.releasePointerCapture?.(state.pointerId)
                        const dx = e.clientX - state.startX
                        const panDayWidth = state.areaWidth / Math.max(1, state.dayCount)
                        if (Number.isFinite(panDayWidth) && panDayWidth > 0) {
                          const appliedDx = clampPanDelta(dx, panDayWidth, state.dayCount)
                          state.lastAppliedDx = appliedDx
                          const totalPx = calendarBaseTranslateRef.current + appliedDx
                          const daysEl = calendarDaysRef.current
                          if (daysEl) daysEl.style.transform = `translateX(${totalPx}px)`
                          const hdrEl = calendarHeadersRef.current
                          if (hdrEl) hdrEl.style.transform = `translateX(${totalPx}px)`
                          const { snap } = resolvePanSnap(state, dx, panDayWidth, calendarView, appliedDx)
                          animateCalendarPan(snap, panDayWidth, state.baseOffset)
                        } else {
                          const base = calendarBaseTranslateRef.current
                          const daysEl = calendarDaysRef.current
                          if (daysEl) daysEl.style.transform = `translateX(${base}px)`
                          const hdrEl = calendarHeadersRef.current
                          if (hdrEl) hdrEl.style.transform = `translateX(${base}px)`
                        }
                      }
                      calendarDragRef.current = null
                      setPageScrollLock(false)
                      calendarInteractionModeRef.current = null
                      return
                    }

                    if (finalMode === 'creating' && creatingNewAllDay && newEntryId) {
                      setPageScrollLock(false)
                      const preview = dragPreviewRef.current
                      if (preview && preview.entryId === 'new-allday') {
                        const startCol = Math.min(initialColIndex, currentColIndex)
                        const endCol = Math.max(initialColIndex, currentColIndex)
                        const startDateKey = dayDateKeys[startCol]
                        const endDateKey = dayDateKeys[endCol]
                        const startUtc = dateKeyToUtcMidnight(startDateKey)
                        const endUtc = dateKeyToUtcMidnight(endDateKey) + DAY_DURATION_MS
                        const elapsed = endUtc - startUtc
                        const newEntry: HistoryEntry = {
                          id: newEntryId,
                          taskName: '',
                          elapsed,
                          startedAt: startUtc,
                          endedAt: endUtc,
                          goalName: LIFE_ROUTINES_NAME,
                          bucketName: null,
                          goalId: LIFE_ROUTINES_GOAL_ID,
                          bucketId: null,
                          taskId: null,
                          goalSurface: LIFE_ROUTINES_SURFACE,
                          bucketSurface: null,
                          notes: '',
                          subtasks: [],
                          isAllDay: true,
                        }
                        flushSync(() => {
                          updateHistory((current) => {
                            const next = [...current, newEntry]
                            next.sort((a, b) => a.startedAt - b.startedAt)
                            return next
                          })
                        })
                        setPendingNewHistoryId(newEntryId)
                        setTimeout(() => { openCalendarInspector(newEntry) }, 0)
                      }
                      dragPreviewRef.current = null
                      setDragPreview(null)
                      calendarInteractionModeRef.current = null
                      return
                    }

                    // Mode was pending - just a click, do nothing
                    calendarInteractionModeRef.current = null
                    setPageScrollLock(false)
                  }

                  // Start hold timer for creating
                  calendarHoldTimerRef.current = window.setTimeout(() => {
                    calendarHoldTimerRef.current = null
                    startCreate()
                  }, DRAG_HOLD_DURATION_MS)

                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                  window.addEventListener('pointercancel', onUp)
                }}
                aria-label="Hold to create all-day session"
              />
              {/* Preview element for new all-day session being created */}
              {(() => {
                const preview = dragPreview
                if (!preview || preview.entryId !== 'new-allday') return null
                // Calculate columns from UTC midnight timestamps
                const startDateKey = getUtcDateKey(preview.startedAt)
                const endDateKey = getUtcDateKey(preview.endedAt)
                const colStart = dayDateKeys.indexOf(startDateKey)
                const endColIdx = dayDateKeys.indexOf(endDateKey)
                const colEnd = endColIdx >= 0 ? endColIdx : dayDateKeys.length
                if (colStart < 0 || colEnd <= colStart) return null
                return (
                  <div
                    className="calendar-allday-event calendar-allday-event--preview"
                    style={{
                      gridColumn: `${colStart + 1} / ${colEnd + 1}`,
                      gridRow: '1',
                      background: 'rgba(104, 124, 255, 0.6)',
                      pointerEvents: 'none',
                    }}
                    aria-hidden
                  >
                    <div className="calendar-allday-event__content">
                      <div className="calendar-allday-event__title">New session</div>
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
          <div className="calendar-time-axis" aria-hidden>
            {hours.map((h) => (
              <div key={`t-${h}`} className="calendar-time-label" style={{ top: `${(h / 24) * 100}%` }}>
                {h > 0 && h < 24 ? formatHourLabel(h, use24HourTime) : ''}
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
                  // Check if another interaction is already active - if so, don't interfere
                  const currentMode = calendarInteractionModeRef.current
                  if (currentMode === 'panning' || currentMode === 'creating' || currentMode === 'dragging') return
                  
                  // Stop propagation to prevent handleCalendarAreaPointerDown from also firing
                  ev.stopPropagation()
                  
                  const targetEl = ev.currentTarget as HTMLDivElement
                  // Ignore if starting on an existing event or timezone marker
                  const rawTarget = ev.target as HTMLElement | null
                  if (rawTarget && (rawTarget.closest('.calendar-event') || rawTarget.closest('.calendar-timezone-marker'))) return
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

                  // Set interaction mode to pending - waiting for hold timer or pan detection
                  calendarInteractionModeRef.current = 'pending'
                  
                  // Intent detection: wait to decide between horizontal pan vs vertical create
                  const pointerId = ev.pointerId
                  const startX = ev.clientX
                  const startY = ev.clientY

                  const startCreate = () => {
                    // Double-check we're still in pending mode (not cancelled by pan)
                    if (calendarInteractionModeRef.current !== 'pending') return
                    calendarInteractionModeRef.current = 'creating'
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
                    // Lock page scroll while dragging to create
                    setPageScrollLock(true)
                    try { targetEl.setPointerCapture?.(pointerId) } catch {}
                  }

                  const startPan = () => {
                    // Only transition to panning if we're still in pending mode
                    if (calendarInteractionModeRef.current !== 'pending') return
                    calendarInteractionModeRef.current = 'panning'
                    // Clear the hold timer since we're panning now
                    if (calendarHoldTimerRef.current !== null) {
                      try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
                      calendarHoldTimerRef.current = null
                    }
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
                    setPageScrollLock(true)
                  }

                  const onMove = (e: PointerEvent) => {
                    if (e.pointerId !== pointerId) return
                    const dx = e.clientX - startX
                    const dy = e.clientY - startY
                    const currentInteraction = calendarInteractionModeRef.current
                    
                    if (currentInteraction === 'pending') {
                      // Still waiting - check if we should transition to pan
                      if (hasMovedPastThreshold(dx, dy, 8)) {
                        startPan()
                        try { e.preventDefault() } catch {}
                        return
                      }
                      // Not enough movement yet - wait for hold timer or more movement
                      return
                    }
                    
                    if (currentInteraction === 'panning') {
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
                    
                    if (currentInteraction === 'creating') {
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
                      newEnd = snapToNearestInterval(Math.round(target.dayStart + timeOfDay), snapToInterval)
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
                    // Clear hold timer if still running
                    if (calendarHoldTimerRef.current !== null) {
                      try { window.clearTimeout(calendarHoldTimerRef.current) } catch {}
                      calendarHoldTimerRef.current = null
                    }
                    
                    const finalMode = calendarInteractionModeRef.current

                    if (finalMode === 'panning') {
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
                      setPageScrollLock(false)
                      calendarInteractionModeRef.current = null
                      return
                    }

                    if (finalMode === 'creating') {
                      // Release page scroll lock at the end of create drag (noop if not locked)
                      setPageScrollLock(false)
                      try { targetEl.releasePointerCapture?.(pointerId) } catch {}
                      const preview = dragPreviewRef.current
                      if (preview && preview.entryId === 'new-entry') {
                        // Preview timestamps are already UTC (dayStarts uses display timezone bounds)
                        const rawStartedAt = Math.min(preview.startedAt, preview.endedAt)
                        const rawEndedAt = Math.max(preview.startedAt, preview.endedAt)
                        const elapsed = Math.max(rawEndedAt - rawStartedAt, MIN_SESSION_DURATION_DRAG_MS)
                        const newId = makeHistoryId()
                        const newEntry: HistoryEntry = {
                          id: newId,
                          taskName: '',
                          goalName: LIFE_ROUTINES_NAME,
                          bucketName: null,
                          goalId: LIFE_ROUTINES_GOAL_ID,
                          bucketId: null,
                          taskId: null,
                          elapsed,
                          startedAt: rawStartedAt,
                          endedAt: rawEndedAt,
                          goalSurface: LIFE_ROUTINES_SURFACE,
                          bucketSurface: null,
                          notes: '',
                          subtasks: [],
                        }
                        flushSync(() => {
                          updateHistory((current) => {
                            const next = [...current, newEntry]
                            next.sort((a, b) => a.startedAt - b.startedAt)
                            return next
                          })
                        })
                        setPendingNewHistoryId(newId)
                        // Open editor synchronously to maintain user gesture chain for touch keyboard
                        flushSync(() => {
                          openCalendarInspector(newEntry)
                        })
                        // Focus the input immediately after flushSync renders the modal
                        const input = calendarEditorNameInputRef.current
                        if (input) {
                          try {
                            input.focus()
                            const len = input.value?.length ?? 0
                            input.setSelectionRange(len, len)
                          } catch {}
                        }
                      }
                      calendarEventDragRef.current = null
                      dragPreviewRef.current = null
                      setDragPreview(null)
                      calendarInteractionModeRef.current = null
                      return
                    }
                    
                    // No intent detected (tap) or still pending — clean up
                    calendarInteractionModeRef.current = null
                    // Always release scroll lock as safety (no-op if not locked)
                    setPageScrollLock(false)
                  }
                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                  window.addEventListener('pointercancel', onUp)
                  // Require a hold timer to start creation for all input types
                  // Store in ref so it can be cancelled by pan detection
                  calendarHoldTimerRef.current = window.setTimeout(() => {
                    calendarHoldTimerRef.current = null
                    startCreate()
                  }, DRAG_HOLD_DURATION_MS)
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
                      
                      // Check if this is a timezone change marker
                      const isTimezoneMarker = ev.entry.bucketName?.trim() === TIMEZONE_CHANGE_MARKER
                      
                      // Render timezone markers as horizontal indicator lines instead of event blocks
                      if (isTimezoneMarker) {
                        return (
                          <div
                            key={`tz-${di}-${idx}-${ev.entry.id}`}
                            className="calendar-timezone-marker"
                            style={{
                              position: 'absolute',
                              top: `${ev.topPct}%`,
                              left: '0',
                              right: '0',
                              transform: 'translateY(-50%)',
                              // Use padding to create a larger hit area while keeping the visual line thin
                              height: '20px',
                              display: 'flex',
                              alignItems: 'center',
                              zIndex: ev.zIndex + 10,
                              cursor: 'default',
                              pointerEvents: 'auto',
                            }}
                            data-entry-id={ev.entry.id}
                            role="button"
                            aria-label={`Timezone change marker at ${ev.rangeLabel}`}
                            title={`Timezone Change · ${formatTime(ev.entry.startedAt)}`}
                            onClick={(e) => {
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
                              setSelectedHistoryId(ev.entry.id)
                              setHoveredHistoryId(ev.entry.id)
                              setEditingHistoryId(ev.entry.id)
                              taskNameAutofilledRef.current = false
                              setHistoryDraft(createHistoryDraftFromEntry(ev.entry))
                              openCalendarInspector(ev.entry)
                              handleCloseCalendarPreview()
                            }}
                            onPointerDown={(pev) => {
                              // Set grabbing cursor while dragging
                              (pev.currentTarget as HTMLElement).style.cursor = 'grabbing'
                              // Only allow move drag for timezone markers (no resize)
                              handleCalendarEventPointerDown(ev.entry, start, true)(pev)
                            }}
                            onPointerUp={(pev) => {
                              // Restore default cursor after drag
                              (pev.currentTarget as HTMLElement).style.cursor = 'default'
                            }}
                          >
                            {/* The visible line - matching calendar-now-line style */}
                            <div
                              style={{
                                width: '100%',
                                height: '2px',
                                background: 'linear-gradient(90deg, #ef4444 0%, #ec4899 100%)',
                                pointerEvents: 'none',
                              }}
                            />
                          </div>
                        )
                      }
                      
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
                          left: `calc(${ev.leftPct}% + 2px)`,
                          width: `calc(${ev.widthPct}% - 4px)`,
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
                            // Guide timestamps are now UTC (dayStarts uses display timezone bounds)
                            const storedStartedAt = ev.entry.startedAt
                            const storedEndedAt = ev.entry.endedAt
                            const newEntry: HistoryEntry = {
                              ...ev.entry,
                              id: makeHistoryId(),
                              startedAt: storedStartedAt,
                              endedAt: storedEndedAt,
                              elapsed: Math.max(storedEndedAt - storedStartedAt, 1),
                              repeatingSessionId: ruleId,
                              // originalTime must match guide's time for suppression lookup
                              originalTime: ev.entry.startedAt,
                            }
                            updateHistory((current) => {
                              const next = [...current, newEntry]
                              next.sort((a, b) => a.startedAt - b.startedAt)
                              return next
                            })
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
                      // Drag preview values are computed from dayStarts (display timezone)
                      const label = `${formatTimeOfDay(startClamped, displayTimezone, use24HourTime)} — ${formatTimeOfDay(endClamped, displayTimezone, use24HourTime)}`
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
      // Rotate headers based on weekStartDay (0=Sunday first, 1=Monday first)
      const baseHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const headers = [...baseHeaders.slice(weekStartDay), ...baseHeaders.slice(0, weekStartDay)]
      const buildMonthPanel = (baseDate: Date) => {
        const firstOfMonth = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1)
        const lastOfMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0)
        // Start from the weekStartDay on/before the first of the month
        const gridStart = new Date(firstOfMonth)
        const offset = (gridStart.getDay() - weekStartDay + 7) % 7
        gridStart.setDate(gridStart.getDate() - offset)
        // Extend to the day before next weekStartDay on/after the end of the month
        const gridEnd = new Date(lastOfMonth)
        const gridEndDow = gridEnd.getDay()
        const daysToWeekEnd = (6 - gridEndDow + weekStartDay) % 7
        gridEnd.setDate(gridEnd.getDate() + daysToWeekEnd)

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
      // Use display timezone for today detection
      const todayDateKeyInDisplayTz = getDateKeyInTimezone(Date.now(), displayTimezone)

      const buildYearPanel = (yr: number) => {
        const months = Array.from({ length: 12 }).map((_, idx) => {
          const firstOfMonth = new Date(yr, idx, 1)
          const label = firstOfMonth.toLocaleDateString(undefined, { month: 'short' })
          // Calculate the start of the grid (first day of the week containing the 1st)
          const start = new Date(firstOfMonth)
          const startDow = start.getDay() // 0=Sun
          const offset = (startDow - weekStartDay + 7) % 7
          start.setDate(start.getDate() - offset)
          // Calculate how many weeks we need: only show weeks that contain days from this month
          const lastOfMonth = new Date(yr, idx + 1, 0) // last day of current month
          const lastDow = lastOfMonth.getDay()
          const daysAfterLastInWeek = (weekStartDay + 6 - lastDow + 7) % 7 // days to complete that week
          const endOfGrid = new Date(lastOfMonth)
          endOfGrid.setDate(lastOfMonth.getDate() + daysAfterLastInWeek)
          const totalDays = Math.round((endOfGrid.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
          const cells: ReactElement[] = []
          for (let i = 0; i < totalDays; i += 1) {
            const d = new Date(start)
            d.setDate(start.getDate() + i)
            d.setHours(0, 0, 0, 0)
            const inMonth = d.getMonth() === idx
            // Compare date key strings instead of timestamps for accurate today detection
            const cellDateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            const isToday = cellDateKey === todayDateKeyInDisplayTz
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
    setView,
    setHistoryDayOffset,
    navigateByDelta,
    stepSizeByView,
    formatTime,
    weekStartDay,
    snapToInterval,
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
      if (isEntryAllDay(entry)) {
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
        return `${dateFmt} · ${formatTime(entry.startedAt)} — ${formatTime(entry.endedAt)}`
      }
      return formatDateRange(entry.startedAt, entry.endedAt, use24HourTime)
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
        futureSession: true,
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
    // Check if this is a timezone change marker
    const isTimezoneChangeMarker = 
      entry.goalName?.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase() &&
      entry.bucketName?.trim() === TIMEZONE_CHANGE_MARKER
    // Parse From/To cities from session name for timezone markers
    const parsedTimezones = isTimezoneChangeMarker ? parseTimezoneFromSessionName(entry.taskName || '') : null
    const cachedSubtasks = subtasksCache.get(entry.id)
    const summarySubtasks =
      entry.id === selectedHistoryId ? historyDraft.subtasks : cachedSubtasks ?? entry.subtasks
    const subtaskCount = summarySubtasks.length
    const completedSubtasks = summarySubtasks.reduce((count, subtask) => (subtask.completed ? count + 1 : count), 0)
    const hasNotes = entry.notes.trim().length > 0
    const subtasksSummary = subtaskCount > 0 ? `${completedSubtasks}/${subtaskCount} subtasks` : 'No subtasks'
    const notesSummary = hasNotes ? 'Notes added' : 'No notes'
          const isGuide = entry.id.startsWith('repeat:')
    const isActiveSessionEntry = entry.id === 'active-session'
    const isActiveRunning = isActiveSessionEntry && activeSession?.isRunning
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
      // Check if this is an all-day guide (has ':allday' suffix)
      const isAllDayGuide = parts.length >= 4 && parts[3] === 'allday'
      // Use display timezone for date key to match how occurrence keys are built
      const ymd = getDateKeyInTimezone(dayStart, displayTimezone)
      // For all-day guides, compute UTC midnight for storage
      // (all-day entries use getUtcDateKey for column matching, which expects UTC midnight)
      const utcMidnight = isAllDayGuide ? dateKeyToUtcMidnight(ymd) : null
      return { ruleId, dayStart, ymd, isAllDayGuide, utcMidnight }
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
            {isGuide ? null : (
              <>
                <button
                  type="button"
                  className="calendar-popover__action"
                  aria-label="Edit session"
                  onPointerDown={(ev) => {
                    ev.preventDefault()
                    ev.stopPropagation()
                  }}
                  onClick={(ev) => {
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
              // Use display timezone for wall-clock time extraction
              const minutes = getMinutesFromMidnightInTimezone(entry.startedAt, displayTimezone)
              const durMin = Math.max(1, Math.round((entry.endedAt - entry.startedAt) / 60000))
              const timeParts = getTimePartsInTimezone(entry.startedAt, displayTimezone)
              const dateKey = getDateKeyInTimezone(entry.startedAt, displayTimezone)
              const dayStartMs = getMidnightUtcForDateInTimezone(dateKey, displayTimezone)
              // Get day of week in display timezone
              const dowDate = new Date(dayStartMs + 12 * 60 * 60 * 1000) // noon to avoid DST issues
              const dow = dowDate.getUTCDay()
              const monthDay = `${String(timeParts.month).padStart(2, '0')}-${String(timeParts.day).padStart(2, '0')}`
              // Check if this entry is all-day
              const entryIsAllDay = isEntryAllDay(entry)
              
              // Check if entry has been moved from its original scheduled time
              // If so, it's a rescheduled instance and should not show the repeat rule
              const originalTime = (entry as any).originalTime as number | undefined | null
              const hasBeenMoved = (() => {
                if (!Number.isFinite(originalTime as number)) return false
                if (entryIsAllDay) {
                  // For all-day entries, compare by date (UTC date key)
                  const originalDateKey = getUtcDateKey(originalTime as number)
                  const currentDateKey = getUtcDateKey(entry.startedAt)
                  return originalDateKey !== currentDateKey
                } else {
                  // For timed entries, compare exact timestamps
                  return entry.startedAt !== originalTime
                }
              })()
              
              // Check if entry is linked to a rule that has ended
              // If so, this entry (and all future entries with this ID) should show "None"
              const entryRepeatId = (entry as any).repeatingSessionId as string | undefined | null
              const linkedRule = entryRepeatId ? repeatingRules.find((r) => r.id === entryRepeatId) : null
              const linkedRuleEndAtMs = linkedRule ? ((linkedRule as any).endAtMs as number | undefined | null) : null
              const isPastLinkedRuleEnd = Number.isFinite(linkedRuleEndAtMs as number) && entry.startedAt >= (linkedRuleEndAtMs as number)
              
              // Helper to check if a rule is all-day
              const ruleIsAllDay = (r: RepeatingSessionRule) => 
                r.isAllDay === true || (r.timeOfDayMinutes === 0 && (r.durationMinutes ?? 60) >= 1440)
              const matches = (r: RepeatingSessionRule) => {
                if (!r.isActive) return false
                // If entry has been moved from original time, don't match any rules
                if (hasBeenMoved) return false
                // If entry is past its linked rule's end, don't match any rules
                if (isPastLinkedRuleEnd) return false
                // If the rule has ended at or before this entry's scheduled time, don't match
                // This ensures entries at the end boundary show "None" in the dropdown
                const ruleEndAtMs = (r as any).endAtMs as number | undefined | null
                if (Number.isFinite(ruleEndAtMs as number) && entry.startedAt >= (ruleEndAtMs as number)) {
                  return false
                }
                // Match task/goal/bucket names
                const taskMatch = (r.taskName?.trim() || '') === (entry.taskName?.trim() || '')
                const goalMatch = (r.goalName?.trim() || null) === (entry.goalName?.trim() || null)
                const bucketMatch = (r.bucketName?.trim() || null) === (entry.bucketName?.trim() || null)
                if (!taskMatch || !goalMatch || !bucketMatch) return false
                // For all-day entries, match against all-day rules (skip time/duration check)
                if (entryIsAllDay) {
                  return ruleIsAllDay(r)
                }
                // For timed entries, match time and duration
                return r.timeOfDayMinutes === minutes && r.durationMinutes === durMin
              }
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
                      // If already showing 'none', do nothing
                      if (currentVal === 'none') return
                      // If this entry is a guide from a repeating rule, cut the series after this instance
                      if (isGuide) {
                        // parsedGuide contains ruleId and ymd for this guide
                        if (parsedGuide) {
                          const guideMinutes = getMinutesFromMidnightInTimezone(entry.startedAt, displayTimezone)
                          const guideDateKey = getDateKeyInTimezone(entry.startedAt, displayTimezone)
                          const guideDayStart = getMidnightUtcForDateInTimezone(guideDateKey, displayTimezone)
                          const scheduledStart = guideDayStart + guideMinutes * 60000
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
                        const noneMinutes = getMinutesFromMidnightInTimezone(entry.startedAt, displayTimezone)
                        const durMin = Math.max(1, Math.round((entry.endedAt - entry.startedAt) / 60000))
                        const noneDateKey = getDateKeyInTimezone(entry.startedAt, displayTimezone)
                        const noneDayStartMs = getMidnightUtcForDateInTimezone(noneDateKey, displayTimezone)
                        // Get day of week in display timezone
                        const noneDowDate = new Date(noneDayStartMs + 12 * 60 * 60 * 1000)
                        const noneDow = noneDowDate.getUTCDay()
                        const noneTimeParts = getTimePartsInTimezone(entry.startedAt, displayTimezone)
                        const noneMonthDay = `${String(noneTimeParts.month).padStart(2, '0')}-${String(noneTimeParts.day).padStart(2, '0')}`
                        const labelTask = (entry.taskName?.trim() || '')
                        const labelGoal = (entry.goalName?.trim() || null)
                        const labelBucket = (entry.bucketName?.trim() || null)
                        // Compute scheduled start (truncate seconds/ms) to match how rules store startAtMs
                        const scheduledStart = noneDayStartMs + noneMinutes * 60000
                        const seedRules = repeatingRules.filter((r) => {
                          const labelMatch = (r.taskName?.trim() || '') === labelTask && (r.goalName?.trim() || null) === labelGoal && (r.bucketName?.trim() || null) === labelBucket
                          const timeMatch = r.timeOfDayMinutes === noneMinutes && r.durationMinutes === durMin
                          const freqMatch =
                            r.frequency === 'daily' ||
                            (r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(noneDow)) ||
                            (r.frequency === 'monthly' && matchesMonthlyDay(r, noneDayStartMs)) ||
                            (r.frequency === 'annually' && ruleMonthDayKey(r) === noneMonthDay)
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
                            const timeMatch = r.timeOfDayMinutes === noneMinutes && r.durationMinutes === durMin
                            const freqMatch =
                              r.frequency === 'daily' ||
                              (r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(noneDow)) ||
                              (r.frequency === 'monthly' && matchesMonthlyDay(r, noneDayStartMs)) ||
                              (r.frequency === 'annually' && ruleMonthDayKey(r) === noneMonthDay)
                            return !(labelMatch && timeMatch && freqMatch)
                          }))
                        }
                      }
                      return
                    }
                    // If entry is already linked to a different repeating session, unlink it first
                    // This allows the old rule's guide task to reappear for that occurrence
                    const existingRuleId = entry.repeatingSessionId
                    if (existingRuleId) {
                      updateHistory((current) =>
                        current.map((h) => (h.id === entry.id ? { ...h, repeatingSessionId: null, originalTime: null } : h)),
                      )
                    }
                    const created = await createRepeatingRuleForEntry(entry, val, { displayTimezone })
                    if (created) {
                      // Add rule to state, but avoid duplicates (createRepeatingRuleForEntry already writes to localStorage)
                      setRepeatingRules((prev) => {
                        if (prev.some((r) => r.id === created.id)) return prev
                        return [...prev, created]
                      })
                      const scheduledStart = computeEntryScheduledStart(entry, displayTimezone)
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
                    // For all-day guides, use UTC midnight for storage so getUtcDateKey works correctly
                    // For regular guides, use the display-timezone timestamps
                    const storedStartedAt = parsedGuide.isAllDayGuide && parsedGuide.utcMidnight != null
                      ? parsedGuide.utcMidnight
                      : entry.startedAt
                    const storedEndedAt = parsedGuide.isAllDayGuide && parsedGuide.utcMidnight != null
                      ? parsedGuide.utcMidnight + DAY_DURATION_MS
                      : entry.endedAt
                    // For all-day guides, store originalTime as UTC midnight for timezone-agnostic matching
                    // For time-based guides, use dayStart (display-timezone midnight)
                    const originalTimeForKey = parsedGuide.isAllDayGuide && parsedGuide.utcMidnight != null
                      ? parsedGuide.utcMidnight
                      : parsedGuide.dayStart
                    const newEntry: HistoryEntry = {
                      ...entry,
                      id: makeHistoryId(),
                      startedAt: storedStartedAt,
                      endedAt: storedEndedAt,
                      elapsed: Math.max(storedEndedAt - storedStartedAt, 1),
                      repeatingSessionId: parsedGuide.ruleId,
                      // For all-day: UTC midnight for timezone-agnostic suppression
                      // For time-based: dayStart for display-timezone matching
                      originalTime: originalTimeForKey,
                      futureSession: false,
                    }
                    updateHistory((current) => {
                      const next = [...current, newEntry]
                      next.sort((a, b) => a.startedAt - b.startedAt)
                      return next
                    })
                    try {
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
                    // Create a zero-duration entry to mark this occurrence as resolved without rendering.
                    // For all-day guides, use UTC midnight; for regular guides, use display-timezone time
                    const storedTime = parsedGuide.isAllDayGuide && parsedGuide.utcMidnight != null
                      ? parsedGuide.utcMidnight
                      : entry.startedAt
                    // For all-day guides, store originalTime as UTC midnight for timezone-agnostic matching
                    const originalTimeForKey = parsedGuide.isAllDayGuide && parsedGuide.utcMidnight != null
                      ? parsedGuide.utcMidnight
                      : parsedGuide.dayStart
                    const zeroEntry: HistoryEntry = {
                      ...entry,
                      id: makeHistoryId(),
                      startedAt: storedTime,
                      endedAt: storedTime,
                      elapsed: 0,
                      repeatingSessionId: parsedGuide.ruleId,
                      // For all-day: UTC midnight; for time-based: dayStart
                      originalTime: originalTimeForKey,
                    }
                    updateHistory((current) => {
                      const next = [...current, zeroEntry]
                      next.sort((a, b) => a.startedAt - b.startedAt)
                      return next
                    })
                    void evaluateAndMaybeRetireRule(parsedGuide.ruleId)
                    handleCloseCalendarPreview()
                  }}
                >
                  Skip
                </button>
              </div>
            ) : null}
            {!isGuide && !isTimezoneChangeMarker && isPastPlanned ? (
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
            {!isGuide && !isTimezoneChangeMarker && isUpcomingPlanned ? (
              <div className="calendar-popover__cta-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem' }}>
                <button
                  type="button"
                  className="history-timeline__action-button history-timeline__action-button--primary"
                  onClick={() => {
                    // Confirm future session without changing its scheduled time.
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
              </div>
            ) : null}
            {isActiveRunning ? (
              <div className="calendar-popover__cta-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem' }}>
                <button
                  type="button"
                  className="history-timeline__action-button history-timeline__action-button--primary"
                  onClick={() => {
                    broadcastPauseFocus()
                    handleCloseCalendarPreview()
                  }}
                >
                  Stop Focus
                </button>
              </div>
            ) : null}
            {isTimezoneChangeMarker && parsedTimezones ? (() => {
              const fromCity = parsedTimezones.from
              const toCity = parsedTimezones.to
              const fromCityName = extractCityName(fromCity)
              const toCityName = extractCityName(toCity)
              // Use app timezone override if set, otherwise fall back to system timezone
              const fromIsCurrentTz = fromCity ? isCityInEffectiveTimezone(fromCity, appTimezone) : false
              const toIsCurrentTz = toCity ? isCityInEffectiveTimezone(toCity, appTimezone) : false
              return (
                <div className="calendar-popover__cta-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.65rem' }}>
                  {fromCity && (
                    <button
                      type="button"
                      className={`history-timeline__action-button${fromIsCurrentTz ? ' history-timeline__action-button--selected' : ''}`}
                      style={{
                        flex: 1,
                        position: 'relative',
                        ...(fromIsCurrentTz ? {
                          background: 'rgba(34, 197, 94, 0.15)',
                          borderColor: 'rgba(34, 197, 94, 0.5)',
                          color: '#22c55e',
                        } : {}),
                      }}
                      onClick={() => {
                        const fromIana = getIanaTimezoneForCity(fromCity)
                        if (fromIana) {
                          updateAppTimezone(fromIana)
                        }
                        handleCloseCalendarPreview()
                      }}
                      disabled={fromIsCurrentTz}
                    >
                      {fromIsCurrentTz && (
                        <span style={{ marginRight: '0.35rem' }}>✓</span>
                      )}
                      {fromCityName || 'From'}
                    </button>
                  )}
                  {toCity && (
                    <button
                      type="button"
                      className={`history-timeline__action-button${toIsCurrentTz ? ' history-timeline__action-button--selected' : ''}`}
                      style={{
                        flex: 1,
                        position: 'relative',
                        ...(toIsCurrentTz ? {
                          background: 'rgba(34, 197, 94, 0.15)',
                          borderColor: 'rgba(34, 197, 94, 0.5)',
                          color: '#22c55e',
                        } : {}),
                      }}
                      onClick={() => {
                        const toIana = getIanaTimezoneForCity(toCity)
                        if (toIana) {
                          updateAppTimezone(toIana)
                        }
                        handleCloseCalendarPreview()
                      }}
                      disabled={toIsCurrentTz}
                    >
                      {toIsCurrentTz && (
                        <span style={{ marginRight: '0.35rem' }}>✓</span>
                      )}
                      {toCityName || 'To'}
                    </button>
                  )}
                </div>
              )
            })() : null}
        </div>
      </div>,
      document.body,
    )
  }, [
    activeSession,
    appTimezone,
    calendarPreview,
    calendarPopoverEditing,
    effectiveHistory,
    handleCloseCalendarPreview,
    handleDeleteHistoryEntry,
    handleStartEditingHistoryEntry,
    subtasksCache,
    historyDraft.subtasks,
    selectedHistoryId,
    updateAppTimezone,
    updateHistory,
    repeatingRules,
  ])

  // Month cell overview panel
  const monthCellOverviewPanel = useMemo(() => {
    if (!monthCellOverview) return null
    return createPortal(
      <div
        className="month-cell-overview__backdrop"
        onClick={(e) => {
          // Close when clicking backdrop (not the modal itself)
          if (e.target === e.currentTarget) {
            setMonthCellOverview(null)
          }
        }}
      >
        <div
          className="month-cell-overview"
          ref={monthCellOverviewRef}
          role="dialog"
          aria-label={`Events for ${monthCellOverview.dateLabel}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="month-cell-overview__header">
            <h3 className="month-cell-overview__title">{monthCellOverview.dateLabel}</h3>
            <button
              type="button"
              className="month-cell-overview__close"
              aria-label="Close"
              onClick={() => setMonthCellOverview(null)}
            >
              <IconClose />
            </button>
          </div>
          <div className="month-cell-overview__events">
            {monthCellOverview.entries.map((entry) => {
              const meta = resolveGoalMetadata(entry, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup)
              const label = deriveEntryTaskName(entry)
              const colorCss = meta.colorInfo?.gradient?.css ?? meta.colorInfo?.solidColor ?? getPaletteColorForLabel(label)
              const isPlanned = !!entry.futureSession
              const baseColor = meta.colorInfo?.solidColor ?? meta.colorInfo?.gradient?.start ?? getPaletteColorForLabel(label)
              const goalLabel = entry.goalName || 'No goal'
              const entryIsAllDay = isEntryAllDay(entry)
              // Format time range for timed entries
              const formatTime = (ts: number) => {
                const d = new Date(ts)
                const h = d.getHours()
                const m = d.getMinutes()
                const ampm = h >= 12 ? 'pm' : 'am'
                const displayH = h % 12 || 12
                return m === 0 ? `${displayH}${ampm}` : `${displayH}:${String(m).padStart(2, '0')}${ampm}`
              }
              const timeRange = entryIsAllDay ? 'All day' : `${formatTime(entry.startedAt)} – ${formatTime(entry.endedAt)}`
              return (
                <div
                  key={entry.id}
                  className={`month-cell-overview__event${isPlanned ? ' month-cell-overview__event--planned' : ''}`}
                  style={isPlanned ? { borderColor: baseColor } : {}}
                >
                  <div
                    className="month-cell-overview__event-color"
                    style={{ background: colorCss }}
                  />
                  <div className="month-cell-overview__event-content">
                    <div className="month-cell-overview__event-title">{label || 'Untitled'}</div>
                    <div className="month-cell-overview__event-meta">
                      <span className="month-cell-overview__event-time">{timeRange}</span>
                      <span className="month-cell-overview__event-goal">{goalLabel}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>,
      document.body,
    )
  }, [monthCellOverview, enhancedGoalLookup, goalColorLookup, lifeRoutineSurfaceLookup])

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

  // Fallback focus effect for desktop - the callback ref handles immediate focus for touch devices,
  // but this useEffect serves as a backup for cases where the input is already mounted.
  useEffect(() => {
    if (!calendarEditorEntryId) return
    if (!pendingNewHistoryId || pendingNewHistoryId !== calendarEditorEntryId) return
    // If the pending flag is still set, the callback ref hasn't fired yet - skip fallback
    if (pendingNameInputFocusRef.current) return
    const focusLater = () => {
      const input = calendarEditorNameInputRef.current
      if (input && document.activeElement !== input) {
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
    
    // Check if this entry is a timezone change marker (use draft bucket which has current selection)
    const currentGoal = historyDraft.goalName.trim() || entry.goalName?.trim() || ''
    const currentBucket = historyDraft.bucketName.trim() || entry.bucketName?.trim() || ''
    const editorIsTimezoneChangeMarker = 
      currentGoal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase() &&
      currentBucket === TIMEZONE_CHANGE_MARKER
    
    // All timestamps are now UTC - dayStarts uses display timezone bounds
    // so no adjustment needed for display
    const adjustForDisplay = (ts: number) => ts
    
    // Resolve current values - timestamps are already in UTC
    const startBase = adjustForDisplay(entry.startedAt)
    const endBase = adjustForDisplay(entry.endedAt)
    const resolvedStart = resolveTimestamp(historyDraft.startedAt, startBase)
    const resolvedEnd = resolveTimestamp(historyDraft.endedAt, endBase)
    const shiftStartAndPreserveDuration = (nextStart: number) => {
      setHistoryDraft((draft) => {
        // For timezone markers, keep start and end synchronized
        if (editorIsTimezoneChangeMarker) {
          return { ...draft, startedAt: nextStart, endedAt: nextStart }
        }
        return { ...draft, startedAt: nextStart }
      })
    }
    const startMinutesOfDay = (() => {
      const d = new Date(resolvedStart)
      return d.getHours() * 60 + d.getMinutes()
    })()
    // Use the entry's isAllDay flag (not timestamp detection) - all-day entries can't be converted to timed and vice versa
    const isDraftAllDay = entry.isAllDay === true
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
          onPointerDownCapture={handleInspectorSurfacePointerDown}
          onClickCapture={handleInspectorSurfaceClick}
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
                ref={calendarEditorNameInputCallbackRef}
                value={historyDraft.taskName}
                placeholder="Describe the focus block"
                onChange={handleHistoryFieldChange('taskName')}
                onKeyDown={handleHistoryFieldKeyDown}
                readOnly={editorIsTimezoneChangeMarker}
                style={editorIsTimezoneChangeMarker ? { opacity: 0.7, cursor: 'default' } : undefined}
              />
            </label>
            {editorIsTimezoneChangeMarker ? (
              <>
                <label className="history-timeline__field">
                  <span className="history-timeline__field-text">From</span>
                  <TimezoneSearchDropdown
                    id={`timezone-from-editor-${calendarEditorEntryId}`}
                    value={parseTimezoneFromSessionName(historyDraft.taskName).from}
                    placeholder="Search city (e.g. Sydney)"
                    onChange={(value) => setHistoryDraft((draft) => {
                      const parsed = parseTimezoneFromSessionName(draft.taskName)
                      return {
                        ...draft,
                        taskName: generateTimezoneSessionName(value, parsed.to),
                      }
                    })}
                  />
                </label>
                <label className="history-timeline__field">
                  <span className="history-timeline__field-text">To</span>
                  <TimezoneSearchDropdown
                    id={`timezone-to-editor-${calendarEditorEntryId}`}
                    value={parseTimezoneFromSessionName(historyDraft.taskName).to}
                    placeholder="Search city (e.g. New York)"
                    onChange={(value) => setHistoryDraft((draft) => {
                      const parsed = parseTimezoneFromSessionName(draft.taskName)
                      return {
                        ...draft,
                        taskName: generateTimezoneSessionName(parsed.from, value),
                      }
                    })}
                  />
                </label>
              </>
            ) : null}
            {/* All-day toggle removed per request; preserve read-only all-day state via isDraftAllDay to hide time pickers */}
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">Start</span>
              <div
                className="calendar-inspector__schedule-inputs"
                onPointerDownCapture={(event) => {
                  // Clicking blank panel space should not toggle any picker
                  const target = event.target as HTMLElement | null
                  if (target && !target.closest('.inspector-picker')) {
                    try { event.preventDefault() } catch {}
                    try { event.stopPropagation() } catch {}
                  }
                }}
              >
                <InspectorDateInput
                  value={resolvedStart}
                  onChange={shiftStartAndPreserveDuration}
                  ariaLabel="Select start date"
                />
                {isDraftAllDay ? null : (
                  <InspectorTimeInput
                    value={resolvedStart}
                    onChange={shiftStartAndPreserveDuration}
                    ariaLabel="Select start time"
                    use24HourTime={use24HourTime}
                  />
                )}
              </div>
            </label>
            {editorIsTimezoneChangeMarker ? null : (
            <label className="history-timeline__field">
              <span className="history-timeline__field-text">End</span>
              <div
                className="calendar-inspector__schedule-inputs"
                onPointerDownCapture={(event) => {
                  const target = event.target as HTMLElement | null
                  if (target && !target.closest('.inspector-picker')) {
                    try { event.preventDefault() } catch {}
                    try { event.stopPropagation() } catch {}
                  }
                }}
              >
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
                    snapMinutes={15}
                    alignFromMinutes={startMinutesOfDay}
                    alignAnchorTimestamp={resolvedStart}
                    relativeToMinutes={startMinutesOfDay}
                    maxSpanMinutes={24 * 60}
                    use24HourTime={use24HourTime}
                  />
                )}
              </div>
            </label>
            )}
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
                                placeholder={bucketDropdownPlaceholder}
                                options={bucketDropdownOptions}
                                onChange={handleBucketDropdownChange}
                                disabled={bucketDropdownDisabled}
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
                                disabled={taskDropdownDisabled}
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
    historyDraft.startedAt,
    historyDraft.endedAt,
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
        // Preview timestamps are now UTC (dayStarts uses display timezone bounds)
        const rawStartedAt = Math.min(preview.startedAt, preview.endedAt)
        const rawEndedAt = Math.max(preview.startedAt, preview.endedAt)
        const isNewEntry = state.entryId === 'new-entry'
        if (isNewEntry) {
          const elapsed = Math.max(rawEndedAt - rawStartedAt, MIN_SESSION_DURATION_DRAG_MS)
          const newEntry: HistoryEntry = {
            id: makeHistoryId(),
            taskName: '',
            goalName: LIFE_ROUTINES_NAME,
            bucketName: null,
            goalId: LIFE_ROUTINES_GOAL_ID,
            bucketId: null,
            taskId: null,
            elapsed,
            startedAt: rawStartedAt,
            endedAt: rawEndedAt,
            goalSurface: LIFE_ROUTINES_SURFACE,
            bucketSurface: null,
            notes: '',
            subtasks: [],
          }
          flushSync(() => {
            updateHistory((current) => {
              const next = [...current, newEntry]
              next.sort((a, b) => a.startedAt - b.startedAt)
              return next
            })
          })
          setPendingNewHistoryId(newEntry.id)
          // Open editor synchronously to maintain user gesture chain for touch keyboard
          flushSync(() => {
            openCalendarInspector(newEntry)
          })
          // Focus the input immediately after flushSync renders the modal
          const input = calendarEditorNameInputRef.current
          if (input) {
            try {
              input.focus()
              const len = input.value?.length ?? 0
              input.setSelectionRange(len, len)
            } catch {}
          }
        } else {
          flushSync(() => {
            updateHistory((current) => {
              const index = current.findIndex((entry) => entry.id === preview.entryId)
              if (index === -1) {
                return current
              }
              const target = current[index]
              if (target.startedAt === rawStartedAt && target.endedAt === rawEndedAt) {
                return current
              }
              const next = [...current]
              next[index] = {
                ...target,
                startedAt: rawStartedAt,
                endedAt: rawEndedAt,
                elapsed: Math.max(rawEndedAt - rawStartedAt, 1),
              }
              return next
            })
          })
          if (selectedHistoryIdRef.current === state.entryId) {
            setHistoryDraft((draft) => ({
              ...draft,
              startedAt: rawStartedAt,
              endedAt: rawEndedAt,
            }))
          }
        }
      }

      dragStateRef.current = null
      dragPreviewRef.current = null
      setDragPreview(null)
      dragPreventClickRef.current = state.hasMoved
      setHoveredDuringDragId(null)
      // Release scroll lock
      setPageScrollLock(false)
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
      // Lock page scroll while dragging (for all input types)
      setPageScrollLock(true, 'full')
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

  // Compute isTimezoneChangeMarker locally for the inspector, based on draft bucket (current selection)
  const inspectorCurrentGoal = historyDraft.goalName.trim() || inspectorEntry?.goalName?.trim() || ''
  const inspectorCurrentBucket = historyDraft.bucketName.trim() || inspectorEntry?.bucketName?.trim() || ''
  const inspectorIsTimezoneChangeMarker = 
    inspectorCurrentGoal.toLowerCase() === LIFE_ROUTINES_NAME.toLowerCase() &&
    inspectorCurrentBucket === TIMEZONE_CHANGE_MARKER

  let calendarInspectorPanel: ReactElement | null = null
  if (calendarInspectorEntryId !== null) {
    if (inspectorEntry) {
      // All timestamps are now UTC - dayStarts uses display timezone bounds
      // so no adjustment needed for display
      const adjustForDisplay = (ts: number) => ts
      
      const startBase = adjustForDisplay(inspectorEntry.startedAt)
      const endBase = adjustForDisplay(inspectorEntry.endedAt)
      const resolvedStart = resolveTimestamp(historyDraft.startedAt, startBase)
      const resolvedEnd = resolveTimestamp(historyDraft.endedAt, endBase)
      const shiftStartAndPreserveDuration = (nextStart: number) => {
        setHistoryDraft((draft) => {
          // For timezone markers, keep start and end synchronized
          if (inspectorIsTimezoneChangeMarker) {
            return { ...draft, startedAt: nextStart, endedAt: nextStart }
          }
          return { ...draft, startedAt: nextStart }
        })
      }
      const startMinutesOfDay = (() => {
        const d = new Date(resolvedStart)
        return d.getHours() * 60 + d.getMinutes()
      })()
      const inspectorDateLabel = (() => {
        const startD = new Date(resolvedStart)
        const endD = new Date(resolvedEnd)
        const sameDay =
          startD.getFullYear() === endD.getFullYear() &&
          startD.getMonth() === endD.getMonth() &&
          startD.getDate() === endD.getDate()
        if (sameDay) {
          const dateFmt = startD.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
          return `${dateFmt} · ${formatTime(resolvedStart)} — ${formatTime(resolvedEnd)}`
        }
        return formatDateRange(resolvedStart, resolvedEnd, use24HourTime)
      })()
      const inspectorDurationLabel = formatDuration(Math.max(resolvedEnd - resolvedStart, 0))

      const inspectorRepeatControl = (() => {
        // Use display timezone for wall-clock time extraction
        const minutes = getMinutesFromMidnightInTimezone(inspectorEntry.startedAt, displayTimezone)
        const durMin = Math.max(1, Math.round((inspectorEntry.endedAt - inspectorEntry.startedAt) / 60000))
        const inspDateKey = getDateKeyInTimezone(inspectorEntry.startedAt, displayTimezone)
        const dayStartMs = getMidnightUtcForDateInTimezone(inspDateKey, displayTimezone)
        // Get day of week in display timezone
        const inspDowDate = new Date(dayStartMs + 12 * 60 * 60 * 1000)
        const dow = inspDowDate.getUTCDay()
        const inspTimeParts = getTimePartsInTimezone(inspectorEntry.startedAt, displayTimezone)
        const monthDay = `${String(inspTimeParts.month).padStart(2, '0')}-${String(inspTimeParts.day).padStart(2, '0')}`
        // Check if this entry is all-day
        const entryIsAllDay = isEntryAllDay(inspectorEntry)
        
        // Check if entry has been moved from its original scheduled time
        // If so, it's a rescheduled instance and should not show the repeat rule
        const originalTime = (inspectorEntry as any).originalTime as number | undefined | null
        const hasBeenMoved = (() => {
          if (!Number.isFinite(originalTime as number)) return false
          if (entryIsAllDay) {
            // For all-day entries, compare by date (UTC date key)
            const originalDateKey = getUtcDateKey(originalTime as number)
            const currentDateKey = getUtcDateKey(inspectorEntry.startedAt)
            return originalDateKey !== currentDateKey
          } else {
            // For timed entries, compare exact timestamps
            return inspectorEntry.startedAt !== originalTime
          }
        })()
        
        // Check if entry is linked to a rule that has ended
        // If so, this entry (and all future entries with this ID) should show "None"
        const entryRepeatId = (inspectorEntry as any).repeatingSessionId as string | undefined | null
        const linkedRule = entryRepeatId ? repeatingRules.find((r) => r.id === entryRepeatId) : null
        const linkedRuleEndAtMs = linkedRule ? ((linkedRule as any).endAtMs as number | undefined | null) : null
        const isPastLinkedRuleEnd = Number.isFinite(linkedRuleEndAtMs as number) && inspectorEntry.startedAt >= (linkedRuleEndAtMs as number)
        
        // Helper to check if a rule is all-day
        const ruleIsAllDay = (r: RepeatingSessionRule) => 
          r.isAllDay === true || (r.timeOfDayMinutes === 0 && (r.durationMinutes ?? 60) >= 1440)
        const matches = (r: RepeatingSessionRule) => {
          if (!r.isActive) return false
          // If entry has been moved from original time, don't match any rules
          if (hasBeenMoved) return false
          // If entry is past its linked rule's end, don't match any rules
          if (isPastLinkedRuleEnd) return false
          // If the rule has ended at or before this entry's scheduled time, don't match
          const ruleEndAtMs = (r as any).endAtMs as number | undefined | null
          if (Number.isFinite(ruleEndAtMs as number) && inspectorEntry.startedAt >= (ruleEndAtMs as number)) {
            return false
          }
          // Match task/goal/bucket names
          const taskMatch = (r.taskName?.trim() || '') === (inspectorEntry.taskName?.trim() || '')
          const goalMatch = (r.goalName?.trim() || null) === (inspectorEntry.goalName?.trim() || null)
          const bucketMatch = (r.bucketName?.trim() || null) === (inspectorEntry.bucketName?.trim() || null)
          if (!taskMatch || !goalMatch || !bucketMatch) return false
          // For all-day entries, match against all-day rules (skip time/duration check)
          if (entryIsAllDay) {
            return ruleIsAllDay(r)
          }
          // For timed entries, match time and duration
          return r.timeOfDayMinutes === minutes && r.durationMinutes === durMin
        }
        const hasDaily = repeatingRules.some((r) => matches(r) && r.frequency === 'daily')
        const hasCustom = repeatingRules.some(
          (r) => matches(r) && r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.length > 1,
        )
        const hasWeekly = repeatingRules.some(
          (r) => matches(r) && r.frequency === 'weekly' && Array.isArray(r.dayOfWeek) && r.dayOfWeek.includes(dow),
        )
        const hasMonthly = repeatingRules.some((r) => matches(r) && r.frequency === 'monthly' && matchesMonthlyDay(r, dayStartMs))
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
                  // If already showing 'none', do nothing
                  if (currentVal === 'none') return
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
                // If entry is already linked to a different repeating session, unlink it first
                // This allows the old rule's guide task to reappear for that occurrence
                const existingRuleId = inspectorEntry.repeatingSessionId
                if (existingRuleId) {
                  updateHistory((current) =>
                    current.map((h) => (h.id === inspectorEntry.id ? { ...h, repeatingSessionId: null, originalTime: null } : h)),
                  )
                }
                const created = await createRepeatingRuleForEntry(inspectorEntry, val, { displayTimezone })
                if (created) {
                  // Add rule to state, but avoid duplicates (createRepeatingRuleForEntry already writes to localStorage)
                  setRepeatingRules((prev) => {
                    if (prev.some((r) => r.id === created.id)) return prev
                    return [...prev, created]
                  })
                  const scheduledStart = computeEntryScheduledStart(inspectorEntry, displayTimezone)
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
            <div
              className="calendar-inspector__inner"
              ref={calendarInspectorRef}
              onPointerDownCapture={handleInspectorSurfacePointerDown}
              onClickCapture={handleInspectorSurfaceClick}
            >
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
                      readOnly={inspectorIsTimezoneChangeMarker}
                      style={inspectorIsTimezoneChangeMarker ? { opacity: 0.7, cursor: 'default' } : undefined}
                    />
                  </label>
                  {inspectorIsTimezoneChangeMarker ? (
                    <>
                      <label className="history-timeline__field">
                        <span className="history-timeline__field-text">From</span>
                        <TimezoneSearchDropdown
                          id={`timezone-from-${calendarInspectorEntryId}`}
                          value={parseTimezoneFromSessionName(historyDraft.taskName).from}
                          placeholder="Search city (e.g. Sydney)"
                          onChange={(value) => setHistoryDraft((draft) => {
                            const parsed = parseTimezoneFromSessionName(draft.taskName)
                            return {
                              ...draft,
                              taskName: generateTimezoneSessionName(value, parsed.to),
                            }
                          })}
                        />
                      </label>
                      <label className="history-timeline__field">
                        <span className="history-timeline__field-text">To</span>
                        <TimezoneSearchDropdown
                          id={`timezone-to-${calendarInspectorEntryId}`}
                          value={parseTimezoneFromSessionName(historyDraft.taskName).to}
                          placeholder="Search city (e.g. New York)"
                          onChange={(value) => setHistoryDraft((draft) => {
                            const parsed = parseTimezoneFromSessionName(draft.taskName)
                            return {
                              ...draft,
                              taskName: generateTimezoneSessionName(parsed.from, value),
                            }
                          })}
                        />
                      </label>
                    </>
                  ) : null}
                  <div className="calendar-inspector__schedule">
                    <div className="calendar-inspector__schedule-row">
                      <label className="calendar-inspector__schedule-group">
                        <span className="calendar-inspector__schedule-heading">Start</span>
                  <div
                    className="calendar-inspector__schedule-inputs"
                    onPointerDownCapture={(event) => {
                      const target = event.target as HTMLElement | null
                      if (target && !target.closest('.inspector-picker')) {
                        try { event.preventDefault() } catch {}
                        try { event.stopPropagation() } catch {}
                      }
                    }}
                  >
                    <InspectorDateInput
                      value={resolvedStart}
                      onChange={shiftStartAndPreserveDuration}
                      ariaLabel="Select start date"
                    />
                          <InspectorTimeInput
                            value={resolvedStart}
                            onChange={shiftStartAndPreserveDuration}
                            ariaLabel="Select start time"
                            use24HourTime={use24HourTime}
                          />
                        </div>
                      </label>
                      {inspectorIsTimezoneChangeMarker ? null : (
                      <label className="calendar-inspector__schedule-group">
                        <span className="calendar-inspector__schedule-heading">End</span>
                    <div
                      className="calendar-inspector__schedule-inputs"
                      onPointerDownCapture={(event) => {
                        const target = event.target as HTMLElement | null
                        if (target && !target.closest('.inspector-picker')) {
                          try { event.preventDefault() } catch {}
                          try { event.stopPropagation() } catch {}
                        }
                      }}
                    >
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
                            snapMinutes={15}
                            alignFromMinutes={startMinutesOfDay}
                            alignAnchorTimestamp={resolvedStart}
                            relativeToMinutes={startMinutesOfDay}
                            maxSpanMinutes={24 * 60}
                            use24HourTime={use24HourTime}
                          />
                        </div>
                      </label>
                      )}
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
                      placeholder={bucketDropdownPlaceholder}
                      options={bucketDropdownOptions}
                      onChange={handleBucketDropdownChange}
                      disabled={bucketDropdownDisabled}
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
                      disabled={taskDropdownDisabled}
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
                  readOnly={inspectorIsTimezoneChangeMarker}
                  style={inspectorIsTimezoneChangeMarker ? { opacity: 0.7, cursor: 'default' } : undefined}
                />
              </label>
              {inspectorIsTimezoneChangeMarker ? (
                <>
                  <label className="history-timeline__field">
                    <span className="history-timeline__field-text">From</span>
                    <TimezoneSearchDropdown
                      id={`timezone-from-legacy-${calendarInspectorEntryId}`}
                      value={parseTimezoneFromSessionName(historyDraft.taskName).from}
                      placeholder="Search city (e.g. Sydney)"
                      onChange={(value) => setHistoryDraft((draft) => {
                        const parsed = parseTimezoneFromSessionName(draft.taskName)
                        return {
                          ...draft,
                          taskName: generateTimezoneSessionName(value, parsed.to),
                        }
                      })}
                    />
                  </label>
                  <label className="history-timeline__field">
                    <span className="history-timeline__field-text">To</span>
                    <TimezoneSearchDropdown
                      id={`timezone-to-legacy-${calendarInspectorEntryId}`}
                      value={parseTimezoneFromSessionName(historyDraft.taskName).to}
                      placeholder="Search city (e.g. New York)"
                      onChange={(value) => setHistoryDraft((draft) => {
                        const parsed = parseTimezoneFromSessionName(draft.taskName)
                        return {
                          ...draft,
                          taskName: generateTimezoneSessionName(parsed.from, value),
                        }
                      })}
                    />
                  </label>
                </>
              ) : null}
              <div className="calendar-inspector__schedule legacy-editor-panel__schedule">
                <div className="calendar-inspector__schedule-row">
                  <label className="calendar-inspector__schedule-group">
                    <span className="calendar-inspector__schedule-heading">Start</span>
                    <div className="calendar-inspector__schedule-inputs">
                      <InspectorDateInput
                        value={resolvedStart}
                        onChange={shiftStartAndPreserveDuration}
                        ariaLabel="Select start date"
                      />
                      <InspectorTimeInput
                        value={resolvedStart}
                        onChange={shiftStartAndPreserveDuration}
                        ariaLabel="Select start time"
                        use24HourTime={use24HourTime}
                      />
                    </div>
                  </label>
                  {inspectorIsTimezoneChangeMarker ? null : (
                  <label className="calendar-inspector__schedule-group">
                    <span className="calendar-inspector__schedule-heading">End</span>
                    <div
                      className="calendar-inspector__schedule-inputs"
                      onPointerDownCapture={(event) => {
                        const target = event.target as HTMLElement | null
                        if (target && !target.closest('.inspector-picker')) {
                          try { event.preventDefault() } catch {}
                          try { event.stopPropagation() } catch {}
                        }
                      }}
                    >
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
                        snapMinutes={15}
                        alignFromMinutes={startMinutesOfDay}
                        alignAnchorTimestamp={resolvedStart}
                        relativeToMinutes={startMinutesOfDay}
                        maxSpanMinutes={24 * 60}
                        use24HourTime={use24HourTime}
                      />
                    </div>
                  </label>
                  )}
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
                    placeholder={bucketDropdownPlaceholder}
                    options={bucketDropdownOptions}
                    onChange={handleBucketDropdownChange}
                    disabled={bucketDropdownDisabled}
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
                  disabled={taskDropdownDisabled}
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
            <div
              className="calendar-inspector__inner"
              ref={calendarInspectorRef}
              onPointerDownCapture={handleInspectorSurfacePointerDown}
              onClickCapture={handleInspectorSurfaceClick}
            >
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
            // If entry is already linked to a different repeating session, unlink it first
            // This allows the old rule's guide task to reappear for that occurrence
            const existingRuleId = customRecurrenceEntry.repeatingSessionId
            if (existingRuleId) {
              updateHistory((current) =>
                current.map((h) => (h.id === customRecurrenceEntry.id ? { ...h, repeatingSessionId: null, originalTime: null } : h)),
              )
            }
            const created = await createRepeatingRuleForEntry(customRecurrenceEntry, frequency, { ...createOptions, displayTimezone })
            if (created) {
              // Add rule to state, but avoid duplicates (createRepeatingRuleForEntry already writes to localStorage)
              setRepeatingRules((prev) => {
                if (prev.some((r) => r.id === created.id)) return prev
                const next = [...prev, created]
                storeRepeatingRulesLocal(next)
                return next
              })
              const scheduledStart = computeEntryScheduledStart(customRecurrenceEntry, displayTimezone)
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
        {/* Timezone indicator - shows current app timezone */}
        <div className="timezone-indicator">
          <span className="timezone-indicator__icon">🌐</span>
          <span className="timezone-indicator__label">{effectiveTimezoneDisplay}</span>
          {isUsingCustomTimezone && (
            <button
              type="button"
              className="timezone-indicator__reset"
              onClick={() => updateAppTimezone(null)}
              title="Reset to system timezone"
            >
              ✕
            </button>
          )}
        </div>
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
            {monthCellOverviewPanel}
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
            {/* Render timezone change markers as indicator lines */}
            {timezoneMarkers.map((marker) => {
              const isSelected = marker.entry.id === selectedHistoryId
              const markerClassName = [
                'history-timeline__timezone-marker',
                isSelected ? 'history-timeline__timezone-marker--selected' : '',
              ].filter(Boolean).join(' ')
              
              return (
                <div
                  key={`tz-marker-${marker.id}-${marker.start}`}
                  className={markerClassName}
                  style={{ 
                    left: `${marker.leftPercent}%`,
                  }}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={`Timezone change marker at ${formatTime(marker.start)}`}
                  title={`Timezone Change · ${formatTime(marker.start)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    handleSelectHistorySegment(marker.entry)
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    openCalendarInspector(marker.entry)
                  }}
                  onKeyDown={handleTimelineBlockKeyDown(marker.entry)}
                  onPointerDown={(event) => {
                    // Allow dragging the marker (move only, no resize)
                    if (event.button === 0) {
                      (event.currentTarget as HTMLElement).style.cursor = 'grabbing'
                      handleSelectHistorySegment(marker.entry)
                      startDrag(event, marker, 'move')
                    }
                  }}
                  onPointerUp={(event) => {
                    (event.currentTarget as HTMLElement).style.cursor = ''
                  }}
                />
              )
            })}
            {regularSegments.map((segment) => {
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
              const displayGoal = isSelected && trimmedGoalDraft.length > 0 ? trimmedGoalDraft : segment.goalLabel
              const displayBucket = isSelected && trimmedBucketDraft.length > 0 ? trimmedBucketDraft : segment.bucketLabel
              
              // Check if this should render as a timezone marker
              // Check: 1) saved bucket, 2) draft bucket (when selected), 3) the segment's label
              const savedBucket = segment.entry.bucketName?.trim() ?? ''
              const isTimezoneMarkerSegment = 
                savedBucket === TIMEZONE_CHANGE_MARKER ||
                displayBucket === TIMEZONE_CHANGE_MARKER ||
                (isSelected && trimmedBucketDraft === TIMEZONE_CHANGE_MARKER)
              
              // If this segment should be a timezone change marker, render it as an indicator line
              if (isTimezoneMarkerSegment) {
                const markerClassName = [
                  'history-timeline__timezone-marker',
                  isSelected ? 'history-timeline__timezone-marker--selected' : '',
                ].filter(Boolean).join(' ')
                
                return (
                  <div
                    key={`tz-segment-${segment.id}-${segment.start}`}
                    className={markerClassName}
                    style={{ 
                      left: `${segment.leftPercent}%`,
                    }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={isSelected}
                    aria-label={`Timezone change marker at ${formatTime(resolvedStartedAt)}`}
                    title={`Timezone Change · ${formatTime(resolvedStartedAt)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      handleSelectHistorySegment(segment.entry)
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      openCalendarInspector(segment.entry)
                    }}
                    onKeyDown={handleTimelineBlockKeyDown(segment.entry)}
                    onPointerDown={(event) => {
                      // Allow dragging the marker (move only, no resize)
                      if (event.button === 0) {
                        (event.currentTarget as HTMLElement).style.cursor = 'grabbing'
                        handleSelectHistorySegment(segment.entry)
                        startDrag(event, segment, 'move')
                      }
                    }}
                    onPointerUp={(event) => {
                      (event.currentTarget as HTMLElement).style.cursor = ''
                    }}
                  />
                )
              }
              
              const timeRangeLabel = (() => {
                const startDate = new Date(resolvedStartedAt)
                const endDate = new Date(resolvedEndedAt)
                const sameDay =
                  startDate.getFullYear() === endDate.getFullYear() &&
                  startDate.getMonth() === endDate.getMonth() &&
                  startDate.getDate() === endDate.getDate()
                if (sameDay) {
                  return `${formatTime(resolvedStartedAt)} — ${formatTime(resolvedEndedAt)}`
                }
                return formatDateRange(resolvedStartedAt, resolvedEndedAt, use24HourTime)
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
                // Enable long-press to move for all input types; short press will select (handled by onClick)
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
                }, DRAG_HOLD_DURATION_MS)
              }
              const handleResizeStartPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-start')
              }
              const handleResizeEndPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
                startDrag(event, segment, 'resize-end')
              }
              const handleBlockPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
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
                segment.entry.futureSession ? 'history-timeline__block--future' : '',
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
                                      const prevStart = resolveTimestamp(draft.startedAt, resolvedStartedAt)
                                      const prevEnd = resolveTimestamp(draft.endedAt, resolvedEndedAt)
                                      const delta = timestamp - prevStart
                                      return { ...draft, startedAt: timestamp, endedAt: prevEnd + delta }
                                    })
                                  }}
                                  ariaLabel="Select start date"
                                />
                                <InspectorTimeInput
                                  value={resolvedStartedAt}
                                  onChange={(timestamp) => {
                                    setHistoryDraft((draft) => {
                                      if (!isEditing || selectedHistoryId !== segment.entry.id) return draft
                                      const prevStart = resolveTimestamp(draft.startedAt, resolvedStartedAt)
                                      const prevEnd = resolveTimestamp(draft.endedAt, resolvedEndedAt)
                                      const delta = timestamp - prevStart
                                      return { ...draft, startedAt: timestamp, endedAt: prevEnd + delta }
                                    })
                                  }}
                                  ariaLabel="Select start time"
                                  use24HourTime={use24HourTime}
                                />
                              </div>
                            </label>
                            <label className="history-timeline__field">
                              <span className="history-timeline__field-text">End</span>
                              <div
                                className="calendar-inspector__schedule-inputs"
                                onPointerDownCapture={(event) => {
                                  const target = event.target as HTMLElement | null
                                  if (target && !target.closest('.inspector-picker')) {
                                    try { event.preventDefault() } catch {}
                                    try { event.stopPropagation() } catch {}
                                  }
                                }}
                              >
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
                                  snapMinutes={15}
                                  alignFromMinutes={new Date(resolvedStartedAt).getHours() * 60 + new Date(resolvedStartedAt).getMinutes()}
                                  alignAnchorTimestamp={resolvedStartedAt}
                                  relativeToMinutes={new Date(resolvedStartedAt).getHours() * 60 + new Date(resolvedStartedAt).getMinutes()}
                                  maxSpanMinutes={24 * 60}
                                  use24HourTime={use24HourTime}
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
                                placeholder={bucketDropdownPlaceholder}
                                options={bucketDropdownOptions}
                                onChange={handleBucketDropdownChange}
                                disabled={bucketDropdownDisabled}
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
                                disabled={taskDropdownDisabled}
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
                      ? `${formatTime(resolvedStartedAt)} — ${formatTime(resolvedEndedAt)}`
                      : undefined
                  }
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={`${segment.tooltipTask} from ${formatTime(resolvedStartedAt)} to ${formatTime(resolvedEndedAt)}`}
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
                    title={`${displayTask} · ${formatTime(resolvedStartedAt)} — ${formatTime(resolvedEndedAt)}`}
                    aria-hidden
                  >
                    <div className="history-timeline__block-title">{displayTask}</div>
                    <div className="history-timeline__block-time">
                      {formatTime(resolvedStartedAt)} — {formatTime(resolvedEndedAt)}
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
                    {formatHourLabel(hour, use24HourTime)}
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
                  <span className="reflection-pie__value" style={{ fontSize: pieValueFontSize }}>{pieValueLabel}</span>
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

      {/* Snapback Overview */}
      <section className="reflection-section reflection-section--overview">
        <div className="reflection-overview__header">
          <div className="reflection-overview__titles">
            <h2 className="reflection-section__title">Snapback Overview</h2>
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
                const isLocalCustom = localTriggers.some((lt) => lt.id === item.id)
                // Can delete ONLY if there are zero sessions in ALL history (including future)
                const allTimeCount = allTimeSessionCounts.get(item.label.toLowerCase().trim()) ?? 0
                const canDelete = allTimeCount === 0
                const isEditing = editingTriggerId === item.id
              return (
                <div
                  key={item.id}
                  data-id={item.id}
                  className={`snapback-item snapback-item--row${isActive ? ' snapback-item--active' : ''}`}
                  onClick={handleTriggerSelect}
                  onDoubleClick={() => {
                    // Allow editing newly created triggers
                    if (isLocalCustom || (item.count === 0 && snapDbRows.some((r) => r.id === item.id))) {
                      setEditingTriggerId(item.id)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={handleTriggerKeyDown}
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
                    {canDelete ? (
                      <button
                        type="button"
                        className="snapback-item__delete"
                        aria-label={`Delete trigger ${item.label}`}
                        title="Delete trigger"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (isLocalCustom) {
                            // Delete local trigger (guest user)
                            setLocalTriggers((cur) => cur.filter((t) => t.id !== item.id))
                          } else {
                            // Delete from DB (authenticated user)
                            apiDeleteSnapbackById(item.id).then((ok) => {
                              if (ok) {
                                setSnapDbRows((cur) => cur.filter((r) => r.id !== item.id))
                                broadcastSnapbackUpdate()
                              }
                            })
                          }
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
                  onRename={async (id, label) => {
                    const trimmed = label.trim()
                    if (!trimmed) return
                    // Check if this is a local trigger (guest user)
                    const isLocalTrigger = localTriggers.some((t) => t.id === id)
                    if (isLocalTrigger) {
                      setLocalTriggers((cur) => cur.map((t) => (t.id === id ? { ...t, label: trimmed } : t)))
                      return
                    }
                    // For guest users, just update UI state (no API call)
                    if (isGuestUser) {
                      // Update the label in snapbackOverview will happen on next history change
                      // For now, we can't persist this for guests
                      return
                    }
                    // Check if this is a history-derived trigger (id starts with "trigger-")
                    if (id.startsWith('trigger-')) {
                      const oldName = id.slice('trigger-'.length)
                      // Get or create DB row for this trigger, then rename
                      const existing = await apiGetOrCreateTrigger(oldName)
                      if (!existing) return
                      const ok = await apiRenameSnapbackTrigger(existing.id, trimmed, oldName)
                      if (ok) {
                        setSnapDbRows((cur) => {
                          const idx = cur.findIndex((r) => r.id === existing.id)
                          const updatedRow = { ...existing, trigger_name: trimmed }
                          if (idx >= 0) { const copy = cur.slice(); copy[idx] = updatedRow; return copy }
                          return [...cur, updatedRow]
                        })
                        broadcastSnapbackUpdate()
                      }
                      return
                    }
                    // DB trigger (UUID) - direct rename
                    const row = snapDbRows.find((r) => r.id === id)
                    if (row) {
                      // If this trigger has sessions, rename them too
                      const ok = await apiRenameSnapbackTrigger(row.id, trimmed, row.trigger_name)
                      if (ok) {
                        setSnapDbRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, trigger_name: trimmed } : r)))
                        broadcastSnapbackUpdate()
                      }
                    }
                  }}
                />
                {selectedItem ? (
                  <p className="snapback-drawer__subtitle">Occurred {selectedItem.count}× ({formatDuration(selectedItem.durationMs)}) total.</p>
                ) : null}
                {/* privacy note removed per request */}
              </div>
              <div className="snapback-drawer__badge">
                <span className="snapback-drawer__badge-full">Last recorded: {selectedTriggerLastAtLabel.full}</span>
                <span className="snapback-drawer__badge-short">Last: {selectedTriggerLastAtLabel.short}</span>
              </div>
            </div>
            {selectedItem ? (
              <SnapbackPlanForm
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
