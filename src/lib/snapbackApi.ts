import { supabase, ensureSingleUserSession } from './supabaseClient'

export type DbSnapbackOverview = {
  id: string
  user_id: string
  trigger_name: string
  cue_text: string
  deconstruction_text: string
  plan_text: string
  sort_index: number
  created_at?: string
  updated_at?: string
}

export async function fetchSnapbackOverviewRows(): Promise<DbSnapbackOverview[]> {
  if (!supabase) return []
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return []
  const { data, error } = await supabase
    .from('snapback_overview')
    .select('id, user_id, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })
  if (error) {
    return []
  }
  return Array.isArray(data) ? (data as DbSnapbackOverview[]) : []
}

export async function getOrCreateTriggerByName(trigger_name: string): Promise<DbSnapbackOverview | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null
  
  // First try to find existing trigger
  const { data: existing, error: findError } = await supabase
    .from('snapback_overview')
    .select('id, user_id, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .eq('user_id', session.user.id)
    .eq('trigger_name', trigger_name)
    .single()
  
  if (existing && !findError) {
    return existing as DbSnapbackOverview
  }
  
  // Create new trigger
  const payload = {
    user_id: session.user.id,
    trigger_name,
    cue_text: '',
    deconstruction_text: '',
    plan_text: '',
    sort_index: 0,
  }
  const { data, error } = await supabase
    .from('snapback_overview')
    .insert([payload])
    .select('id, user_id, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .single()
  if (error) {
    return null
  }
  return data as DbSnapbackOverview
}

export async function createSnapbackTrigger(trigger_name: string): Promise<DbSnapbackOverview | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null
  const payload = {
    user_id: session.user.id,
    trigger_name,
    cue_text: '',
    deconstruction_text: '',
    plan_text: '',
    sort_index: 0,
  }
  const { data, error } = await supabase
    .from('snapback_overview')
    .insert([payload])
    .select('id, user_id, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .single()
  if (error) {
    return null
  }
  return data as DbSnapbackOverview
}

export async function updateSnapbackTriggerNameById(id: string, newName: string, oldName: string): Promise<boolean> {
  if (!supabase) return false
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return false
  
  // Update the trigger name in snapback_overview
  const { error: updateError } = await supabase
    .from('snapback_overview')
    .update({ trigger_name: newName })
    .eq('id', id)
    .eq('user_id', session.user.id)
  if (updateError) {
    return false
  }
  
  // Update all session_history rows that reference the old name
  const { error: historyError } = await supabase
    .from('session_history')
    .update({ bucket_name: newName })
    .eq('user_id', session.user.id)
    .eq('goal_name', 'Snapback')
    .eq('bucket_name', oldName)
  if (historyError) {
    // Log but don't fail - trigger was renamed successfully
    console.warn('Failed to update session history bucket names:', historyError)
  }
  
  return true
}

export async function upsertSnapbackPlanById(id: string, plan: {
  cue_text?: string
  deconstruction_text?: string
  plan_text?: string
}): Promise<DbSnapbackOverview | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null
  
  const payload: Record<string, string> = {}
  if (typeof plan.cue_text === 'string') payload.cue_text = plan.cue_text
  if (typeof plan.deconstruction_text === 'string') payload.deconstruction_text = plan.deconstruction_text
  if (typeof plan.plan_text === 'string') payload.plan_text = plan.plan_text
  
  const { data, error } = await supabase
    .from('snapback_overview')
    .update(payload)
    .eq('id', id)
    .eq('user_id', session.user.id)
    .select('id, user_id, trigger_name, cue_text, deconstruction_text, plan_text, sort_index, created_at, updated_at')
    .single()
  if (error) {
    return null
  }
  return data as DbSnapbackOverview
}

export async function deleteSnapbackRowById(id: string): Promise<boolean> {
  if (!supabase) return false
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return false
  const { error } = await supabase
    .from('snapback_overview')
    .delete()
    .eq('id', id)
    .eq('user_id', session.user.id)
  if (error) {
    return false
  }
  return true
}
