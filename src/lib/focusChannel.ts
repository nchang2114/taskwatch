import type { SurfaceStyle } from './surfaceStyles'

export const FOCUS_EVENT_TYPE = 'nc-taskwatch:set-focus'
export const PAUSE_FOCUS_EVENT_TYPE = 'nc-taskwatch:pause-focus'

export type FocusBroadcastSubtaskDetail = {
  id: string
  text: string
  completed: boolean
  sortIndex?: number | null
}

export type FocusBroadcastDetail = {
  goalId: string
  goalName: string
  bucketId: string
  bucketName: string
  taskId: string
  taskName: string
  taskDifficulty?: 'none' | 'green' | 'yellow' | 'red' | null
  priority?: boolean | null
  goalSurface?: SurfaceStyle | null
  bucketSurface?: SurfaceStyle | null
  autoStart?: boolean
  notes?: string | null
  subtasks?: FocusBroadcastSubtaskDetail[] | null
  repeatingRuleId?: string | null
  repeatingOccurrenceDate?: string | null
  repeatingOriginalTime?: number | null
}

export type FocusBroadcastEvent = CustomEvent<FocusBroadcastDetail>

export const broadcastFocusTask = (detail: FocusBroadcastDetail) => {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent<FocusBroadcastDetail>(FOCUS_EVENT_TYPE, { detail }))
}

export const broadcastPauseFocus = () => {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(PAUSE_FOCUS_EVENT_TYPE))
}
