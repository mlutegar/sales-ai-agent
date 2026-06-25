import React, { useState, useEffect } from 'react'
import { api, esc } from '../api.js'

export default function Agenda({ toast, loadStats }) {
  const [slots, setSlots] = useState([])
  const [date, setDate] = useState('')
  const [duration, setDuration] = useState('15')
  const [link, setLink] = useState('')

  const loadSlots = async () => {
    try {
      const data = await api('/api/schedule/slots')
      setSlots(data || [])
    } catch (e) {
      toast('Erro ao carregar agenda', 'danger')
    }
  }

  useEffect(() => {
    loadSlots()
  }, [])

  const addSlot = async () => {
    if (!date) {
      toast('Selecione data e hora', 'warning')
      return
    }
    try {
      await api('/api/schedule/slots', 'POST', {
        date_time: date,
        duration_min: parseInt(duration),
        meeting_link: link.trim(),
      })
      setDate('')
      setLink('')
      toast('Slot adicionado!', 'success')
      loadSlots()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao adicionar slot', 'danger')
    }
  }

  const delSlot = async (id) => {
    try {
      await api(`/api/schedule/slots/${id}`, 'DELETE')
      toast('Slot removido', 'warning')
      loadSlots()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao remover slot', 'danger')
    }
  }

  return (
    <div className="tab-container">
      <div id="tab-agenda">
        <div className="row g-3">
          
          <div className="col-md-4">
            <div className="card p-3">
              <h6 className="fw-bold mb-3"><i className="bi bi-calendar-plus me-1"></i>Novo Horário Disponível</h6>
              <div className="mb-2">
                <input 
                  className="form-control form-control-sm" 
                  type="datetime-local" 
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="mb-2">
                <select 
                  className="form-select form-select-sm" 
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                >
                  <option value="15">15 minutos</option>
                  <option value="30">30 minutos</option>
                  <option value="60">1 hora</option>
                </select>
              </div>
              <div className="mb-3">
                <input 
                  className="form-control form-control-sm" 
                  placeholder="Link da reunião (Meet, Zoom...)" 
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                />
              </div>
              <button className="btn btn-success btn-sm w-100" onClick={addSlot}>
                <i className="bi bi-plus-circle me-1"></i>Adicionar Slot
              </button>
              <hr />
              <p className="small text-muted mb-0">
                <i className="bi bi-info-circle me-1"></i>
                Integração com Calendly/Google Calendar requer configuração de API externa — não implementada neste protótipo.
              </p>
            </div>
          </div>
          
          <div className="col-md-8">
            <div className="card p-3">
              <div className="d-flex justify-content-between mb-2">
                <h6 className="fw-bold mb-0">Slots de Agenda</h6>
                <button className="btn btn-outline-secondary btn-sm" onClick={loadSlots}>
                  <i className="bi bi-arrow-clockwise"></i>
                </button>
              </div>
              
              <div>
                {slots.length > 0 ? (
                  <div className="table-responsive">
                    <table className="table table-sm table-hover align-middle">
                      <thead className="table-light">
                        <tr>
                          <th>Data/Hora</th>
                          <th>Duração</th>
                          <th>Status</th>
                          <th>Empresa</th>
                          <th>Contato</th>
                          <th>Link</th>
                          <th>Ação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slots.map(s => (
                          <tr key={s.id}>
                            <td>{s.date_time}</td>
                            <td>{s.duration_min} min</td>
                            <td>
                              {s.booked ? (
                                <span className="badge bg-success">Agendado</span>
                              ) : (
                                <span className="badge bg-secondary">Disponível</span>
                              )}
                            </td>
                            <td>{s.company_name ? esc(s.company_name) : '—'}</td>
                            <td>{s.contact_name ? esc(s.contact_name) : '—'}</td>
                            <td>
                              {s.meeting_link ? (
                                <a href={esc(s.meeting_link)} target="_blank" rel="noreferrer" className="small">Abrir</a>
                              ) : '—'}
                            </td>
                            <td>
                              <button className="btn btn-outline-danger btn-sm" onClick={() => delSlot(s.id)}>
                                <i className="bi bi-trash"></i>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted small">Nenhum slot cadastrado.</p>
                )}
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  )
}
