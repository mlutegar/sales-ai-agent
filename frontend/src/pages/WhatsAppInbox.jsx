import React, { useState, useEffect, useCallback, useRef } from 'react'

const API = ''

// Cargo do contato: o texto original da planilha (title) ou um rótulo legível da categoria
const ROLE_LABEL = { c_level: 'C-Level / Diretor', manager: 'Gerente / Coordenador', engineer: 'Engenheiro / TI', other: 'Outro' }
const cargoDe = (c) => (c && c.title && c.title.trim()) ? c.title : (ROLE_LABEL[c?.role] || c?.role || '')

const SLOTS_LABEL = dt =>
  new Date(dt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

function MeetingModal({ companyId, contactId, companyName, contactName, toast, onClose, onBooked }) {
  const [dateTime,    setDateTime]    = useState('')
  const [duration,    setDuration]    = useState(30)
  const [meetingLink, setMeetingLink] = useState('')
  const [loading,     setLoading]     = useState(false)

  // pré-preenche com a próxima hora cheia
  useEffect(() => {
    const d = new Date()
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() + 1)
    // formato datetime-local: YYYY-MM-DDTHH:MM
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16)
    setDateTime(local)
  }, [])

  async function confirm() {
    if (!dateTime) { alert('Escolha a data e hora.'); return }
    setLoading(true)
    try {
      // Cria o slot já reservado diretamente
      const res  = await fetch(`${API}/api/schedule/slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_time:    dateTime,
          duration_min: duration,
          meeting_link: meetingLink,
          company_id:   companyId,
          contact_id:   contactId,
          booked:       1,
        }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      // Atualiza status da empresa para meeting_set
      await fetch(`${API}/api/companies/${companyId}/auto-reply`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_reply_mode: 'off' }),
      })

      toast(`✅ Reunião marcada para ${SLOTS_LABEL(dateTime)}!`, 'success')
      onBooked()
    } catch (e) {
      toast(e.message || 'Erro ao marcar reunião.', 'danger')
    }
    setLoading(false)
  }

  return (
    <div
      className="modal d-block"
      style={{ background: 'rgba(0,0,0,.45)', zIndex: 1050 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title fw-bold">
              <i className="bi bi-calendar-check me-2 text-success" />Marcar Reunião
            </h5>
            <button className="btn-close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <div className="mb-3 p-3 rounded" style={{ background: '#f0faf4', border: '1px solid #b7e4c7' }}>
              <div className="fw-semibold" style={{ fontSize: '.9rem' }}>{companyName}</div>
              {contactName && <div className="text-muted" style={{ fontSize: '.82rem' }}>{contactName}</div>}
            </div>

            <div className="mb-3">
              <label className="form-label fw-semibold" style={{ fontSize: '.85rem' }}>
                <i className="bi bi-calendar-event me-1" />Data e hora
              </label>
              <input
                type="datetime-local"
                className="form-control"
                value={dateTime}
                onChange={e => setDateTime(e.target.value)}
              />
            </div>

            <div className="mb-3">
              <label className="form-label fw-semibold" style={{ fontSize: '.85rem' }}>
                <i className="bi bi-clock me-1" />Duração (minutos)
              </label>
              <select
                className="form-select"
                value={duration}
                onChange={e => setDuration(Number(e.target.value))}
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>1 hora</option>
              </select>
            </div>

            <div className="mb-1">
              <label className="form-label fw-semibold" style={{ fontSize: '.85rem' }}>
                <i className="bi bi-camera-video me-1" />Link da reunião (opcional)
              </label>
              <input
                type="url"
                className="form-control"
                placeholder="https://meet.google.com/..."
                value={meetingLink}
                onChange={e => setMeetingLink(e.target.value)}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-outline-secondary btn-sm" onClick={onClose}>Cancelar</button>
            <button
              className="btn btn-success btn-sm"
              onClick={confirm}
              disabled={loading || !dateTime}
            >
              {loading
                ? <><span className="spinner-border spinner-border-sm me-1" />Marcando…</>
                : <><i className="bi bi-check-lg me-1" />Confirmar reunião</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const STATUS_CFG = {
  pending:  { label: 'Pendente',  bg: 'warning',   icon: 'bi-clock'            },
  approved: { label: 'Aprovada',  bg: 'success',   icon: 'bi-check-circle'     },
  sent:     { label: 'Enviada',   bg: 'primary',   icon: 'bi-send-check'       },
  received: { label: 'Recebida',  bg: 'secondary', icon: 'bi-arrow-down-left'  },
  paused:   { label: 'Pausada',   bg: 'dark',      icon: 'bi-pause-circle'     },
}

const SENTIMENT_CFG = {
  interested:         { label: '🔥 Interessado',    badge: 'success'   },
  technical_question: { label: '🤔 Dúvida técnica', badge: 'warning'   },
  negative:           { label: '👎 Negativo',        badge: 'danger'    },
  out_of_scope:       { label: '↗ Fora de escopo',  badge: 'secondary' },
  wants_meeting:      { label: '📅 Quer reunião',   badge: 'primary'   },
}

const AR_LABELS = {
  off:            { label: 'Bot off',             color: '#6c757d' },
  except_meeting: { label: 'Bot ativo',           color: '#25d366' },
  all:            { label: 'Bot total',           color: '#0d6efd' },
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'agora'
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ── Painel de contexto do lead (ao lado da conversa) ───────────────────────────
function LeadContextPanel({ contactId, contactName, initialContext, toast }) {
  const [savedCtx, setSavedCtx] = useState(initialContext || '')
  const [ctx, setCtx]           = useState(initialContext || '')
  const [open, setOpen]         = useState(false)
  const [saving, setSaving]     = useState(false)
  const hasContext = !!(savedCtx && savedCtx.trim())

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`${API}/api/contacts/${contactId}/context`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctx }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setSavedCtx(ctx)
      setOpen(false)
      toast('Contexto do lead salvo!', 'success')
    } catch (e) { toast(e.message || 'Erro ao salvar contexto', 'danger') }
    setSaving(false)
  }

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
      <div className="fw-semibold mb-2" style={{ fontSize: '.82rem', color: '#075e54' }}>
        <i className="bi bi-person-lines-fill me-1" />Contexto do lead
      </div>
      {!open && (
        <>
          {hasContext ? (
            <div style={{ fontSize: '.76rem', color: '#444', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', background: '#f8f9fa', border: '1px solid #eee', borderRadius: 6, padding: 8 }}>
              {savedCtx}
            </div>
          ) : (
            <div style={{ fontSize: '.76rem', color: '#999' }}>Sem contexto ainda para este lead.</div>
          )}
          <button className="btn btn-outline-primary btn-sm w-100 mt-2" style={{ fontSize: '.75rem' }} onClick={() => { setCtx(savedCtx); setOpen(true) }}>
            <i className={`bi ${hasContext ? 'bi-pencil' : 'bi-plus-lg'} me-1`} />{hasContext ? 'Editar contexto' : 'Adicionar contexto'}
          </button>
        </>
      )}
      {open && (
        <>
          <textarea
            className="form-control form-control-sm"
            rows={5}
            placeholder="Quem é essa pessoa, como falar com ela, o que importa pra ela... (personaliza o gancho e ajuda a lembrar quem é o lead)"
            value={ctx}
            onChange={e => setCtx(e.target.value)}
            style={{ fontSize: '.78rem' }}
          />
          <div className="d-flex gap-2 mt-1">
            <button className="btn btn-primary btn-sm" style={{ fontSize: '.72rem' }} onClick={save} disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button className="btn btn-outline-secondary btn-sm" style={{ fontSize: '.72rem' }} onClick={() => { setCtx(savedCtx); setOpen(false) }} disabled={saving}>
              Cancelar
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Chat panel ────────────────────────────────────────────────────────────────
function ChatPanel({ companyId, initialContactId, onEditMessage, toast }) {
  const [data,            setData]            = useState(null)
  const [simulateText,    setSimulateText]    = useState('')
  const [simulateTone,    setSimulateTone]    = useState('random')
  const [sentimentResult, setSentimentResult] = useState(null)
  const [autoReplyMode,   setAutoReplyMode]   = useState('off')
  const [selectedContact, setSelectedContact] = useState(initialContactId ? String(initialContactId) : '')
  const [product,     setProduct]     = useState('')
  const [hook,        setHook]        = useState('')
  const [loadingHook, setLoadingHook] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [sending,     setSending]     = useState(false)
  const [regenId,     setRegenId]     = useState(null)
  const [loadingSeq,      setLoadingSeq]      = useState(false)
  const [loadingSim,      setLoadingSim]      = useState(false)
  const [loadingBot,      setLoadingBot]      = useState(false)
  const [loadingGen,      setLoadingGen]      = useState(false)
  const [loadingAR,       setLoadingAR]       = useState(false)
  const [showMeeting,     setShowMeeting]     = useState(false)
  const [commentFor,      setCommentFor]      = useState(null)
  const [commentText,     setCommentText]     = useState('')
  const [commentChannelOnly, setCommentChannelOnly] = useState(false)
  const bottomRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/whatsapp/${companyId}/messages`)
      const d    = await res.json()
      setData(d)
      const cts = d.contacts || []
      if (!selectedContact) {
        const primary = cts.find(c => c.is_primary) || cts[0]
        if (primary) setSelectedContact(String(primary.id))
      }
      setAutoReplyMode(d.company?.auto_reply_mode || 'off')
    } catch {}
  }, [companyId, selectedContact])

  useEffect(() => {
    setData(null)
    setSentimentResult(null)
    setSimulateText('')
    setSelectedContact(initialContactId ? String(initialContactId) : '')
    setHook('')
    load()
  }, [companyId]) // eslint-disable-line

  useEffect(() => {
    // Rola só o container das mensagens (nunca a página) — evita o "pulo" ao abrir a aba.
    setTimeout(() => {
      const el = bottomRef.current?.parentElement
      if (el) el.scrollTop = el.scrollHeight
    }, 80)
  }, [data?.messages?.length])

  async function approve(msgId) {
    await fetch(`${API}/api/messages/${msgId}/approve`, { method: 'POST' })
    load()
  }
  async function markSent(msgId) {
    await fetch(`${API}/api/messages/${msgId}/send`, { method: 'POST' })
    load()
  }
  function copy(text) {
    navigator.clipboard.writeText(text || '')
    toast('Copiado!', 'success')
  }
  async function saveFeedback(msgId, patch) {
    try {
      await fetch(`${API}/api/messages/${msgId}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      setData(d => ({ ...d, messages: (d?.messages || []).map(m => m.id === msgId ? { ...m, ...patch, score_comment: patch.comment !== undefined ? patch.comment : m.score_comment } : m) }))
      return true
    } catch {
      toast('Erro ao salvar avaliação.', 'danger')
      return false
    }
  }
  async function scoreMessage(msgId, n) {
    if (await saveFeedback(msgId, { score: n })) toast(n >= 4 ? '👍 Marcada como boa' : '👎 Marcada como ruim', 'success')
  }

  // 👎 = marca como ruim E abre a caixa de observação (o motivo alimenta o aprendizado).
  function thumbsDown(msg) {
    scoreMessage(msg.id, 1)
    openComment(msg)
  }

  // "Gerar de novo": reescreve usando a observação (se houver) + o que a IA aprendeu.
  async function regenerate(msg) {
    setRegenId(msg.id)
    try {
      const res = await fetch(`${API}/api/messages/${msg.id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observation: msg.score_comment || '' }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      await load()
      toast(msg.score_comment ? 'Regerada com a sua observação.' : 'Regerada numa versão diferente.', 'success')
    } catch (e) { toast(e.message || 'Erro ao gerar de novo.', 'danger') }
    setRegenId(null)
  }
  function openComment(msg) {
    setCommentFor(msg.id)
    setCommentText(msg.score_comment || '')
    setCommentChannelOnly((msg.comment_scope && msg.comment_scope !== 'global'))
  }
  async function saveComment(msgId) {
    const scope = commentChannelOnly ? 'channel' : 'global'
    if (await saveFeedback(msgId, { comment: commentText, scope })) {
      toast('Comentário salvo.', 'success')
      setCommentFor(null)
      setCommentText('')
    }
  }

  async function generateSequence() {
    if (!selectedContact) { toast('Selecione um contato.', 'warning'); return }
    // Gerar sequência REINICIA a conversa (apaga o histórico do contato). Confirma se já há mensagens.
    if (messages.length > 0 && !window.confirm('Gerar a sequência vai REINICIAR esta conversa e apagar o histórico atual. Deseja continuar?')) return
    setLoadingSeq(true)
    setSentimentResult(null)
    try {
      const res  = await fetch(`${API}/api/companies/${companyId}/sequence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContact) }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      await load()
      toast('Sequência gerada!', 'success')
    } catch (e) { toast(e.message || 'Erro ao gerar sequência.', 'danger') }
    setLoadingSeq(false)
  }

  async function sendMessage() {
    if (!composeText.trim()) { toast('Escreva a mensagem.', 'warning'); return }
    if (!selectedContact) { toast('Selecione um contato.', 'warning'); return }
    setSending(true)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContact), content: composeText.trim() }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setComposeText('')
      await load()
    } catch (e) { toast(e.message || 'Erro ao enviar mensagem.', 'danger') }
    setSending(false)
  }

  async function generateHook() {
    if (!selectedContact) { toast('Selecione um contato.', 'warning'); return }
    if (!product.trim()) { toast('Informe o produto.', 'warning'); return }
    setLoadingHook(true)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_value: product, contact_id: Number(selectedContact) }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      // Cria a mensagem como RASCUNHO PENDENTE na conversa — avaliável/editável antes de enviar.
      const mres = await fetch(`${API}/api/companies/${companyId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContact), content: d.hook || '', status: 'pending' }),
      })
      const md = await mres.json()
      if (md.error) throw new Error(md.error)
      await load()
      toast('Gancho gerado como rascunho — avalie (👍/👎), edite se precisar e clique "Aprovar" para enviar.', 'success')
    } catch (e) { toast(e.message || 'Erro ao gerar gancho.', 'danger') }
    setLoadingHook(false)
  }

  async function generateProspectReply() {
    if (!selectedContact) { toast('Selecione um contato.', 'warning'); return }
    setLoadingGen(true)
    try {
      const res  = await fetch(`${API}/api/companies/${companyId}/simulator/generate-prospect-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContact), tone: simulateTone }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setSimulateText(d.generated_reply)
    } catch (e) { toast(e.message || 'Erro ao gerar.', 'danger') }
    setLoadingGen(false)
  }

  async function simulateResponse() {
    if (!simulateText.trim()) { toast('Digite ou gere a resposta.', 'warning'); return }
    if (!selectedContact) { toast('Selecione um contato.', 'warning'); return }
    setLoadingSim(true)
    setSentimentResult(null)
    try {
      const res  = await fetch(`${API}/api/companies/${companyId}/simulator/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_text: simulateText.trim(), contact_id: Number(selectedContact) }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setSentimentResult(d)
      setSimulateText('')
      await load()
    } catch (e) { toast(e.message || 'Erro ao simular.', 'danger') }
    setLoadingSim(false)
  }

  async function simulateBotReply() {
    if (!selectedContact) { toast('Selecione um contato.', 'warning'); return }
    setLoadingBot(true)
    try {
      const res  = await fetch(`${API}/api/companies/${companyId}/simulator/bot-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(selectedContact) }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      await load()
      toast('Resposta do bot adicionada.', 'success')
    } catch (e) { toast(e.message || 'Erro ao simular resposta do bot.', 'danger') }
    setLoadingBot(false)
  }

  async function aiReplyToMessage(msg) {
    setLoadingBot(true)
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/simulator/bot-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: Number(msg.contact_id || selectedContact) }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      await load()
      toast('Resposta da IA adicionada.', 'success')
    } catch (e) { toast(e.message || 'Erro ao responder com IA.', 'danger') }
    setLoadingBot(false)
  }

  async function changeAutoReply(mode) {
    setLoadingAR(true)
    try {
      await fetch(`${API}/api/companies/${companyId}/auto-reply`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_reply_mode: mode }),
      })
      setAutoReplyMode(mode)
    } catch { toast('Erro ao alterar bot.', 'danger') }
    setLoadingAR(false)
  }

  if (!data) {
    return (
      <div className="d-flex justify-content-center align-items-center h-100">
        <div className="spinner-border text-success" />
      </div>
    )
  }

  const messages = data.messages || []
  const contacts = data.contacts || []
  const sentCfg  = sentimentResult ? (SENTIMENT_CFG[sentimentResult.sentiment] || { label: sentimentResult.sentiment, badge: 'secondary' }) : null

  const selectedContactObj = contacts.find(c => String(c.id) === String(selectedContact))

  return (
    <>
      {showMeeting && (
        <MeetingModal
          companyId={companyId}
          contactId={selectedContact ? Number(selectedContact) : null}
          companyName={data.company?.name}
          contactName={selectedContactObj?.name}
          toast={toast}
          onClose={() => setShowMeeting(false)}
          onBooked={() => { setShowMeeting(false); load() }}
        />
      )}
    <div style={{ display: 'flex', height: '100%', gap: 0, overflow: 'hidden' }}>

      {/* ── Conversa ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #e2e8f0' }}>

        {/* sub-header */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #e2e8f0', background: '#fff', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{data.company?.name}</div>
          <div style={{ fontSize: '.75rem', color: '#888', flex: 1 }}>{data.company?.sector}</div>
          {contacts.length > 1 && (
            <select
              className="form-select form-select-sm"
              style={{ width: 'auto', maxWidth: 180 }}
              value={selectedContact}
              onChange={e => setSelectedContact(e.target.value)}
            >
              {contacts.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.is_primary ? ' ★' : ''}</option>
              ))}
            </select>
          )}
          {contacts.length === 1 && (
            <span style={{ fontSize: '.8rem', color: '#555' }}>
              <i className="bi bi-person me-1" />{contacts[0].name}
            </span>
          )}
          {selectedContactObj && cargoDe(selectedContactObj) && (
            <span className="badge" style={{ background: '#eef4ff', color: '#1a44be', fontSize: '.7rem', whiteSpace: 'nowrap' }}>
              <i className="bi bi-briefcase me-1" />{cargoDe(selectedContactObj)}
            </span>
          )}
        </div>

        {/* mensagens */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', background: '#f8f9fa' }}>
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: '#aaa', padding: '40px 0', fontSize: '.88rem' }}>
              <i className="bi bi-chat-dots fs-1 d-block mb-2" style={{ color: '#25d366', opacity: .4 }} />
              Nenhuma mensagem ainda — gere a sequência no painel →
            </div>
          )}
          {messages.map(msg => {
            const isInbound = msg.status === 'received'
            const cfg = STATUS_CFG[msg.status] || STATUS_CFG.pending
            return (
              <div key={msg.id} className={`d-flex mb-2 ${isInbound ? 'justify-content-start' : 'justify-content-end'}`}>
                <div style={{
                  maxWidth: '78%',
                  background: isInbound ? '#fff' : '#dcf8c6',
                  border: `1px solid ${isInbound ? '#e2e8f0' : '#b7dfb8'}`,
                  borderRadius: isInbound ? '12px 12px 12px 2px' : '12px 12px 2px 12px',
                  padding: '8px 12px',
                  boxShadow: '0 1px 2px rgba(0,0,0,.08)',
                }}>
                  {!isInbound && (
                    <div style={{ fontSize: '.68rem', color: '#666', marginBottom: 2 }}>
                      {msg.msg_type === 'follow_up' ? 'Follow-up' : msg.msg_type || 'WhatsApp'}
                      {msg.day ? ` · Dia ${msg.day}` : ''}
                    </div>
                  )}
                  {isInbound && msg.contact_name && (
                    <div style={{ fontSize: '.68rem', color: '#25d366', fontWeight: 600, marginBottom: 2 }}>
                      {msg.contact_name}
                    </div>
                  )}
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '.88rem', lineHeight: 1.5 }}>
                    {msg.content || msg.ai_original}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    <span className={`badge bg-${cfg.bg}`} style={{ fontSize: '.65rem' }}>
                      <i className={`bi ${cfg.icon} me-1`} />{cfg.label}
                    </span>
                    {isInbound && (
                      <button
                        className="btn btn-success"
                        style={{ fontSize: '.65rem', padding: '1px 7px', borderRadius: 20 }}
                        onClick={() => aiReplyToMessage(msg)}
                        disabled={loadingBot}
                        title="Gera a resposta da nossa IA para esta mensagem, sem reiniciar a conversa"
                      >
                        {loadingBot
                          ? <span className="spinner-border spinner-border-sm" />
                          : <><i className="bi bi-robot me-1" />Responder com IA</>}
                      </button>
                    )}
                    {!isInbound && !msg.approved && (
                      <button className="btn btn-success" style={{ fontSize: '.65rem', padding: '1px 7px', borderRadius: 20 }} onClick={() => approve(msg.id)}>
                        ✓ Aprovar
                      </button>
                    )}
                    {!isInbound && msg.approved === 1 && msg.status !== 'sent' && (
                      <button className="btn btn-primary" style={{ fontSize: '.65rem', padding: '1px 7px', borderRadius: 20 }} onClick={() => markSent(msg.id)}>
                        <i className="bi bi-send me-1" />Enviada
                      </button>
                    )}
                    {!isInbound && (
                      <button className="btn btn-outline-secondary" style={{ fontSize: '.65rem', padding: '1px 7px', borderRadius: 20 }} onClick={() => copy(msg.content)}>
                        <i className="bi bi-clipboard" />
                      </button>
                    )}
                    {!isInbound && (
                      <span className="d-flex align-items-center gap-1">
                        <button
                          className={`btn ${msg.score >= 4 ? 'btn-success' : 'btn-outline-success'}`}
                          style={{ fontSize: '.72rem', padding: '1px 9px', borderRadius: 20 }}
                          onClick={() => scoreMessage(msg.id, 5)}
                          title="Mensagem boa"
                        >
                          <i className="bi bi-hand-thumbs-up" />
                        </button>
                        <button
                          className={`btn ${msg.score != null && msg.score <= 2 ? 'btn-danger' : 'btn-outline-danger'}`}
                          style={{ fontSize: '.72rem', padding: '1px 9px', borderRadius: 20 }}
                          onClick={() => thumbsDown(msg)}
                          title="Não ficou boa — abre um campo pra você dizer o porquê (a IA aprende)"
                        >
                          <i className="bi bi-hand-thumbs-down" />
                        </button>
                        <button
                          className="btn btn-outline-success"
                          style={{ fontSize: '.65rem', padding: '1px 8px', borderRadius: 20 }}
                          onClick={() => regenerate(msg)}
                          disabled={regenId === msg.id}
                          title="Gera a mensagem de novo, usando a sua observação (se houver) e o que a IA aprendeu"
                        >
                          {regenId === msg.id
                            ? <><span className="spinner-border spinner-border-sm me-1" />Gerando…</>
                            : <><i className="bi bi-arrow-repeat me-1" />Gerar de novo</>}
                        </button>
                        <button
                          className="btn btn-outline-secondary"
                          style={{ fontSize: '.65rem', padding: '1px 8px', borderRadius: 20 }}
                          onClick={() => onEditMessage && onEditMessage(msg.id)}
                          title="Editar manualmente e ver/ajustar o prompt (vai para RLHF / Curadoria)"
                        >
                          <i className="bi bi-pencil me-1" />Editar
                        </button>
                      </span>
                    )}
                  </div>
                  {!isInbound && commentFor === msg.id && (
                    <div style={{ marginTop: 6 }}>
                      <textarea
                        className="form-control form-control-sm"
                        rows={2}
                        placeholder="O que não ficou bom nessa mensagem? (a IA vai evitar isso nas próximas)"
                        value={commentText}
                        onChange={e => setCommentText(e.target.value)}
                        style={{ fontSize: '.8rem' }}
                      />
                      <div className="d-flex gap-2 mt-1 align-items-center">
                        <button className="btn btn-sm btn-info" style={{ fontSize: '.7rem' }} onClick={() => saveComment(msg.id)}>
                          <i className="bi bi-check-lg me-1" />Salvar observação
                        </button>
                        <button className="btn btn-sm btn-outline-success" style={{ fontSize: '.7rem' }} onClick={() => { saveComment(msg.id); regenerate({ ...msg, score_comment: commentText }) }} title="Salva a observação e já gera a mensagem de novo corrigindo">
                          <i className="bi bi-arrow-repeat me-1" />Salvar e gerar de novo
                        </button>
                        <button className="btn btn-sm btn-link text-decoration-none" style={{ fontSize: '.7rem' }} onClick={() => setCommentFor(null)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                  {!isInbound && msg.score_comment && commentFor !== msg.id && (
                    <div style={{ marginTop: 4, fontSize: '.72rem', color: '#555', fontStyle: 'italic' }}>
                      <i className="bi bi-chat-left-quote me-1" />{msg.score_comment}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {/* compor + enviar mensagem */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #e2e8f0', background: '#fff', flexShrink: 0, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            className="form-control form-control-sm"
            rows={2}
            placeholder="Escreva a mensagem para o lead… (ou gere um gancho ao lado e clique em 'Usar como mensagem')"
            value={composeText}
            onChange={e => setComposeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            style={{ fontSize: '.85rem', resize: 'none' }}
            disabled={sending || !selectedContact}
          />
          <button className="btn btn-success btn-sm" onClick={sendMessage} disabled={sending || !composeText.trim() || !selectedContact} style={{ whiteSpace: 'nowrap' }}>
            {sending ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-send me-1" />Enviar</>}
          </button>
        </div>
      </div>

      {/* ── Painel de Ações ──────────────────────────────────────────────── */}
      <div style={{ width: 280, flexShrink: 0, overflowY: 'auto', background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Contexto do lead */}
        {selectedContact && (
          <LeadContextPanel
            key={selectedContact}
            contactId={selectedContact}
            contactName={selectedContactObj?.name}
            initialContext={selectedContactObj?.context || ''}
            toast={toast}
          />
        )}

        {/* Gerar gancho */}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
          <div className="fw-semibold mb-2" style={{ fontSize: '.82rem', color: '#075e54' }}>
            <i className="bi bi-lightning me-1" />Gerar Gancho
          </div>
          <input
            className="form-control form-control-sm mb-2"
            placeholder="Produto sendo vendido"
            value={product}
            onChange={e => setProduct(e.target.value)}
            style={{ fontSize: '.78rem' }}
          />
          <button className="btn btn-outline-success btn-sm w-100" onClick={generateHook} disabled={loadingHook || !selectedContact}>
            {loadingHook
              ? <><span className="spinner-border spinner-border-sm me-1" />Pesquisando…</>
              : <><i className="bi bi-stars me-1" />Gerar gancho (vira rascunho)</>}
          </button>
          <div className="text-muted mt-1" style={{ fontSize: '.7rem' }}>
            O gancho entra na conversa como rascunho pendente — avalie e edite antes de enviar.
          </div>
        </div>


        {/* Marcar Reunião */}
        <button
          className="btn btn-success btn-sm w-100"
          onClick={() => setShowMeeting(true)}
          style={{ borderRadius: 10, padding: '10px 0', fontWeight: 600 }}
        >
          <i className="bi bi-calendar-check me-2" />Marcar Reunião na Agenda
        </button>

        {/* Simular resposta */}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
          <div className="fw-semibold mb-2" style={{ fontSize: '.82rem', color: '#333' }}>
            <i className="bi bi-bug me-1" />Simular Resposta
          </div>
          <div className="d-flex gap-1 mb-2">
            <select
              className="form-select form-select-sm"
              value={simulateTone}
              onChange={e => setSimulateTone(e.target.value)}
              disabled={loadingGen || loadingSim}
              style={{ flex: 1, fontSize: '.75rem' }}
            >
              <option value="random">🎲 Aleatório</option>
              <option value="interested">🔥 Interessado</option>
              <option value="skeptical">🤔 Cético</option>
              <option value="negative">👎 Negativo</option>
            </select>
            <button
              className="btn btn-outline-primary btn-sm"
              onClick={generateProspectReply}
              disabled={loadingGen || loadingSim}
              title="Gerar com IA"
              style={{ whiteSpace: 'nowrap', fontSize: '.75rem' }}
            >
              {loadingGen ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-stars" /> IA</>}
            </button>
          </div>
          <textarea
            className="form-control form-control-sm mb-2"
            rows={3}
            placeholder="Resposta do prospect…"
            value={simulateText}
            onChange={e => setSimulateText(e.target.value)}
            disabled={loadingSim || loadingGen}
            style={{ fontSize: '.8rem', resize: 'vertical' }}
          />
          <button
            className="btn btn-outline-success btn-sm w-100"
            onClick={simulateResponse}
            disabled={loadingSim || loadingGen || !simulateText.trim()}
          >
            {loadingSim
              ? <><span className="spinner-border spinner-border-sm me-1" />Analisando…</>
              : <><i className="bi bi-whatsapp me-1" />Simular (prospect)</>
            }
          </button>
          <button
            className="btn btn-outline-secondary btn-sm w-100 mt-2"
            onClick={simulateBotReply}
            disabled={loadingBot || loadingSim || loadingGen}
            title="Gera e adiciona a resposta do bot à última mensagem recebida — sem apagar o histórico"
          >
            {loadingBot
              ? <><span className="spinner-border spinner-border-sm me-1" />Gerando…</>
              : <><i className="bi bi-robot me-1" />Simular resposta do Bot</>
            }
          </button>
          {sentimentResult && sentCfg && (
            <div className="mt-2 p-2 rounded" style={{ background: '#f8f9fa', border: '1px solid #e2e8f0', fontSize: '.76rem' }}>
              <span className={`badge bg-${sentCfg.badge} me-1`}>{sentCfg.label}</span>
              {sentimentResult.interest_score !== undefined && (
                <span className="badge bg-info">Score {sentimentResult.interest_score}/10</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  )
}

// ── Inbox principal ───────────────────────────────────────────────────────────
// ── Barra do Bot Auto-reply (embaixo, horizontal, fora da caixa de conversa) ────
function BotAutoReplyBar({ companyId, toast }) {
  const [mode, setMode] = useState('off')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(`${API}/api/companies/${companyId}`).then(r => r.json())
      .then(d => { if (alive) setMode(d.company?.auto_reply_mode || 'off') }).catch(() => {})
    return () => { alive = false }
  }, [companyId])
  async function change(m) {
    setLoading(true)
    try {
      await fetch(`${API}/api/companies/${companyId}/auto-reply`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_reply_mode: m }),
      })
      setMode(m)
    } catch { toast('Erro ao alterar bot.', 'danger') }
    setLoading(false)
  }
  const opts = [
    { value: 'off',            label: '🔴 Desativado' },
    { value: 'except_meeting', label: '🟡 Ativo (exceto reuniões)' },
    { value: 'all',            label: '🟢 Totalmente automático' },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', flexWrap: 'wrap', flexShrink: 0 }}>
      <span className="fw-semibold" style={{ fontSize: '.82rem', color: '#333' }}>
        <i className="bi bi-robot me-1" />Bot Auto-reply:
      </span>
      {opts.map(o => (
        <button
          key={o.value}
          onClick={() => !loading && change(o.value)}
          className="btn btn-sm"
          style={{
            fontSize: '.78rem',
            border: `1.5px solid ${mode === o.value ? '#075e54' : '#e2e8f0'}`,
            background: mode === o.value ? '#f0faf4' : '#fafafa',
            fontWeight: mode === o.value ? 600 : 400,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {o.label}{mode === o.value && <i className="bi bi-check-circle-fill ms-1 text-success" />}
        </button>
      ))}
      <span className="text-muted" style={{ fontSize: '.72rem', marginLeft: 'auto' }}>
        Durante o treino, deixe <b>Desativado</b> para revisar cada resposta da IA.
      </span>
    </div>
  )
}

export default function WhatsAppInbox({ toast, initialCompanyId, initialContactId, onEditMessage }) {
  const [inbox,      setInbox]      = useState([])
  const [selected,   setSelected]   = useState(initialCompanyId ?? null)
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [listCollapsed, setListCollapsed] = useState(() => {
    try { return localStorage.getItem('wa_list_collapsed') === '1' } catch { return false }
  })
  function toggleList() {
    setListCollapsed(v => { try { localStorage.setItem('wa_list_collapsed', v ? '0' : '1') } catch {} return !v })
  }
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/whatsapp/inbox`)
      const data = await res.json()
      setInbox(data || [])
      // Auto-seleciona o primeiro somente se nenhum estiver selecionado
      setSelected(prev => prev ?? (data?.[0]?.company_id ?? null))
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    pollRef.current = setInterval(load, 20_000)
    return () => clearInterval(pollRef.current)
  }, [load])

  const filtered = inbox.filter(c =>
    !search || c.company_name?.toLowerCase().includes(search.toLowerCase())
  )

  // Altura total disponível menos navbar e statcards (~160px)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 150px)', gap: 8 }}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>

      {/* ── Lista de chats (retrátil) ──────────────────────────────────────── */}
      {listCollapsed ? (
        <div style={{ width: 46, flexShrink: 0, borderRight: '1px solid #e2e8f0', background: '#075e54', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 14 }}>
          <button onClick={toggleList} title="Mostrar conversas" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.15rem', padding: 0 }}>
            <i className="bi bi-chevron-double-right" />
          </button>
          <i className="bi bi-chat-left-text" style={{ color: 'rgba(255,255,255,.85)', fontSize: '1.05rem' }} title="Conversas" />
        </div>
      ) : (
      <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>

        {/* header lista */}
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0', background: '#075e54' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: '.95rem' }}>
              <i className="bi bi-whatsapp me-2" />WhatsApp
            </span>
            <button onClick={toggleList} title="Ocultar lista de conversas" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1rem', padding: 0, lineHeight: 1 }}>
              <i className="bi bi-chevron-double-left" />
            </button>
          </div>
          <input
            className="form-control form-control-sm"
            placeholder="Buscar empresa…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ borderRadius: 20, fontSize: '.8rem' }}
          />
        </div>

        {/* lista */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div className="d-flex justify-content-center py-4">
              <div className="spinner-border spinner-border-sm text-success" />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#aaa', fontSize: '.82rem' }}>
              {search ? 'Nenhum resultado' : 'Nenhuma conversa ainda'}
            </div>
          ) : filtered.map(c => {
            const isActive = selected === c.company_id
            const arCfg   = AR_LABELS[c.auto_reply_mode] || AR_LABELS.off
            return (
              <div
                key={c.company_id}
                onClick={() => setSelected(c.company_id)}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid #f0f0f0',
                  background: isActive ? '#e8f5e9' : '#fff',
                  cursor: 'pointer',
                  borderLeft: `3px solid ${isActive ? '#25d366' : 'transparent'}`,
                  transition: 'background .1s',
                }}
              >
                <div className="d-flex align-items-center gap-2 mb-1">
                  {/* avatar */}
                  <div style={{
                    width: 34, height: 34, borderRadius: '50%',
                    background: isActive ? '#25d366' : '#e0e0e0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: '.9rem', color: isActive ? '#fff' : '#555',
                    flexShrink: 0,
                  }}>
                    {(c.company_name || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: '.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
                        {c.company_name}
                      </span>
                      <span style={{ fontSize: '.68rem', color: '#999', flexShrink: 0 }}>
                        {timeAgo(c.last_at)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: '.75rem', color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {c.last_status === 'received' ? '← ' : '→ '}
                        {(c.last_message || '').substring(0, 35)}{(c.last_message || '').length > 35 ? '…' : ''}
                      </span>
                      {c.unread > 0 && (
                        <span style={{ background: '#25d366', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.65rem', fontWeight: 700, flexShrink: 0 }}>
                          {c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ paddingLeft: 42 }}>
                  <span style={{ fontSize: '.65rem', color: arCfg.color, fontWeight: 500 }}>
                    ● {arCfg.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      )}

      {/* ── Painel direito ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selected ? (
          <ChatPanel key={selected} companyId={selected} initialContactId={selected === initialCompanyId ? initialContactId : null} onEditMessage={onEditMessage} toast={toast} />
        ) : (
          <div className="d-flex flex-column justify-content-center align-items-center h-100 text-center" style={{ color: '#aaa' }}>
            <i className="bi bi-whatsapp" style={{ fontSize: '3rem', color: '#25d366', opacity: .4, display: 'block', marginBottom: 12 }} />
            <div style={{ fontSize: '.9rem' }}>Selecione uma conversa ao lado</div>
          </div>
        )}
      </div>
    </div>
    {selected && <BotAutoReplyBar companyId={selected} toast={toast} />}
    </div>
  )
}
