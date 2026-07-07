import { useState, useEffect, useCallback } from 'react'
import { api, STAGE_LABEL, formatCurrency } from '../api.js'

const STAGE_BADGE = {
  prospecting: 'bg-secondary',
  qualified:   'bg-info text-dark',
  proposal:    'bg-primary',
  negotiation: 'bg-warning text-dark',
  won:         'bg-success',
  lost:        'bg-dark',
}

function downloadCSV(filename, rows) {
  const csv = rows
    .map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
}

function sortArrayBy(arr, key, asc) {
  return [...arr].sort((a, b) => {
    const va = a[key] ?? ''
    const vb = b[key] ?? ''
    if (typeof va === 'number' && typeof vb === 'number') return asc ? va - vb : vb - va
    return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
  })
}

export default function Opportunities({ toast, loadStats }) {
  const [opportunities, setOpportunities] = useState([])
  const [companies, setCompanies] = useState([])
  const [sortKey, setSortKey] = useState('created_at')
  const [sortAsc, setSortAsc] = useState(false)
  const [loading, setLoading] = useState(false)

  // Form state
  const [form, setForm] = useState({
    company_id: '',
    name: '',
    stage: 'prospecting',
    value: '',
    notes: '',
  })

  // Inline edit state: { id, stage, value }
  const [editingId, setEditingId] = useState(null)
  const [editStage, setEditStage] = useState('')
  const [editValue, setEditValue] = useState('')

  const loadOpportunities = useCallback(async () => {
    try {
      const data = await api('/api/opportunities')
      setOpportunities(data)
    } catch (e) {
      toast('Erro ao carregar oportunidades', 'danger')
    }
  }, [toast])

  const loadCompanies = useCallback(async () => {
    try {
      const data = await api('/api/companies')
      setCompanies(data)
    } catch (e) {
      // silently fail — companies may load via parent
    }
  }, [])

  useEffect(() => {
    loadOpportunities()
    loadCompanies()
  }, [loadOpportunities, loadCompanies])

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortAsc(prev => !prev)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const sorted = sortArrayBy(opportunities, sortKey, sortAsc)

  const pipelineTotal = opportunities.reduce((sum, o) => {
    return o.stage !== 'lost' ? sum + (o.value || 0) : sum
  }, 0)

  const handleCreate = async () => {
    if (!form.company_id) { toast('Selecione uma empresa', 'warning'); return }
    if (!form.name.trim()) { toast('Nome da oportunidade é obrigatório', 'warning'); return }
    if (form.value !== '' && parseFloat(form.value) < 0) { toast('Valor não pode ser negativo', 'warning'); return }

    setLoading(true)
    try {
      await api('/api/opportunities', 'POST', {
        company_id: parseInt(form.company_id),
        name: form.name.trim(),
        stage: form.stage,
        value: parseFloat(form.value) || 0,
        notes: form.notes.trim(),
      })
      toast('Oportunidade criada!')
      setForm({ company_id: '', name: '', stage: 'prospecting', value: '', notes: '' })
      await loadOpportunities()
      if (loadStats) loadStats()
    } catch (e) {
      // api() already shows toast on error
    } finally {
      setLoading(false)
    }
  }

  const startEdit = (opp) => {
    setEditingId(opp.id)
    setEditStage(opp.stage)
    setEditValue(String(opp.value || 0))
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditStage('')
    setEditValue('')
  }

  const saveEdit = async (id) => {
    try {
      await api(`/api/opportunities/${id}`, 'PATCH', {
        stage: editStage,
        value: parseFloat(editValue) || 0,
      })
      toast('Oportunidade atualizada!')
      cancelEdit()
      await loadOpportunities()
      if (loadStats) loadStats()
    } catch (e) {
      // api() shows toast
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Remover esta oportunidade?')) return
    try {
      await api(`/api/opportunities/${id}`, 'DELETE')
      toast('Oportunidade removida', 'warning')
      await loadOpportunities()
      if (loadStats) loadStats()
    } catch (e) {
      // api() shows toast
    }
  }

  const exportCSV = () => {
    const header = ['Empresa', 'Oportunidade', 'Estágio', 'Valor', 'Data']
    const rows = opportunities.map(o => [
      o.company_name,
      o.name,
      STAGE_LABEL[o.stage] || o.stage,
      o.value,
      o.created_at,
    ])
    downloadCSV('oportunidades.csv', [header, ...rows])
    toast('CSV de oportunidades exportado!')
  }

  const SortIcon = ({ field }) => {
    if (sortKey !== field) return <i className="bi bi-arrow-down-up text-muted small ms-1"></i>
    return <i className={`bi bi-arrow-${sortAsc ? 'up' : 'down'} text-primary small ms-1`}></i>
  }

  return (
    <div className="row g-3">
      {/* ── Sidebar form ── */}
      <div className="col-12 col-md-3 order-2 order-md-1">
        <div className="card p-3">
          <h6 className="fw-bold mb-3">
            <i className="bi bi-funnel me-1"></i>Nova Oportunidade
          </h6>

          <div className="mb-2">
            <select
              className="form-select form-select-sm"
              value={form.company_id}
              onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))}
            >
              <option value="">Selecione empresa *</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="mb-2">
            <input
              className="form-control form-control-sm"
              placeholder="Nome da oportunidade *"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="mb-2">
            <select
              className="form-select form-select-sm"
              value={form.stage}
              onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}
            >
              {Object.entries(STAGE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          <div className="mb-2">
            <input
              className="form-control form-control-sm"
              type="number"
              min="0"
              step="0.01"
              placeholder="Valor R$"
              value={form.value}
              onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
            />
          </div>

          <div className="mb-3">
            <textarea
              className="form-control form-control-sm"
              rows={3}
              placeholder="Notas..."
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>

          <button
            className="btn btn-primary btn-sm w-100"
            onClick={handleCreate}
            disabled={loading}
          >
            {loading
              ? <><span className="spinner-border spinner-border-sm me-1"></span>Aguarde...</>
              : <><i className="bi bi-plus-circle me-1"></i>Adicionar</>
            }
          </button>
        </div>
      </div>

      {/* ── Main table ── */}
      <div className="col-12 col-md-9 order-1 order-md-2">
        <div className="card p-3">
          <div className="d-flex justify-content-between mb-2">
            <h6 className="fw-bold mb-0">
              <i className="bi bi-funnel me-1"></i>Pipeline de Oportunidades
            </h6>
            <div className="d-flex gap-2">
              <button
                className="btn btn-outline-success btn-sm"
                onClick={exportCSV}
                title="Exportar CSV"
              >
                <i className="bi bi-download me-1"></i>CSV
              </button>
              <button
                className="btn btn-outline-secondary btn-sm"
                onClick={loadOpportunities}
              >
                <i className="bi bi-arrow-clockwise"></i>
              </button>
            </div>
          </div>

          <div className="table-responsive">
            <table className="table table-hover table-sm">
              <thead className="table-light">
                <tr>
                  <th
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleSort('company_name')}
                  >
                    Empresa<SortIcon field="company_name" />
                  </th>
                  <th>Oportunidade</th>
                  <th
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleSort('stage')}
                  >
                    Estágio<SortIcon field="stage" />
                  </th>
                  <th
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleSort('value')}
                  >
                    Valor<SortIcon field="value" />
                  </th>
                  <th
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleSort('created_at')}
                  >
                    Data<SortIcon field="created_at" />
                  </th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted text-center py-4">
                      Nenhuma oportunidade.
                    </td>
                  </tr>
                ) : sorted.map(o => (
                  <tr key={o.id}>
                    <td>{o.company_name || '—'}</td>
                    <td>
                      {editingId === o.id ? (
                        <span className="text-muted fst-italic">{o.name}</span>
                      ) : (
                        <button
                          className="btn btn-link btn-sm p-0 text-start"
                          title="Clique para editar estágio e valor"
                          onClick={() => startEdit(o)}
                        >
                          {o.name}
                        </button>
                      )}
                    </td>
                    <td>
                      {editingId === o.id ? (
                        <select
                          className="form-select form-select-sm"
                          style={{ minWidth: 130 }}
                          value={editStage}
                          onChange={e => setEditStage(e.target.value)}
                        >
                          {Object.entries(STAGE_LABEL).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={`badge ${STAGE_BADGE[o.stage] || 'bg-secondary'}`}>
                          {STAGE_LABEL[o.stage] || o.stage}
                        </span>
                      )}
                    </td>
                    <td>
                      {editingId === o.id ? (
                        <input
                          className="form-control form-control-sm"
                          type="number"
                          min="0"
                          step="0.01"
                          style={{ width: 110 }}
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                        />
                      ) : (
                        formatCurrency(o.value || 0)
                      )}
                    </td>
                    <td className="small text-muted">
                      {(o.created_at || '').substring(0, 10)}
                    </td>
                    <td>
                      {editingId === o.id ? (
                        <div className="d-flex gap-1">
                          <button
                            className="btn btn-success btn-sm"
                            onClick={() => saveEdit(o.id)}
                          >
                            <i className="bi bi-check"></i>
                          </button>
                          <button
                            className="btn btn-outline-secondary btn-sm"
                            onClick={cancelEdit}
                          >
                            <i className="bi bi-x"></i>
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-outline-danger btn-sm"
                          onClick={() => handleDelete(o.id)}
                        >
                          <i className="bi bi-trash"></i>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="table-light fw-bold">
                  <td colSpan={3}>Total do Pipeline (excl. perdidos)</td>
                  <td colSpan={3}>{formatCurrency(pipelineTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
