// API helper — proxy para Express em localhost:3000
export async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  let res
  try {
    res = await fetch(path, opts)
  } catch (err) {
    throw new Error('Sem conexão com o servidor')
  }

  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`)
    Object.assign(err, data)
    throw err
  }
  return data
}

export function formatCurrency(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const STATUS_BADGE = {
  new: 'bg-secondary',
  researched: 'bg-info text-dark',
  sequence_created: 'bg-primary',
  contacted: 'bg-primary',
  needs_followup: 'bg-warning text-dark',
  hot_lead: 'bg-danger',
  rejected: 'bg-dark',
  meeting_set: 'bg-success',
  opted_out: 'bg-secondary',
}

export const STATUS_LABEL = {
  new: 'Novo',
  researched: 'Pesquisado',
  sequence_created: 'Sequência criada',
  contacted: 'Contactado',
  needs_followup: 'Follow-up',
  hot_lead: 'Hot Lead',
  rejected: 'Rejeitado',
  meeting_set: 'Reunião',
  opted_out: 'Opt-out',
}

export const ROLE_LABEL = {
  c_level: 'C-Level',
  manager: 'Gerente',
  engineer: 'Engenheiro',
  other: 'Outro',
}

export const STAGE_LABEL = {
  prospecting: 'Prospecção',
  qualified: 'Qualificado',
  proposal: 'Proposta',
  negotiation: 'Negociação',
  won: 'Ganho',
  lost: 'Perdido',
}
