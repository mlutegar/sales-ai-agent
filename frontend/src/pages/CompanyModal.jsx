import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const API = '';

// ─── helpers ───────────────────────────────────────────────────────────────
function channelBadge(channel) {
  const map = {
    linkedin: { bg: '#0077b5', label: 'LinkedIn' },
    email:    { bg: '#ea4335', label: 'E-mail' },
    whatsapp: { bg: '#25d366', label: 'WhatsApp' },
  };
  const c = map[channel] || { bg: '#6c757d', label: channel };
  return (
    <span className="badge me-1" style={{ background: c.bg, fontSize: '.7rem' }}>
      {c.label}
    </span>
  );
}

function ScoreStars({ messageId, current, onScored }) {
  const [hovered, setHovered] = useState(0);
  const [scored, setScored] = useState(current || 0);
  async function score(n) {
    setScored(n);
    await fetch(`${API}/api/messages/${messageId}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: n }),
    });
    if (onScored) onScored(n);
  }
  return (
    <span>
      {[1, 2, 3, 4, 5].map(n => (
        <i
          key={n}
          className={`bi bi-star${(hovered || scored) >= n ? '-fill' : ''} me-1`}
          style={{ cursor: 'pointer', color: '#f0ad4e', fontSize: '.9rem' }}
          onMouseEnter={() => setHovered(n)}
          onMouseLeave={() => setHovered(0)}
          onClick={() => score(n)}
        />
      ))}
    </span>
  );
}

function MessageCard({ msg, contacts, toast }) {
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  const [approved, setApproved] = useState(msg.approved);
  const [sent, setSent] = useState(msg.sent);
  const [loading, setLoading] = useState('');

  async function approve() {
    setLoading('approve');
    await fetch(`${API}/api/messages/${msg.id}/approve`, { method: 'POST' });
    setApproved(true);
    setLoading('');
    toast('Mensagem aprovada.', 'success');
  }

  async function correct() {
    if (!correction.trim()) return;
    setLoading('correct');
    await fetch(`${API}/api/messages/${msg.id}/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correction }),
    });
    setLoading('');
    setCorrecting(false);
    toast('Correção enviada.', 'info');
  }

  async function send() {
    setLoading('send');
    await fetch(`${API}/api/messages/${msg.id}/send`, { method: 'POST' });
    setSent(true);
    setLoading('');
    toast('Mensagem marcada como enviada.', 'success');
  }

  function copy() {
    navigator.clipboard.writeText(msg.content || '');
    toast('Copiado!', 'info');
  }

  const contactName = contacts.find(c => c.id === msg.contact_id)?.name || '';

  // Mensagem RECEBIDA do cliente: balão de entrada, sem selo "Aprovado" e sem ações.
  if (msg.status === 'received') {
    return (
      <div className="border rounded p-2 mb-2" style={{ background: '#e9fbef', borderColor: '#a3e4bf', borderLeft: '4px solid #25d366' }}>
        <div className="d-flex align-items-center gap-1 mb-1 flex-wrap">
          <span className="badge" style={{ background: '#25d366', color: '#fff', fontSize: '.65rem' }}>
            <i className="bi bi-chat-left-text me-1" />Resposta do cliente
          </span>
          {channelBadge(msg.channel)}
          {contactName && <span className="text-muted small">{contactName}</span>}
        </div>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: '.9rem', padding: '2px' }}>{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="border rounded p-2 mb-2" style={{ background: '#fff' }}>
      <div className="d-flex align-items-center gap-1 mb-1 flex-wrap">
        {channelBadge(msg.channel)}
        {contactName && <span className="text-muted small">{contactName}</span>}
        {!approved && <span className="badge bg-warning text-dark" style={{ fontSize: '.65rem' }}><i className="bi bi-stars me-1" />Sugestão da IA</span>}
        {approved && <span className="badge bg-success" style={{ fontSize: '.65rem' }}>Aprovado</span>}
        {sent && <span className="badge bg-primary" style={{ fontSize: '.65rem' }}>Enviado</span>}
      </div>
      <div
        className="msg-box mb-2"
        style={{
          background: '#f8f9fa',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: 12,
          whiteSpace: 'pre-wrap',
          fontSize: '.88rem',
        }}
      >
        {msg.content}
      </div>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <button
          className="btn btn-outline-success btn-sm"
          disabled={approved || loading === 'approve'}
          onClick={approve}
        >
          <i className="bi bi-check me-1" />Aprovar
        </button>
        <ScoreStars messageId={msg.id} current={msg.score} />
        <button
          className="btn btn-outline-warning btn-sm"
          onClick={() => setCorrecting(v => !v)}
        >
          <i className="bi bi-pencil me-1" />Corrigir
        </button>
        <button className="btn btn-outline-secondary btn-sm" onClick={copy}>
          <i className="bi bi-clipboard me-1" />Copiar
        </button>
        <button
          className="btn btn-outline-primary btn-sm"
          disabled={sent || loading === 'send'}
          onClick={send}
        >
          <i className="bi bi-send me-1" />Enviar
        </button>
      </div>
      {correcting && (
        <div className="mt-2">
          <textarea
            className="form-control form-control-sm mb-1"
            rows={3}
            placeholder="Descreva a correção desejada..."
            value={correction}
            onChange={e => setCorrection(e.target.value)}
          />
          <div className="d-flex gap-1">
            <button
              className="btn btn-sm btn-warning"
              disabled={loading === 'correct'}
              onClick={correct}
            >
              {loading === 'correct' ? 'Enviando…' : 'Enviar Correção'}
            </button>
            <button className="btn btn-sm btn-link" onClick={() => setCorrecting(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function CompanyModal({ companyId, onClose, toast, loadStats, onCompanyUpdated, onOpenWhatsApp }) {
  const navigate = useNavigate();

  // ── company state
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);

  // ── inline edit
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editSector, setEditSector] = useState('');

  // ── research
  const [product, setProduct] = useState('');
  const [researchLoading, setResearchLoading] = useState(false);
  const [hook, setHook] = useState('Clique em "Pesquisar" para gerar o gancho personalizado...');
  const [painPoints, setPainPoints] = useState([]);
  const [selectedPain, setSelectedPain] = useState('');
  const [customPainVisible, setCustomPainVisible] = useState(false);
  const [customPain, setCustomPain] = useState('');
  const [contextText, setContextText] = useState('');
  const [contextVisible, setContextVisible] = useState(false);
  const [researchHistory, setResearchHistory] = useState([]);
  const [researchHistoryVisible, setResearchHistoryVisible] = useState(false);

  // ── sequence
  const [sequenceContactId, setSequenceContactId] = useState('');
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const [abVariants, setAbVariants] = useState([]);
  const [abVisible, setAbVisible] = useState(false);
  const [sequenceHistory, setSequenceHistory] = useState([]);
  const [sequenceHistoryVisible, setSequenceHistoryVisible] = useState(false);

  // ── response / sentiment
  const [responseContactId, setResponseContactId] = useState('');
  const [responseText, setResponseText] = useState('');
  const [sentimentLoading, setSentimentLoading] = useState(false);
  const [sentimentResult, setSentimentResult] = useState(null);

  // ── contacts
  const [contacts, setContacts] = useState([]);
  const [addContactVisible, setAddContactVisible] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', role: 'other', email: '', linkedin: '', whatsapp: '' });
  const [contactSaving, setContactSaving] = useState(false);

  // ── schedule
  const [slots, setSlots] = useState([]);
  const [bookingSlot, setBookingSlot] = useState(null);

  // ── timeline
  const [timeline, setTimeline] = useState([]);

  // ── hand-off
  const [showHandoff, setShowHandoff] = useState(false);

  // ── flags/etiquetas
  const [flagCatalog, setFlagCatalog] = useState([]);
  useEffect(() => {
    fetch(`${API}/api/flags`).then(r => r.json())
      .then(d => setFlagCatalog(Array.isArray(d) ? d : [])).catch(() => setFlagCatalog([]));
  }, []);

  const loadTimeline = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/timeline`);
      const data = await res.json();
      setTimeline(data.timeline || data || []);
    } catch {}
  }, [companyId]);

  // ─── load company ──────────────────────────────────────────────────────────
  const loadCompany = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}`);
      const data = await res.json();
      // a API retorna { company:{...}, contacts, messages, sentiments, ... } — achatamos
      // os campos da empresa para o topo (status/score/name) mantendo os arrays acessíveis.
      setCompany({ ...(data.company || {}), ...data });
      setContacts(data.contacts || []);
      setMessages(data.messages || []);
      setEditName(data.company?.name || '');
      setEditSector(data.company?.sector || '');
      
      // Carrega a linha do tempo junto
      loadTimeline();

      if (data.interest_score >= 7 && data.last_sentiment === 'interested') {
        setShowHandoff(true);
      }
    } catch {
      toast('Erro ao carregar empresa.', 'danger');
    }
    setLoading(false);
  }, [companyId, loadTimeline]);

  useEffect(() => {
    loadCompany();
  }, [loadCompany]);

  // load slots
  useEffect(() => {
    fetch(`${API}/api/schedule/slots`)
      .then(r => r.json())
      .then(d => setSlots(d.slots || d || []))
      .catch(() => {});
  }, []);

  // load timeline initial
  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // ─── inline edit ───────────────────────────────────────────────────────────
  async function saveCompanyEdit() {
    try {
      const res = await fetch(`${API}/api/companies/${companyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, sector: editSector }),
      });
      const data = await res.json();
      setCompany(prev => ({ ...prev, name: editName, sector: editSector }));
      setEditingName(false);
      toast('Empresa atualizada.', 'success');
      if (onCompanyUpdated) onCompanyUpdated(data);
      if (loadStats) loadStats();
    } catch {
      toast('Erro ao salvar.', 'danger');
    }
  }

  // ─── opt-out ───────────────────────────────────────────────────────────────
  async function optoutCompany() {
    if (!window.confirm('Confirmar opt-out LGPD? Os dados serão anonimizados.')) return;
    try {
      await fetch(`${API}/api/companies/${companyId}/optout`, { method: 'POST' });
      toast('Opt-out registrado.', 'warning');
      onClose();
      if (loadStats) loadStats();
    } catch {
      toast('Erro ao registrar opt-out.', 'danger');
    }
  }

  // ─── flags/etiquetas ─────────────────────────────────────────────────────────
  async function toggleFlag(flagKey, isActive) {
    try {
      const url = `${API}/api/companies/${companyId}/flags${isActive ? '/' + flagKey : ''}`;
      const res = await fetch(url, {
        method: isActive ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isActive ? undefined : JSON.stringify({ flag: flagKey }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCompany(prev => ({ ...prev, flags: data.flags || [] }));
      toast('Etiqueta atualizada.', 'success');
      if (onCompanyUpdated) onCompanyUpdated();
    } catch (err) {
      toast(err.message || 'Erro ao atualizar etiqueta.', 'danger');
    }
  }

  // ─── delete ────────────────────────────────────────────────────────────────
  async function deleteCompany() {
    if (!window.confirm('Excluir empresa permanentemente?')) return;
    try {
      await fetch(`${API}/api/companies/${companyId}`, { method: 'DELETE' });
      toast('Empresa excluída.', 'success');
      if (onCompanyUpdated) onCompanyUpdated();
      if (loadStats) loadStats();
      onClose();
    } catch {
      toast('Erro ao excluir.', 'danger');
    }
  }

  // ─── research ──────────────────────────────────────────────────────────────
  async function runResearch() {
    if (!product.trim()) { toast('Informe o produto.', 'warning'); return; }
    setResearchLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_value: product }),
      });
      const data = await res.json();
      setHook(data.hook || '');
      setPainPoints(data.pain_points || []);
      setContextText(data.context || '');
      setContextVisible(false);
      setResearchHistory(prev => [{ product, hook: data.hook, created_at: new Date().toISOString() }, ...prev]);
    } catch {
      toast('Erro na pesquisa.', 'danger');
    }
    setResearchLoading(false);
  }

  // ─── sequence ──────────────────────────────────────────────────────────────
  async function generateSequence() {
    if (!sequenceContactId) { toast('Selecione um contato.', 'warning'); return; }
    setSequenceLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/sequence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: sequenceContactId, selected_pain: selectedPain }),
      });
      const data = await res.json();
      const msgs = data.messages || [];
      setMessages(msgs);
      setSequenceHistory(prev => [{ contact_id: sequenceContactId, messages: msgs, created_at: new Date().toISOString() }, ...prev]);
    } catch {
      toast('Erro ao gerar sequência.', 'danger');
    }
    setSequenceLoading(false);
  }

  async function generateABVariants() {
    if (!sequenceContactId) { toast('Selecione um contato.', 'warning'); return; }
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/sequence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: sequenceContactId, selected_pain: selectedPain, variant: 'B' }),
      });
      const data = await res.json();
      setAbVariants(data.messages || []);
      setAbVisible(true);
    } catch {
      toast('Erro ao gerar variantes A/B.', 'danger');
    }
  }

  // ─── response / sentiment ──────────────────────────────────────────────────
  async function recordResponse() {
    if (!responseText.trim()) { toast('Digite a resposta do prospect.', 'warning'); return; }
    setSentimentLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: responseText, contact_id: responseContactId }),
      });
      const data = await res.json();
      setSentimentResult(data);
      if (data.interest_score >= 7 && data.sentiment === 'interested') setShowHandoff(true);
    } catch {
      toast('Erro ao analisar sentimento.', 'danger');
    }
    setSentimentLoading(false);
  }

  async function simulateWhatsAppInbound() {
    if (!responseText.trim()) { toast('Digite a resposta do prospect.', 'warning'); return; }
    if (!responseContactId) { toast('Selecione o contato.', 'warning'); return; }
    setSentimentLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/simulator/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_text: responseText, contact_id: responseContactId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const SENT_LABEL = { interested: '🔥 Interessado → Hot Lead', technical_question: 'Dúvida técnica → Aguard. follow-up', negative: 'Negativo → Rejeitado', out_of_scope: 'Fora de escopo → Contactado' };
      toast(`Resposta classificada: ${SENT_LABEL[data.sentiment] || data.sentiment} (score ${data.interest_score})`, 'success');
      setResponseText('');
      loadCompany();              // recarrega o modal (timeline/mensagens/status)
      if (onCompanyUpdated) onCompanyUpdated(); // atualiza a lista de empresas por trás (badge do status)
      if (loadStats) loadStats(); // atualiza os contadores (Hot Leads etc.)
    } catch (err) {
      toast(err.message || 'Erro ao simular.', 'danger');
    }
    setSentimentLoading(false);
  }

  // ─── contacts ──────────────────────────────────────────────────────────────
  async function addContact() {
    if (!newContact.name.trim()) { toast('Nome do contato obrigatório.', 'warning'); return; }
    setContactSaving(true);
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newContact),
      });
      const data = await res.json();
      setContacts(prev => [...prev, data.contact || data]);
      setNewContact({ name: '', role: 'other', email: '', linkedin: '', whatsapp: '' });
      setAddContactVisible(false);
      toast('Contato adicionado.', 'success');
    } catch {
      toast('Erro ao adicionar contato.', 'danger');
    }
    setContactSaving(false);
  }

  async function deleteContact(contactId) {
    if (!window.confirm('Remover contato?')) return;
    try {
      await fetch(`${API}/api/companies/${companyId}/contacts/${contactId}`, { method: 'DELETE' });
      setContacts(prev => prev.filter(c => c.id !== contactId));
      toast('Contato removido.', 'info');
      if (onCompanyUpdated) onCompanyUpdated();
      if (loadStats) loadStats();
    } catch {
      toast('Erro ao remover contato.', 'danger');
    }
  }

  async function setPrimaryContact(contactId) {
    try {
      await fetch(`${API}/api/companies/${companyId}/contacts/${contactId}/set-primary`, { method: 'PATCH' });
      setContacts(prev => prev.map(c => ({ ...c, is_primary: c.id === contactId })));
      toast('Contato principal definido.', 'success');
    } catch {
      toast('Erro.', 'danger');
    }
  }

  // ─── schedule ──────────────────────────────────────────────────────────────
  async function bookSlot(slotId) {
    setBookingSlot(slotId);
    try {
      await fetch(`${API}/api/schedule/slots/${slotId}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: companyId }),
      });
      setSlots(prev => prev.map(s => s.id === slotId ? { ...s, booked: true } : s));
      toast('Reunião agendada.', 'success');
      if (loadStats) loadStats();
    } catch {
      toast('Erro ao agendar.', 'danger');
    }
    setBookingSlot(null);
  }

  // ─── sentiment badge ───────────────────────────────────────────────────────
  function sentimentBadge(s) {
    const map = {
      interested:    'success',
      neutral:       'secondary',
      not_interested:'danger',
      objection:     'warning',
    };
    return (
      <span className={`badge bg-${map[s] || 'secondary'} sentiment-badge`}>
        {s || '—'}
      </span>
    );
  }

  // ─── render ────────────────────────────────────────────────────────────────
  if (!companyId) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="modal-backdrop fade show"
        style={{ zIndex: 1040 }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="modal show d-block"
        tabIndex="-1"
        style={{ zIndex: 1050 }}
        role="dialog"
      >
        <div className="modal-dialog modal-xl modal-dialog-scrollable modal-fullscreen-md-down">
          <div className="modal-content">

            {/* ── HEADER ── */}
            <div className="modal-header">
              <div style={{ flex: 1 }}>
                {!editingName ? (
                  <div className="d-flex align-items-center gap-2 mb-0">
                    <h5 className="modal-title fw-bold mb-0">
                      {company?.name || (loading ? 'Carregando…' : '—')}
                    </h5>
                    <button
                      className="btn btn-link btn-sm p-0"
                      title="Editar empresa"
                      onClick={() => setEditingName(true)}
                    >
                      <i className="bi bi-pencil" />
                    </button>
                  </div>
                ) : (
                  <div className="mt-1">
                    <input
                      className="form-control form-control-sm mb-1"
                      placeholder="Nome da empresa"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                    />
                    <input
                      className="form-control form-control-sm mb-1"
                      placeholder="Setor"
                      value={editSector}
                      onChange={e => setEditSector(e.target.value)}
                    />
                    <div className="d-flex gap-1">
                      <button className="btn btn-success btn-sm" onClick={saveCompanyEdit}>Salvar</button>
                      <button className="btn btn-link btn-sm" onClick={() => setEditingName(false)}>Cancelar</button>
                    </div>
                  </div>
                )}
              </div>
              <div className="ms-auto d-flex gap-2 me-3 align-items-start">
                <button className="btn btn-outline-danger btn-sm" onClick={optoutCompany}>
                  <i className="bi bi-slash-circle me-1" />Opt-out LGPD
                </button>
                <button className="btn btn-danger btn-sm" onClick={deleteCompany}>
                  <i className="bi bi-trash me-1" />Excluir
                </button>
              </div>
              <button type="button" className="btn-close" onClick={onClose} />
            </div>

            {/* ── BODY ── */}
            <div className="modal-body">
              {loading ? (
                <div className="text-center py-5">
                  <div className="spinner-border text-primary" />
                </div>
              ) : (
                <div className="row g-3">

                  {/* ══ LEFT COLUMN ══════════════════════════════════════ */}
                  <div className="col-12 col-md-7">

                    {/* ── Research card ── */}
                    <div className="card mb-3">
                      <div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2">
                        <span className="fw-bold">
                          <i className="bi bi-search me-1" />Pesquisa &amp; Gancho
                        </span>
                        <div className="d-flex gap-2">
                          <input
                            className="form-control form-control-sm"
                            style={{ width: 200 }}
                            placeholder="Produto sendo vendido"
                            value={product}
                            onChange={e => setProduct(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && runResearch()}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={researchLoading}
                            onClick={runResearch}
                          >
                            {researchLoading
                              ? <span className="spinner-border spinner-border-sm" />
                              : <><i className="bi bi-lightning me-1" />Pesquisar</>
                            }
                          </button>
                        </div>
                      </div>
                      <div className="card-body">
                        {/* Hook */}
                        <div
                          style={{
                            background: '#fff',
                            border: '1px solid #e2e8f0',
                            borderRadius: 8,
                            padding: 12,
                            whiteSpace: 'pre-wrap',
                            fontSize: '.88rem',
                            minHeight: 60,
                          }}
                        >
                          {hook}
                        </div>

                        {/* Pain points */}
                        {painPoints.length > 0 && (
                          <div className="mt-3">
                            <p className="small fw-semibold mb-2">
                              <i className="bi bi-bullseye me-1 text-danger" />
                              Selecione a dor principal do lead para personalizar as mensagens:
                            </p>
                            <div className="d-flex flex-column gap-2">
                              {painPoints.map((pain, i) => (
                                <button
                                  key={i}
                                  className={`btn btn-sm text-start ${selectedPain === pain ? 'btn-danger' : 'btn-outline-danger'}`}
                                  onClick={() => setSelectedPain(selectedPain === pain ? '' : pain)}
                                >
                                  {pain}
                                </button>
                              ))}
                            </div>
                            <div className="mt-1">
                              <button
                                className="btn btn-link btn-sm p-0 mt-1 text-muted"
                                onClick={() => setCustomPainVisible(v => !v)}
                              >
                                + Dor personalizada
                              </button>
                              {customPainVisible && (
                                <div className="mt-2">
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    placeholder="Ou descreva uma dor personalizada..."
                                    value={customPain}
                                    onChange={e => setCustomPain(e.target.value)}
                                  />
                                  <button
                                    className="btn btn-sm btn-outline-secondary mt-1"
                                    onClick={() => { setSelectedPain(customPain); setCustomPainVisible(false); }}
                                  >
                                    <i className="bi bi-check me-1" />Usar esta dor
                                  </button>
                                </div>
                              )}
                            </div>
                            {selectedPain && (
                              <div className="mt-2 alert alert-success py-1 px-2 small mb-0">
                                <i className="bi bi-check-circle me-1" />
                                {selectedPain}
                                <button
                                  className="btn btn-link btn-sm p-0 ms-2"
                                  onClick={() => setSelectedPain('')}
                                >
                                  ✕ Limpar
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Context */}
                        {contextText && (
                          <div className="mt-2">
                            <button
                              className="btn btn-link btn-sm p-0"
                              onClick={() => setContextVisible(v => !v)}
                            >
                              Ver contexto completo {contextVisible ? '▲' : '▼'}
                            </button>
                            {contextVisible && (
                              <pre className="mt-2 bg-light p-2 rounded" style={{ fontSize: '.82rem' }}>
                                {contextText}
                              </pre>
                            )}
                          </div>
                        )}

                        {/* Research history */}
                        {researchHistory.length > 0 && (
                          <div className="mt-2">
                            <button
                              className="btn btn-link btn-sm p-0 text-muted"
                              onClick={() => setResearchHistoryVisible(v => !v)}
                            >
                              <i className="bi bi-clock-history me-1" />
                              Histórico de pesquisas anteriores {researchHistoryVisible ? '▲' : '▼'}
                            </button>
                            {researchHistoryVisible && (
                              <div className="mt-2">
                                {researchHistory.map((h, i) => (
                                  <div key={i} className="border rounded p-2 mb-1 bg-light small">
                                    <div className="text-muted" style={{ fontSize: '.75rem' }}>
                                      {h.product} — {new Date(h.created_at).toLocaleString('pt-BR')}
                                    </div>
                                    <div style={{ whiteSpace: 'pre-wrap' }}>{h.hook}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ── Etiquetas / Flags card ── */}
                    <div className="card mb-3">
                      <div className="card-header fw-bold">
                        <i className="bi bi-tags me-1" />Etiquetas
                      </div>
                      <div className="card-body">
                        <div className="d-flex flex-wrap gap-1">
                          {flagCatalog.length === 0 && (
                            <span className="text-muted small">Nenhuma etiqueta disponível.</span>
                          )}
                          {flagCatalog.map((f) => {
                            const on = (company.flags || []).includes(f.key);
                            return (
                              <button
                                key={f.key}
                                type="button"
                                className={`btn btn-sm me-1 mb-1 ${on ? f.badge : 'btn-outline-secondary'}`}
                                onClick={() => toggleFlag(f.key, on)}
                              >
                                <i className={`bi bi-${on ? 'check-circle-fill' : 'circle'} me-1`} />{f.label}
                              </button>
                            );
                          })}
                        </div>
                        {(company.flags || []).includes('nao_contatar') && (
                          <div className="alert alert-danger py-1 px-2 mt-2 mb-0 small">
                            <i className="bi bi-exclamation-triangle me-1" />
                            Empresa marcada como <strong>Não contatar</strong> — a geração de abordagem está bloqueada.
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ── Sequence card ── */}
                    <div className="card mb-3">
                      <div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2">
                        <span className="fw-bold">
                          <i className="bi bi-send me-1" />Sequência Multicanal
                        </span>
                        <div className="d-flex gap-2 align-items-center flex-wrap">
                          <select
                            className="form-select form-select-sm"
                            style={{ minWidth: 160 }}
                            value={sequenceContactId}
                            onChange={e => setSequenceContactId(e.target.value)}
                          >
                            <option value="">Selecione contato...</option>
                            {contacts.map(c => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={sequenceLoading}
                            onClick={generateSequence}
                          >
                            {sequenceLoading
                              ? <span className="spinner-border spinner-border-sm" />
                              : <><i className="bi bi-magic me-1" />Gerar</>
                            }
                          </button>
                          <button
                            className="btn btn-outline-secondary btn-sm"
                            title="Gerar variante B para cada canal"
                            onClick={generateABVariants}
                          >
                            <i className="bi bi-shuffle me-1" />A/B
                          </button>
                        </div>
                      </div>
                      <div className="card-body">
                        {messages.length === 0 ? (
                          <p className="text-muted small mb-0">
                            Selecione um contato e clique em "Gerar" para criar as mensagens personalizadas.
                          </p>
                        ) : (
                          messages.map(msg => (
                            <MessageCard key={msg.id} msg={msg} contacts={contacts} toast={toast} />
                          ))
                        )}
                      </div>

                      {/* A/B Variants */}
                      {abVisible && abVariants.length > 0 && (
                        <div className="card-footer p-2">
                          <div className="d-flex justify-content-between align-items-center mb-2">
                            <span className="small fw-bold text-secondary">
                              <i className="bi bi-shuffle me-1" />Variantes A/B
                            </span>
                            <button className="btn btn-link btn-sm p-0" onClick={() => setAbVisible(false)}>✕</button>
                          </div>
                          {abVariants.map(msg => (
                            <MessageCard key={msg.id} msg={msg} contacts={contacts} toast={toast} />
                          ))}
                        </div>
                      )}

                      {/* Sequence history */}
                      {sequenceHistory.length > 0 && (
                        <div className="card-footer p-2">
                          <button
                            className="btn btn-link btn-sm p-0 text-muted"
                            onClick={() => setSequenceHistoryVisible(v => !v)}
                          >
                            <i className="bi bi-clock-history me-1" />
                            Sequências anteriores {sequenceHistoryVisible ? '▲' : '▼'}
                          </button>
                          {sequenceHistoryVisible && (
                            <div className="mt-2">
                              {sequenceHistory.map((h, i) => (
                                <div key={i} className="border rounded p-2 mb-1 bg-light small">
                                  <div className="text-muted" style={{ fontSize: '.75rem' }}>
                                    {new Date(h.created_at).toLocaleString('pt-BR')}
                                  </div>
                                  {h.messages.map(m => (
                                    <div key={m.id} className="mb-1">
                                      {channelBadge(m.channel)}
                                      <span style={{ whiteSpace: 'pre-wrap', fontSize: '.82rem' }}>
                                        {m.content?.substring(0, 120)}…
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* ── Response / Sentiment card ── */}
                    <div className="card">
                      <div className="card-header fw-bold">
                        <i className="bi bi-chat-dots me-1" />Registrar Resposta do Prospect
                      </div>
                      <div className="card-body">
                        <div className="mb-2">
                          <label className="form-label small fw-bold">De qual contato veio a resposta?</label>
                          <select
                            className="form-select form-select-sm mb-2"
                            value={responseContactId}
                            onChange={e => setResponseContactId(e.target.value)}
                          >
                            <option value="">Selecione contato...</option>
                            {contacts.map(c => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                        </div>
                        <textarea
                          className="form-control form-control-sm mb-2"
                          rows={3}
                          placeholder="Cole aqui a resposta recebida do prospect..."
                          value={responseText}
                          onChange={e => setResponseText(e.target.value)}
                        />
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={sentimentLoading}
                          onClick={recordResponse}
                        >
                          {sentimentLoading
                            ? <span className="spinner-border spinner-border-sm" />
                            : <><i className="bi bi-bullseye me-1" />Analisar Sentimento</>
                          }
                        </button>
                        <button
                          className="btn btn-success btn-sm ms-2"
                          disabled={sentimentLoading}
                          onClick={simulateWhatsAppInbound}
                        >
                          {sentimentLoading
                            ? <span className="spinner-border spinner-border-sm" />
                            : <><i className="bi bi-whatsapp me-1" />Simular no WhatsApp</>
                          }
                        </button>
                        <button
                          className="btn btn-outline-success btn-sm ms-2"
                          onClick={() => {
                            onClose()
                            if (onOpenWhatsApp) onOpenWhatsApp(companyId)
                          }}
                          title="Ir para a conversa WhatsApp deste cliente"
                        >
                          <i className="bi bi-whatsapp me-1" />Ver WhatsApp
                        </button>

                        {sentimentResult && (
                          <div className="mt-3">
                            <div className="d-flex align-items-center gap-2 mb-2">
                              <strong>Sentimento:</strong>
                              {sentimentBadge(sentimentResult.sentiment)}
                              {sentimentResult.interest_score !== undefined && (
                                <span className="badge bg-info">
                                  Score: {sentimentResult.interest_score}
                                </span>
                              )}
                            </div>
                            {sentimentResult.draft_reply && (
                              <div>
                                <p className="small fw-bold mb-1">Rascunho de Resposta:</p>
                                <div
                                  style={{
                                    background: '#f8f9fa',
                                    border: '1px solid #e2e8f0',
                                    borderRadius: 8,
                                    padding: 12,
                                    whiteSpace: 'pre-wrap',
                                    fontSize: '.88rem',
                                  }}
                                >
                                  {sentimentResult.draft_reply}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                  </div>
                  {/* ══ END LEFT COLUMN ══════════════════════════════════ */}

                  {/* ══ RIGHT COLUMN ═════════════════════════════════════ */}
                  <div className="col-12 col-md-5">

                    {/* ── Contacts card ── */}
                    <div className="card mb-3">
                      <div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-1">
                        <span className="fw-bold">
                          <i className="bi bi-people me-1" />Contatos
                        </span>
                        <div className="d-flex gap-1 flex-wrap">
                          <button
                            className="btn btn-outline-secondary btn-sm"
                            title="Buscar novo contato na internet"
                            onClick={() => toast('Funcionalidade de busca de contatos.', 'info')}
                          >
                            <i className="bi bi-search me-1" />Buscar
                          </button>
                          <button
                            className="btn btn-outline-success btn-sm"
                            title="Exportar contatos CSV"
                            onClick={() => window.open(`${API}/api/companies/${companyId}/contacts/export`)}
                          >
                            <i className="bi bi-download me-1" />CSV
                          </button>
                          <button
                            className="btn btn-outline-primary btn-sm"
                            onClick={() => setAddContactVisible(v => !v)}
                          >
                            <i className="bi bi-person-plus me-1" />Adicionar
                          </button>
                        </div>
                      </div>
                      <div className="card-body">
                        {/* Add contact form */}
                        {addContactVisible && (
                          <div className="d-none d-block mb-3 p-2 border rounded bg-light">
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="Nome *"
                                value={newContact.name}
                                onChange={e => setNewContact(p => ({ ...p, name: e.target.value }))}
                              />
                            </div>
                            <div className="mb-2">
                              <select
                                className="form-select form-select-sm"
                                value={newContact.role}
                                onChange={e => setNewContact(p => ({ ...p, role: e.target.value }))}
                              >
                                <option value="c_level">C-Level / Diretor</option>
                                <option value="manager">Gerente / Coordenador</option>
                                <option value="engineer">Engenheiro / TI</option>
                                <option value="other">Outro</option>
                              </select>
                            </div>
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="E-mail"
                                value={newContact.email}
                                onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))}
                              />
                            </div>
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="LinkedIn URL"
                                value={newContact.linkedin}
                                onChange={e => setNewContact(p => ({ ...p, linkedin: e.target.value }))}
                              />
                            </div>
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="WhatsApp"
                                value={newContact.whatsapp}
                                onChange={e => setNewContact(p => ({ ...p, whatsapp: e.target.value }))}
                              />
                            </div>
                            <div className="d-flex gap-2">
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={contactSaving}
                                onClick={addContact}
                              >
                                {contactSaving ? 'Salvando…' : 'Salvar'}
                              </button>
                              <button
                                className="btn btn-link btn-sm"
                                onClick={() => setAddContactVisible(false)}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        )}
                        {addContactVisible && (
                          <div className="mb-3 p-2 border rounded bg-light">
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="Nome *"
                                value={newContact.name}
                                onChange={e => setNewContact(p => ({ ...p, name: e.target.value }))}
                              />
                            </div>
                            <div className="mb-2">
                              <select
                                className="form-select form-select-sm"
                                value={newContact.role}
                                onChange={e => setNewContact(p => ({ ...p, role: e.target.value }))}
                              >
                                <option value="c_level">C-Level / Diretor</option>
                                <option value="manager">Gerente / Coordenador</option>
                                <option value="engineer">Engenheiro / TI</option>
                                <option value="other">Outro</option>
                              </select>
                            </div>
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="E-mail"
                                value={newContact.email}
                                onChange={e => setNewContact(p => ({ ...p, email: e.target.value }))}
                              />
                            </div>
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="LinkedIn URL"
                                value={newContact.linkedin}
                                onChange={e => setNewContact(p => ({ ...p, linkedin: e.target.value }))}
                              />
                            </div>
                            <div className="mb-2">
                              <input
                                className="form-control form-control-sm"
                                placeholder="WhatsApp"
                                value={newContact.whatsapp}
                                onChange={e => setNewContact(p => ({ ...p, whatsapp: e.target.value }))}
                              />
                            </div>
                            <div className="d-flex gap-2">
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={contactSaving}
                                onClick={addContact}
                              >
                                {contactSaving ? 'Salvando…' : 'Salvar'}
                              </button>
                              <button
                                className="btn btn-link btn-sm"
                                onClick={() => setAddContactVisible(false)}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        )}

                        {contacts.length === 0 ? (
                          <p className="text-muted small">Nenhum contato cadastrado.</p>
                        ) : (
                          contacts.map(c => (
                            <div
                              key={c.id}
                              style={{
                                background: '#f8f9fa',
                                border: '1px solid #dee2e6',
                                borderRadius: 8,
                                padding: 10,
                                marginBottom: 8,
                              }}
                            >
                              <div className="d-flex justify-content-between align-items-start">
                                <div>
                                  <strong>{c.name}</strong>
                                  {c.is_primary && (
                                    <span
                                      style={{
                                        background: '#eff4ff',
                                        color: '#1a44be',
                                        fontSize: '.7rem',
                                        padding: '.2em .5em',
                                        borderRadius: 4,
                                        marginLeft: 6,
                                      }}
                                    >
                                      Principal
                                    </span>
                                  )}
                                  <div className="text-muted small">{c.role}</div>
                                  {c.email && <div className="small"><i className="bi bi-envelope me-1" />{c.email}</div>}
                                  {c.whatsapp && <div className="small"><i className="bi bi-whatsapp me-1" />{c.whatsapp}</div>}
                                  {c.linkedin && (
                                    <div className="small">
                                      <a href={c.linkedin} target="_blank" rel="noreferrer">
                                        <i className="bi bi-linkedin me-1" />LinkedIn
                                      </a>
                                    </div>
                                  )}
                                </div>
                                <div className="d-flex flex-column gap-1">
                                  {!c.is_primary && (
                                    <button
                                      className="btn btn-outline-secondary btn-sm"
                                      style={{ fontSize: '.72rem' }}
                                      onClick={() => setPrimaryContact(c.id)}
                                      title="Definir como principal"
                                    >
                                      <i className="bi bi-star" />
                                    </button>
                                  )}
                                  <button
                                    className="btn btn-outline-danger btn-sm"
                                    style={{ fontSize: '.72rem' }}
                                    onClick={() => deleteContact(c.id)}
                                  >
                                    <i className="bi bi-trash" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* ── Info card ── */}
                    <div className="card mb-3">
                      <div className="card-header fw-bold">
                        <i className="bi bi-building me-1" />Informações
                      </div>
                      <div className="card-body" style={{ fontSize: '.9rem' }}>
                        {company && (
                          <table className="table table-sm table-borderless mb-0">
                            <tbody>
                              <tr><td className="text-muted">Status</td><td>{(() => {
                                const S = { new: ['secondary', 'Novo'], researched: ['info', 'Pesquisado'], sequence_created: ['primary', 'Sequência criada'], contacted: ['primary', 'Contactado'], hot_lead: ['danger', '🔥 Hot Lead'], needs_followup: ['warning text-dark', 'Aguard. follow-up'], meeting_set: ['success', '✅ Reunião'], opted_out: ['secondary', 'Opt-out'], rejected: ['secondary', 'Rejeitado'] };
                                if (!company.status) return '—';
                                const v = S[company.status] || ['secondary', company.status];
                                return <span className={`badge bg-${v[0]}`}>{v[1]}</span>;
                              })()}</td></tr>
                              <tr><td className="text-muted">Setor</td><td>{company.sector || '—'}</td></tr>
                              <tr>
                                <td className="text-muted">Score</td>
                                <td>
                                  <span className={`badge bg-${company.interest_score >= 7 ? 'danger' : company.interest_score >= 4 ? 'warning' : 'secondary'}`}>
                                    {company.interest_score ?? '—'}
                                  </span>
                                </td>
                              </tr>
                              <tr><td className="text-muted">País</td><td>{company.country || '—'}</td></tr>
                              <tr><td className="text-muted">Criado em</td><td>{company.created_at ? new Date(company.created_at).toLocaleDateString('pt-BR') : '—'}</td></tr>
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>

                    {/* ── Hand-off alert ── */}
                    {showHandoff && (
                      <div
                        style={{
                          background: '#fff3cd',
                          border: '2px solid #f0ad4e',
                          borderRadius: 8,
                          padding: 12,
                          marginBottom: 16,
                        }}
                      >
                        <strong>
                          <i className="bi bi-bell-fill text-warning me-1" />ALERTA DE HAND-OFF
                        </strong>
                        <p className="mb-0 mt-1 small">
                          Esta empresa demonstrou <strong>alto interesse</strong>. Recomenda-se transição imediata para atendimento humano.
                        </p>
                      </div>
                    )}

                    {/* ── Schedule card ── */}
                    <div className="card mb-3">
                      <div className="card-header fw-bold">
                        <i className="bi bi-calendar-check me-1" />Agendar Reunião
                      </div>
                      <div className="card-body">
                        {slots.length === 0 ? (
                          <p className="text-muted small">Nenhum slot disponível.</p>
                        ) : (
                          slots.slice(0, 5).map(s => (
                            <div key={s.id} className="d-flex justify-content-between align-items-center mb-2">
                              <span className="small">
                                {s.datetime
                                  ? new Date(s.datetime).toLocaleString('pt-BR')
                                  : s.label || s.id}
                              </span>
                              <button
                                className="btn btn-outline-success btn-sm"
                                disabled={s.booked || bookingSlot === s.id}
                                onClick={() => bookSlot(s.id)}
                              >
                                {s.booked ? 'Agendado' : bookingSlot === s.id ? '…' : 'Book'}
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* ── Sentiment History ── */}
                    <div className="card mb-3">
                      <div className="card-header fw-bold">
                        <i className="bi bi-graph-up me-1" />Histórico de Sentimentos
                      </div>
                      <div className="card-body">
                        {(company?.sentiments || []).length === 0 ? (
                          <p className="text-muted small">Nenhum registro.</p>
                        ) : (
                          (company.sentiments || []).map((s, i) => (
                            <div key={i} className="d-flex align-items-center gap-2 mb-1 small flex-wrap">
                              <span className="text-muted">{s.created_at ? new Date(s.created_at).toLocaleDateString('pt-BR') : ''}</span>
                              {sentimentBadge(s.sentiment)}
                              {s.interest_score != null && (
                                <span className="badge bg-info">Score: {s.interest_score}</span>
                              )}
                              {s.response_text && <span className="text-muted">"{s.response_text.slice(0, 40)}"</span>}
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* ── Timeline ── */}
                    <div className="card mb-3">
                      <div className="card-header fw-bold">
                        <i className="bi bi-clock-history me-1" />Linha do Tempo
                      </div>
                      <div className="card-body p-2" style={{ maxHeight: 300, overflowY: 'auto' }}>
                        {timeline.length === 0 ? (
                          <p className="text-muted small">Nenhum evento.</p>
                        ) : (
                          timeline.map((t, i) => (
                            <div
                              key={i}
                              style={{
                                display: 'flex',
                                gap: 10,
                                padding: '8px 0',
                                borderBottom: i < timeline.length - 1 ? '1px solid #f0f0f0' : 'none',
                              }}
                            >
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: '50%',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                  fontSize: '.85rem',
                                  background: '#e9ecef',
                                }}
                              >
                                <i className={`bi bi-${t.icon || 'circle'}`} />
                              </div>
                              <div>
                                <div className="small fw-semibold">{t.title || t.type}</div>
                                {t.description && <div className="text-muted" style={{ fontSize: '.8rem' }}>{t.description}</div>}
                                <div className="text-muted" style={{ fontSize: '.75rem' }}>
                                  {t.created_at ? new Date(t.created_at).toLocaleString('pt-BR') : ''}
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* ── Consent Log ── */}
                    <div className="card">
                      <div className="card-header fw-bold">
                        <i className="bi bi-journal-text me-1" />Log de Consentimento
                      </div>
                      <div className="card-body">
                        {(company?.consent_log || []).length === 0 ? (
                          <p className="text-muted small">Nenhum registro de consentimento.</p>
                        ) : (
                          (company.consent_log || []).map((entry, i) => (
                            <div key={i} className="small mb-1">
                              <span className="text-muted me-2">
                                {new Date(entry.created_at).toLocaleString('pt-BR')}
                              </span>
                              <span>{entry.action}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                  </div>
                  {/* ══ END RIGHT COLUMN ═════════════════════════════════ */}

                </div>
              )}
            </div>
            {/* ── END BODY ── */}

          </div>
        </div>
      </div>
    </>
  );
}
