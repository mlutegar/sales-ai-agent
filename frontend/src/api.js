// API helper — proxy para Express em localhost:3000
export async function api(path, method = 'GET', body = null) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const opts = { method, headers: isForm ? {} : { 'Content-Type': 'application/json' } }
  if (body) opts.body = isForm ? body : JSON.stringify(body)

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

  let data
  try {
    data = await res.json()
  } catch (err) {
    if (!res.ok) throw new Error(`Erro ${res.status}`)
    throw new Error('Resposta inválida do servidor (esperava JSON)')
  }

  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`)
    Object.assign(err, data)
    throw err
  }
  return data
}

// (#7) Upload de arquivo com barra de progresso via XMLHttpRequest.
// onProgress recebe um número 0–100. Rejeita com Error enriquecido (err.status, err.duplicate...).
export function apiUpload(path, file, { fields = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file)
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let data = {}
      try { data = JSON.parse(xhr.responseText) } catch (_) {}
      if (xhr.status === 401) { window.location.href = '/login'; return reject(new Error('Unauthorized')) }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data)
      const err = new Error(data.error || `Erro ${xhr.status}`)
      err.status = xhr.status
      Object.assign(err, data)
      reject(err)
    }
    xhr.onerror = () => reject(new Error('Sem conexão com o servidor'))
    xhr.send(fd)
  })
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
