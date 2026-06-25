import React, { useState, useEffect } from 'react'
import { api, esc } from '../api.js'

export default function LGPD({ toast }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)

  const loadConsentLogs = async () => {
    setLoading(true)
    try {
      const data = await api('/api/consent-logs')
      setLogs(data || [])
    } catch (e) {
      toast('Erro ao carregar logs de consentimento', 'danger')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConsentLogs()
  }, [])

  const actionBadge = {
    company_added: 'bg-secondary', 
    contact_added: 'bg-info text-dark',
    contacted: 'bg-primary', 
    meeting_booked: 'bg-success',
    opted_out: 'bg-danger',
  }

  return (
    <div className="tab-container">
      <div id="tab-lgpd">
        <div className="card p-3">
          <div className="d-flex justify-content-between mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-shield-lock me-1"></i>Logs de Consentimento LGPD</h6>
            <button className="btn btn-outline-secondary btn-sm" onClick={loadConsentLogs}>
              <i className="bi bi-arrow-clockwise"></i>
            </button>
          </div>
          
          <div className="table-responsive">
            <table className="table table-sm table-hover align-middle">
              <thead className="table-light">
                <tr>
                  <th>Data</th>
                  <th>Empresa</th>
                  <th>Contato</th>
                  <th>Ação</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="5" className="text-center text-muted small py-3">Carregando...</td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="text-center text-muted small py-3">Nenhum log encontrado.</td>
                  </tr>
                ) : (
                  logs.map(l => (
                    <tr key={l.id}>
                      <td className="small">{l.created_at}</td>
                      <td>{esc(l.company_name || '—')}</td>
                      <td>{esc(l.contact_name || '—')}</td>
                      <td>
                        <span className={`badge ${actionBadge[l.action] || 'bg-secondary'}`}>
                          {l.action}
                        </span>
                      </td>
                      <td className="small">{esc(l.details)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          
        </div>
      </div>
    </div>
  )
}
