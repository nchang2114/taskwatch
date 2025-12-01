export type QuickSubtask = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
  updatedAt?: string
}

export type QuickItem = {
  id: string
  text: string
  completed: boolean
  sortIndex: number
  updatedAt?: string
  // Optional details (to mirror bucket task capabilities visually)
  notes?: string
  subtasks?: QuickSubtask[]
  expanded?: boolean
  subtasksCollapsed?: boolean
  notesCollapsed?: boolean
  // Visual parity: difficulty and priority
  difficulty?: 'none' | 'green' | 'yellow' | 'red'
  priority?: boolean
}

export const QUICK_LIST_STORAGE_KEY = 'nc-taskwatch-quick-list-v1'
export const QUICK_LIST_UPDATE_EVENT = 'nc-quick-list:updated'
export const QUICK_LIST_USER_STORAGE_KEY = 'nc-taskwatch-quick-list-user'
export const QUICK_LIST_GUEST_USER_ID = '__guest__'
export const QUICK_LIST_USER_EVENT = 'nc-quick-list:user-updated'

const QUICK_LIST_DEFAULT_ITEMS: QuickItem[] = [
  {
    id: 'quick-groceries',
    text: 'Groceries – restock basics',
    completed: false,
    sortIndex: 0,
    notes: 'Think breakfast, greens, grab-and-go snacks.',
    difficulty: 'green',
    priority: true,
    subtasks: [
      { id: 'quick-groceries-1', text: 'Fruit + greens', completed: false, sortIndex: 0 },
      { id: 'quick-groceries-2', text: 'Breakfast staples', completed: false, sortIndex: 1 },
      { id: 'quick-groceries-3', text: 'Snacks / treats', completed: false, sortIndex: 2 },
    ],
  },
  {
    id: 'quick-laundry',
    text: 'Laundry + fold',
    completed: false,
    sortIndex: 1,
    notes: 'Start a load before work, fold during a show.',
    difficulty: 'green',
    priority: false,
  },
  {
    id: 'quick-clean',
    text: '10-min reset: tidy desk & surfaces',
    completed: false,
    sortIndex: 2,
    notes: 'Clear cups, wipe surfaces, light candle or diffuser.',
    difficulty: 'yellow',
    priority: false,
  },
  {
    id: 'quick-bills',
    text: 'Pay bills & snapshot budget',
    completed: false,
    sortIndex: 3,
    notes: 'Autopay check + log any big expenses.',
    difficulty: 'yellow',
    priority: false,
  },
  {
    id: 'quick-social',
    text: 'Send a check-in text',
    completed: false,
    sortIndex: 4,
    notes: 'Ping a friend/family member you’ve been thinking about.',
    difficulty: 'green',
    priority: false,
  },
]

const getDefaultQuickList = (): QuickItem[] =>
  QUICK_LIST_DEFAULT_ITEMS.map((item, index) => ({
    ...item,
    sortIndex: index,
    subtasks:
      item.subtasks?.map((subtask, subIndex) => ({
        ...subtask,
        sortIndex: subIndex,
      })) ?? [],
  }))

const readStoredQuickListUserId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(QUICK_LIST_USER_STORAGE_KEY)
    if (!value) return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

const setStoredQuickListUserId = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (!userId) {
      window.localStorage.removeItem(QUICK_LIST_USER_STORAGE_KEY)
    } else {
      window.localStorage.setItem(QUICK_LIST_USER_STORAGE_KEY, userId)
    }
    try {
      window.dispatchEvent(new Event(QUICK_LIST_USER_EVENT))
    } catch {}
  } catch {}
}

const normalizeQuickListUserId = (userId: string | null | undefined): string =>
  typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : QUICK_LIST_GUEST_USER_ID

const isGuestQuickListUser = (userId: string | null): boolean =>
  !userId || userId === QUICK_LIST_GUEST_USER_ID

export const readQuickListOwnerId = (): string | null => readStoredQuickListUserId()

const sanitizeSubtask = (value: unknown, index: number): QuickSubtask | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as any
  const id = typeof v.id === 'string' && v.id.trim().length > 0 ? v.id : `ql-sub-${index}`
  const text = typeof v.text === 'string' ? v.text : ''
  const completed = Boolean(v.completed)
  const sortIndex = Number.isFinite(v.sortIndex) ? Number(v.sortIndex) : index
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt : undefined
  return { id, text, completed, sortIndex, updatedAt }
}

const sanitizeSubtasks = (value: unknown): QuickSubtask[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: QuickSubtask[] = []
  value.forEach((item, i) => {
    const s = sanitizeSubtask(item, i)
    if (!s) return
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push(s)
  })
  return out
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((it, i) => ({ ...it, sortIndex: i }))
}

const sanitizeItem = (value: unknown, index: number): QuickItem | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as any
  const id = typeof v.id === 'string' && v.id.trim().length > 0 ? v.id : null
  const text = typeof v.text === 'string' ? v.text : ''
  const completed = Boolean(v.completed)
  const sortIndex = Number.isFinite(v.sortIndex) ? Number(v.sortIndex) : index
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt : undefined
  if (!id) return null
  const notes = typeof v.notes === 'string' ? v.notes : ''
  const subtasks = sanitizeSubtasks(v.subtasks)
  const expanded = Boolean(v.expanded)
  const subtasksCollapsed = Boolean(v.subtasksCollapsed)
  const notesCollapsed = Boolean(v.notesCollapsed)
  const difficulty: QuickItem['difficulty'] =
    v.difficulty === 'green' || v.difficulty === 'yellow' || v.difficulty === 'red' || v.difficulty === 'none'
      ? v.difficulty
      : 'none'
  const priority = Boolean(v.priority)
  return {
    id,
    text,
    completed,
    sortIndex,
    updatedAt,
    notes,
    subtasks,
    expanded,
    subtasksCollapsed,
    notesCollapsed,
    difficulty,
    priority,
  }
}

export const sanitizeQuickList = (value: unknown): QuickItem[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: QuickItem[] = []
  value.forEach((item, i) => {
    const s = sanitizeItem(item, i)
    if (!s) return
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push(s)
  })
  // normalize sortIndex sequentially
  return out
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((it, i) => ({ ...it, sortIndex: i }))
}

export const readStoredQuickList = (): QuickItem[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(QUICK_LIST_STORAGE_KEY)
    const currentUser = readStoredQuickListUserId()
    const guestContext = isGuestQuickListUser(currentUser)
    if (!raw) {
      if (guestContext) {
        const seeded = writeStoredQuickList(getDefaultQuickList())
        if (!currentUser) {
          setStoredQuickListUserId(QUICK_LIST_GUEST_USER_ID)
        }
        return seeded
      }
      return []
    }
    const parsed = JSON.parse(raw)
    const sanitized = sanitizeQuickList(parsed)
    if (sanitized.length > 0) {
      return sanitized
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      return []
    }
    if (guestContext) {
      return writeStoredQuickList(getDefaultQuickList())
    }
    return sanitized
  } catch {
    return []
  }
}

export const writeStoredQuickList = (items: QuickItem[]): QuickItem[] => {
  const normalized = sanitizeQuickList(items)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(QUICK_LIST_STORAGE_KEY, JSON.stringify(normalized))
      window.dispatchEvent(new CustomEvent<QuickItem[]>(QUICK_LIST_UPDATE_EVENT, { detail: normalized }))
    } catch {}
  }
  return normalized
}

export const ensureQuickListUser = (userId: string | null): void => {
  if (typeof window === 'undefined') return
  const normalized = normalizeQuickListUserId(userId)
  const current = readStoredQuickListUserId()
  if (current === normalized) return
  const migratingFromGuest = current === QUICK_LIST_GUEST_USER_ID && normalized !== QUICK_LIST_GUEST_USER_ID
  setStoredQuickListUserId(normalized)
  if (normalized === QUICK_LIST_GUEST_USER_ID) {
    if (current !== QUICK_LIST_GUEST_USER_ID) {
      writeStoredQuickList(getDefaultQuickList())
    }
  } else if (!migratingFromGuest) {
    writeStoredQuickList([])
  }
}

export const subscribeQuickList = (cb: (items: QuickItem[]) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {}
  const handler = (ev: Event) => {
    const ce = ev as CustomEvent<QuickItem[]>
    if (Array.isArray(ce.detail)) cb(sanitizeQuickList(ce.detail))
    else cb(readStoredQuickList())
  }
  window.addEventListener(QUICK_LIST_UPDATE_EVENT, handler as EventListener)
  return () => window.removeEventListener(QUICK_LIST_UPDATE_EVENT, handler as EventListener)
}

// Set up cross-tab sync via storage events
if (typeof window !== 'undefined') {
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === QUICK_LIST_STORAGE_KEY) {
      try {
        const newValue = event.newValue
        if (newValue) {
          const items = JSON.parse(newValue) as QuickItem[]
          // Dispatch custom event so all listeners in this tab get updated
          window.dispatchEvent(new CustomEvent<QuickItem[]>(QUICK_LIST_UPDATE_EVENT, { detail: items }))
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  
  window.addEventListener('storage', handleStorageChange)
}
