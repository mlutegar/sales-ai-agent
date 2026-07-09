import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

const API = ''

const STATUS_CONFIG = {
  pending:  { label: 'Pendente',  bg: 'warning',   icon: 'bi-clock'           },
  approved: { label: 'Aprovada',  bg: 'success',   icon: 'bi-check-circle'    },
  sent:     { label: 'Enviada',   bg: 'primary',   icon: 'bi-send-check'      },
  received: { label: 'Recebida',  bg: 'secondary', icon: 'bi-arrow-down-left' },
  paused:   { label: 'Pausada',   bg: 'dark',      icon: 'bi-pause-circle'    },
}

const SENTIMENT_CONFIG = {
  interested:         { label: '🔥 Interessado',    badge: 'success'   },
  technical_question: { label: '🤔 Dúvida técnica', badge: 'warning'   },
  negative:           { label: '👎 Negativo',         badge: 'danger'    },
  out_of_scope:       { label: '↗ Fora de escopo',  badge: 'secondary' },
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || { label: status, bg: 'secondary', icon: 'bi-circle' }
  return (
    <span className={`badge bg-${cfg.bg} d-inline-flex align-items-center gap-1`} style={{ fontSize: '.72rem' }}>
      <i className={`bi ${cfg.icon}`} />
      {cfg.label}
    </span>
  )
}

function MessageRow({ msg, onApprove, onSend, toast }) {
  const [loadingApprove, setLoadingApprove] = useState(false)
  const [loadingSend, setLoadingSend]       = useState(false)
  const [localMsg, setLocalMsg]             = useState(msg)

  async function approve() {
    setLoadingApprove(true)
    try {
      await fetch(`${API}/api/messages/${localMsg.id}/approve`, { method: 'POST' })
      setLocalMsg(m => ({ ...m, approved: 1, status: 'approved' }))
      if (onApprove) onApprove(localMsg.id)
    } catch {
      toast('Erro ao aprovar.', 'danger')
    }
    setLoadingApprove(false)
  }

  async function send() {
    setLoadingSend(true)
    try {
      await fetch(`${API}/api/messages/${localMsg.id}/send`, { method: 'POST' })
      setLocalMsg(m => ({ ...m, status: 'sent', sent: 1 }))
      if (onSend) onSend(localMsg.id)
    } catch {
      toast('Erro ao marcar como enviada.', 'danger')
    }
    setLoadingSend(false)
  }

  function copy() {
    navigator.clipboard.writeText(localMsg.content || '')
    toast('Mensagem copiada!', 'success')
  }

  async function score(n) {
    try {
      await fetch(`${API}/api/messages/${localMsg.id}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: n }),
      })
      setLocalMsg(m => ({ ...m, score: n }))
      toast(`Avaliada com ${n}★`, 'success')
    } catch {
      toast('Erro ao avaliar.', 'danger')
    }
  }

  const isInbound = localMsg.status === 'received'

  return (
    <div
      style={{
        background: isInbound ? '#f0faf4' : '#fff',
        border: `1px solid ${isInbound ? '#b7e4c7' : '#e2e8f0'}`,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 10,
      }}
    >
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        {isInbound ? (
          <span className="badge" style={{ background: '#6c757d', fontSize: '.7rem' }}>
            <i className="bi bi-person-fill me-1" />Prospect
          </span>
        ) : (
          <span className="badge" style={{ background: '#25d366', fontSize: '.7rem' }}>
            <i className="bi bi-whatsapp me-1" />
            {localMsg.msg_type === 'follow_up' ? 'Follow-up' : localMsg.msg_type || 'WhatsApp'}
            {localMsg.day ? ` · Dia ${localMsg.day}` : ''}
          </span>
        )}
        <StatusBadge status={localMsg.status} />
        {localMsg.contact_name && (
          <span className="text-muted" style={{ fontSize: '.75rem' }}>
            <i className="bi bi-person me-1" />{localMsg.contact_name}
          </span>
        )}
      </div>

      <div
        style={{
          whiteSpace: 'pre-wrap',
          fontSize: '.9rem',
          color: '#1a1a1a',
          lineHeight: 1.55,
          background: '#f8f9fa',
          borderRadius: 6,
          padding: '10px 12px',
        }}
      >
        {localMsg.content || localMsg.ai_original}
      </div>

      {!isInbound && (
        <div className="d-flex gap-2 mt-2 flex-wrap">
          {!localMsg.approved && (
            <button
              className="btn btn-sm btn-success"
              onClick={approve}
              disabled={loadingApprove}
            >
              {loadingApprove
                ? <span className="spinner-border spinner-border-sm" />
                : <><i className="bi bi-check-lg me-1" />Aprovar</>
              }
            </button>
          )}
          {localMsg.approved && localMsg.status !== 'sent' && (
            <button
              className="btn btn-sm btn-primary"
              onClick={send}
              disabled={loadingSend}
            >
              {loadingSend
                ? <span className="spinner-border spinner-border-sm" />
                : <><i className="bi bi-send me-1" />Marcar como Enviada</>
              }
            </button>
          )}
          <button className="btn btn-sm btn-outline-secondary" onClick={copy}>
            <i className="bi bi-clipboard me-1" />Copiar
          </button>
          <div className="d-flex align-items-center gap-1 ms-auto">
            <span className="text-muted me-1" style={{ fontSize: '.7rem' }}>Avaliar:</span>
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                className={`btn btn-sm py-0 px-1 ${localMsg.score === n ? 'btn-warning' : 'btn-outline-warning'}`}
                onClick={() => score(n)}
              >
                {n}★
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function CompanyWhatsApp() {
  const { companyId } = useParams()
  const navigate      = useNavigate()

  const [company,           setCompany]           = useState(null)
  const [contacts,          setContacts]           = useState([])
  const [messages,          setMessages]           = useState([])
  const [selectedContactId, setSelectedContactId] = useState('')
  const [simulateText,      setSimulateText]       = useState('')
  const [simulateTone,      setSimulateTone]       = useState('random')
  const [sentimentResult,   setSentimentResult]    = useState(null)
  const [loadingData,       setLoadingData]        = useState(true)
  const [loadingSeq,        setLoadingSeq]         = useState(false)
  const [loadingSim,        setLoadingSim]         = useState(false)
  const [loadingBot,        setLoadingBot]         = useState(false)
  const [loadingGen,        setLoadingGen]         = useState(false)
  const [autoReplyMode,     setAutoReplyMode]      = useState('off')
  const [loadingAR,         setLoadingAR]          = useState(false)
  const [error,             setError]              = useState('')

  const loadData = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/companies/${companyId}`)
      if (!res.ok) throw new Error('Empresa não encontrada')
      const data = await res.json()
      setCompany(data)
      const cts = data.contacts || []
      setContacts(cts)
      if (!selectedContactId) {
        const primary = cts.find(c => c.is_primary) || cts[0]
        if (primary) setSelectedContactId(String(primary.id))
      }
      const waMsgs = (data.messages || []).filter(m => m.channel === 'whatsapp')
      setMessages(waMsgs)

      // Carrega auto-reply mode
      const arRes  = await fetch(`${API}/api/companies/${companyId}/auto-reply`)
      const arData = await arRes.json()
      setAutoReplyMode(arData.auto_reply_mode || 'off')
    } catch (e) {
      setError(e.message)
    }
    setLoadingData(false)
  }, [companyId, selectedContactId])

  useEffect(() => { loadData() }, [companyId]) // eslint-disable-line

  async function changeAutoReply(mode) {
    setLoadingAR(true)
    try {
      await fetch(`${API}/api/companies/${companyId}/auto-reply`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_reply_mode: mode }),
      })
      setAutoReplyMode(mode)
    } catch {
      alert('Erro ao alterar modo de auto-reply.')
    }
    setLoadingAR(false)
  }

  async function generateSequence() {
    if (!selectedContactId) { alert('Selecione um contato.'); return }
    // Gerar sequência REINICIA a conversa (apaga o histórico do contato). Confirma se já há mensagens.
    if (messages.length > 0 && !window.confirm('Gerar a sequência vai REINICIAR esta conversa e apagar o histórico atual. Deseja continuar?')) return
    setLoadingSeq(true)
    setSentimentResult(null)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/sequence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContactId) }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      // Reload to get full message list including all channels (we filter to whatsapp)
      await loadData()
    } catch (e) {
      alert(e.message || 'Erro ao gerar sequência.')
    }
    setLoadingSeq(false)
  }

  async function generateProspectReply() {
    if (!selectedContactId) { alert('Selecione um contato.'); return }
    setLoadingGen(true)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/simulator/generate-prospect-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContactId), tone: simulateTone }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setSimulateText(data.generated_reply)
    } catch (e) {
      alert(e.message || 'Erro ao gerar resposta.')
    }
    setLoadingGen(false)
  }

  async function simulateBotReply() {
    if (!selectedContactId) { alert('Selecione um contato.'); return }
    setLoadingBot(true)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/simulator/bot-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContactId) }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      await loadData()
    } catch (e) {
      alert(e.message || 'Erro ao simular resposta do bot.')
    }
    setLoadingBot(false)
  }

  async function simulateResponse() {
    const text = simulateText.trim()
    if (!text) { alert('Digite a resposta do prospect.'); return }
    if (!selectedContactId) { alert('Selecione um contato.'); return }
    setLoadingSim(true)
    setSentimentResult(null)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/simulator/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_text: text, contact_id: Number(selectedContactId) }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setSentimentResult(data)
      setSimulateText('')
      // Reload messages — received message + draft will appear
      await loadData()
    } catch (e) {
      alert(e.message || 'Erro ao simular resposta.')
    }
    setLoadingSim(false)
  }

  // ── screens ────────────────────────────────────────────────────────────────
  if (loadingData) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ height: '100vh' }}>
        <div className="spinner-border text-success" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="d-flex flex-column justify-content-center align-items-center gap-3" style={{ height: '100vh' }}>
        <div className="alert alert-danger mb-0">{error}</div>
        <button className="btn btn-secondary" onClick={() => navigate(-1)}>← Voltar</button>
      </div>
    )
  }

  const sentCfg = sentimentResult ? (SENTIMENT_CONFIG[sentimentResult.sentiment] || { label: sentimentResult.sentiment, badge: 'secondary' }) : null

  return (
    <div style={{ minHeight: '100vh', background: '#f5f7fa' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          background: '#075e54',
          color: '#fff',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          boxShadow: '0 2px 6px rgba(0,0,0,.2)',
        }}
      >
        <button
          className="btn btn-sm"
          style={{ color: '#fff', border: 'none', background: 'transparent', padding: '0 4px' }}
          onClick={() => navigate(-1)}
        >
          <i className="bi bi-arrow-left fs-5" />
        </button>
        <div
          style={{
            width: 36, height: 36, borderRadius: '50%',
            background: '#25d366',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: '1rem', flexShrink: 0,
          }}
        >
          {(company?.name || '?')[0].toUpperCase()}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>{company?.name}</div>
          <div style={{ fontSize: '.75rem', opacity: .8 }}>
            {company?.sector || ''}{company?.status ? ` · ${company.status}` : ''}
          </div>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: '1.3rem', opacity: .85 }}>
          <i className="bi bi-whatsapp" />
        </span>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="container-fluid px-3 py-4" style={{ maxWidth: 1100 }}>
        <div className="row g-4">

          {/* ── LEFT: Mensagens ──────────────────────────────────────────── */}
          <div className="col-lg-7">
            <div className="d-flex align-items-center justify-content-between mb-3">
              <h6 className="fw-bold mb-0" style={{ color: '#075e54' }}>
                <i className="bi bi-whatsapp me-2" />Mensagens WhatsApp
              </h6>
              <span className="badge bg-secondary">{messages.length} mensagem{messages.length !== 1 ? 's' : ''}</span>
            </div>

            {messages.length === 0 ? (
              <div
                style={{
                  background: '#fff',
                  border: '2px dashed #d1d5db',
                  borderRadius: 12,
                  padding: '40px 20px',
                  textAlign: 'center',
                  color: '#888',
                }}
              >
                <i className="bi bi-chat-dots fs-1 d-block mb-2" style={{ color: '#25d366', opacity: .5 }} />
                <div style={{ fontSize: '.92rem' }}>Nenhuma mensagem WhatsApp ainda.</div>
                <div style={{ fontSize: '.8rem', marginTop: 4 }}>Gere a sequência na coluna ao lado.</div>
              </div>
            ) : (
              messages.map(msg => (
                <MessageRow
                  key={msg.id}
                  msg={msg}
                  toast={(msg, type) => {
                    // Simple inline toast fallback
                    console.log(`[${type}] ${msg}`)
                  }}
                />
              ))
            )}
          </div>

          {/* ── RIGHT: Ações ─────────────────────────────────────────────── */}
          <div className="col-lg-5">

            {/* Gerar Sequência */}
            <div
              style={{
                background: '#fff',
                borderRadius: 12,
                border: '1px solid #e2e8f0',
                padding: 20,
                marginBottom: 20,
              }}
            >
              <h6 className="fw-bold mb-3" style={{ color: '#075e54' }}>
                <i className="bi bi-lightning-charge me-2" />Gerar Sequência
              </h6>

              {contacts.length === 0 ? (
                <div className="alert alert-warning py-2 mb-0" style={{ fontSize: '.85rem' }}>
                  Adicione um contato à empresa antes de gerar a sequência.
                </div>
              ) : (
                <>
                  <label className="form-label fw-semibold" style={{ fontSize: '.82rem' }}>Contato</label>
                  <select
                    className="form-select form-select-sm mb-3"
                    value={selectedContactId}
                    onChange={e => setSelectedContactId(e.target.value)}
                  >
                    {contacts.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.role ? ` (${c.role})` : ''}{c.is_primary ? ' ★' : ''}
                      </option>
                    ))}
                  </select>

                  <button
                    className="btn btn-success w-100"
                    onClick={generateSequence}
                    disabled={loadingSeq}
                  >
                    {loadingSeq ? (
                      <><span className="spinner-border spinner-border-sm me-2" />Gerando sequência…</>
                    ) : (
                      <><i className="bi bi-stars me-2" />Gerar Sequência Multicanal</>
                    )}
                  </button>
                  <div className="text-muted mt-2" style={{ fontSize: '.75rem' }}>
                    Gera mensagens para LinkedIn (Dia 1), E-mail (Dia 3) e WhatsApp (Dia 5).
                  </div>
                </>
              )}
            </div>

            {/* Auto-reply */}
            <div
              style={{
                background: '#fff',
                borderRadius: 12,
                border: '1px solid #e2e8f0',
                padding: 20,
                marginBottom: 20,
              }}
            >
              <h6 className="fw-bold mb-1" style={{ color: '#075e54' }}>
                <i className="bi bi-robot me-2" />Bot Auto-reply
              </h6>
              <div className="text-muted mb-3" style={{ fontSize: '.75rem' }}>
                Quando ativado, o bot responde automaticamente às mensagens recebidas via WhatsApp.
                Pedidos de reunião sempre vão para confirmação manual.
              </div>

              <div className="d-flex flex-column gap-2">
                {[
                  { value: 'off',            icon: 'bi-slash-circle',   label: 'Desativado',                    desc: 'Todas as respostas ficam para você revisar' },
                  { value: 'except_meeting', icon: 'bi-robot',          label: 'Bot ativo (exceto reuniões)',    desc: 'Bot responde tudo, mas pede de reunião → você confirma' },
                  { value: 'all',            icon: 'bi-lightning-charge',label: 'Bot ativo (tudo automático)',   desc: 'Bot responde todas as mensagens incluindo dúvidas técnicas' },
                ].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => !loadingAR && changeAutoReply(opt.value)}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: `2px solid ${autoReplyMode === opt.value ? '#075e54' : '#e2e8f0'}`,
                      background: autoReplyMode === opt.value ? '#f0faf4' : '#fafafa',
                      cursor: loadingAR ? 'wait' : 'pointer',
                      transition: 'all .15s',
                    }}
                  >
                    <div className="d-flex align-items-center gap-2">
                      <i
                        className={`bi ${opt.icon}`}
                        style={{ color: autoReplyMode === opt.value ? '#075e54' : '#888', fontSize: '1rem' }}
                      />
                      <span className="fw-semibold" style={{ fontSize: '.85rem' }}>{opt.label}</span>
                      {autoReplyMode === opt.value && (
                        <i className="bi bi-check-circle-fill ms-auto" style={{ color: '#075e54' }} />
                      )}
                    </div>
                    <div style={{ fontSize: '.76rem', color: '#666', marginTop: 2, paddingLeft: 22 }}>
                      {opt.desc}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Simular Resposta */}
            <div
              style={{
                background: '#fff',
                borderRadius: 12,
                border: '1px solid #e2e8f0',
                padding: 20,
              }}
            >
              <h6 className="fw-bold mb-1" style={{ color: '#444' }}>
                <i className="bi bi-flask me-2" />Simulador de conversa (treino)
              </h6>
              <div className="text-muted mb-3" style={{ fontSize: '.75rem' }}>
                Ferramenta de desenvolvimento — encene a conversa: primeiro o cliente responde,
                depois a IA responde para você avaliar.
              </div>

              {/* ── Passo 1: o cliente responde ────────────────────────── */}
              <div
                style={{
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 14,
                }}
              >
                <div className="fw-semibold mb-2" style={{ fontSize: '.82rem', color: '#166534' }}>
                  <i className="bi bi-person-fill me-1" />Passo 1 — O cliente responde
                </div>

              {/* Tom + botão Gerar com IA */}
              <div className="d-flex gap-2 mb-2">
                <select
                  className="form-select form-select-sm"
                  value={simulateTone}
                  onChange={e => setSimulateTone(e.target.value)}
                  disabled={loadingGen || loadingSim}
                  style={{ flex: 1 }}
                >
                  <option value="random">🎲 Tom aleatório</option>
                  <option value="interested">🔥 Interessado</option>
                  <option value="skeptical">🤔 Cético / dúvida técnica</option>
                  <option value="negative">👎 Sem interesse</option>
                </select>
                <button
                  className="btn btn-sm btn-outline-primary"
                  onClick={generateProspectReply}
                  disabled={loadingGen || loadingSim}
                  title="Gerar resposta realista do prospect via IA"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {loadingGen
                    ? <span className="spinner-border spinner-border-sm" />
                    : <><i className="bi bi-stars me-1" />Gerar com IA</>
                  }
                </button>
              </div>

              <textarea
                className="form-control mb-2"
                rows={3}
                placeholder="Escreva (ou gere com IA) o que o CLIENTE diria…"
                value={simulateText}
                onChange={e => setSimulateText(e.target.value)}
                disabled={loadingSim || loadingGen}
                style={{ fontSize: '.88rem', resize: 'vertical' }}
              />

              <button
                className="btn btn-success w-100"
                onClick={simulateResponse}
                disabled={loadingSim || loadingGen || !simulateText.trim()}
                title="Registra esta fala como mensagem recebida do cliente e classifica o sentimento"
              >
                {loadingSim ? (
                  <><span className="spinner-border spinner-border-sm me-2" />Analisando sentimento…</>
                ) : (
                  <><i className="bi bi-person-fill me-2" />Enviar como cliente</>
                )}
              </button>
              </div>

              {/* ── Passo 2: a IA responde ─────────────────────────────── */}
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 10,
                  padding: '12px 14px',
                }}
              >
                <div className="fw-semibold mb-1" style={{ fontSize: '.82rem', color: '#334155' }}>
                  <i className="bi bi-robot me-1" />Passo 2 — A IA responde ao cliente
                </div>
                <div className="text-muted mb-2" style={{ fontSize: '.72rem' }}>
                  Gera um rascunho da resposta do vendedor à última fala do cliente — fica
                  pendente para você avaliar (não envia).
                </div>

                <button
                  className="btn btn-dark w-100"
                  onClick={simulateBotReply}
                  disabled={loadingBot || loadingSim || loadingGen}
                  title="Gera e adiciona a resposta da IA à última mensagem recebida — sem apagar o histórico"
                >
                  {loadingBot ? (
                    <><span className="spinner-border spinner-border-sm me-2" />Gerando resposta da IA…</>
                  ) : (
                    <><i className="bi bi-robot me-2" />Gerar resposta da IA</>
                  )}
                </button>
              </div>

              {/* Resultado do sentimento */}
              {sentimentResult && sentCfg && (
                <div
                  style={{
                    marginTop: 14,
                    background: '#f8f9fa',
                    borderRadius: 8,
                    padding: '12px 14px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div className="d-flex align-items-center gap-2 mb-1">
                    <span className="fw-semibold" style={{ fontSize: '.82rem' }}>Sentimento:</span>
                    <span className={`badge bg-${sentCfg.badge}`}>{sentCfg.label}</span>
                    {sentimentResult.interest_score !== undefined && (
                      <span className="badge bg-info">Score {sentimentResult.interest_score}/10</span>
                    )}
                  </div>
                  <div className="text-muted" style={{ fontSize: '.78rem' }}>
                    As mensagens acima foram atualizadas com a resposta recebida e o draft gerado.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
