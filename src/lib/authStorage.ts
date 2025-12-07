import type { Session } from '@supabase/supabase-js'
import type { SupportedStorage } from '@supabase/auth-js'

export const AUTH_SESSION_STORAGE_KEY = 'nc-taskwatch-supabase-session-v1'
const AUTH_SESSION_COOKIE = 'nc-taskwatch-supabase-session'
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

const memoryStore = new Map<string, string>()

const getBrowserLocalStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const readCookieValue = (name: string): string | null => {
  if (typeof document === 'undefined') {
    return null
  }
  const cookies = document.cookie ? document.cookie.split(';') : []
  for (const entry of cookies) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.substring(name.length + 1))
    }
  }
  return null
}

const writeCookieValue = (name: string, value: string | null): void => {
  if (typeof document === 'undefined') {
    return
  }
  if (value === null) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`
    return
  }
  const encoded = encodeURIComponent(value)
  const secureFlag =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encoded}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secureFlag}`
}

const readRawValue = (key: string): string | null => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      const value = storage.getItem(key)
      if (typeof value === 'string') {
        memoryStore.set(key, value)
        return value
      }
    } catch {}
  }
  const inMemory = memoryStore.get(key)
  if (typeof inMemory === 'string') {
    return inMemory
  }
  if (key === AUTH_SESSION_STORAGE_KEY) {
    const cookieValue = readCookieValue(AUTH_SESSION_COOKIE)
    if (typeof cookieValue === 'string') {
      memoryStore.set(key, cookieValue)
      return cookieValue
    }
  }
  return null
}

const writeRawValue = (key: string, value: string): void => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      storage.setItem(key, value)
    } catch {}
  }
  memoryStore.set(key, value)
  if (key === AUTH_SESSION_STORAGE_KEY) {
    writeCookieValue(AUTH_SESSION_COOKIE, value)
  }
}

const removeRawValue = (key: string): void => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      storage.removeItem(key)
    } catch {}
  }
  memoryStore.delete(key)
  if (key === AUTH_SESSION_STORAGE_KEY) {
    writeCookieValue(AUTH_SESSION_COOKIE, null)
  }
}

export const supabaseAuthStorage: SupportedStorage = {
  getItem: (key: string) => readRawValue(key),
  setItem: (key: string, value: string) => {
    writeRawValue(key, value)
  },
  removeItem: (key: string) => {
    removeRawValue(key)
  },
}

export type CachedSessionTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number | null
}

export const readCachedSupabaseSession = (): Session | null => {
  const raw = readRawValue(AUTH_SESSION_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as Session
    }
  } catch {}
  return null
}

export const readCachedSessionTokens = (): CachedSessionTokens | null => {
  const session = readCachedSupabaseSession()
  if (
    session &&
    typeof session.access_token === 'string' &&
    typeof session.refresh_token === 'string'
  ) {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt:
        typeof session.expires_at === 'number' && Number.isFinite(session.expires_at)
          ? session.expires_at
          : null,
    }
  }
  return null
}

export const clearCachedSupabaseSession = (): void => {
  removeRawValue(AUTH_SESSION_STORAGE_KEY)
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Lock: Coordinates sign-in across multiple tabs
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATION_LOCK_STORAGE_KEY = 'nc-taskwatch-migration-lock'
const MIGRATION_LOCK_STALE_MS = 60_000 // 60 seconds

export type MigrationLockStatus = 'in-progress' | 'complete'

export type MigrationLock = {
  tabId: string
  timestamp: number
  status: MigrationLockStatus
  completedAt?: number
}

// Generate a unique tab ID (persists for the lifetime of the tab via sessionStorage)
const TAB_ID_STORAGE_KEY = 'nc-taskwatch-tab-id'
let cachedTabId: string | null = null

export const getTabId = (): string => {
  if (cachedTabId) {
    return cachedTabId
  }
  
  // Try to read from sessionStorage first (survives page navigations within same tab)
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem(TAB_ID_STORAGE_KEY)
      if (stored) {
        cachedTabId = stored
        return cachedTabId
      }
    } catch {}
  }
  
  // Generate new tab ID
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    cachedTabId = crypto.randomUUID()
  } else {
    // Fallback to timestamp + random
    cachedTabId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
  
  // Persist to sessionStorage
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, cachedTabId)
    } catch {}
  }
  
  return cachedTabId
}

export const setMigrationLock = (status: MigrationLockStatus = 'in-progress'): void => {
  const now = Date.now()
  const lock: MigrationLock = {
    tabId: getTabId(),
    timestamp: now,
    status,
    ...(status === 'complete' ? { completedAt: now } : {}),
  }
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      storage.setItem(MIGRATION_LOCK_STORAGE_KEY, JSON.stringify(lock))
    } catch {}
  }
}

export const clearMigrationLock = (): void => {
  const storage = getBrowserLocalStorage()
  if (storage) {
    try {
      storage.removeItem(MIGRATION_LOCK_STORAGE_KEY)
    } catch {}
  }
}

export const readMigrationLock = (): MigrationLock | null => {
  const storage = getBrowserLocalStorage()
  if (!storage) {
    return null
  }
  try {
    const raw = storage.getItem(MIGRATION_LOCK_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.tabId === 'string' &&
      typeof parsed.timestamp === 'number'
    ) {
      // Default status to 'in-progress' for backwards compatibility
      if (!parsed.status) {
        parsed.status = 'in-progress'
      }
      return parsed as MigrationLock
    }
  } catch {}
  return null
}

/**
 * Check if another tab holds the migration lock.
 * Returns true if:
 * - A lock exists
 * - The lock is NOT owned by this tab
 * - The lock is NOT stale (less than 60 seconds old)
 */
export const isLockedByAnotherTab = (): boolean => {
  const lock = readMigrationLock()
  if (!lock) {
    return false
  }
  // Check if we own the lock
  if (lock.tabId === getTabId()) {
    return false
  }
  // Check if lock is stale
  const age = Date.now() - lock.timestamp
  if (age > MIGRATION_LOCK_STALE_MS) {
    return false
  }
  return true
}

/**
 * Check if this tab owns the migration lock.
 */
export const isLockOwnedByThisTab = (): boolean => {
  const lock = readMigrationLock()
  if (!lock) {
    return false
  }
  return lock.tabId === getTabId()
}

/**
 * Mark the migration as complete (don't clear the lock yet).
 * This signals other tabs that they can reload soon.
 */
export const markMigrationComplete = (): void => {
  const lock = readMigrationLock()
  // Only mark complete if this tab owns the lock
  if (lock && lock.tabId === getTabId()) {
    setMigrationLock('complete')
  }
}

/**
 * Check if migration is complete (by any tab).
 */
export const isMigrationComplete = (): boolean => {
  const lock = readMigrationLock()
  if (!lock) {
    return false
  }
  // Check if stale
  const age = Date.now() - lock.timestamp
  if (age > MIGRATION_LOCK_STALE_MS) {
    return false
  }
  return lock.status === 'complete'
}

/**
 * Clear the lock only if this tab owns it.
 * Returns true if cleared, false otherwise.
 */
export const clearMigrationLockIfOwned = (): boolean => {
  const lock = readMigrationLock()
  if (!lock || lock.tabId !== getTabId()) {
    return false
  }
  clearMigrationLock()
  return true
}
