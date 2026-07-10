import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import PropensityModal from './PropensityModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const API = '';

const STATUS_BADGES = {
  new: { cls: 'bg-secondary', label: 'Novo' },
  researched: { cls: 'bg-info', label: 'Pesquisado' },
  sequence_created: { cls: 'bg-primary', label: 'Sequência criada' },
  contacted: { cls: 'bg-primary', label: 'Contactado' },
  hot_lead: { cls: 'bg-danger', label: '🔥 Hot Lead' },
  meeting_set: { cls: 'bg-success', label: '✅ Reunião' },
  opted_out: { cls: 'bg-secondary', label: 'Opt-out' },
  rejected: { cls: 'bg-secondary', label: 'Rejeitado' },
};

const PAGE_SIZE = 15;

// Metadados dos 3 tipos de call (cold/warm/frozen) — usados em badges e seletores.
const CALL_META = {
  cold:   { label: '❄️ Cold', cls: 'bg-info-subtle text-info border-info-subtle', hint: 'Lead novo — o sistema busca internet + base de conhecimento antes de gerar a mensagem.' },
  warm:   { label: '🔥 Warm', cls: 'bg-warning-subtle text-warning-emphasis border-warning-subtle', hint: 'Lead qualificado — preencha o contexto abaixo; a mensagem usa exatamente essas informações (sem busca).' },
  frozen: { label: '🧊 Frozen', cls: 'bg-primary-subtle text-primary border-primary-subtle', hint: 'Lead que já conhece a empresa — mensagem de reconexão.' },
};
const callMeta = (t) => CALL_META[t] || CALL_META.cold;

// ── AddForm ────────────────────────────────────────────────────────────────────
export function AddForm({ onAdded, toast }) {
  const [form, setForm] = useState({
    companyName: '', sector: '',
    contactName: '', role: 'other', email: '', linkedin: '', whatsapp: '', country: 'BR', callType: 'cold',
  });
  const [loading, setLoading] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit() {
    if (!form.companyName.trim() || !form.contactName.trim()) {
      toast('Nome da empresa e do contato são obrigatórios', 'warning'); return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/companies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.companyName.trim(),
          sector: form.sector.trim(),
          contact_name: form.contactName.trim(),
          contact_role: form.role,
          contact_email: form.email.trim(),
          contact_linkedin: form.linkedin.trim(),
          contact_whatsapp: form.whatsapp.trim(),
          contact_country: form.country,
          contact_call_type: form.callType,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast('Empresa adicionada!', 'success');
      if (data.warning) toast(data.warning, 'warning');
      setForm({ companyName: '', sector: '', contactName: '', role: 'other', email: '', linkedin: '', whatsapp: '', country: 'BR', callType: 'cold' });
      onAdded();
    } catch (err) {
      toast(err.message || 'Erro ao adicionar', 'danger');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card p-3">
      <h6 className="fw-bold mb-3"><i className="bi bi-building-add me-1"></i>Nova Empresa</h6>
      <div className="mb-2">
        <input className="form-control form-control-sm" placeholder="Nome da empresa *" value={form.companyName} onChange={set('companyName')} />
      </div>
      <div className="mb-3">
        <input className="form-control form-control-sm" placeholder="Setor (ex: Fintech)" value={form.sector} onChange={set('sector')} />
      </div>

      <h6 className="fw-bold mb-2 mt-1"><i className="bi bi-person-plus me-1"></i>Primeiro Contato</h6>
      <div className="mb-2">
        <input className="form-control form-control-sm" placeholder="Nome do contato *" value={form.contactName} onChange={set('contactName')} />
      </div>
      <div className="mb-2">
        <select className="form-select form-select-sm" value={form.role} onChange={set('role')}>
          <option value="c_level">C-Level / Diretor</option>
          <option value="manager">Gerente / Coordenador</option>
          <option value="engineer">Engenheiro / TI</option>
          <option value="other">Outro</option>
        </select>
      </div>
      <div className="mb-2">
        <label className="form-label small text-muted mb-1">Tipo de call</label>
        <select className="form-select form-select-sm" value={form.callType} onChange={set('callType')}>
          <option value="cold">❄️ Cold — lead novo, sem vínculo (busca automática)</option>
          <option value="warm">🔥 Warm — lead qualificado (contexto manual)</option>
          <option value="frozen">🧊 Frozen — já conhece a empresa (reconexão)</option>
        </select>
        <div className="form-text small">
          {form.callType === 'cold' && 'O sistema pesquisará internet + base de conhecimento antes de gerar a mensagem.'}
          {form.callType === 'warm' && 'Preencha o contexto do lead manualmente; nenhuma busca automática será disparada.'}
          {form.callType === 'frozen' && 'Mensagem de reconexão: o lead já conhece a empresa.'}
        </div>
      </div>
      <div className="mb-2">
        <input className="form-control form-control-sm" placeholder="E-mail" type="email" value={form.email} onChange={set('email')} />
      </div>
      <div className="mb-2">
        <input className="form-control form-control-sm" placeholder="LinkedIn URL" value={form.linkedin} onChange={set('linkedin')} />
      </div>
      <div className="mb-3">
        <input className="form-control form-control-sm" placeholder="WhatsApp" value={form.whatsapp} onChange={set('whatsapp')} />
      </div>
      <div className="mb-2">
        <select className="form-select form-select-sm" value={form.country} onChange={set('country')}>
          <option value="BR">🇧🇷 Brasil (LGPD)</option>
          <option value="EU">🇪🇺 União Europeia (GDPR)</option>
          <option value="US">🇺🇸 Estados Unidos (CAN-SPAM)</option>
          <option value="OTHER">Outro país</option>
        </select>
      </div>
      <button className="btn btn-primary btn-sm w-100" onClick={handleSubmit} disabled={loading}>
        <i className="bi bi-plus-circle me-1"></i>{loading ? 'Adicionando...' : 'Adicionar'}
      </button>

      <CSVImport toast={toast} onAdded={onAdded} />
    </div>
  );
}

// ── CSVImport ──────────────────────────────────────────────────────────────────
function CSVImport({ toast, onAdded }) {
  const [csvResult, setCsvResult] = useState('');
  const [enrichResult, setEnrichResult] = useState('');
  const [excelResult, setExcelResult] = useState('');
  const [excelLoading, setExcelLoading] = useState(false);
  const [autoEnrich, setAutoEnrich] = useState(true);
  const csvRef = useRef();
  const enrichRef = useRef();
  const excelRef = useRef();

  // Importa planilha Excel (.xlsx). Lê o cabeçalho por nome (qualquer ordem),
  // mapeia as colunas e envia em massa — o backend agrupa contatos por empresa.
  async function importExcel() {
    const file = excelRef.current?.files[0];
    if (!file) { toast('Selecione um arquivo Excel (.xlsx)', 'warning'); return; }
    if (!window.XLSX) { toast('Leitor de Excel não carregou (verifique a conexão).', 'danger'); return; }
    setExcelLoading(true);
    setExcelResult('Lendo planilha...');
    try {
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
      const norm = (s) => String(s ?? '').trim().toLowerCase();

      // Acha a linha de cabeçalho (pula linhas em branco/título no topo)
      let headerIdx = aoa.findIndex((r) => r.some((c) => ['empresa', 'nome', 'email', 'e-mail', 'contato'].includes(norm(c))));
      if (headerIdx === -1) headerIdx = 0;
      const headers = aoa[headerIdx].map(norm);
      const col = (...names) => headers.findIndex((h) => names.includes(h));
      const idx = {
        company: col('empresa', 'company', 'cliente', 'empresa/cliente'),
        contact: col('nome', 'contato', 'contact', 'nome do contato'),
        role: col('cargo', 'title', 'função', 'funcao', 'titulo'),
        email: col('email', 'e-mail'),
        whatsapp: col('whatsapp', 'telefone', 'celular', 'fone'),
        sector: col('setor', 'segmento', 'indústria', 'industria'),
      };
      if (idx.company === -1 && idx.contact === -1) {
        setExcelResult('❌ Não encontrei colunas "Empresa"/"Nome" no cabeçalho.');
        setExcelLoading(false); return;
      }
      const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
      const rows = [];
      for (let i = headerIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const company = get(r, 'company');
        const contact = get(r, 'contact');
        if (!company && !contact) continue;
        rows.push({ company, contact_name: contact, role: get(r, 'role'), email: get(r, 'email'), whatsapp: get(r, 'whatsapp'), sector: get(r, 'sector') });
      }
      if (!rows.length) { setExcelResult('❌ Nenhuma linha de dados encontrada.'); setExcelLoading(false); return; }

      setExcelResult(`Importando ${rows.length} linha(s)...`);
      const res = await fetch(`${API}/api/companies/import-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, import_source: file.name }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      const semContato = d.companies_without_contact || 0;
      setExcelResult(
        `✅ ${d.companies_created} empresa(s), ${d.contacts_created} contato(s)${d.skipped ? `, ${d.skipped} ignorado(s)` : ''}` +
        (semContato > 0 ? `\n⚠️ ${semContato} empresa(s) importada(s) sem contato — use "Enriquecer sem e-mail" ou clique em ⭐ na linha da empresa.` : '')
      );
      onAdded();
    } catch (err) {
      setExcelResult('❌ ' + (err.message || 'Erro ao importar'));
    } finally {
      setExcelLoading(false);
    }
  }

  async function importCSV() {
    const file = csvRef.current?.files[0];
    if (!file) { toast('Selecione um arquivo CSV', 'warning'); return; }
    const text = await file.text();
    const lines = text.trim().split('\n').slice(1);
    let ok = 0, fail = 0;
    for (const line of lines) {
      const [empresa, setor, contato, cargo, email, whatsapp] = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      if (!empresa) continue;
      try {
        const res = await fetch(`${API}/api/companies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: empresa, sector: setor || '', contact_name: contato || '', contact_role: cargo || 'other', contact_email: email || '', contact_whatsapp: whatsapp || '' }),
        });
        const d = await res.json();
        if (d.error) fail++; else ok++;
      } catch { fail++; }
    }
    setCsvResult(`✅ ${ok} importadas, ❌ ${fail} falhas`);
    if (ok > 0) onAdded();
  }

  async function importAndEnrich() {
    const file = enrichRef.current?.files[0];
    if (!file) { toast('Selecione um arquivo CSV', 'warning'); return; }
    const text = await file.text();
    const lines = text.trim().split('\n').slice(1);
    let ok = 0, fail = 0;
    const ids = [];
    for (const line of lines) {
      const [nome, empresa] = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      if (!nome && !empresa) continue;
      try {
        const res = await fetch(`${API}/api/companies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: empresa || nome, sector: '', contact_name: nome || '', contact_role: 'other' }),
        });
        const d = await res.json();
        if (d.error) { fail++; } else { ok++; if (d.id) ids.push(d.id); }
      } catch { fail++; }
    }
    if (autoEnrich && ids.length > 0) {
      try {
        await fetch(`${API}/api/contacts/bulk-enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_ids: ids }),
        });
      } catch { /* ignore */ }
    }
    setEnrichResult(`✅ ${ok} importadas${autoEnrich ? ' e enriquecidas' : ''}, ❌ ${fail} falhas`);
    if (ok > 0) onAdded();
  }

  return (
    <>
      <hr />
      <h6 className="fw-bold mb-2"><i className="bi bi-file-earmark-spreadsheet me-1"></i>Importar CSV</h6>
      <p className="small text-muted mb-2">Colunas: empresa, setor, contato, cargo, email, whatsapp</p>
      <input type="file" ref={csvRef} accept=".csv" className="form-control form-control-sm mb-2" />
      <button className="btn btn-outline-primary btn-sm w-100" onClick={importCSV}>Importar</button>
      {csvResult && <div className="mt-2 small text-muted">{csvResult}</div>}

      <hr />
      <h6 className="fw-bold mb-2"><i className="bi bi-person-lines-fill me-1"></i>Importar Lista (nome + empresa)</h6>
      <p className="small text-muted mb-2">Colunas: <code>nome, empresa</code> — o sistema buscará e-mail e telefone automaticamente</p>
      <input type="file" ref={enrichRef} accept=".csv" className="form-control form-control-sm mb-2" />
      <div className="form-check mb-2">
        <input className="form-check-input" type="checkbox" id="auto-enrich-check" checked={autoEnrich} onChange={(e) => setAutoEnrich(e.target.checked)} />
        <label className="form-check-label small" htmlFor="auto-enrich-check">Enriquecer automaticamente após importar</label>
      </div>
      <button className="btn btn-outline-success btn-sm w-100" onClick={importAndEnrich}>
        <i className="bi bi-search me-1"></i>Importar e Enriquecer
      </button>
      {enrichResult && <div className="mt-2 small text-muted">{enrichResult}</div>}

      <hr />
      <h6 className="fw-bold mb-2"><i className="bi bi-file-earmark-excel me-1"></i>Importar Excel (.xlsx)</h6>
      <p className="small text-muted mb-2">Lê o cabeçalho automaticamente (Empresa, Nome, Cargo, Email, WhatsApp). Agrupa contatos da mesma empresa.</p>
      <input type="file" ref={excelRef} accept=".xlsx,.xls" className="form-control form-control-sm mb-2" />
      <button className="btn btn-outline-primary btn-sm w-100" onClick={importExcel} disabled={excelLoading}>
        <i className="bi bi-upload me-1"></i>{excelLoading ? 'Importando...' : 'Importar Excel'}
      </button>
      {excelResult && <div className="mt-2 small text-muted">{excelResult}</div>}
    </>
  );
}

// ── FiltersBar ─────────────────────────────────────────────────────────────────
function FiltersBar({ filters, setFilters, sectors, importSources, count, flagCatalog, user }) {
  return (
    <div className="d-flex gap-2 mb-2 flex-wrap align-items-center">
      <input
        className="form-control form-control-sm"
        style={{ maxWidth: 220 }}
        placeholder="🔍 Buscar empresa..."
        value={filters.search}
        onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
      />
      <select
        className="form-select form-select-sm"
        style={{ maxWidth: 160 }}
        value={filters.status}
        onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
      >
        <option value="">Todos os status</option>
        <option value="new">Novo</option>
        <option value="researched">Pesquisado</option>
        <option value="sequence_created">Sequência criada</option>
        <option value="contacted">Contactado</option>
        <option value="hot_lead">🔥 Hot Lead</option>
        <option value="meeting_set">✅ Reunião</option>
        <option value="opted_out">Opt-out</option>
      </select>
      <select
        className="form-select form-select-sm"
        style={{ maxWidth: 160 }}
        value={filters.sector}
        onChange={(e) => setFilters((f) => ({ ...f, sector: e.target.value }))}
      >
        <option value="">Todos os setores</option>
        {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {importSources.length > 0 && (
        <select
          className="form-select form-select-sm"
          style={{ maxWidth: 220 }}
          value={filters.importSource}
          onChange={(e) => setFilters((f) => ({ ...f, importSource: e.target.value }))}
        >
          <option value="">Todas as origens</option>
          {importSources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
      <select
        className="form-select form-select-sm"
        style={{ maxWidth: 180 }}
        value={filters.flag}
        onChange={(e) => setFilters((f) => ({ ...f, flag: e.target.value }))}
      >
        <option value="">Todas as etiquetas</option>
        {(flagCatalog || []).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      <div className="form-check form-check-inline mb-0">
        <input
          className="form-check-input"
          type="checkbox"
          id="filtroSemContato"
          checked={filters.semContato}
          onChange={(e) => setFilters((f) => ({ ...f, semContato: e.target.checked }))}
        />
        <label className="form-check-label small" htmlFor="filtroSemContato">Sem contato</label>
      </div>
      {user?.username && (
        <button
          className={`btn btn-sm ${filters.mine ? 'btn-primary' : 'btn-outline-primary'}`}
          onClick={() => setFilters((f) => ({ ...f, mine: !f.mine }))}
          title="Mostrar apenas os leads que eu criei"
        >
          <i className="bi bi-person-check me-1"></i>Meus leads
        </button>
      )}
      <button
        className="btn btn-outline-secondary btn-sm"
        onClick={() => setFilters({ search: '', status: '', sector: '', importSource: '', flag: '', semContato: false, mine: false })}
      >
        ✕ Limpar
      </button>
      {count !== null && <span className="text-muted small">{count} empresa(s)</span>}
    </div>
  );
}

// ── BulkToolbar ────────────────────────────────────────────────────────────────
function BulkToolbar({ selected, onClear, onBulkResearch, onBulkMessages, onBulkPropensity, onBulkStatus }) {
  const count = selected.length;
  if (count === 0) return null;

  return (
    <div className="alert alert-secondary py-2 px-3 mb-2 d-flex align-items-center gap-2 flex-wrap">
      <span className="small fw-bold me-1">{count} selecionada(s)</span>
      <button className="btn btn-sm btn-outline-primary" onClick={onBulkResearch}>
        <i className="bi bi-search me-1"></i>Gerar Pesquisa IA
      </button>
      <button className="btn btn-sm btn-success fw-semibold" onClick={onBulkMessages} title="Selecione um produto por lead e gere mensagens personalizadas para todos de uma vez">
        <i className="bi bi-envelope-paper me-1"></i>Gerar Mensagens por Produto
      </button>
      <button className="btn btn-sm btn-warning fw-semibold" onClick={onBulkPropensity} title="Analisa propensão de compra e sugere as melhores dores para cada lead selecionado">
        <i className="bi bi-graph-up-arrow me-1"></i>Analisar Propensão &amp; Gerar em Lote
      </button>
      <div className="dropdown">
        <button className="btn btn-sm btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown">
          <i className="bi bi-arrow-repeat me-1"></i>Mudar Status
        </button>
        <ul className="dropdown-menu">
          {[['new', 'Novo'], ['contacted', 'Contactado'], ['hot_lead', '🔥 Hot Lead'], ['meeting_set', '✅ Reunião'], ['rejected', 'Rejeitado']].map(([v, l]) => (
            <li key={v}><button className="dropdown-item" onClick={() => onBulkStatus(v)}>{l}</button></li>
          ))}
        </ul>
      </div>
      <button className="btn btn-sm btn-link text-secondary ms-auto py-0" onClick={onClear}>✕ Limpar seleção</button>
    </div>
  );
}

// Rótulo legível para a categoria do cargo (usado quando não há o cargo original da planilha)
const ROLE_LABEL = { c_level: 'C-Level / Diretor', manager: 'Gerente / Coordenador', engineer: 'Engenheiro / TI', other: 'Outro' };
const cargoDe = (c) => (c && (c.title && c.title.trim())) ? c.title : (ROLE_LABEL[c?.role] || c?.role || '');

// ── ContactCard (contato + contexto pessoal do lead) ────────────────────────────
function ContactCard({ contact, companyId, onEnrich, onRemove, onStartConversation, toast }) {
  const [savedCtx, setSavedCtx] = useState(contact.context || '');
  const [ctx, setCtx]           = useState(contact.context || '');
  const [open, setOpen]         = useState(false);
  const [saving, setSaving]     = useState(false);
  const [callType, setCallType] = useState(contact.call_type || 'cold');
  const [logs, setLogs]         = useState(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  const hasContext = !!(savedCtx && savedCtx.trim());

  async function toggleLogs() {
    if (logsOpen) { setLogsOpen(false); return; }
    setLogsOpen(true);
    setLogsLoading(true);
    try {
      const res = await fetch(`${API}/api/contacts/${contact.id}/search-logs`);
      const d = await res.json();
      setLogs(Array.isArray(d) ? d : []);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }

  async function saveCallType(newType) {
    setCallType(newType);
    try {
      const res = await fetch(`${API}/api/contacts/${contact.id}/call-type`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_type: newType }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast(`Tipo de call: ${CALL_META[newType].label}`, 'success');
    } catch (err) {
      toast(err.message || 'Erro ao salvar tipo de call', 'danger');
    }
  }

  async function saveContext() {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/contacts/${contact.id}/context`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctx }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setSavedCtx(ctx);
      toast('Contexto do lead salvo!', 'success');
      setOpen(false);
    } catch (err) {
      toast(err.message || 'Erro ao salvar contexto', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-2 p-2 rounded" style={{ background: '#fff', border: '1px solid #dee2e6' }}>
      <div className="d-flex align-items-start justify-content-between">
        <div>
          <div className="fw-semibold small">
            {contact.name}
            {!contact.email && !contact.whatsapp && !contact.linkedin && (
              <span className="badge bg-warning text-dark ms-2" style={{ fontSize: '.65rem' }}>sem contato</span>
            )}
            {hasContext && (
              <span className="badge bg-success-subtle text-success border border-success-subtle ms-2" style={{ fontSize: '.65rem' }} title="Contexto do lead cadastrado">
                <i className="bi bi-person-lines-fill me-1"></i>com contexto
              </span>
            )}
            <span className={`badge border ms-2 ${CALL_META[callType].cls}`} style={{ fontSize: '.65rem' }} title={CALL_META[callType].hint}>
              {CALL_META[callType].label}
            </span>
          </div>
          {cargoDe(contact) && <div className="text-muted" style={{ fontSize: '.78rem' }}><i className="bi bi-briefcase me-1"></i>{cargoDe(contact)}</div>}
          {contact.email && <div className="text-muted" style={{ fontSize: '.78rem' }}><i className="bi bi-envelope me-1"></i>{contact.email}</div>}
          {contact.whatsapp && <div className="text-muted" style={{ fontSize: '.78rem' }}><i className="bi bi-whatsapp me-1"></i>{contact.whatsapp}</div>}
          {contact.linkedin && <div className="text-muted" style={{ fontSize: '.78rem' }}><i className="bi bi-linkedin me-1"></i><a href={contact.linkedin} target="_blank" rel="noreferrer">LinkedIn</a></div>}
          {contact.import_source && (
            <div className="text-muted" style={{ fontSize: '.72rem' }}>
              <i className="bi bi-file-earmark-spreadsheet me-1"></i>{contact.import_source}
            </div>
          )}
        </div>
        <div className="d-flex gap-1 ms-2">
          <button className="btn btn-sm btn-outline-secondary btn-xs-touch" onClick={() => onEnrich(contact.id)} title="Enriquecer">
            <i className="bi bi-search"></i>
          </button>
          <button className="btn btn-sm btn-outline-danger btn-xs-touch" onClick={() => onRemove(companyId, contact.id)} title="Remover">
            <i className="bi bi-trash"></i>
          </button>
        </div>
      </div>

      <button
        className="btn btn-sm w-100 mt-2 text-white fw-semibold"
        style={{ fontSize: '.75rem', background: '#25d366' }}
        onClick={() => onStartConversation && onStartConversation(companyId, contact.id)}
        title="Abrir a conversa de WhatsApp com este lead"
      >
        <i className="bi bi-whatsapp me-1"></i>Iniciar conversa
      </button>

      <div className="mt-2">
        <label className="form-label small text-muted mb-1">Tipo de call</label>
        <select className="form-select form-select-sm" value={callType} onChange={(e) => saveCallType(e.target.value)}>
          <option value="cold">❄️ Cold — lead novo (busca automática)</option>
          <option value="warm">🔥 Warm — qualificado (contexto manual)</option>
          <option value="frozen">🧊 Frozen — já conhece a empresa</option>
        </select>
        <div className="form-text small">{CALL_META[callType].hint}</div>
      </div>

      {callType === 'cold' && (
        <div className="mt-2">
          <button className="btn btn-sm btn-outline-info w-100" style={{ fontSize: '.75rem' }} onClick={toggleLogs}>
            <i className="bi bi-search me-1"></i>{logsOpen ? 'Ocultar buscas da IA' : 'Ver buscas da IA (internet + base)'}
          </button>
          {logsOpen && (
            <div className="mt-2 p-2 rounded" style={{ background: '#f8f9fa', border: '1px solid #dee2e6', fontSize: '.72rem' }}>
              {logsLoading && <div className="text-muted">Carregando...</div>}
              {!logsLoading && logs && logs.length === 0 && (
                <div className="text-muted">Nenhuma busca registrada ainda. Gere a sequência para disparar a pesquisa.</div>
              )}
              {!logsLoading && logs && logs.map((l) => (
                <div key={l.id} className="mb-1 pb-1 border-bottom">
                  <span className={`badge ${l.source === 'web' ? 'bg-info-subtle text-info' : 'bg-secondary-subtle text-secondary'} me-1`}>
                    {l.source === 'web' ? '🌐 internet' : '📚 base'}
                  </span>
                  <span className="text-muted">{l.created_at}</span>
                  <div><strong>Query:</strong> {l.query}</div>
                  {l.result_summary && <div className="text-muted"><strong>Resultado:</strong> {l.result_summary}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        className={`btn btn-sm ${hasContext ? 'btn-outline-primary' : 'btn-outline-secondary'} w-100 mt-2`}
        style={{ fontSize: '.75rem' }}
        onClick={() => { setCtx(savedCtx); setOpen((o) => !o); }}
      >
        <i className={`bi ${hasContext ? 'bi-person-lines-fill' : 'bi-person-plus'} me-1`}></i>
        {open ? 'Fechar contexto' : hasContext ? 'Ver / editar contexto do lead' : 'Adicionar contexto do lead'}
      </button>

      {open && (
        <div className="mt-2">
          <textarea
            className="form-control form-control-sm"
            rows={4}
            placeholder="Quem é essa pessoa, como falar com ela, o que importa pra ela, histórico de interações... (usado para personalizar o gancho que a IA gera e para lembrar quem é o lead)"
            value={ctx}
            onChange={(e) => setCtx(e.target.value)}
          />
          <div className="d-flex gap-2 mt-1">
            <button className="btn btn-primary btn-sm" onClick={saveContext} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar contexto'}
            </button>
            <button className="btn btn-outline-secondary btn-sm" onClick={() => { setCtx(savedCtx); setOpen(false); }} disabled={saving}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ExpandedRow ────────────────────────────────────────────────────────────────
// Painel de histórico/contagem de abordagens (cold/warm/frozen) disparadas para a empresa.
// Os totais já vêm na listagem (company.cold_calls/warm_calls/frozen_calls);
// o histórico detalhado é carregado sob demanda via /api/companies/:id/call-stats.
function CallHistoryPanel({ company }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);

  const counts = {
    cold: company.cold_calls || 0,
    warm: company.warm_calls || 0,
    frozen: company.frozen_calls || 0,
  };
  const total = counts.cold + counts.warm + counts.frozen;

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (history) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/companies/${company.id}/call-stats`);
      const d = await res.json();
      setHistory(d && Array.isArray(d.history) ? d.history : []);
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-2 p-2 border rounded bg-white">
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <span className="fw-bold small"><i className="bi bi-clock-history me-1"></i>Abordagens disparadas</span>
        {['cold', 'warm', 'frozen'].map((t) => {
          const m = callMeta(t);
          return (
            <span key={t} className={`badge border ${m.cls}`} style={{ fontSize: '.65rem' }} title={m.hint}>
              {m.label}: {counts[t]}
            </span>
          );
        })}
        <button className="btn btn-link btn-sm p-0 ms-auto" onClick={toggle} disabled={total === 0}>
          {open ? 'Ocultar histórico' : 'Ver histórico'}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          {loading && <div className="small text-muted">Carregando…</div>}
          {!loading && history && history.length === 0 && (
            <div className="small text-muted">Nenhuma abordagem disparada ainda.</div>
          )}
          {!loading && history && history.length > 0 && (
            <ul className="list-unstyled small mb-0" style={{ maxHeight: 180, overflowY: 'auto' }}>
              {history.map((h, i) => {
                const m = callMeta(h.call_type);
                return (
                  <li key={i} className="d-flex justify-content-between border-bottom py-1">
                    <span>
                      <span className={`badge border me-1 ${m.cls}`} style={{ fontSize: '.6rem' }}>{m.label}</span>
                      {h.contact_name || 'Contato removido'}
                    </span>
                    <span className="text-muted">{h.created_at}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedRow({ company, onEnrich, onFindContact, onRemoveContact, onContactAdded, onStartConversation, toast }) {
  const [addForm, setAddForm] = useState({ name: '', role: 'other', email: '', whatsapp: '', linkedin: '', country: 'BR', callType: 'cold' });
  const [adding, setAdding] = useState(false);
  const set = (k) => (e) => setAddForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleAddContact() {
    if (!addForm.name.trim()) { toast('Nome do contato obrigatório', 'warning'); return; }
    setAdding(true);
    try {
      const res = await fetch(`${API}/api/companies/${company.id}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addForm.name.trim(),
          role: addForm.role,
          email: addForm.email.trim(),
          whatsapp: addForm.whatsapp.trim(),
          linkedin: addForm.linkedin.trim(),
          country: addForm.country,
          call_type: addForm.callType,
        }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast('Contato adicionado!', 'success');
      if (d.warning) toast(d.warning, 'warning');
      setAddForm({ name: '', role: 'other', email: '', whatsapp: '', linkedin: '', country: 'BR', callType: 'cold' });
      onContactAdded();
    } catch (err) {
      toast(err.message || 'Erro', 'danger');
    } finally {
      setAdding(false);
    }
  }

  const contacts = company.contacts || [];

  return (
    <div style={{ background: '#f8f9fa', padding: '12px 16px', borderTop: '1px solid #dee2e6' }}>
      <CallHistoryPanel company={company} />
      <div className="d-flex gap-3 flex-wrap">
        <div style={{ flex: 1, minWidth: 300 }}>
          <p className="fw-bold small mb-2"><i className="bi bi-people me-1"></i>Contatos ({contacts.length})</p>
          {contacts.length === 0 && (
            <div className="text-center py-3">
              <i className="bi bi-person-x fs-3 text-muted d-block mb-2"></i>
              <p className="text-muted small mb-2">Nenhum contato cadastrado.</p>
              <button
                className="btn btn-warning btn-sm"
                onClick={() => onFindContact(company.id)}
                title="Buscar contato na internet para esta empresa"
              >
                <i className="bi bi-stars me-1"></i>Enriquecer — buscar contato na internet
              </button>
            </div>
          )}
          {contacts.length > 0 && (
            <button
              className="btn btn-outline-warning btn-sm mb-2"
              onClick={() => onFindContact(company.id)}
              title="Buscar mais um contato na internet para esta empresa"
            >
              <i className="bi bi-stars me-1"></i>Buscar outro contato na internet
            </button>
          )}
          {contacts.map((ct) => (
            <ContactCard
              key={ct.id}
              contact={ct}
              companyId={company.id}
              onEnrich={onEnrich}
              onRemove={onRemoveContact}
              onStartConversation={onStartConversation}
              toast={toast}
            />
          ))}
        </div>
        <div style={{ minWidth: 280 }}>
          <p className="fw-bold small mb-2"><i className="bi bi-person-plus me-1"></i>Novo Contato</p>
          <input className="form-control form-control-sm mb-1" placeholder="Nome *" value={addForm.name} onChange={set('name')} />
          <select className="form-select form-select-sm mb-1" value={addForm.role} onChange={set('role')}>
            <option value="c_level">C-Level / Diretor</option>
            <option value="manager">Gerente / Coordenador</option>
            <option value="engineer">Engenheiro / TI</option>
            <option value="other">Outro</option>
          </select>
          <select className="form-select form-select-sm mb-1" value={addForm.callType} onChange={set('callType')} title="Tipo de call">
            <option value="cold">❄️ Cold — lead novo (busca automática)</option>
            <option value="warm">🔥 Warm — qualificado (contexto manual)</option>
            <option value="frozen">🧊 Frozen — já conhece a empresa</option>
          </select>
          <input className="form-control form-control-sm mb-1" placeholder="E-mail" type="email" value={addForm.email} onChange={set('email')} />
          <input className="form-control form-control-sm mb-1" placeholder="WhatsApp" value={addForm.whatsapp} onChange={set('whatsapp')} />
          <input className="form-control form-control-sm mb-1" placeholder="LinkedIn URL" value={addForm.linkedin} onChange={set('linkedin')} />
          <select className="form-select form-select-sm mb-2" value={addForm.country} onChange={set('country')}>
            <option value="BR">🇧🇷 Brasil (LGPD)</option>
            <option value="EU">🇪🇺 União Europeia (GDPR)</option>
            <option value="US">🇺🇸 Estados Unidos (CAN-SPAM)</option>
            <option value="OTHER">Outro país</option>
          </select>
          <button className="btn btn-primary btn-sm w-100" onClick={handleAddContact} disabled={adding}>
            {adding ? 'Adicionando...' : 'Adicionar Contato'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── CompanyRow ─────────────────────────────────────────────────────────────────
function CompanyRow({ company, selected, onToggle, expanded, onToggleExpand, onEnrich, onFindContact, onRemoveContact, onRemoveCompany, onContactAdded, onStartConversation, toast, flagMap }) {
  const badge = STATUS_BADGES[company.status] || STATUS_BADGES.new;
  const contacts = company.contacts || [];

  return (
    <>
      <tr style={selected ? { background: '#f0edff' } : {}}>
        <td>
          <input type="checkbox" checked={selected} onChange={() => onToggle(company.id)} />
        </td>
        <td>
          <button
            className="btn btn-xs p-0 border-0 bg-transparent"
            style={{ fontSize: '.85rem' }}
            onClick={() => onToggleExpand(company.id)}
            title="Expandir contatos"
          >
            <i className={`bi ${expanded ? 'bi-chevron-down' : 'bi-chevron-right'}`}></i>
          </button>
        </td>
        <td className="fw-semibold">
          {company.name}
          {company.has_prior_relationship && (
            <i className="bi bi-link-45deg text-warning ms-1" title="Relacionamento prévio — contato existente na base"></i>
          )}
          {(company.created_by_name || company.created_by_username) && (
            <div className="text-muted fw-normal" style={{ fontSize: '.68rem' }}>
              <i className="bi bi-person me-1"></i>criado por {company.created_by_name || company.created_by_username}
            </div>
          )}
          {(company.flags || []).length > 0 && (
            <div className="mt-1">
              {(company.flags || []).map((k) => {
                const info = (flagMap && flagMap[k]) || { label: k, badge: 'bg-secondary' };
                return <span key={k} className={`badge ${info.badge} me-1`} style={{ fontSize: '.65rem' }}>{info.label}</span>;
              })}
            </div>
          )}
        </td>
        <td className="text-muted small d-none d-md-table-cell">{company.sector || '—'}</td>
        <td className="d-none d-sm-table-cell">
          <span className="badge" style={{ background: '#eff4ff', color: '#1a44be', fontSize: '.75rem' }}>
            {contacts.length}
          </span>
          {['cold', 'warm', 'frozen'].map((t) => {
            const n = contacts.filter((c) => (c.call_type || 'cold') === t).length;
            if (!n) return null;
            const m = callMeta(t);
            return (
              <span key={t} className={`badge border ms-1 ${m.cls}`} style={{ fontSize: '.6rem' }} title={`${n} ${m.label}`}>
                {m.label.split(' ')[0]}{n > 1 ? ` ${n}` : ''}
              </span>
            );
          })}
        </td>
        <td>
          <span className={`badge ${badge.cls}`} style={{ fontSize: '.75rem' }}>{badge.label}</span>
        </td>
        <td className="text-center d-none d-sm-table-cell">
          {company.interest_score != null ? (
            <span className="fw-bold text-warning">{company.interest_score}</span>
          ) : '—'}
        </td>
        <td>
          <div className="d-flex gap-1">
            {contacts.length === 0 && (
              <button
                className="btn btn-sm btn-warning btn-xs-touch"
                onClick={() => onFindContact(company.id)}
                title="Enriquecer: buscar contato na internet"
              >
                <i className="bi bi-stars"></i>
              </button>
            )}
            <button
              className="btn btn-sm btn-outline-danger btn-xs-touch"
              onClick={() => onRemoveCompany(company.id, company.name)}
              title="Remover empresa"
            >
              <i className="bi bi-trash"></i>
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ padding: 0 }}>
            <ExpandedRow
              company={company}
              onEnrich={onEnrich}
              onFindContact={onFindContact}
              onRemoveContact={onRemoveContact}
              onContactAdded={onContactAdded}
              onStartConversation={onStartConversation}
              toast={toast}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── GlobalContactSearch ────────────────────────────────────────────────────────
function GlobalContactSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [show, setShow] = useState(false);
  const debounceRef = useRef();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); setShow(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/api/contacts?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(data.contacts || data || []);
        setShow(true);
      } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function clear() { setQuery(''); setResults([]); setShow(false); }

  return (
    <div className="mb-2">
      <div className="input-group input-group-sm" style={{ maxWidth: 350 }}>
        <span className="input-group-text"><i className="bi bi-person-search"></i></span>
        <input
          className="form-control"
          placeholder="Buscar contato por nome ou e-mail..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-outline-secondary" onClick={clear}>✕</button>
      </div>
      {show && results.length > 0 && (
        <div
          className="mt-1 border rounded p-2 bg-white shadow-sm"
          style={{ maxWidth: 350, maxHeight: 250, overflowY: 'auto', position: 'absolute', zIndex: 100 }}
        >
          {results.map((ct) => (
            <div key={ct.id} className="py-1 border-bottom small">
              <span className="fw-semibold">{ct.name}</span>
              {ct.email && <span className="text-muted ms-2">{ct.email}</span>}
              {ct.company_name && <span className="badge bg-light text-dark ms-2" style={{ fontSize: '.7rem' }}>{ct.company_name}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Companies Component ───────────────────────────────────────────────────
export default function Companies({ toast, loadStats, refreshData, onOpenWhatsApp }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [expanded, setExpanded] = useState([]);
  const [filters, setFilters] = useState({ search: '', status: '', sector: '', importSource: '', flag: '', semContato: false, mine: false });
  const [page, setPage] = useState(1);
  const [sectors, setSectors] = useState([]);
  const [importSources, setImportSources] = useState([]);
  const [flagCatalog, setFlagCatalog] = useState([]);
  const [bulkModal, setBulkModal] = useState(null); // { mode, ids }
  const flagMap = Object.fromEntries((flagCatalog || []).map((f) => [f.key, f]));

  useEffect(() => {
    fetch(`${API}/api/flags`)
      .then((r) => r.json())
      .then((d) => setFlagCatalog(Array.isArray(d) ? d : []))
      .catch(() => setFlagCatalog([]));
  }, []);

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/companies`);
      const data = await res.json();
      const list = data.companies || data || [];
      setCompanies(list);
      const uniqueSectors = [...new Set(list.map((c) => c.sector).filter(Boolean))].sort();
      setSectors(uniqueSectors);
      const uniqueSources = [...new Set(list.map((c) => c.import_source).filter(Boolean))].sort();
      setImportSources(uniqueSources);
    } catch (err) {
      toast('Erro ao carregar empresas', 'danger');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  // Filtering
  const filtered = companies.filter((c) => {
    if (filters.search && !c.name?.toLowerCase().includes(filters.search.toLowerCase()) && !c.sector?.toLowerCase().includes(filters.search.toLowerCase())) return false;
    if (filters.status && c.status !== filters.status) return false;
    if (filters.sector && c.sector !== filters.sector) return false;
    if (filters.importSource && c.import_source !== filters.importSource) return false;
    if (filters.flag && !(c.flags || []).includes(filters.flag)) return false;
    if (filters.semContato && (c.contacts || []).length > 0) return false;
    if (filters.mine && user?.username && c.created_by_username !== user.username) return false;
    return true;
  });

  // Pagination
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function handleToggle(id) {
    setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  }

  function handleSelectAll(checked) {
    setSelected(checked ? paginated.map((c) => c.id) : []);
  }

  function handleToggleExpand(id) {
    setExpanded((e) => e.includes(id) ? e.filter((x) => x !== id) : [...e, id]);
  }

  async function handleEnrichContact(contactId) {
    try {
      const res = await fetch(`${API}/api/contacts/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast('Contato enriquecido!', 'success');
      loadCompanies();
    } catch (err) {
      toast(err.message || 'Erro ao enriquecer', 'danger');
    }
  }

  async function handleFindContact(companyId) {
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/find-contact`, { method: 'POST' });
      const d = await res.json();
      if (d.status === 'already_exists') { toast(d.message || 'Contato já cadastrado', 'info'); return; }
      if (!d.ok) { toast(d.error || 'Nenhum contato encontrado pelo Apollo', 'warning'); return; }
      const src = d.source === 'apollo' ? 'Apollo.io' : 'IA (sugestão)';
      toast(`Contato encontrado via ${src}: ${d.contact.name}`, 'success');
      loadCompanies();
      if (loadStats) loadStats();
    } catch (err) {
      toast(err.message || 'Erro ao buscar contato', 'danger');
    }
  }

  async function handleRemoveContact(companyId, contactId) {
    if (!window.confirm('Remover contato?')) return;
    try {
      const res = await fetch(`${API}/api/companies/${companyId}/contacts/${contactId}`, { method: 'DELETE' });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast('Contato removido', 'success');
      loadCompanies();
      if (loadStats) loadStats();
      if (refreshData) refreshData();
    } catch (err) {
      toast(err.message || 'Erro ao remover', 'danger');
    }
  }

  async function handleRemoveCompany(companyId, companyName) {
    if (!window.confirm(`Remover a empresa "${companyName}" e todos os seus contatos? Esta ação não pode ser desfeita.`)) return;
    try {
      const res = await fetch(`${API}/api/companies/${companyId}`, { method: 'DELETE' });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast('Empresa removida', 'success');
      loadCompanies();
      if (loadStats) loadStats();
      if (refreshData) refreshData();
    } catch (err) {
      toast(err.message || 'Erro ao remover empresa', 'danger');
    }
  }

  async function bulkResearch() {
    if (selected.length === 0) return;
    try {
      const res = await fetch(`${API}/api/companies/bulk-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_ids: selected }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast(`Pesquisa IA iniciada para ${selected.length} empresa(s)`, 'success');
      loadCompanies();
      if (loadStats) loadStats();
    } catch (err) {
      toast(err.message || 'Erro', 'danger');
    }
  }

  function openBulkDirectModal() {
    if (!selected.length) { toast('Selecione ao menos um cliente.', 'warning'); return; }
    setBulkModal({ mode: 'direct', ids: [...selected] });
  }

  function openPropensityModal() {
    if (!selected.length) { toast('Selecione ao menos um cliente.', 'warning'); return; }
    setBulkModal({ mode: 'propensity', ids: [...selected] });
  }

  async function bulkStatus(status) {
    if (selected.length === 0) return;
    try {
      const res = await fetch(`${API}/api/companies/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_ids: selected, status }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast(`Status atualizado para ${selected.length} empresa(s)`, 'success');
      setSelected([]);
      loadCompanies();
      if (loadStats) loadStats();
    } catch (err) {
      toast(err.message || 'Erro', 'danger');
    }
  }

  async function bulkEnrichMissing() {
    try {
      const res = await fetch(`${API}/api/contacts/bulk-enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast('Enriquecimento em lote iniciado!', 'success');
      loadCompanies();
    } catch (err) {
      toast(err.message || 'Erro', 'danger');
    }
  }

  function exportCSV(format) {
    let rows, headers;
    if (format === 'hubspot') {
      headers = ['Company Name', 'Industry', 'First Name', 'Last Name', 'Email', 'Phone'];
      rows = companies.flatMap((c) => (c.contacts || []).map((ct) => {
        const [first, ...rest] = (ct.name || '').split(' ');
        return [c.name, c.sector || '', first, rest.join(' '), ct.email || '', ct.whatsapp || ''];
      }));
    } else if (format === 'salesforce') {
      headers = ['Account Name', 'Industry', 'Contact Name', 'Title', 'Email', 'Phone'];
      rows = companies.flatMap((c) => (c.contacts || []).map((ct) => [c.name, c.sector || '', ct.name || '', ct.role || '', ct.email || '', ct.whatsapp || '']));
    } else if (format === 'linkedin') {
      headers = ['Company', 'First Name', 'Last Name', 'Title', 'Email'];
      rows = companies.flatMap((c) => (c.contacts || []).map((ct) => {
        const [first, ...rest] = (ct.name || '').split(' ');
        return [c.name, first, rest.join(' '), ct.role || '', ct.email || ''];
      }));
    } else {
      headers = ['empresa', 'setor', 'status', 'score', 'contato', 'cargo', 'email', 'whatsapp', 'linkedin'];
      rows = companies.flatMap((c) => (c.contacts || [{ name: '', role: '', email: '', whatsapp: '', linkedin: '' }]).map((ct) => [
        c.name, c.sector || '', c.status || '', c.interest_score ?? '', ct.name || '', ct.role || '', ct.email || '', ct.whatsapp || '', ct.linkedin || '',
      ]));
    }
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `companies_${format || 'padrao'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const allOnPageSelected = paginated.length > 0 && paginated.every((c) => selected.includes(c.id));

  return (
    <div className="row g-3">
      {/* Main table area */}
      <div className="col-12">
        <div className="card p-3">
          {/* Header */}
          <div className="d-flex justify-content-between mb-2">
            <h6 className="fw-bold mb-0"><i className="bi bi-list-ul me-1"></i>Lista de Empresas</h6>
            <div className="d-flex gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/companies/new')}>
                <i className="bi bi-building-add me-1"></i>Nova Empresa
              </button>
              <div className="dropdown">
                <button className="btn btn-outline-success btn-sm dropdown-toggle" data-bs-toggle="dropdown">
                  <i className="bi bi-download me-1"></i>Exportar
                </button>
                <ul className="dropdown-menu">
                  <li><button className="dropdown-item" onClick={() => exportCSV('')}>CSV Padrão</button></li>
                  <li><button className="dropdown-item" onClick={() => exportCSV('hubspot')}>HubSpot CSV</button></li>
                  <li><button className="dropdown-item" onClick={() => exportCSV('salesforce')}>Salesforce CSV</button></li>
                  <li><button className="dropdown-item" onClick={() => exportCSV('linkedin')}>LinkedIn CSV</button></li>
                </ul>
              </div>
              <button
                className="btn btn-sm btn-outline-primary"
                onClick={bulkEnrichMissing}
                title="Buscar e-mail e telefone para contatos sem e-mail"
              >
                <i className="bi bi-search me-1"></i>Enriquecer sem e-mail
              </button>
              <button className="btn btn-outline-secondary btn-sm" onClick={loadCompanies}>
                <i className="bi bi-arrow-clockwise"></i>
              </button>
            </div>
          </div>

          {/* Global contact search */}
          <GlobalContactSearch />

          {/* Filters */}
          <FiltersBar
            filters={filters}
            setFilters={(f) => { setFilters(f); setPage(1); }}
            sectors={sectors}
            importSources={importSources}
            count={filtered.length}
            flagCatalog={flagCatalog}
            user={user}
          />

          {/* Bulk toolbar */}
          <BulkToolbar
            selected={selected}
            onClear={() => setSelected([])}
            onBulkResearch={bulkResearch}
            onBulkMessages={openBulkDirectModal}
            onBulkPropensity={openPropensityModal}
            onBulkStatus={bulkStatus}
          />

          {/* Table */}
          <div className="table-responsive">
            <table className="table table-hover table-sm">
              <thead className="table-light">
                <tr>
                  <th style={{ width: 24 }}>
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      title="Selecionar todas"
                    />
                  </th>
                  <th style={{ width: 30 }}></th>
                  <th>Empresa</th>
                  <th className="d-none d-md-table-cell">Setor</th>
                  <th className="d-none d-sm-table-cell">Contatos</th>
                  <th>Status</th>
                  <th className="d-none d-sm-table-cell">Score</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={8} className="text-center text-muted py-3">Carregando...</td></tr>
                )}
                {!loading && paginated.length === 0 && (
                  <tr><td colSpan={8} className="text-center text-muted py-3">Nenhuma empresa encontrada.</td></tr>
                )}
                {!loading && paginated.map((company) => (
                  <CompanyRow
                    key={company.id}
                    company={company}
                    selected={selected.includes(company.id)}
                    onToggle={handleToggle}
                    expanded={expanded.includes(company.id)}
                    onToggleExpand={handleToggleExpand}
                    onEnrich={handleEnrichContact}
                    onFindContact={handleFindContact}
                    onRemoveContact={handleRemoveContact}
                    onRemoveCompany={handleRemoveCompany}
                    onContactAdded={() => { loadCompanies(); if (loadStats) loadStats(); }}
                    onStartConversation={onOpenWhatsApp}
                    toast={toast}
                    flagMap={flagMap}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="d-flex justify-content-between align-items-center mt-2">
            <span className="text-muted small">
              Mostrando {Math.min((page - 1) * PAGE_SIZE + 1, filtered.length)}–{Math.min(page * PAGE_SIZE, filtered.length)} de {filtered.length}
            </span>
            <nav>
              <ul className="pagination pagination-sm mb-0">
                <li className={`page-item ${page === 1 ? 'disabled' : ''}`}>
                  <button className="page-link" onClick={() => setPage(page - 1)}>‹</button>
                </li>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                  .map((p, idx, arr) => (
                    <>
                      {idx > 0 && arr[idx - 1] !== p - 1 && <li key={`ellipsis-${p}`} className="page-item disabled"><span className="page-link">…</span></li>}
                      <li key={p} className={`page-item ${p === page ? 'active' : ''}`}>
                        <button className="page-link" onClick={() => setPage(p)}>{p}</button>
                      </li>
                    </>
                  ))}
                <li className={`page-item ${page === totalPages ? 'disabled' : ''}`}>
                  <button className="page-link" onClick={() => setPage(page + 1)}>›</button>
                </li>
              </ul>
            </nav>
          </div>
        </div>
      </div>

      {/* Bulk: propensão / mensagens por produto */}
      {bulkModal && (
        <PropensityModal
          mode={bulkModal.mode}
          companyIds={bulkModal.ids}
          toast={toast}
          onClose={() => setBulkModal(null)}
          onDone={() => { loadCompanies(); if (loadStats) loadStats(); setSelected([]); }}
        />
      )}

      {/* Company Modal */}
    </div>
  );
}
