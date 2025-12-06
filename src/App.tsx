import { useCallback, useEffect, useMemo, useRef, useState, useId, Fragment, type RefObject } from 'react'
import type { ReactNode, FormEvent } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import './App.css'
import GoalsPage from './pages/GoalsPage'
import ReflectionPage from './pages/ReflectionPage'
import FocusPage from './pages/FocusPage'
import { FOCUS_EVENT_TYPE } from './lib/focusChannel'
import { SCHEDULE_EVENT_TYPE } from './lib/scheduleChannel'
import { supabase, ensureSingleUserSession } from './lib/supabaseClient'
import { AUTH_SESSION_STORAGE_KEY } from './lib/authStorage'
import { readCachedSessionTokens } from './lib/authStorage'
import { ensureQuickListUser } from './lib/quickList'
import { ensureLifeRoutineUser } from './lib/lifeRoutines'
import { ensureHistoryUser, syncHistoryWithSupabase } from './lib/sessionHistory'
import { ensureRepeatingRulesUser } from './lib/repeatingSessions'
import { bootstrapGuestDataIfNeeded } from './lib/bootstrap'
import { ensureGoalsUser, syncGoalsSnapshotFromSupabase } from './lib/goalsSync'

type Theme = 'light' | 'dark'
type TabKey = 'goals' | 'focus' | 'reflection'
type UserProfile = {
  name: string
  email: string
  avatarUrl?: string
}
type SyncStatus = 'synced' | 'syncing' | 'offline' | 'pending'

const THEME_STORAGE_KEY = 'nc-taskwatch-theme'
const QUICK_LIST_EXPANDED_STORAGE_KEY = 'nc-taskwatch-quick-list-expanded-v1'
const getInitialTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'dark'
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') {
    return stored
  }

  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
  return prefersLight ? 'light' : 'dark'
}

const COMPACT_BRAND_BREAKPOINT = 640
const DEFAULT_NAV_BUFFER = 56
const COMPACT_NAV_BUFFER = 24
const NAV_COLLAPSE_BREAKPOINT = 640

const TAB_PANEL_IDS: Record<TabKey, string> = {
  goals: 'tab-panel-goals',
  focus: 'tab-panel-focus',
  reflection: 'tab-panel-reflection',
}

const ENABLE_TAB_SWIPE = false

const SWIPE_SEQUENCE: TabKey[] = ['reflection', 'focus', 'goals']

const AUTH_PROFILE_STORAGE_KEY = 'nc-taskwatch-auth-profile'
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TERMS_URL = 'https://genzero.vercel.app/taskwatch/terms'
const PRIVACY_URL = 'https://genzero.vercel.app/taskwatch/privacy'

const sanitizeStoredProfile = (value: unknown): UserProfile | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Partial<UserProfile>
  const name = typeof candidate.name === 'string' ? candidate.name : null
  const email = typeof candidate.email === 'string' ? candidate.email : null
  const avatarUrl = typeof candidate.avatarUrl === 'string' ? candidate.avatarUrl : undefined
  if (!name || !email) {
    return null
  }
  return avatarUrl ? { name, email, avatarUrl } : { name, email }
}

const readStoredProfile = (): UserProfile | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(AUTH_PROFILE_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    return sanitizeStoredProfile(parsed)
  } catch {
    return null
  }
}

const deriveProfileFromSupabaseUser = (user: User | null | undefined): UserProfile | null => {
  if (!user) {
    return null
  }
  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>
  const possibleNames = [
    metadata.full_name,
    metadata.name,
    metadata.preferred_username,
    user.email,
  ]
  const resolvedName =
    possibleNames.find((value) => typeof value === 'string' && value.trim().length > 0)?.toString().trim() ??
    'Taskwatch user'
  const email = typeof user.email === 'string' ? user.email : ''
  const avatar =
    typeof metadata.avatar_url === 'string' && metadata.avatar_url.trim().length > 0
      ? metadata.avatar_url
      : undefined
  return {
    name: resolvedName,
    email,
    avatarUrl: avatar,
  }
}

const SYNC_STATUS_COPY: Record<SyncStatus, { icon: string; label: string }> = {
  synced: { icon: '✓', label: 'Synced just now' },
  syncing: { icon: '⟳', label: 'Syncing…' },
  offline: { icon: '⚠', label: 'Offline — changes saved locally' },
  pending: { icon: '⛁', label: 'Local changes pending upload (3)' },
}

const createHelpIcon = (children: ReactNode): ReactNode => (
  <svg
    className="profile-help-menu__item-icon-svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

const HELP_MENU_ITEMS: Array<{ id: string; label: string; icon: ReactNode; url?: string }> = [
  {
    id: 'help-center',
    label: 'Help center',
    icon: createHelpIcon(
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.4c-.6.3-1 .9-1 1.6v.5" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
      </>,
    ),
  },
  {
    id: 'release-notes',
    label: 'Release notes',
    url: 'https://genzero.vercel.app/taskwatch/release-notes',
    icon: createHelpIcon(
      <>
        <path d="M8 4.5h8l3 3.2v11.3a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 18.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />
        <path d="M16 4.5V8H19.5" />
        <path d="M10 11h5" />
        <path d="M10 14h7" />
      </>,
    ),
  },
  {
    id: 'terms',
    label: 'Terms & policies',
    url: 'https://genzero.vercel.app/taskwatch/policies',
    icon: createHelpIcon(
      <>
        <rect x="7" y="5.5" width="10" height="13" rx="1.6" />
        <path d="M10 9.5h6" />
        <path d="M10 12.5h4.5" />
        <path d="M10 15.5h5.5" />
      </>,
    ),
  },
  {
    id: 'report-bug',
    label: 'Report bug',
    icon: createHelpIcon(
      <>
        <path d="M7 6v12" />
        <path d="M7 7.5h8l-1.4 2L15 11H7" />
      </>,
    ),
  },
  {
    id: 'download-apps',
    label: 'Download apps',
    icon: createHelpIcon(
      <>
        <path d="M12 5v8.5" />
        <path d="M9.5 10.5 12 13l2.5-2.5" />
        <path d="M7 16h10" />
        <path d="M6 19h12" />
      </>,
    ),
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: createHelpIcon(
      <>
        <rect x="5.5" y="7.5" width="13" height="9" rx="1.6" />
        <path d="M9 11.5h6" />
        <path d="M7.5 14h9" />
      </>,
    ),
  },
]

// Guest help menu - excludes release notes and terms & policies (shown separately in guest menu)
const GUEST_HELP_MENU_ITEMS = HELP_MENU_ITEMS.filter(
  (item) => item.id !== 'release-notes' && item.id !== 'terms'
)

const SETTINGS_SECTIONS: Array<{ id: string; label: string; description?: string; icon: ReactNode }> = [
  {
    id: 'general',
    label: 'General',
    icon: createHelpIcon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </>,
    ),
  },
  {
    id: 'focus-timers',
    label: 'Focus & Timers',
    icon: createHelpIcon(
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 6v6l4 2" />
      </>,
    ),
  },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: createHelpIcon(
      <>
        <rect x="5" y="6" width="14" height="13" rx="1.4" />
        <path d="M8 4v4" />
        <path d="M16 4v4" />
        <path d="M5 10h14" />
      </>,
    ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: createHelpIcon(
      <>
        <path d="M12 20a1.5 1.5 0 0 1-1.5-1.5h3A1.5 1.5 0 0 1 12 20Z" />
        <path d="M18 14V9a6 6 0 0 0-12 0v5l-1.5 2H19.5Z" />
      </>,
    ),
  },
  {
    id: 'account',
    label: 'Account',
    icon: createHelpIcon(
      <>
        <circle cx="12" cy="9" r="3.4" />
        <path d="M6 18c.8-3.1 3.4-4.5 6-4.5s5.2 1.4 6 4.5" />
      </>,
    ),
  },
  {
    id: 'data',
    label: 'Data',
    icon: createHelpIcon(
      <>
        <path d="M6 8c0-2.5 3-4 6-4s6 1.5 6 4-3 4-6 4-6-1.5-6-4Z" />
        <path d="M6 12.3c0 2.5 3 4.2 6 4.2s6-1.7 6-4.2" />
        <path d="M6 16.5C6 19 9 20.5 12 20.5S18 19 18 16.5" />
      </>,
    ),
  },
  {
    id: 'about-me',
    label: 'About Me',
    icon: createHelpIcon(
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
        <path d="M8 14c1 2 3 3 4 3s3-1 4-3" />
      </>,
    ),
  },
]


function MainApp() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [activeTab, setActiveTab] = useState<TabKey>('focus')
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  )
  const [isNavCollapsed, setIsNavCollapsed] = useState(false)
  const [isNavOpen, setIsNavOpen] = useState(false)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(() => readStoredProfile())
  const [syncStatus] = useState<SyncStatus>('synced')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [profileHelpMenuOpen, setProfileHelpMenuOpen] = useState(false)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authEmailValue, setAuthEmailValue] = useState('')
  const [authEmailError, setAuthEmailError] = useState<string | null>(null)
  const [authEmailStage, setAuthEmailStage] = useState<'input' | 'create' | 'verify'>('input')
  const [authEmailChecking, setAuthEmailChecking] = useState(false)
  const [authCreatePassword, setAuthCreatePassword] = useState('')
  const [authCreatePasswordVisible, setAuthCreatePasswordVisible] = useState(false)
  const [authCreateSubmitting, setAuthCreateSubmitting] = useState(false)
  const [authCreateError, setAuthCreateError] = useState<string | null>(null)
  const [authVerifyError, setAuthVerifyError] = useState<string | null>(null)
  const [authVerifyResending, setAuthVerifyResending] = useState(false)
  const [authVerifyStatus, setAuthVerifyStatus] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [featureModalOpen, setFeatureModalOpen] = useState(false)
  const [shortcutsPanelOpen, setShortcutsPanelOpen] = useState(false)
  const [shortcutsSearch, setShortcutsSearch] = useState('')
  const [showMilliseconds, setShowMilliseconds] = useState(true)
  const [use24HourTime, setUse24HourTime] = useState(false)
  const [weekStartDay, setWeekStartDay] = useState<0 | 1>(0) // 0 = Sunday, 1 = Monday
  const [isSigningOut, setIsSigningOut] = useState(false)
  // Only show "Signing you in..." screen when returning from OAuth redirect
  const [isSigningIn, setIsSigningIn] = useState(() => {
    if (typeof window !== 'undefined') {
      const hasAuthCallback = window.location.hash.includes('access_token') || 
                              window.location.search.includes('code=')
      return hasAuthCallback
    }
    return false
  })
  const [activeSettingsSection, setActiveSettingsSection] = useState(SETTINGS_SECTIONS[0]?.id ?? 'general')
  const [authEmailLookupValue, setAuthEmailLookupValue] = useState('')
  const [authEmailLookupResult, setAuthEmailLookupResult] = useState<boolean | null>(null)

  const navContainerRef = useRef<HTMLElement | null>(null)
  const navBrandRef = useRef<HTMLButtonElement | null>(null)
  const navControlsRef = useRef<HTMLDivElement | null>(null)
  const navMeasureRef = useRef<HTMLDivElement | null>(null)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const profileButtonRef = useRef<HTMLButtonElement | null>(null)
  const profileHelpMenuRef = useRef<HTMLDivElement | null>(null)
  const profileHelpButtonRef = useRef<HTMLButtonElement | null>(null)
  const profileMenuId = useId()
  const profileButtonId = useId()
  const profileHelpMenuId = useId()
  const settingsOverlayRef = useRef<HTMLDivElement | null>(null)
  const goalsPanelRef = useRef<HTMLElement | null>(null)
  const focusPanelRef = useRef<HTMLElement | null>(null)
  const reflectionPanelRef = useRef<HTMLElement | null>(null)
  const authModalRef = useRef<HTMLDivElement | null>(null)
  const previousProfileRef = useRef<UserProfile | null>(null)
  const authEmailLookupReqIdRef = useRef(0)
  const lastAlignedUserIdRef = useRef<string | null | undefined>(undefined)
  const isSignedIn = Boolean(userProfile)
  const userInitials = useMemo(() => {
    if (!userProfile?.name) {
      return 'U'
    }
    const tokens = userProfile.name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
    const initials = tokens.join('')
    return initials || 'U'
  }, [userProfile])
  const syncStatusCopy = SYNC_STATUS_COPY[syncStatus]
  const profileButtonClassName = useMemo(
    () =>
      ['profile-button', isSignedIn ? 'profile-button--signed-in' : 'profile-button--guest', profileMenuOpen ? 'profile-button--open' : '']
        .filter(Boolean)
        .join(' '),
    [isSignedIn, profileMenuOpen],
  )

  const closeProfileMenu = useCallback(() => {
    setProfileMenuOpen(false)
    setProfileHelpMenuOpen(false)
  }, [])

  const resetAuthEmailFlow = useCallback(() => {
    setAuthEmailValue('')
    setAuthEmailError(null)
    setAuthEmailStage('input')
    setAuthEmailChecking(false)
    setAuthCreatePassword('')
    setAuthCreatePasswordVisible(false)
    setAuthCreateSubmitting(false)
    setAuthCreateError(null)
    setAuthVerifyError(null)
    setAuthVerifyResending(false)
    setAuthVerifyStatus(null)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    if (userProfile) {
      window.localStorage.setItem(AUTH_PROFILE_STORAGE_KEY, JSON.stringify(userProfile))
    } else {
      window.localStorage.removeItem(AUTH_PROFILE_STORAGE_KEY)
    }
    const prev = previousProfileRef.current
    if (prev?.email !== userProfile?.email) {
      try {
        window.localStorage.setItem(QUICK_LIST_EXPANDED_STORAGE_KEY, 'false')
      } catch {}
    }
    previousProfileRef.current = userProfile ?? null
  }, [userProfile])

  const featureModalOpenRef = useRef(false)
  
  // Keep ref in sync with state so event handlers can access current value
  useEffect(() => {
    featureModalOpenRef.current = featureModalOpen
  }, [featureModalOpen])

  useEffect(() => {
    if (!profileMenuOpen) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      // Don't close profile menu if feature modal is open
      if (featureModalOpenRef.current) {
        return
      }
      const target = event.target as Node | null
      if (profileMenuRef.current?.contains(target)) {
        return
      }
      if (profileButtonRef.current?.contains(target)) {
        return
      }
      closeProfileMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't close profile menu via Escape if feature modal is open
      if (featureModalOpenRef.current) {
        return
      }
      if (event.key === 'Escape') {
        closeProfileMenu()
        window.setTimeout(() => {
          profileButtonRef.current?.focus()
        }, 0)
      }
    }
    // Use capture phase to detect clicks before they can be stopped by child components
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [profileMenuOpen, closeProfileMenu])

  const featureModalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!profileHelpMenuOpen) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (profileHelpMenuRef.current?.contains(target)) {
        return
      }
      if (profileHelpButtonRef.current?.contains(target)) {
        return
      }
      setProfileHelpMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProfileHelpMenuOpen(false)
        window.setTimeout(() => profileHelpButtonRef.current?.focus(), 0)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [profileHelpMenuOpen])

  const closeAuthModal = useCallback(() => {
    resetAuthEmailFlow()
    setAuthModalOpen(false)
  }, [resetAuthEmailFlow])

  const handleGoogleSignIn = useCallback(async (emailHint?: string): Promise<boolean> => {
    if (!supabase) {
      return false
    }
    try {
      const queryParams: Record<string, string> = {}
      const trimmedHint = emailHint?.trim()
      if (trimmedHint) {
        queryParams.login_hint = trimmedHint
        queryParams.prompt = 'login'
      } else {
        queryParams.prompt = 'select_account'
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
          queryParams,
        },
      })
      if (error) {
        return false
      }
      return true
    } catch {
      return false
    }
  }, [])

  const handleMicrosoftSignIn = useCallback(async () => {
    if (!supabase) {
      return
    }
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'azure',
        options: {
          redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
        },
      })
      if (error) {
        return
      }
    } catch {}
  }, [])

  const isAuthEmailValid = useMemo(() => EMAIL_PATTERN.test(authEmailValue.trim()), [authEmailValue])

  const checkAuthEmailExists = useCallback(
    async (email: string): Promise<boolean | null> => {
      if (!supabase) {
        return null
      }
      const normalized = email.trim().toLowerCase()
      if (!normalized) {
        return false
      }
      try {
        const { data, error } = await supabase.rpc('check_auth_email_exists', { target_email: normalized })
        if (error) {
          return null
        }
        return Boolean(data)
      } catch {
        return null
      }
    },
    [],
  )

  useEffect(() => {
    if (authEmailStage !== 'input') {
      return
    }
    const trimmed = authEmailValue.trim()
    if (!EMAIL_PATTERN.test(trimmed)) {
      setAuthEmailLookupValue('')
      setAuthEmailLookupResult(null)
      return
    }
    const requestId = ++authEmailLookupReqIdRef.current
    const timeoutId =
      typeof window !== 'undefined'
        ? window.setTimeout(() => {
            ;(async () => {
              const exists = await checkAuthEmailExists(trimmed)
              if (authEmailLookupReqIdRef.current !== requestId) {
                return
              }
              setAuthEmailLookupValue(trimmed)
              setAuthEmailLookupResult(exists)
            })().catch(() => {
              if (authEmailLookupReqIdRef.current === requestId) {
                setAuthEmailLookupValue(trimmed)
                setAuthEmailLookupResult(null)
              }
            })
          }, 200)
        : null
    return () => {
      if (timeoutId !== null && typeof window !== 'undefined') {
        window.clearTimeout(timeoutId)
      }
    }
  }, [authEmailStage, authEmailValue, checkAuthEmailExists])

  const handleAuthEmailSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!isAuthEmailValid) {
        setAuthEmailError('Please enter a valid email address.')
        return
      }
      setAuthEmailError(null)
      setAuthEmailChecking(true)
      const trimmed = authEmailValue.trim()
      let exists: boolean | null = null
      if (authEmailLookupValue === trimmed) {
        exists = authEmailLookupResult
      }
      let redirecting = false
      try {
        if (exists === null) {
          exists = await checkAuthEmailExists(trimmed)
        }
        if (exists === true) {
          if (!supabase) {
            setAuthEmailError('Unable to sign in right now. Please try again later.')
            return
          }
          const { error } = await supabase.auth.signInWithOtp({
            email: trimmed,
            options: {
              emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
            },
          })
          if (error) {
            setAuthEmailError(error.message || 'We could not send a sign-in link. Please try again.')
            return
          }
          setAuthEmailValue(trimmed)
          setAuthEmailStage('verify')
          setAuthVerifyError(null)
          setAuthVerifyStatus('Check your email for a sign-in link to continue.')
          return
        }
        if (exists === false) {
          setAuthEmailValue(trimmed)
          setAuthEmailStage('create')
          setAuthCreatePassword('')
          setAuthCreatePasswordVisible(false)
          setAuthCreateError(null)
          setAuthVerifyStatus(null)
          return
        }
        setAuthEmailError('We could not verify that email right now. Please try again.')
      } finally {
        if (!redirecting) {
          setAuthEmailChecking(false)
        }
      }
    },
    [
      authEmailLookupResult,
      authEmailLookupValue,
      authEmailValue,
      checkAuthEmailExists,
      handleGoogleSignIn,
      isAuthEmailValid,
    ],
  )

  const handleAuthCreateBack = useCallback(() => {
    setAuthEmailStage('input')
    setAuthCreatePassword('')
    setAuthCreatePasswordVisible(false)
    setAuthCreateSubmitting(false)
    setAuthCreateError(null)
    setAuthVerifyError(null)
    setAuthVerifyStatus(null)
  }, [])

  const handleAuthCreateSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (authCreateSubmitting) {
        return
      }
      const trimmedPassword = authCreatePassword.trim()
      if (trimmedPassword.length < 8) {
        return
      }
      const trimmedEmail = authEmailValue.trim()
      if (!trimmedEmail) {
        setAuthCreateError('Enter a valid email to continue.')
        return
      }
      if (!supabase) {
        setAuthCreateError('Sign-ups are unavailable right now. Please try again later.')
        return
      }
      setAuthCreateError(null)
      setAuthVerifyStatus(null)
      setAuthCreateSubmitting(true)
      
      // Snapshot guest data before sign-up so bootstrap can migrate it
      // even if another tab signs out and clears localStorage
      if (typeof window !== 'undefined') {
        try {
          const guestRoutines = window.localStorage.getItem('nc-taskwatch-life-routines::__guest__')
          const guestQuickList = window.localStorage.getItem('nc-taskwatch-quicklist::__guest__')
          const guestGoals = window.localStorage.getItem('nc-taskwatch-goals-snapshot::__guest__')
          // Don't snapshot history or repeating rules - they have stale references
          
          console.log('[signup] Snapshotting guest data:', {
            routines: guestRoutines ? JSON.parse(guestRoutines).length : 0,
            quickList: guestQuickList ? JSON.parse(guestQuickList).length : 0,
            goals: guestGoals ? 'exists' : 'none',
          })
          
          if (guestRoutines) window.localStorage.setItem('nc-taskwatch-bootstrap-snapshot::life-routines', guestRoutines)
          if (guestQuickList) window.localStorage.setItem('nc-taskwatch-bootstrap-snapshot::quick-list', guestQuickList)
          if (guestGoals) window.localStorage.setItem('nc-taskwatch-bootstrap-snapshot::goals', guestGoals)
        } catch (e) {
          console.warn('[signup] Could not snapshot guest data:', e)
        }
      }
      
      try {
        const { data, error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password: trimmedPassword,
          options: {
            emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
          },
        })
        if (error) {
          setAuthCreateError(error.message || 'We could not create your account. Please try again.')
          return
        }
        if (data?.session) {
          closeAuthModal()
          return
        }
        setAuthEmailValue(trimmedEmail)
        setAuthEmailStage('verify')
        setAuthVerifyError(null)
        setAuthVerifyStatus('Click the confirmation link we sent to your inbox to continue.')
      } catch {
        setAuthCreateError('We could not create your account. Please try again.')
      } finally {
        setAuthCreateSubmitting(false)
      }
    },
    [authCreatePassword, authCreateSubmitting, authEmailValue, closeAuthModal],
  )

  const handleAuthVerifyResend = useCallback(async () => {
    if (authVerifyResending) {
      return
    }
    const trimmedEmail = authEmailValue.trim()
    if (!trimmedEmail) {
      setAuthVerifyError('Something went wrong. Please restart the sign-up flow.')
      return
    }
    if (!supabase) {
      setAuthVerifyError('Unable to resend email right now. Please try again later.')
      return
    }
    setAuthVerifyError(null)
    setAuthVerifyStatus(null)
    setAuthVerifyResending(true)
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: trimmedEmail,
        options: {
          emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined,
        },
      })
      if (error) {
        setAuthVerifyError(error.message || 'We could not resend the email. Please try again.')
        return
      }
      setAuthVerifyStatus('Email resent. It may take a minute to arrive.')
    } catch {
      setAuthVerifyError('We could not resend the email. Please try again.')
    } finally {
      setAuthVerifyResending(false)
    }
  }, [authEmailValue, authVerifyResending])

  const toggleAuthCreatePasswordVisibility = useCallback(() => {
    setAuthCreatePasswordVisible((prev) => !prev)
  }, [])

  const authCreateContinueDisabled = authCreatePassword.trim().length < 8 || authCreateSubmitting

  useEffect(() => {
    if (!authModalOpen) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAuthModal()
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (authModalRef.current && target && authModalRef.current.contains(target)) {
        return
      }
      closeAuthModal()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [authModalOpen, closeAuthModal])

  useEffect(() => {
    if (!settingsOpen) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!settingsOverlayRef.current) {
        return
      }
      if (event.target instanceof Node && settingsOverlayRef.current.contains(event.target)) {
        if ((event.target as HTMLElement).closest('.settings-panel')) {
          return
        }
        setSettingsOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [settingsOpen])

  useEffect(() => {
    if (!supabase) {
      return
    }
    const client = supabase
    let mounted = true

    // Track pending alignment operations to prevent race conditions across tabs
    const ALIGN_LOCK_KEY = 'nc-taskwatch-align-lock'
    const ALIGN_LOCK_TTL_MS = 10000 // 10 seconds
    const ALIGN_COMPLETE_KEY = 'nc-taskwatch-align-complete'

    const isAlignmentComplete = (userId: string): boolean => {
      if (typeof window === 'undefined') return false
      try {
        const raw = window.localStorage.getItem(ALIGN_COMPLETE_KEY)
        if (!raw) return false
        const parsed = JSON.parse(raw) as { userId: string; timestamp: number }
        // Check if alignment was completed for this user in the last 30 seconds
        return parsed.userId === userId && Date.now() - parsed.timestamp < 30000
      } catch {
        return false
      }
    }

    const markAlignmentComplete = (userId: string): void => {
      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(ALIGN_COMPLETE_KEY, JSON.stringify({ userId, timestamp: Date.now() }))
      } catch {}
    }

    const acquireAlignLock = (userId: string): boolean => {
      if (typeof window === 'undefined') return true
      try {
        const raw = window.localStorage.getItem(ALIGN_LOCK_KEY)
        const now = Date.now()
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { userId: string; expiresAt: number }
            // If lock is for same user and still valid, another tab is aligning
            if (parsed.userId === userId && parsed.expiresAt > now) {
              return false
            }
          } catch {}
        }
        // Acquire lock
        const expiresAt = now + ALIGN_LOCK_TTL_MS
        window.localStorage.setItem(ALIGN_LOCK_KEY, JSON.stringify({ userId, expiresAt }))
        return true
      } catch {
        return true
      }
    }

    const releaseAlignLock = (): void => {
      if (typeof window === 'undefined') return
      try {
        window.localStorage.removeItem(ALIGN_LOCK_KEY)
      } catch {}
    }

    const alignLocalStoresForUser = async (userId: string | null): Promise<void> => {
      const previousUserId = lastAlignedUserIdRef.current
      const userChanged = previousUserId !== userId
      
      // Do not attempt to bootstrap/sync without a valid Supabase session
      // EXCEPT when signing out (userId is null) - we need to reset to guest
      const session = await ensureSingleUserSession()
      if (!session && userId) {
        return
      }

      // If user hasn't changed and no migration needed, skip alignment
      if (!userChanged) {
        return
      }

      // Check if alignment was already completed by another tab
      if (userId && isAlignmentComplete(userId)) {
        lastAlignedUserIdRef.current = userId
        return
      }

      // Acquire lock to prevent multiple tabs from aligning simultaneously
      if (userId && !acquireAlignLock(userId)) {
        // Another tab is handling alignment
        // Just update tracking - the winning tab will sync data via storage events
        lastAlignedUserIdRef.current = userId
        
        // Still need to set the user ID in each module so they know which user to track
        // but DON'T trigger syncs (they'll get data via storage events from the winning tab)
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem('nc-taskwatch-quicklist-user-id', userId)
            window.localStorage.setItem('nc-taskwatch-life-routine-user-id', userId)
            window.localStorage.setItem('nc-taskwatch-session-history-user-id', userId)
            window.localStorage.setItem('nc-taskwatch-goals-user-id', userId)
            window.localStorage.setItem('nc-taskwatch-repeating-rules-user-id', userId)
          } catch {}
        }
        return
      }

      try {
        let migrated = false
        try {
          migrated = await bootstrapGuestDataIfNeeded(userId)
        } catch (error) {
          console.error('[bootstrap] failed during alignLocalStoresForUser', error)
        }

        if (userId) {
          if (migrated) {
            // Bootstrap cleared guest data, now initialize user data from DB
            // Clear history/repeating first to prevent stale guest data from syncing
            if (typeof window !== 'undefined') {
              try {
                window.localStorage.removeItem('nc-taskwatch-history')
                window.localStorage.removeItem('nc-taskwatch-current-session')
                window.localStorage.removeItem('nc-taskwatch-session-history::__guest__')
                window.localStorage.removeItem('nc-taskwatch-repeating-rules::__guest__')
              } catch {}
            }
            ensureQuickListUser(userId)
            ensureLifeRoutineUser(userId)
            ensureHistoryUser(userId)
            ensureGoalsUser(userId)
            await ensureRepeatingRulesUser(userId)
            // Pre-fetch goals and history from Supabase so calendar renders correctly immediately
            await Promise.all([
              syncGoalsSnapshotFromSupabase(),
              syncHistoryWithSupabase(),
            ])
          } else {
            // User already bootstrapped, just fetch from DB
            // Don't reset - just ensure user data is loaded
            ensureQuickListUser(userId)
            ensureLifeRoutineUser(userId)
            ensureHistoryUser(userId)
            ensureGoalsUser(userId)
            await ensureRepeatingRulesUser(userId)
            // Pre-fetch goals and history from Supabase so calendar renders correctly immediately
            await Promise.all([
              syncGoalsSnapshotFromSupabase(),
              syncHistoryWithSupabase(),
            ])
          }
        } else {
          // Guest mode - just ensure defaults exist if no data
          // Don't clear existing guest work!
          ensureQuickListUser(null)
          ensureLifeRoutineUser(null, { suppressGuestDefaults: false })
          ensureHistoryUser(null)
          ensureGoalsUser(null)
          ensureRepeatingRulesUser(null)
        }
        
        // Mark alignment as complete so other tabs don't retry
        if (userId) {
          markAlignmentComplete(userId)
        }
        
        lastAlignedUserIdRef.current = userId
      } finally {
        if (userId) {
          releaseAlignLock()
        }
      }
    }

    const applySessionUser = async (user: User | null | undefined): Promise<void> => {
      // Skip alignment if we're in the middle of signing out
      // (we're about to reload anyway, no point triggering syncs)
      if (typeof window !== 'undefined') {
        try {
          const signingOut = window.sessionStorage.getItem('nc-taskwatch-signing-out')
          if (signingOut === 'true') {
            if (mounted) {
              const profile = deriveProfileFromSupabaseUser(user ?? null)
              setUserProfile(profile)
            }
            return
          }
        } catch {}
      }
      
      // Check if user ID actually changed (sign-in or sign-out, not just page refresh)
      // Use localStorage to persist across page reloads (OAuth redirects cause fresh page loads)
      const newUserId = user?.id ?? null
      let previousUserId: string | null | undefined = lastAlignedUserIdRef.current
      if (previousUserId === undefined && typeof window !== 'undefined') {
        try {
          // On fresh page load, check localStorage for last known user
          const stored = window.localStorage.getItem('nc-taskwatch-last-auth-user-id')
          previousUserId = stored === null ? null : (stored === '' ? null : stored)
        } catch {}
      }
      const userActuallyChanged = previousUserId !== undefined && previousUserId !== newUserId
      
      // Reset app timezone to system default ONLY on actual auth changes (sign-in/sign-out)
      // Not on page refresh where user stays the same
      if (userActuallyChanged && typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem('taskwatch_app_timezone')
          // Dispatch custom event to notify same-tab components (storage events only fire cross-tab)
          window.dispatchEvent(new CustomEvent('taskwatch-timezone-reset'))
        } catch {}
      }
      
      // Persist current user ID for future page loads
      if (typeof window !== 'undefined') {
        try {
          if (newUserId) {
            window.localStorage.setItem('nc-taskwatch-last-auth-user-id', newUserId)
          } else {
            window.localStorage.setItem('nc-taskwatch-last-auth-user-id', '')
          }
        } catch {}
      }
      
      const profile = deriveProfileFromSupabaseUser(user ?? null)
      
      // Fetch all data BEFORE updating the profile (which triggers UI change)
      // Keep the auth modal open during this time - user just sees the sign-in screen
      await alignLocalStoresForUser(user?.id ?? null)
      
      // Now that data is ready, update the profile and close the modal
      if (mounted) {
        setUserProfile(profile)
        if (profile) {
          setAuthModalOpen(false)
        }
      }
    }

    const restoreSessionFromCache = async (): Promise<Session | null> => {
      const cachedTokens = readCachedSessionTokens()
      if (!cachedTokens) {
        return null
      }
      try {
        const { data, error } = await client.auth.setSession({
          access_token: cachedTokens.accessToken,
          refresh_token: cachedTokens.refreshToken,
        })
        if (error) {
          return null
        }
        return data.session ?? null
      } catch {
        return null
      }
    }

    const bootstrapSession = async () => {
      // Clear the signing-out flag at the start of a fresh page load
      // This flag is only meant to block alignment during the immediate sign-out reload
      if (typeof window !== 'undefined') {
        try {
          window.sessionStorage.removeItem('nc-taskwatch-signing-out')
        } catch {}
      }
      
      let session: Session | null = null
      try {
        const { data } = await client.auth.getSession()
        session = data.session ?? null
      } catch {}
      if (!session) {
        session = await restoreSessionFromCache()
      }
      await applySessionUser(session?.user ?? null)
      try {
        const { data } = await client.auth.getUser()
        const resolvedUser = data?.user ?? session?.user ?? null
        await applySessionUser(resolvedUser)
      } catch {}
      
      // Bootstrap complete - all data is loaded, ready to show the app
      if (mounted) {
        setIsSigningIn(false)
      }
    }

    // Track last session check to debounce rapid auth changes
    let lastSessionCheckTime = 0
    const SESSION_CHECK_DEBOUNCE_MS = 500

    const recheckSession = async (options?: { skipDebounce?: boolean }) => {
      const now = Date.now()
      if (!options?.skipDebounce && now - lastSessionCheckTime < SESSION_CHECK_DEBOUNCE_MS) {
        return
      }
      lastSessionCheckTime = now

      let session: Session | null = null
      try {
        const { data } = await client.auth.getSession()
        session = data.session ?? null
      } catch {}
      
      if (mounted) {
        await applySessionUser(session?.user ?? null)
      }
    }

    // Track whether initial bootstrap is complete to avoid duplicate alignment calls
    let bootstrapComplete = false

    void (async () => {
      await bootstrapSession()
      bootstrapComplete = true
    })()

    // Listen to auth state changes within this tab
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      // Skip during initial bootstrap - bootstrapSession handles it
      if (!bootstrapComplete) {
        return
      }
      void applySessionUser(session?.user ?? null)
    })

    // Listen to auth changes from other tabs via storage events
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === AUTH_SESSION_STORAGE_KEY) {
        // Skip debounce for sign-out events to ensure immediate response
        const newValue = event.newValue
        const isSignOut = !newValue || newValue === 'null' || newValue === ''
        if (isSignOut) {
          // Another tab signed out - reload this tab to reset to guest mode
          if (typeof window !== 'undefined') {
            window.location.reload()
          }
        } else {
          void recheckSession({ skipDebounce: false })
        }
      } else if (event.key === AUTH_PROFILE_STORAGE_KEY) {
        // Profile was cleared from another tab (sign-out), reload to reset to guest
        const newValue = event.newValue
        if (!newValue || newValue === 'null' || newValue === '') {
          if (typeof window !== 'undefined') {
            window.location.reload()
          }
        }
      } else if (event.key === THEME_STORAGE_KEY) {
        // Theme changed in another tab
        const newValue = event.newValue
        if (newValue === 'light' || newValue === 'dark') {
          setTheme(newValue)
        }
      }
    }

    // Validate session when tab regains focus or becomes visible
    const handleFocus = () => {
      void recheckSession({ skipDebounce: true })
    }

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void recheckSession({ skipDebounce: true })
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', handleStorageChange)
      window.addEventListener('focus', handleFocus)
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange)
      }
    }

    return () => {
      mounted = false
      listener?.subscription.unsubscribe()
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', handleStorageChange)
        window.removeEventListener('focus', handleFocus)
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
      }
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const originalOverflow = document.body.style.overflow
    if (settingsOpen || authModalOpen || featureModalOpen || shortcutsPanelOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = originalOverflow
    }
    return () => {
      document.body.style.overflow = originalOverflow
    }
  }, [settingsOpen, authModalOpen, featureModalOpen, shortcutsPanelOpen])

  const handleLogOut = useCallback(async () => {
    setIsSigningOut(true)
    setActiveTab('focus')
    closeProfileMenu()
    
    // Set flag to skip alignment (we're about to reload anyway)
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem('nc-taskwatch-signing-out', 'true')
      } catch {}
    }
    
    // Sign out from Supabase (local only - don't invalidate sessions on other devices)
    if (supabase) {
      try {
        await supabase.auth.signOut({ scope: 'local' })
      } catch (err) {
        console.warn('[logout] Sign out error:', err)
      }
    }
    
    // Clear auth keys to signal sign-out to other tabs
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY)
      } catch {}
      try {
        window.localStorage.removeItem(AUTH_PROFILE_STORAGE_KEY)
      } catch {}
      
      // Clear all user/guest data before reload for fresh defaults
      try {
        // Clear user ID tracking keys (forces guest mode on reload)
        window.localStorage.removeItem('nc-taskwatch-life-routine-user-id')
        window.localStorage.removeItem('nc-taskwatch-life-routines-user') // Alternative key
        window.localStorage.removeItem('nc-taskwatch-quicklist-user-id')
        window.localStorage.removeItem('nc-taskwatch-quick-list-user') // Alternative key
        window.localStorage.removeItem('nc-taskwatch-history-user') // Correct key for history user
        window.localStorage.removeItem('nc-taskwatch-goals-user-id')
        window.localStorage.removeItem('nc-taskwatch-repeating-user') // Correct key for repeating rules user
        
        // Clear guest keys (both old and new format)
        window.localStorage.removeItem('nc-taskwatch-life-routines::__guest__')
        window.localStorage.removeItem('nc-taskwatch-life-routines-v1::__guest__')
        window.localStorage.removeItem('nc-taskwatch-quicklist::__guest__')
        window.localStorage.removeItem('nc-taskwatch-session-history::__guest__')
        window.localStorage.removeItem('nc-taskwatch-repeating-rules::__guest__')
        window.localStorage.removeItem('nc-taskwatch-goals-snapshot::__guest__')
        
        // Clear snapback guest data
        window.localStorage.removeItem('nc-taskwatch-local-snapback-triggers')
        window.localStorage.removeItem('nc-taskwatch-local-snap-plans')
        
        // Clear non-suffixed data keys (goals, tasks, history, etc.)
        window.localStorage.removeItem('nc-taskwatch-goals-snapshot')
        window.localStorage.removeItem('nc-taskwatch-quick-list-v1')
        window.localStorage.removeItem('nc-taskwatch-history')
        window.localStorage.removeItem('nc-taskwatch-repeating-rules')
        window.localStorage.removeItem('nc-taskwatch-current-session')
        window.localStorage.removeItem('nc-taskwatch-task-details-v1')
        window.localStorage.removeItem('nc-taskwatch-flags')
        
        // Clear focus task state so defaults are shown on reload
        window.localStorage.removeItem('nc-taskwatch-current-task')
        window.localStorage.removeItem('nc-taskwatch-current-task-source')
        window.localStorage.removeItem('nc-taskwatch-stopwatch-v1')
        
        // Clear app timezone override so it resets to system default on next load
        window.localStorage.removeItem('taskwatch_app_timezone')
        
        // Clear last auth user tracking (used to detect sign-in/sign-out across page loads)
        window.localStorage.removeItem('nc-taskwatch-last-auth-user-id')
        
        // Clear alignment tracking so next sign-in runs fresh alignment
        window.localStorage.removeItem('nc-taskwatch-align-complete')
        window.localStorage.removeItem('nc-taskwatch-align-lock')
        
        // Clear ALL goals-related keys (for any user)
        const allKeys = Object.keys(window.localStorage)
        allKeys.forEach(key => {
          if (key.includes('goals-snapshot') || key.includes('task-details')) {
            try { window.localStorage.removeItem(key) } catch {}
          }
        })
        
        // Clear ALL user-specific life routine keys (both formats)
        const keysToRemove: string[] = []
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i)
          if (key && (
            (key.startsWith('nc-taskwatch-life-routines::') && key !== 'nc-taskwatch-life-routines::__guest__') ||
            (key.startsWith('nc-taskwatch-life-routines-v1::') && key !== 'nc-taskwatch-life-routines-v1::__guest__') ||
            (key.startsWith('nc-taskwatch-repeating-rules::') && key !== 'nc-taskwatch-repeating-rules::__guest__')
          )) {
            keysToRemove.push(key)
          }
        }
        keysToRemove.forEach(key => window.localStorage.removeItem(key))
      } catch {}
      
      // Immediately reload - fresh page will have clean guest defaults
      window.location.reload()
    }
  }, [closeProfileMenu, setActiveTab, setIsSigningOut])

  const handleHelpMenuItemSelect = useCallback((itemId: string, url?: string) => {
    // Always close the help menu
    setProfileHelpMenuOpen(false)
    // Keyboard shortcuts opens its own panel
    if (itemId === 'shortcuts') {
      closeProfileMenu()
      setShortcutsPanelOpen(true)
      setShortcutsSearch('')
      return
    }
    // Items that show feature not implemented modal
    const unimplementedItems = ['help-center', 'report-bug', 'download-apps']
    if (unimplementedItems.includes(itemId)) {
      // Show feature modal (profile menu stays open behind it)
      setFeatureModalOpen(true)
      return
    }
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [closeProfileMenu])

  const openSettingsPanel = useCallback((sectionId?: string) => {
    closeProfileMenu()
    setSettingsOpen(true)
    setActiveSettingsSection((current) => sectionId ?? current ?? (SETTINGS_SECTIONS[0]?.id ?? 'general'))
  }, [closeProfileMenu])

  const closeSettingsPanel = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  const isCompactBrand = viewportWidth <= COMPACT_BRAND_BREAKPOINT

  const evaluateNavCollapse = useCallback(() => {
    const container = navContainerRef.current
    const measure = navMeasureRef.current

    if (!container || !measure) {
      setIsNavCollapsed((current) => (current ? false : current))
      return
    }

    const brandWidth = navBrandRef.current?.offsetWidth ?? 0
    const controlsWidth = navControlsRef.current?.offsetWidth ?? 0
    const navWidth = container.clientWidth
    const linksWidth = measure.scrollWidth
    const buffer = isCompactBrand ? COMPACT_NAV_BUFFER : DEFAULT_NAV_BUFFER
    const available = Math.max(0, navWidth - brandWidth - controlsWidth - buffer)
    const shouldCollapse = viewportWidth <= NAV_COLLAPSE_BREAKPOINT && linksWidth > available

    setIsNavCollapsed((current) => (current !== shouldCollapse ? shouldCollapse : current))
  }, [isCompactBrand, viewportWidth])

  const applyTheme = useCallback(
    (value: Theme) => {
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', value)
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_STORAGE_KEY, value)
        // Dispatch custom event for same-tab listeners (storage event doesn't fire in same tab)
        try {
          const event = new CustomEvent('nc-taskwatch:theme-update', { detail: value })
          window.dispatchEvent(event)
        } catch {}
      }
    },
    [],
  )

  useEffect(() => {
    applyTheme(theme)
  }, [applyTheme, theme])

  // Gate hover-only visuals with a root class to avoid accidental previews on touch devices
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const mq1 = window.matchMedia('(hover: hover) and (pointer: fine)')
    const mq2 = window.matchMedia('(any-hover: hover) and (any-pointer: fine)')
    const update = () => {
      const supportsHover = mq1.matches || mq2.matches
      document.documentElement.classList.toggle('has-hover', supportsHover)
    }
    update()
    if (typeof mq1.addEventListener === 'function') {
      mq1.addEventListener('change', update)
      mq2.addEventListener('change', update)
      return () => {
        mq1.removeEventListener('change', update)
        mq2.removeEventListener('change', update)
      }
    }
    // Fallback for older Safari
    if (typeof mq1.addListener === 'function') {
      mq1.addListener(update)
      mq2.addListener(update)
      return () => {
        mq1.removeListener(update)
        mq2.removeListener(update)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      const width = window.innerWidth
      setViewportWidth(width)
      evaluateNavCollapse()
    }

    window.addEventListener('resize', handleResize)
    handleResize()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        evaluateNavCollapse()
      })

      const observeNodes = () => {
        const nodes: Array<Element | null> = [
          navContainerRef.current,
          navMeasureRef.current,
          navBrandRef.current,
          navControlsRef.current,
        ]

        nodes.forEach((node) => {
          if (node) {
            observer.observe(node)
          }
        })
      }

      observeNodes()

      return () => {
        window.removeEventListener('resize', handleResize)
        observer.disconnect()
      }
    }

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [evaluateNavCollapse])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    evaluateNavCollapse()
  }, [activeTab, theme, evaluateNavCollapse])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const panels: Array<[TabKey, RefObject<HTMLElement | null>]> = [
      ['goals', goalsPanelRef],
      ['focus', focusPanelRef],
      ['reflection', reflectionPanelRef],
    ]
    const activeEl = document.activeElement as HTMLElement | null
    panels.forEach(([key, ref]) => {
      const node = ref.current as (HTMLElement & { inert?: boolean }) | null
      if (!node) return
      const isInactive = key !== activeTab
      if (isInactive) {
        try { (node as any).inert = true } catch {}
        node.setAttribute('data-inert', 'true')
        if (activeEl && node.contains(activeEl)) {
          activeEl.blur()
        }
      } else {
        try { (node as any).inert = false } catch {}
        node.removeAttribute('data-inert')
      }
    })
    const activePanel = panels.find(([key]) => key === activeTab)?.[1].current
    if (activePanel && activePanel !== document.activeElement) {
      try {
        activePanel.focus({ preventScroll: true })
      } catch {
        activePanel.focus()
      }
    }
  }, [activeTab])

  useEffect(() => {
    if (!isNavCollapsed && isNavOpen) {
      setIsNavOpen(false)
    }
  }, [isNavCollapsed, isNavOpen])

  useEffect(() => {
    if (!isNavOpen) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsNavOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isNavOpen])

  const toggleTheme = () => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  const closeNav = useCallback(() => {
    setIsNavOpen(false)
  }, [])

  const selectTab = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab)
      closeNav()
    },
    [closeNav],
  )

  const toggleNav = useCallback(() => {
    if (!isNavCollapsed) {
      return
    }
    setIsNavOpen((current) => !current)
  }, [isNavCollapsed])

  // Keyboard shortcuts: 1/2/3 or g/f/r → Goals/Focus/Reflection
  useEffect(() => {
    if (typeof window === 'undefined') return
    const isEditableTarget = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null
      if (!node) return false
      const tag = node.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      // contentEditable anywhere up the tree
      let cur: HTMLElement | null = node
      while (cur) {
        if (cur.getAttribute?.('contenteditable') === 'true') return true
        cur = cur.parentElement
      }
      return false
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (isEditableTarget(e.target)) return
      const k = e.key.toLowerCase()
      let target: TabKey | null = null
  if (k === '1' || k === 'g') target = 'goals'
  else if (k === '2' || k === 'f') target = 'focus'
  else if (k === '3' || k === 'r') target = 'reflection'
      if (target) {
        e.preventDefault()
        setActiveTab(target)
        setIsNavOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleFocusSwitch = () => {
      setActiveTab('focus')
      setIsNavOpen(false)
    }
    const handleScheduleSwitch = () => {
      setActiveTab('reflection')
      setIsNavOpen(false)
    }
    window.addEventListener(FOCUS_EVENT_TYPE, handleFocusSwitch)
    window.addEventListener(SCHEDULE_EVENT_TYPE, handleScheduleSwitch)
    return () => {
      window.removeEventListener(FOCUS_EVENT_TYPE, handleFocusSwitch)
      window.removeEventListener(SCHEDULE_EVENT_TYPE, handleScheduleSwitch)
    }
  }, [])

const nextThemeLabel = theme === 'dark' ? 'light' : 'dark'
  const brandButtonClassName = useMemo(
    () => ['brand', 'brand--toggle', isCompactBrand ? 'brand--compact' : ''].filter(Boolean).join(' '),
    [isCompactBrand],
  )
  const navItems: Array<{ key: TabKey; label: string }> = [
    { key: 'goals', label: 'Goals' },
    { key: 'focus', label: 'Focus' },
    { key: 'reflection', label: 'Reflection' },
  ]
  const swipeStateRef = useRef<{
    pointerId: number | null
    startX: number
    startY: number
    active: boolean
    handled: boolean
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    active: false,
    handled: false,
  })
  const SWIPE_ACTIVATION_DISTANCE = 16
  const SWIPE_TRIGGER_DISTANCE = 72
  const SWIPE_MAX_OFF_AXIS = 80


  const handleSwipePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') {
        return
      }
      if (isNavOpen) {
        return
      }
      const state = swipeStateRef.current
      if (state.pointerId !== null) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target &&
        target.closest?.(
          'input, textarea, select, [contenteditable="true"], [data-disable-tab-swipe], .goal-task-input',
        )
      ) {
        return
      }
      swipeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        handled: false,
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [isNavOpen],
  )

  const handleSwipePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = swipeStateRef.current
    if (event.pointerId !== state.pointerId || state.handled) {
      return
    }
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.active) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_ACTIVATION_DISTANCE) {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        swipeStateRef.current = {
          pointerId: null,
          startX: 0,
          startY: 0,
          active: false,
          handled: true,
        }
        return
      }
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_ACTIVATION_DISTANCE) {
        state.active = true
      }
    }
    if (state.active && Math.abs(dy) > SWIPE_MAX_OFF_AXIS) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      swipeStateRef.current = {
        pointerId: null,
        startX: 0,
        startY: 0,
        active: false,
        handled: true,
      }
      return
    }
    if (state.active) {
      event.preventDefault()
    }
  }, [])

  const finalizeSwipe = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = swipeStateRef.current
      if (event.pointerId !== state.pointerId) {
        return
      }
      if (state.active && !state.handled) {
        const dx = event.clientX - state.startX
        if (Math.abs(dx) >= SWIPE_TRIGGER_DISTANCE) {
          const currentIndex = SWIPE_SEQUENCE.indexOf(activeTab)
          if (currentIndex !== -1) {
            const length = SWIPE_SEQUENCE.length
            const nextIndex = dx > 0
              ? (currentIndex + 1) % length
              : (currentIndex - 1 + length) % length
            const next = SWIPE_SEQUENCE[nextIndex]
            if (next !== activeTab) {
              selectTab(next)
            }
          }
        }
      }
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      swipeStateRef.current = {
        pointerId: null,
        startX: 0,
        startY: 0,
        active: false,
        handled: false,
      }
    },
    [activeTab, selectTab],
  )

  const handleSwipePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finalizeSwipe(event)
    },
    [finalizeSwipe],
  )

  const handleSwipePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finalizeSwipe(event)
    },
    [finalizeSwipe],
  )

  const topBarClassName = useMemo(
    () =>
      ['top-bar', isNavCollapsed ? 'top-bar--collapsed' : '', isNavCollapsed && isNavOpen ? 'top-bar--drawer-open' : '']
        .filter(Boolean)
        .join(' '),
    [isNavCollapsed, isNavOpen],
  )

  const headerClassName = useMemo(
    () => ['navbar', isNavCollapsed && isNavOpen ? 'navbar--drawer-open' : ''].filter(Boolean).join(' '),
    [isNavCollapsed, isNavOpen],
  )

  const drawerContainerClassName = useMemo(
    () => ['top-bar__drawer', isNavCollapsed && isNavOpen ? 'top-bar__drawer--open' : ''].filter(Boolean).join(' '),
    [isNavCollapsed, isNavOpen],
  )

  const collapsedNavClassName = useMemo(() => ['nav-links', 'nav-links--drawer'].join(' '), [])

  const navLinkElements = navItems.map((item) => {
    const isActive = item.key === activeTab
    return (
      <button
        key={item.key}
        type="button"
        className={`nav-link${isActive ? ' nav-link--active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => selectTab(item.key)}
        aria-controls={TAB_PANEL_IDS[item.key]}
      >
        {item.label}
      </button>
    )
  })

  const navMeasureElements = navItems.map((item) => (
    <span key={item.key} className="nav-link nav-link--ghost">
      {item.label}
    </span>
  ))

  const renderSettingsContent = () => {
    if (activeSettingsSection === 'general') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">General</p>
              <p className="settings-panel__content-subtitle">Quickly adjust the look and feel of Taskwatch.</p>
            </div>
          </header>
          <div className="settings-panel__group">
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Appearance</p>
                <p className="settings-panel__row-subtitle">Choose between light and dark mode.</p>
              </div>
              <button
                type="button"
                className="settings-panel__text-toggle"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? '☾ Dark' : '☀ Light'}
              </button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Accent color</p>
                <p className="settings-panel__row-subtitle">Pick the highlight tone for panels.</p>
              </div>
              <button type="button" className="settings-panel__chip">Blue ▾</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Time format</p>
                <p className="settings-panel__row-subtitle">Choose 12-hour or 24-hour clock.</p>
              </div>
              <button
                type="button"
                className="settings-panel__text-toggle"
                onClick={() => setUse24HourTime(!use24HourTime)}
              >
                {use24HourTime ? '24h' : '12h'}
              </button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Timezone</p>
                <p className="settings-panel__row-subtitle">Your current timezone.</p>
              </div>
              <button type="button" className="settings-panel__chip">Auto-detect ▾</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Default landing page</p>
                <p className="settings-panel__row-subtitle">Page shown when you open Taskwatch.</p>
              </div>
              <button type="button" className="settings-panel__chip">Focus ▾</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Language</p>
                <p className="settings-panel__row-subtitle">Display language for the app.</p>
              </div>
              <button type="button" className="settings-panel__chip">Auto-detect ▾</button>
            </div>
          </div>
        </>
      )
    }
    if (activeSettingsSection === 'focus-timers') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">Focus &amp; Timers</p>
              <p className="settings-panel__content-subtitle">Configure timer behavior and display.</p>
            </div>
          </header>
          <div className="settings-panel__group">
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Show milliseconds on timers</p>
                <p className="settings-panel__row-subtitle">Display milliseconds for precision timing.</p>
              </div>
              <button
                type="button"
                className="settings-panel__text-toggle"
                onClick={() => setShowMilliseconds(!showMilliseconds)}
              >
                {showMilliseconds ? 'On' : 'Off'}
              </button>
            </div>
          </div>
        </>
      )
    }
    if (activeSettingsSection === 'calendar') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">Calendar &amp; Routines</p>
              <p className="settings-panel__content-subtitle">Customize your calendar view and scheduling.</p>
            </div>
          </header>
          <div className="settings-panel__group">
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Week start</p>
                <p className="settings-panel__row-subtitle">First day of the week.</p>
              </div>
              <select
                className="settings-panel__select"
                value={weekStartDay}
                onChange={(e) => setWeekStartDay(Number(e.target.value) as 0 | 1)}
              >
                <option value={0}>Sunday</option>
                <option value={1}>Monday</option>
              </select>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Default calendar view</p>
                <p className="settings-panel__row-subtitle">Initial view when opening calendar.</p>
              </div>
              <button type="button" className="settings-panel__chip">5-Day ▾</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Snap to interval</p>
                <p className="settings-panel__row-subtitle">Round times when dragging events.</p>
              </div>
              <button type="button" className="settings-panel__chip">15 min ▾</button>
            </div>
          </div>
        </>
      )
    }
    if (activeSettingsSection === 'notifications') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">Notifications</p>
              <p className="settings-panel__content-subtitle">Manage alerts and reminders.</p>
            </div>
          </header>
          <div className="settings-panel__group">
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Session reminders</p>
                <p className="settings-panel__row-subtitle">Get notified before scheduled sessions.</p>
              </div>
              <button type="button" className="settings-panel__text-toggle">Off</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Daily reflection reminder</p>
                <p className="settings-panel__row-subtitle">Reminder to review your day.</p>
              </div>
              <button type="button" className="settings-panel__text-toggle">Off</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Return to focus reminder</p>
                <p className="settings-panel__row-subtitle">Nudge to get back on track after breaks.</p>
              </div>
              <button type="button" className="settings-panel__text-toggle">Off</button>
            </div>
          </div>
        </>
      )
    }
    if (activeSettingsSection === 'data') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">Data</p>
              <p className="settings-panel__content-subtitle">Import, export, and manage your data.</p>
            </div>
          </header>
          <div className="settings-panel__group">
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Import data</p>
                <p className="settings-panel__row-subtitle">Restore from a backup file.</p>
              </div>
              <button type="button" className="settings-panel__chip">Import</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Export data</p>
                <p className="settings-panel__row-subtitle">Download all your data as a file.</p>
              </div>
              <button type="button" className="settings-panel__chip">Export</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Clear local cache</p>
                <p className="settings-panel__row-subtitle">Remove temporary data stored on this device.</p>
              </div>
              <button type="button" className="settings-panel__chip settings-panel__chip--warning">Clear cache</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Reset to guest data</p>
                <p className="settings-panel__row-subtitle">Restore default settings and sample data.</p>
              </div>
              <button type="button" className="settings-panel__chip settings-panel__chip--danger">Reset</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Delete account &amp; data</p>
                <p className="settings-panel__row-subtitle">Permanently remove all your data.</p>
              </div>
              <button type="button" className="settings-panel__chip settings-panel__chip--danger">Delete</button>
            </div>
          </div>
        </>
      )
    }
    if (activeSettingsSection === 'account') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">Account</p>
              <p className="settings-panel__content-subtitle">Manage your account and subscription.</p>
            </div>
          </header>
          <div className="settings-panel__group">
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Subscription</p>
                <p className="settings-panel__row-subtitle">View or change your current plan.</p>
              </div>
              <button type="button" className="settings-panel__chip">Free plan ▾</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Email / Login</p>
                <p className="settings-panel__row-subtitle">{userProfile?.email || 'Not signed in'}</p>
              </div>
              <button type="button" className="settings-panel__chip">Manage</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Manage authentication</p>
                <p className="settings-panel__row-subtitle">Connected sign-in methods.</p>
              </div>
              <button type="button" className="settings-panel__chip">Manage</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Restore purchases</p>
                <p className="settings-panel__row-subtitle">Recover previous subscriptions.</p>
              </div>
              <button type="button" className="settings-panel__chip">Restore</button>
            </div>
            <div className="settings-panel__row">
              <div>
                <p className="settings-panel__row-title">Delete account &amp; data</p>
                <p className="settings-panel__row-subtitle">Permanently remove your account.</p>
              </div>
              <button type="button" className="settings-panel__chip settings-panel__chip--danger">Delete</button>
            </div>
          </div>
        </>
      )
    }
    if (activeSettingsSection === 'about-me') {
      return (
        <>
          <header className="settings-panel__content-header">
            <div>
              <p className="settings-panel__content-title">About Me</p>
              <p className="settings-panel__content-subtitle">A note from the creator.</p>
            </div>
          </header>
          <div className="settings-panel__about-me">
            <p>Hey everyone! <br></br> &nbsp; Thank you all so much for giving my app a try – <br></br> &nbsp; &nbsp; I really appreciate it a lot :D</p>
            <p>I've spent the last 8 weeks building this thing nonstop and finally... <br></br> &nbsp; it's ready to test!</p>
            <p>There are a lot of features (and prolly a few bugs :/ ) so pls Whatsapp me if you are confused or have any issues.</p>
            <p>I'll be back at the start of Feb but down below are some things I'll fix up when I'm back.</p>
            <ul>
              <li>Notifications</li>
              <li>Payments (DW y'alls wont have to pay)</li>
              <li>GCAL imports</li>
            </ul>
            <p>If you have suggestions or anything you’d like to see added, definitely let me know and I'll add them to the list!</p>
            <p>And on the off chance the app feels super slow or glitchy, try clearing your cookies & site data — and please tell me so I can squish some more bugs 😭.</p>
            <p>Once again, thanks everyone!!!</p>
          </div>
        </>
      )
    }
    const current = SETTINGS_SECTIONS.find((section) => section.id === activeSettingsSection)
    return (
      <div className="settings-panel__placeholder">
        <p className="settings-panel__content-title">{current?.label ?? 'Settings'}</p>
        <p className="settings-panel__content-subtitle">Detailed controls for this section are coming soon.</p>
      </div>
    )
  }

  const renderSignedInMenu = () => {
    if (!userProfile) {
      return null
    }
    return (
      <>
        <div className="profile-menu__section profile-menu__section--user">
          <div className="profile-menu__avatar profile-menu__avatar--filled" aria-hidden="true">
            {userInitials}
          </div>
          <div className="profile-menu__user-text">
            <p className="profile-menu__user-name">{userProfile.name}</p>
            <p className="profile-menu__user-email">{userProfile.email}</p>
          </div>
        </div>
        <hr className="profile-menu__divider" />
        <div className="profile-menu__section profile-menu__section--links">
          <div className={`profile-menu__link-status profile-menu__link-status--${syncStatus}`} role="status" aria-live="polite">
            <span className="profile-menu__link-status-icon" aria-hidden="true">
              {syncStatusCopy.icon}
            </span>
            <span>{syncStatusCopy.label}</span>
          </div>
        </div>
        <hr className="profile-menu__divider" />
        <div className="profile-menu__section profile-menu__section--links">
          <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => openSettingsPanel()}>
            <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
            <span>Settings</span>
          </button>
          <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => openSettingsPanel('account')}>
            <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="9" r="3.4" />
              <path d="M6 18c.8-3.1 3.4-4.5 6-4.5s5.2 1.4 6 4.5" />
            </svg>
            <span>Account</span>
          </button>
          <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => window.open('https://genzero.vercel.app/taskwatch/pricing', '_blank', 'noopener,noreferrer')}>
            <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4l8 7h-5v9h-6v-9h-5l8-7z" />
            </svg>
            <span>Upgrade your plan</span>
          </button>
          <div className="profile-menu__link-help-wrapper">
            <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => setProfileHelpMenuOpen((open) => !open)} ref={profileHelpButtonRef}>
              <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="8" />
                <path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.4c-.6.3-1 .9-1 1.6v.5" />
                <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
              </svg>
              <span>Help</span>
            </button>
            {profileHelpMenuOpen ? (
              <div className="profile-help-menu" role="menu" id={profileHelpMenuId} ref={profileHelpMenuRef}>
                {HELP_MENU_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="profile-help-menu__item"
                    onClick={() => handleHelpMenuItemSelect(item.id, item.url)}
                  >
                    <span className="profile-help-menu__item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="profile-help-menu__item-label">{item.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <hr className="profile-menu__divider" />
        <div className="profile-menu__section profile-menu__section--links">
          <button
            type="button"
            className="profile-menu__link-action profile-menu__link-action--danger"
            role="menuitem"
            onClick={handleLogOut}
          >
            <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Log out</span>
          </button>
        </div>
      </>
    )
  }

  const renderGuestMenu = () => (
    <>
      <div className="profile-menu__section profile-menu__section--user">
        <div className="profile-menu__avatar profile-menu__avatar--empty" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="profile-menu__avatar-icon" aria-hidden="true">
            <circle cx="12" cy="9" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M5 19.2c.68-3.8 3.6-5.9 7-5.9s6.32 2.1 7 5.9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="profile-menu__user-text">
          <p className="profile-menu__user-name">You’re using Taskwatch as a guest</p>
          <p className="profile-menu__user-email">Your data is stored locally only</p>
        </div>
      </div>
      <hr className="profile-menu__divider" />
      <div className="profile-menu__section">
        <p className="profile-menu__section-label">Sign in to:</p>
        <ul className="profile-menu__benefits">
          <li>Sync across devices</li>
          <li>Back up your goals &amp; sessions</li>
          <li>Restore your history anytime</li>
        </ul>
        <button
          type="button"
          className="profile-menu__primary-action"
          onClick={() => setAuthModalOpen(true)}
          role="menuitem"
        >
          Sign in / Create account
        </button>
      </div>
      <hr className="profile-menu__divider" />
      <div className="profile-menu__section profile-menu__section--links">
        <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => window.open('https://genzero.vercel.app/taskwatch/pricing', '_blank', 'noopener,noreferrer')}>
          <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l8 7h-5v9h-6v-9h-5l8-7z" />
          </svg>
          <span>See plans and pricing</span>
        </button>
      </div>
      <hr className="profile-menu__divider" />
      <div className="profile-menu__section profile-menu__section--links">
        <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => openSettingsPanel()}>
          <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <span>Settings</span>
        </button>
        <div className="profile-menu__link-help-wrapper">
          <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => setProfileHelpMenuOpen((open) => !open)} ref={profileHelpButtonRef}>
            <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8" />
              <path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.4c-.6.3-1 .9-1 1.6v.5" />
              <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
            </svg>
            <span>Help</span>
          </button>
          {profileHelpMenuOpen ? (
            <div className="profile-help-menu profile-help-menu--guest" role="menu" id={profileHelpMenuId} ref={profileHelpMenuRef}>
              {GUEST_HELP_MENU_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="profile-help-menu__item"
                  onClick={() => handleHelpMenuItemSelect(item.id, item.url)}
                >
                  <span className="profile-help-menu__item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="profile-help-menu__item-label">{item.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => window.open('https://genzero.vercel.app/taskwatch/release-notes', '_blank', 'noopener,noreferrer')}>
          <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
            <path d="M14 3v6h6" />
            <path d="M8 13h8M8 17h5" />
          </svg>
          <span>Release notes</span>
        </button>
      </div>
      <hr className="profile-menu__divider" />
      <div className="profile-menu__section profile-menu__section--links">
        <button type="button" className="profile-menu__link-action" role="menuitem" onClick={() => window.open('https://genzero.vercel.app/taskwatch/policies', '_blank', 'noopener,noreferrer')}>
          <svg className="profile-menu__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="4" width="14" height="17" rx="2" />
            <path d="M9 9h6M9 13h6M9 17h4" />
          </svg>
          <span>Terms &amp; policies</span>
        </button>
      </div>
    </>
  )

  const swipeHandlers = ENABLE_TAB_SWIPE
    ? {
        onPointerDownCapture: handleSwipePointerDown,
        onPointerMoveCapture: handleSwipePointerMove,
        onPointerUpCapture: handleSwipePointerUp,
        onPointerCancelCapture: handleSwipePointerCancel,
      }
    : undefined

  const mainClassName = 'site-main'

  if (isSigningOut) {
    return <SignOutScreen />
  }

  if (isSigningIn) {
    return (
      <div className="app-loading">
        <div className="app-loading__content">
          <p className="app-loading__title">Signing you in...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className={headerClassName}>
        <div className="navbar__inner">
            <nav
              className={topBarClassName}
              aria-label="Primary navigation"
              ref={navContainerRef}
            >
              <button
                className={brandButtonClassName}
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${nextThemeLabel} mode`}
                ref={navBrandRef}
              >
                <span className={`brand-text${isCompactBrand ? ' sr-only' : ''}`}>Taskwatch</span>
                <span className="brand-indicator" aria-hidden="true">
                  {theme === 'dark' ? '☾' : '☀︎'}
                </span>
              </button>
              <div className="nav-links" hidden={isNavCollapsed}>
                {navLinkElements}
              </div>
              <div className="nav-links nav-links--measure" aria-hidden ref={navMeasureRef}>
                {navMeasureElements}
              </div>
              <div className="top-bar__controls" ref={navControlsRef}>
                <div className="profile-menu-wrapper">
                  <button
                    type="button"
                    className={profileButtonClassName}
                    aria-haspopup="menu"
                    aria-expanded={profileMenuOpen}
                    aria-controls={profileMenuId}
                    aria-label={isSignedIn ? 'Open account menu' : 'Open guest menu'}
                    title={isSignedIn ? 'Account' : 'You are browsing as a guest'}
                    onClick={() => setProfileMenuOpen((open) => !open)}
                    id={profileButtonId}
                    ref={profileButtonRef}
                  >
                    {isSignedIn ? (
                      <span className="profile-button__avatar" aria-hidden="true">
                        {userInitials}
                      </span>
                    ) : (
                      <svg viewBox="0 0 24 24" className="profile-button__icon" aria-hidden="true">
                        <circle cx="12" cy="9" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                        <path
                          d="M5 19.2c.68-3.8 3.6-5.9 7-5.9s6.32 2.1 7 5.9"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                    <span className="sr-only">{isSignedIn ? 'Account menu' : 'Guest menu'}</span>
                  </button>
                  {profileMenuOpen ? (
                    <div
                      className="profile-menu"
                      role="menu"
                      id={profileMenuId}
                      aria-labelledby={profileButtonId}
                      ref={profileMenuRef}
                    >
                      {isSignedIn ? renderSignedInMenu() : renderGuestMenu()}
                    </div>
                  ) : null}
                </div>
                <button
                  className="nav-toggle"
                  type="button"
                  aria-label="Toggle navigation"
                  aria-expanded={isNavCollapsed ? isNavOpen : undefined}
                  aria-controls={isNavCollapsed ? 'primary-navigation' : undefined}
                  onClick={toggleNav}
                  hidden={!isNavCollapsed}
                >
                  <span className={`hamburger${isNavOpen ? ' open' : ''}`} />
                </button>
              </div>
            </nav>
        </div> 
        {isNavCollapsed ? (
          <div className={drawerContainerClassName} aria-hidden={!isNavOpen}>
            <div className={collapsedNavClassName} id="primary-navigation" aria-hidden={!isNavOpen}>
              {navItems.map((item) => {
                const isActive = item.key === activeTab
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`nav-link nav-link--drawer${isActive ? ' nav-link--active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    aria-controls={TAB_PANEL_IDS[item.key]}
                    onClick={() => selectTab(item.key)}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </header>

      <main
        className={mainClassName}
        {...(swipeHandlers ?? {})}
      >
        <section
          id={TAB_PANEL_IDS.goals}
          role="tabpanel"
          className="tab-panel"
          ref={goalsPanelRef as RefObject<HTMLElement>}
          tabIndex={-1}
          hidden={activeTab !== 'goals'}
        >
          {!isSigningIn && <GoalsPage />}
        </section>

        <section
          id={TAB_PANEL_IDS.focus}
          role="tabpanel"
          className="tab-panel"
          ref={focusPanelRef as RefObject<HTMLElement>}
          tabIndex={-1}
          hidden={activeTab !== 'focus'}
        >
          {!isSigningIn && <FocusPage viewportWidth={viewportWidth} showMilliseconds={showMilliseconds} use24HourTime={use24HourTime} />}
        </section>

        <section
          id={TAB_PANEL_IDS.reflection}
          role="tabpanel"
          className="tab-panel"
          ref={reflectionPanelRef as RefObject<HTMLElement>}
          tabIndex={-1}
          hidden={activeTab !== 'reflection'}
        >
          {!isSigningIn && <ReflectionPage use24HourTime={use24HourTime} weekStartDay={weekStartDay} />}
        </section>
      </main>
      {settingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Taskwatch settings" ref={settingsOverlayRef}>
          <div className="settings-panel" role="document">
            <aside className="settings-panel__sidebar">
              <div className="settings-panel__sidebar-header">
                <p>Settings</p>
                <button type="button" className="settings-panel__close" aria-label="Close settings" onClick={closeSettingsPanel}>
                  ✕
                </button>
              </div>
              <nav className="settings-panel__nav" aria-label="Settings sections">
                {SETTINGS_SECTIONS.map((section) => {
                  const isActive = section.id === activeSettingsSection
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={['settings-panel__nav-button', isActive ? 'settings-panel__nav-button--active' : ''].filter(Boolean).join(' ')}
                      onClick={() => setActiveSettingsSection(section.id)}
                    >
                      <span className="settings-panel__nav-icon" aria-hidden="true">
                        {section.icon}
                      </span>
                      <span className="settings-panel__nav-label">{section.label}</span>
                    </button>
                  )
                })}
              </nav>
            </aside>
            <section className="settings-panel__content">{renderSettingsContent()}</section>
          </div>
        </div>
      ) : null}
      {featureModalOpen ? (
        <div className="feature-modal-overlay" role="dialog" aria-modal="true" aria-label="Feature not implemented" onClick={() => setFeatureModalOpen(false)}>
          <div className="feature-modal" ref={featureModalRef} onClick={(e) => e.stopPropagation()}>
            <div className="feature-modal__icon" aria-hidden="true">
              🐦
            </div>
            <h2 className="feature-modal__title">Feature not implemented yet</h2>
            <p className="feature-modal__text">Contact us via pigeon for any suggestions/inquiries.</p>
            <button type="button" className="feature-modal__close" onClick={() => setFeatureModalOpen(false)}>
              Got it
            </button>
          </div>
        </div>
      ) : null}
      {shortcutsPanelOpen ? (
        <div className="shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={() => setShortcutsPanelOpen(false)}>
          <div className="shortcuts-panel" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-panel__header">
              <h2 className="shortcuts-panel__title">Keyboard shortcuts</h2>
              <button type="button" className="shortcuts-panel__close" aria-label="Close keyboard shortcuts" onClick={() => setShortcutsPanelOpen(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="shortcuts-panel__search">
              <svg className="shortcuts-panel__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                className="shortcuts-panel__search-input"
                placeholder="Search"
                value={shortcutsSearch}
                onChange={(e) => setShortcutsSearch(e.target.value)}
              />
            </div>
            <div className="shortcuts-panel__content">
              {(() => {
                const shortcuts = [
                  { section: 'Page Navigation', items: [
                    { label: 'Goals page', keys: ['1', 'G'] },
                    { label: 'Focus page', keys: ['2', 'F'] },
                    { label: 'Reflection page', keys: ['3', 'R'] },
                  ]},
                  { section: 'Calendar Navigation', items: [
                    { label: 'Previous period', keys: ['P'] },
                    { label: 'Next period', keys: ['N'] },
                    { label: 'Today', keys: ['T'] },
                  ]},
                  { section: 'Calendar Views', items: [
                    { label: 'Day view', keys: ['D'] },
                    { label: 'Custom view', keys: ['X'] },
                    { label: 'Custom view (double tap)', keys: ['X X'], noOr: true },
                    { label: 'Week view', keys: ['W'] },
                    { label: 'Month view', keys: ['M'] },
                    { label: 'Year view', keys: ['Y'] },
                  ]},
                ]
                const searchLower = shortcutsSearch.toLowerCase()
                const filtered = shortcuts.map(section => ({
                  ...section,
                  items: section.items.filter(item => 
                    item.label.toLowerCase().includes(searchLower) ||
                    item.keys.some(k => k.toLowerCase().includes(searchLower))
                  )
                })).filter(section => section.items.length > 0)
                
                return filtered.map(section => (
                  <div key={section.section} className="shortcuts-panel__section">
                    <h3 className="shortcuts-panel__section-title">{section.section}</h3>
                    {section.items.map(item => (
                      <div key={item.label} className="shortcuts-panel__row">
                        <span className="shortcuts-panel__label">{item.label}</span>
                        <span className="shortcuts-panel__keys">
                          {(item as any).noOr ? (
                            item.keys[0].split(' ').map((key: string, i: number) => (
                              <kbd key={i} className="shortcuts-panel__key">{key}</kbd>
                            ))
                          ) : (
                            item.keys.map((key, i) => (
                              <Fragment key={i}>
                                {i > 0 && <span className="shortcuts-panel__or">or</span>}
                                <kbd className="shortcuts-panel__key">{key}</kbd>
                              </Fragment>
                            ))
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              })()}
            </div>
            <div className="shortcuts-panel__footer">
              <a href="https://genzero.vercel.app/taskwatch/help" target="_blank" rel="noopener noreferrer" className="shortcuts-panel__help-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span>View all in help center</span>
              </a>
            </div>
          </div>
        </div>
      ) : null}
      {authModalOpen ? (
        <div className="auth-modal-overlay" role="dialog" aria-modal="true" aria-label="Sign in to Taskwatch">
          <div className="auth-modal" ref={authModalRef}>
            {authEmailStage === 'create' ? (
              <form className="auth-create" onSubmit={handleAuthCreateSubmit}>
                <div className="auth-create__header">
                  <div>
                    <p className="auth-create__eyebrow">Taskwatch</p>
                    <h2 className="auth-create__title">Create your account</h2>
                    <p className="auth-create__subtitle">Set your password to continue.</p>
                  </div>
                  <button type="button" className="auth-modal__close auth-create__close" aria-label="Close sign-in panel" onClick={closeAuthModal}>
                    ✕
                  </button>
                </div>
                <div className="auth-create__card">
                  <div className="auth-create__field">
                    <span className="auth-create__label">Email address</span>
                    <div className="auth-create__input auth-create__pill">
                      <span className="auth-create__pill-value">{authEmailValue}</span>
                      <button type="button" className="auth-create__edit" onClick={handleAuthCreateBack}>
                        Edit
                      </button>
                    </div>
                  </div>
                  <label className="auth-create__field">
                    <span className="auth-create__label">Password</span>
                    <div className="auth-create__input auth-create__password">
                      <input
                        type={authCreatePasswordVisible ? 'text' : 'password'}
                        name="auth-create-password"
                        id="auth-create-password"
                        placeholder="Create a password"
                        autoComplete="new-password"
                        minLength={8}
                        value={authCreatePassword}
                        onChange={(event) => {
                          setAuthCreatePassword(event.target.value)
                          if (authCreateError) {
                            setAuthCreateError(null)
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="auth-create__toggle"
                        onClick={toggleAuthCreatePasswordVisibility}
                        aria-label={authCreatePasswordVisible ? 'Hide password' : 'Show password'}
                        aria-pressed={authCreatePasswordVisible}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M12 5C6.5 5 2 9.67 2 12s4.5 7 10 7 10-4.67 10-7-4.5-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                          />
                          {authCreatePasswordVisible ? <circle cx="12" cy="12" r="1.8" fill="currentColor" /> : null}
                        </svg>
                      </button>
                    </div>
                    <p className="auth-create__hint">Use at least 8 characters.</p>
                  </label>
                </div>
                <button type="submit" className="auth-create__continue" disabled={authCreateContinueDisabled}>
                  {authCreateSubmitting ? 'Sending…' : 'Continue'}
                </button>
                {authCreateError ? (
                  <p className="auth-create__error" role="alert">
                    {authCreateError}
                  </p>
                ) : null}
                <p className="auth-modal__terms auth-modal__terms--center">
                  By continuing, you acknowledge that you understand and agree to the{' '}
                  <a className="auth-modal__link" href={TERMS_URL} target="_blank" rel="noreferrer noopener">
                    Terms &amp; Conditions
                  </a>{' '}
                  and{' '}
                  <a className="auth-modal__link" href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">
                    Privacy Policy
                  </a>
                  .
                </p>
              </form>
            ) : authEmailStage === 'verify' ? (
              <div className="auth-create auth-verify">
                <div className="auth-create__header">
                  <div>
                    <p className="auth-create__eyebrow">Taskwatch</p>
                    <h2 className="auth-create__title">Check your inbox</h2>
                    <p className="auth-create__subtitle">
                      Click the confirmation link we sent to finish creating your account.
                    </p>
                  </div>
                  <button type="button" className="auth-modal__close auth-create__close" aria-label="Close sign-in panel" onClick={closeAuthModal}>
                    ✕
                  </button>
                </div>
                <div className="auth-create__card">
                  <div className="auth-create__field">
                    <span className="auth-create__label">Email address</span>
                    <div className="auth-create__input auth-create__pill">
                      <span className="auth-create__pill-value">{authEmailValue}</span>
                      <button type="button" className="auth-create__edit" onClick={handleAuthCreateBack}>
                        Edit
                      </button>
                    </div>
                  </div>
                  <p
                    className={`auth-verify__message${authVerifyError ? ' auth-verify__message--error' : ''}`}
                    role={authVerifyError ? 'alert' : 'status'}
                  >
                    {authVerifyError ?? authVerifyStatus ?? 'When you click the link, we will sign you in automatically.'}
                  </p>
                </div>
                <button type="button" className="auth-verify__resend" onClick={handleAuthVerifyResend} disabled={authVerifyResending}>
                  {authVerifyResending ? 'Sending…' : 'Resend email'}
                </button>
                <p className="auth-modal__terms auth-modal__terms--center">
                  Having trouble? Check your spam folder or try resending the confirmation email.
                </p>
              </div>
            ) : (
              <>
                <div className="auth-modal__header">
                  <div>
                    <p className="auth-modal__title">Sign in to Taskwatch</p>
                    <p className="auth-modal__subtitle">Sync your data and pick up right where you left off.</p>
                  </div>
                  <button type="button" className="auth-modal__close" aria-label="Close sign-in panel" onClick={closeAuthModal}>
                    ✕
                  </button>
                </div>
                <div className="auth-modal__providers" role="group" aria-label="Sign-in options">
                  <button type="button" className="auth-provider auth-provider--google" onClick={() => handleGoogleSignIn()}>
                    <span className="auth-provider__icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M21.6 12.227c0-.68-.057-1.362-.179-2.027H12v3.84h5.44c-.227 1.243-.934 2.352-1.987 3.07v2.553h3.208c1.882-1.733 2.938-4.29 2.938-7.436z" fill="#4285F4" />
                        <path d="M12 22c2.7 0 4.97-.89 6.626-2.337l-3.208-2.553c-.893.6-2.037.947-3.418.947a5.92 5.92 0 0 1-5.592-4.018H3.08v2.6C4.8 19.915 8.17 22 12 22z" fill="#34A853" />
                        <path d="M6.408 14.04A5.83 5.83 0 0 1 6.1 12c0-.706.123-1.386.308-2.04V7.36H3.08A9.996 9.996 0 0 0 2 12c0 1.6.38 3.112 1.08 4.64l3.328-2.6z" fill="#FBBC05" />
                        <path d="M12 6.08c1.469 0 2.789.507 3.828 1.5l2.872-2.872C16.967 2.94 14.7 2 12 2 8.17 2 4.8 4.085 3.08 7.36l3.328 2.6A5.92 5.92 0 0 1 12 6.08z" fill="#EA4335" />
                      </svg>
                    </span>
                    Continue with Google
                  </button>
                  <button type="button" className="auth-provider" aria-disabled="true">
                    <span className="auth-provider__icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M16.365 2c-.948.062-2.074.66-2.752 1.45-.6.69-1.123 1.77-.924 2.795 1.006.032 2.062-.574 2.715-1.373.634-.793 1.123-1.877.961-2.872zM19.66 11.23c-.026-2.58 2.14-3.819 2.243-3.879-1.225-1.79-3.124-2.034-3.791-2.058-1.607-.167-3.14.942-3.955.942-.824 0-2.078-.922-3.416-.897-1.764.026-3.395 1.03-4.295 2.622-1.829 3.165-.466 7.85 1.309 10.418.869 1.25 1.904 2.642 3.264 2.592 1.317-.052 1.813-.84 3.408-.84 1.586 0 2.043.84 3.424.81 1.41-.026 2.303-1.277 3.168-2.532.994-1.45 1.4-2.857 1.421-2.927-.032-.013-2.718-1.034-2.741-4.344z" />
                      </svg>
                    </span>
                    Continue with Apple
                  </button>
                  <button type="button" className="auth-provider auth-provider--microsoft" onClick={handleMicrosoftSignIn}>
                    <span className="auth-provider__icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M3 3h8.5v8.5H3Z" fill="#f25022" />
                        <path d="M12.5 3H21v8.5h-8.5Z" fill="#7fba00" />
                        <path d="M3 12.5h8.5V21H3Z" fill="#00a4ef" />
                        <path d="M12.5 12.5H21V21h-8.5Z" fill="#ffb900" />
                      </svg>
                    </span>
                    Continue with Microsoft
                  </button>
                </div>
                <hr className="auth-modal__divider" />
                <form className="auth-modal__email" onSubmit={handleAuthEmailSubmit} noValidate>
                  <label htmlFor="auth-modal-email">Email</label>
                  <input
                    id="auth-modal-email"
                    name="email"
                    type="email"
                    placeholder="Enter your email address…"
                    autoComplete="email"
                    value={authEmailValue}
                    onChange={(event) => {
                      setAuthEmailValue(event.target.value)
                      if (authEmailError) {
                        setAuthEmailError(null)
                      }
                    }}
                    aria-invalid={authEmailError ? 'true' : 'false'}
                  />
                  {authEmailError ? (
                    <p className="auth-modal__error" role="alert">
                      {authEmailError}
                    </p>
                  ) : (
                    <p className="auth-modal__hint">Use an organization email to easily collaborate with teammates.</p>
                  )}
                  <button type="submit" className="auth-modal__continue" disabled={!isAuthEmailValid || authEmailChecking}>
                    {authEmailChecking ? 'Checking…' : 'Continue'}
                  </button>
                </form>
                <p className="auth-modal__terms">
                  By continuing, you acknowledge that you understand and agree to the{' '}
                  <a className="auth-modal__link" href={TERMS_URL} target="_blank" rel="noreferrer noopener">
                    Terms &amp; Conditions
                  </a>{' '}
                  and{' '}
                  <a className="auth-modal__link" href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">
                    Privacy Policy
                  </a>
                  .
                </p>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function App(): React.ReactElement {
  const [isAuthCallbackRoute, setIsAuthCallbackRoute] = useState(() =>
    typeof window !== 'undefined' ? window.location.pathname.startsWith('/auth/callback') : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handlePopState = () => {
      setIsAuthCallbackRoute(window.location.pathname.startsWith('/auth/callback'))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  if (isAuthCallbackRoute) {
    return <AuthCallbackScreen />
  }
  return <MainApp />
}

export default App

function AuthCallbackScreen(): React.ReactElement {
  // Apply stored theme so the callback screen respects dark/light mode
  useEffect(() => {
    const storedTheme = getInitialTheme()
    document.documentElement.setAttribute('data-theme', storedTheme)
  }, [])

  useEffect(() => {
    let cancelled = false
    const finalize = async () => {
      if (!supabase) {
        window.location.replace('/')
        return
      }
      const url = new URL(window.location.href)
      const hasAuthCode = Boolean(url.searchParams.get('code'))
      let session = null
      try {
        if (hasAuthCode) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(window.location.href)
          if (error) {
            await supabase.auth.getSession().catch(() => {})
          } else {
            session = data?.session
          }
        } else {
          const { data } = await supabase.auth.getSession()
          session = data?.session
        }
      } catch {
        const { data } = await supabase.auth.getSession().catch(() => ({ data: null }))
        session = data?.session
      }
      
      // Now that we're authenticated, pre-fetch all the user's data before redirecting
      if (session?.user?.id && !cancelled) {
        const userId = session.user.id
        
        // Set up user in all the stores
        ensureQuickListUser(userId)
        ensureLifeRoutineUser(userId)
        ensureHistoryUser(userId)
        ensureGoalsUser(userId)
        await ensureRepeatingRulesUser(userId)
        
        // Fetch goals and history from Supabase so they're in localStorage
        await Promise.all([
          syncGoalsSnapshotFromSupabase(),
          syncHistoryWithSupabase(),
        ])
      }
      
      if (!cancelled) {
        // Clear focus task state on sign-in so user starts with default presets
        try {
          window.localStorage.removeItem('nc-taskwatch-current-task')
          window.localStorage.removeItem('nc-taskwatch-current-task-source')
          window.localStorage.removeItem('nc-taskwatch-stopwatch-v1')
        } catch {}
        window.location.replace('/')
      }
    }
    finalize().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="auth-callback-screen">
      <div className="auth-callback-panel">
        <p className="auth-callback-title">Signing you in…</p>
        <p className="auth-callback-text">Hang tight while we finish connecting your account.</p>
      </div>
    </div>
  )
}

function SignOutScreen(): React.ReactElement {
  return (
    <div className="auth-callback-screen">
      <div className="auth-callback-panel">
        <p className="auth-callback-title">Signing you out…</p>
        <p className="auth-callback-text">Hang tight while we wrap things up.</p>
      </div>
    </div>
  )
}
