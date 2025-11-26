export const SURFACE_STYLES = [
  'glass',
  'midnight',
  'coastal',
  'linen',
  'frost',
  'grove',
  'lagoon',
  'ember',
  'cherry',
  // New themes
  'deep-indigo',
  'warm-amber',
  'fresh-teal',
  'sunset-orange',
  'cool-blue',
  'soft-magenta',
  // Note: corrected spelling from earlier draft 'muted-lavendar'
  'muted-lavender',
  'neutral-grey-blue',
  // Life routine: additional green variants (#6EBF77/bg-green-400 family)
  'leaf',
  'sprout',
  'fern',
  'sage',
  'meadow',
  'willow',
  'pine',
  'basil',
  'mint',
  // Life routine: additional warm/coral variants (#FF8C69 family)
  'coral',
  'peach',
  'apricot',
  'salmon',
  'tangerine',
  'papaya',
] as const

// Server-enforced allowlist for buckets (mirrors DB check constraint)
const SERVER_BUCKET_STYLE_ALLOWLIST = new Set<string>([
  'glass',
  'coastal',
  'cherry',
  'linen',
  'frost',
  'grove',
  'lagoon',
  'ember',
  'deep-indigo',
  'warm-amber',
  'fresh-teal',
  'sunset-orange',
  'cool-blue',
  'soft-magenta',
  'muted-lavender',
  'neutral-grey-blue',
])

export type SurfaceStyle = (typeof SURFACE_STYLES)[number]

export const DEFAULT_SURFACE_STYLE: SurfaceStyle = 'glass'

export const sanitizeSurfaceStyle = (value: unknown): SurfaceStyle | null => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim() as SurfaceStyle
  return (SURFACE_STYLES as readonly string[]).includes(normalized) ? normalized : null
}

export const ensureSurfaceStyle = (
  value: unknown,
  fallback: SurfaceStyle = DEFAULT_SURFACE_STYLE,
): SurfaceStyle => sanitizeSurfaceStyle(value) ?? fallback

export const ensureServerBucketStyle = (
  value: unknown,
  fallback: SurfaceStyle = DEFAULT_SURFACE_STYLE,
): SurfaceStyle => {
  const normalized = sanitizeSurfaceStyle(value)
  if (normalized && SERVER_BUCKET_STYLE_ALLOWLIST.has(normalized)) {
    return normalized as SurfaceStyle
  }
  return fallback
}
