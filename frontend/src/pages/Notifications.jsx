import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

const API = ''

const TYPE_CONFIG = {
  meeting_request: { icon: 'bi-calendar-event-fill', color: '#0d6efd', bg: '#e7f1ff', label: 'Quer reunião' },
  message:         { icon: 'bi-chat-dots-fill',       color: '#25d366', bg: '#f0faf4', label: 'Resposta' },
  sentiment_alert: { icon: 'bi-exclamation-circle-fill', color: '#dc3545', bg: '#fdf2f2', label: 'Alerta' },
}

const SLOTS_LABEL = dt =>
  new Date(dt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

function MeetingConfirmModal({ notif, onClose, onConfirmed, toast }) {
  const [slots,    setSlots]    = useState([])
  const [selected, setSelected] = useState('')
  const [loading,  setLoading]  = useState(false)

  useEffect(() => {
    fetch(`${API}/api/schedule/slots`)
      .then(r => r.json())
      .then(data => setSlots((data || []).filter(s => !s.booked)))
      .catch(() => {})
  }, [])

  async function confirm() {
    if (!selected) { alert('Selecione um horário.'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/notifications/${notif.id}/confirm-meeting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_id: Number(selected) }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      toast(`✅ Reunião marcada para ${SLOTS_LABEL(data.date_time)}! Confirmação enviada via WhatsApp.`, 'success')
      onConfirmed()
    } catch (e) {
      toast(e.message || 'Erro ao confirmar reunião.', 'danger')
    }
    setLoading(false)
  }

  return (
    <div
      className="modal d-block"
      style={{ background: 'rgba(0,0,0,.45)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header" style={{ borderBottom: '1px solid #e2e8f0' }}>
            <h5 className="modal-title fw-bold">
              <i className="bi bi-calendar-check me-2 text-primary" />
              Confirmar Reunião
            </h5>
            <button className="btn-close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <div className="mb-3 p-3 rounded" style={{ background: '#f0faf4', border: '1px solid #b7e4c7' }}>
              <div className="fw-semibold" style={{ fontSize: '.9rem' }}>{notif.company_name}</div>
              <div className="text-muted" style={{ fontSize: '.82rem' }}>{notif.contact_name}</div>
              <div className="mt-2" style={{ fontSize: '.88rem', fontStyle: 'italic' }}>"{notif.body}"</div>
            </div>

            {slots.length === 0 ? (
              <div className="alert alert-warning py-2" style={{ fontSize: '.85rem' }}>
                Nenhum horário disponível. Crie horários na aba <strong>Agenda</strong> primeiro.
              </div>
            ) : (
              <>
                <label className="form-label fw-semibold" style={{ fontSize: '.85rem' }}>
                  Escolha o horário disponível:
                </label>
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {slots.map(s => (
                    <div
                      key={s.id}
                      onClick={() => setSelected(String(s.id))}
                      style={{
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: `2px solid ${selected === String(s.id) ? '#0d6efd' : '#e2e8f0'}`,
                        background: selected === String(s.id) ? '#e7f1ff' : '#fff',
                        cursor: 'pointer',
                        marginBottom: 8,
                        transition: 'all .15s',
                      }}
                    >
                      <div className="fw-semibold" style={{ fontSize: '.9rem' }}>
                        <i className="bi bi-clock me-2 text-primary" />
                        {SLOTS_LABEL(s.date_time)}
                      </div>
                      <div className="text-muted" style={{ fontSize: '.78rem' }}>
                        {s.duration_min} min
                        {s.meeting_link ? ` · ${s.meeting_link}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="modal-footer" style={{ borderTop: '1px solid #e2e8f0' }}>
            <button className="btn btn-outline-secondary btn-sm" onClick={onClose}>Cancelar</button>
            <button
              className="btn btn-primary btn-sm"
              onClick={confirm}
              disabled={loading || !selected || slots.length === 0}
            >
              {loading
                ? <><span className="spinner-border spinner-border-sm me-1" />Confirmando…</>
                : <><i className="bi bi-check-lg me-1" />Confirmar e enviar WhatsApp</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Notifications({ toast, onUnreadChange }) {
  const navigate = useNavigate()

  const [notifications, setNotifications] = useState([])
  const [unread,        setUnread]        = useState(0)
  const [loading,       setLoading]       = useState(true)
  const [meetingNotif,  setMeetingNotif]  = useState(null)  // notif aberta no modal

  const load = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/notifications`)
      const data = await res.json()
      setNotifications(data.notifications || [])
      setUnread(data.unread || 0)
      if (onUnreadChange) onUnreadChange(data.unread || 0)
    } catch {}
    setLoading(false)
  }, [onUnreadChange])

  useEffect(() => { load() }, [load])

  async function markRead(id) {
    await fetch(`${API}/api/notifications/${id}/read`, { method: 'POST' })
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: 1 } : n))
    setUnread(prev => Math.max(0, prev - 1))
    if (onUnreadChange) onUnreadChange(Math.max(0, unread - 1))
  }

  async function markAllRead() {
    await fetch(`${API}/api/notifications/read-all`, { method: 'POST' })
    setNotifications(prev => prev.map(n => ({ ...n, read: 1 })))
    setUnread(0)
    if (onUnreadChange) onUnreadChange(0)
  }

  function openNotif(notif) {
    if (!notif.read) markRead(notif.id)
    if (notif.type === 'meeting_request') {
      setMeetingNotif(notif)
    } else {
      // Abre a aba WhatsApp na conversa desse cliente (com o histórico todo), não a tela antiga.
      navigate('/whatsapp', { state: { companyId: notif.company_id, contactId: notif.contact_id } })
    }
  }

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <div className="spinner-border text-primary" />
      </div>
    )
  }

  return (
    <>
      {meetingNotif && (
        <MeetingConfirmModal
          notif={meetingNotif}
          toast={toast}
          onClose={() => setMeetingNotif(null)}
          onConfirmed={() => { setMeetingNotif(null); load() }}
        />
      )}

      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div className="d-flex align-items-center justify-content-between mb-3">
          <h5 className="fw-bold mb-0">
            <i className="bi bi-bell-fill me-2" style={{ color: '#6c63ff' }} />
            Notificações
            {unread > 0 && (
              <span className="badge bg-danger rounded-pill ms-2" style={{ fontSize: '.75rem' }}>
                {unread} nova{unread !== 1 ? 's' : ''}
              </span>
            )}
          </h5>
          {unread > 0 && (
            <button className="btn btn-sm btn-outline-secondary" onClick={markAllRead}>
              <i className="bi bi-check2-all me-1" />Marcar todas como lidas
            </button>
          )}
        </div>

        {notifications.length === 0 ? (
          <div
            style={{
              background: '#fff',
              border: '2px dashed #d1d5db',
              borderRadius: 12,
              padding: '48px 20px',
              textAlign: 'center',
              color: '#888',
            }}
          >
            <i className="bi bi-bell-slash fs-1 d-block mb-2" style={{ opacity: .35 }} />
            <div>Nenhuma notificação ainda.</div>
            <div style={{ fontSize: '.82rem', marginTop: 4 }}>As respostas dos prospects aparecerão aqui.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {notifications.map(n => {
              const cfg = TYPE_CONFIG[n.type] || TYPE_CONFIG.message
              return (
                <div
                  key={n.id}
                  style={{
                    background: n.read ? '#fff' : cfg.bg,
                    border: `1px solid ${n.read ? '#e2e8f0' : cfg.color + '44'}`,
                    borderLeft: `4px solid ${n.read ? '#d1d5db' : cfg.color}`,
                    borderRadius: 10,
                    padding: '14px 16px',
                    cursor: 'pointer',
                    transition: 'box-shadow .15s',
                  }}
                  onClick={() => openNotif(n)}
                  onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,.1)'}
                  onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
                >
                  <div className="d-flex align-items-start gap-3">
                    <div
                      style={{
                        width: 36, height: 36, borderRadius: '50%',
                        background: cfg.color + '22',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <i className={`bi ${cfg.icon}`} style={{ color: cfg.color, fontSize: '1.1rem' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="d-flex align-items-center gap-2 flex-wrap">
                        <span className="fw-semibold" style={{ fontSize: '.9rem' }}>{n.title}</span>
                        {!n.read && (
                          <span
                            style={{
                              width: 8, height: 8, borderRadius: '50%',
                              background: cfg.color, display: 'inline-block',
                            }}
                          />
                        )}
                      </div>
                      {n.body && (
                        <div
                          style={{
                            fontSize: '.82rem', color: '#555', marginTop: 2,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          "{n.body}"
                        </div>
                      )}
                      <div className="d-flex align-items-center gap-3 mt-2 flex-wrap">
                        <span className="text-muted" style={{ fontSize: '.74rem' }}>
                          <i className="bi bi-clock me-1" />
                          {new Date(n.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                        {n.company_name && (
                          <span className="text-muted" style={{ fontSize: '.74rem' }}>
                            <i className="bi bi-building me-1" />{n.company_name}
                          </span>
                        )}
                        {n.contact_name && (
                          <span className="text-muted" style={{ fontSize: '.74rem' }}>
                            <i className="bi bi-person me-1" />{n.contact_name}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="d-flex flex-column align-items-end gap-1 flex-shrink-0">
                      {n.type === 'meeting_request' && (
                        <span
                          className="badge bg-primary"
                          style={{ fontSize: '.72rem', cursor: 'pointer' }}
                          onClick={e => { e.stopPropagation(); openNotif(n) }}
                        >
                          <i className="bi bi-calendar-plus me-1" />Confirmar reunião
                        </span>
                      )}
                      <span
                        className="badge"
                        style={{ background: cfg.color + '22', color: cfg.color, fontSize: '.7rem' }}
                      >
                        {cfg.label}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
