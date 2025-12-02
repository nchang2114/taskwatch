/**
 * Cross-tab sync channel for Snapback Overview.
 * Uses BroadcastChannel for efficient tab-to-tab communication.
 * Falls back to localStorage events for older browsers.
 */

export const SNAPBACK_CHANNEL_NAME = 'nc-taskwatch-snapback-sync'
export const SNAPBACK_SYNC_EVENT = 'nc-taskwatch:snapback-sync'
export const SNAPBACK_SYNC_STORAGE_KEY = 'nc-taskwatch-snapback-sync-signal'

type SnapbackSyncMessage = {
  type: 'snapback-updated'
  timestamp: number
}

let channel: BroadcastChannel | null = null

const getChannel = (): BroadcastChannel | null => {
  if (typeof window === 'undefined') return null
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    try {
      channel = new BroadcastChannel(SNAPBACK_CHANNEL_NAME)
    } catch {
      return null
    }
  }
  return channel
}

/**
 * Broadcast that Snapback data has been updated.
 * Other tabs will receive this and refetch their data.
 */
export const broadcastSnapbackUpdate = (): void => {
  if (typeof window === 'undefined') return
  
  const message: SnapbackSyncMessage = {
    type: 'snapback-updated',
    timestamp: Date.now(),
  }
  
  // Try BroadcastChannel first
  const bc = getChannel()
  if (bc) {
    try {
      bc.postMessage(message)
    } catch {}
  }
  
  // Also use localStorage for fallback and same-tab notification
  try {
    window.localStorage.setItem(SNAPBACK_SYNC_STORAGE_KEY, JSON.stringify(message))
    // Dispatch custom event for same-tab listeners
    window.dispatchEvent(new CustomEvent(SNAPBACK_SYNC_EVENT, { detail: message }))
  } catch {}
}

type SnapbackSyncCallback = () => void

/**
 * Subscribe to Snapback sync events from other tabs.
 * Returns an unsubscribe function.
 */
export const subscribeToSnapbackSync = (callback: SnapbackSyncCallback): (() => void) => {
  if (typeof window === 'undefined') return () => {}
  
  const handlers: Array<() => void> = []
  
  // BroadcastChannel listener
  const bc = getChannel()
  if (bc) {
    const bcHandler = (event: MessageEvent<SnapbackSyncMessage>) => {
      if (event.data?.type === 'snapback-updated') {
        callback()
      }
    }
    bc.addEventListener('message', bcHandler)
    handlers.push(() => bc.removeEventListener('message', bcHandler))
  }
  
  // Storage event listener (for cross-tab when BroadcastChannel not available)
  const storageHandler = (event: StorageEvent) => {
    if (event.key === SNAPBACK_SYNC_STORAGE_KEY && event.newValue) {
      try {
        const message = JSON.parse(event.newValue) as SnapbackSyncMessage
        if (message?.type === 'snapback-updated') {
          callback()
        }
      } catch {}
    }
  }
  window.addEventListener('storage', storageHandler)
  handlers.push(() => window.removeEventListener('storage', storageHandler))
  
  // Custom event listener (for same-tab)
  const customHandler = () => callback()
  window.addEventListener(SNAPBACK_SYNC_EVENT, customHandler)
  handlers.push(() => window.removeEventListener(SNAPBACK_SYNC_EVENT, customHandler))
  
  // Return unsubscribe function
  return () => {
    handlers.forEach((unsub) => unsub())
  }
}
