import React, { useState, useEffect } from 'react'
import { api, apiUpload, esc } from '../api.js'

export default function RAG({ toast, loadStats }) {
  const [docs, setDocs] = useState([])
  const [docName, setDocName] = useState('')
  const [docContent, setDocContent] = useState('')
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)

  // (#6) preview do arquivo extraído antes de salvar
  const [preview, setPreview] = useState(null) // { name, markdown, source_type, size, duplicate }
  const [savingPreview, setSavingPreview] = useState(false)

  const [viewDoc, setViewDoc] = useState(null)
  const [loadingView, setLoadingView] = useState(false)
  const [docSearch, setDocSearch] = useState('')      // (#2) busca dentro do documento aberto
  const [editMode, setEditMode] = useState(false)     // (#4) edição do documento
  const [editName, setEditName] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const [filter, setFilter] = useState('')            // (#1) filtro da lista
  const [visibleCount, setVisibleCount] = useState(20) // (#9) paginação simples

  const [query, setQuery] = useState('')
  const [storytelling, setStorytelling] = useState(false)
  const [ragAnswer, setRagAnswer] = useState(null)
  const [loadingRAG, setLoadingRAG] = useState(false)

  const loadDocs = async () => {
    try {
      const data = await api('/api/documents')
      setDocs(data || [])
    } catch (e) {
      toast('Erro ao carregar documentos', 'danger')
    }
  }

  useEffect(() => {
    loadDocs()
  }, [])

  // (#8) fecha modais com a tecla ESC
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (viewDoc) { if (!savingEdit) closeView() }
      else if (preview) { if (!savingPreview) setPreview(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewDoc, preview, savingEdit, savingPreview])

  // (#1) lista filtrada + (#9) paginação
  const filteredDocs = docs.filter(d =>
    !filter.trim() || d.name.toLowerCase().includes(filter.trim().toLowerCase())
  )
  const shownDocs = filteredDocs.slice(0, visibleCount)

  // (#2) destaca ocorrências do termo buscado no conteúdo do documento
  const renderContent = (content, term) => {
    const text = String(content || '')
    const q = term.trim()
    if (!q) return text
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = text.split(re)
    // split com grupo de captura: índices ímpares são as ocorrências
    return parts.map((part, i) =>
      i % 2 === 1
        ? <mark key={i}>{part}</mark>
        : <React.Fragment key={i}>{part}</React.Fragment>
    )
  }
  const matchCount = (content, term) => {
    const q = term.trim()
    if (!q) return 0
    try {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      return (String(content || '').match(re) || []).length
    } catch { return 0 }
  }

  const addDoc = async () => {
    if (!docName.trim() || !docContent.trim()) {
      toast('Nome e conteúdo são obrigatórios', 'warning')
      return
    }
    try {
      await api('/api/documents', 'POST', { name: docName.trim(), content: docContent.trim() })
      setDocName('')
      setDocContent('')
      toast('Documento adicionado!')
      loadDocs()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao adicionar documento', 'danger')
    }
  }

  // (#6/#7/#9) extrai o arquivo (PDF/DOCX/TXT/MD) com barra de progresso e abre o preview.
  const extractFile = async () => {
    if (!file) {
      toast('Selecione um arquivo (PDF, DOCX, TXT ou MD)', 'warning')
      return
    }
    setUploading(true)
    setProgress(0)
    try {
      const r = await apiUpload('/api/documents/extract', file, {
        onProgress: (p) => setProgress(p),
      })
      setPreview(r)
    } catch (e) {
      toast(e.message || 'Erro ao processar arquivo', 'danger')
    } finally {
      setUploading(false)
      setProgress(0)
    }
  }

  // Salva o conteúdo do preview (com dedup: 409 pergunta se substitui).
  const savePreview = async (replace = false) => {
    if (!preview?.name?.trim() || !preview?.markdown?.trim()) {
      toast('Nome e conteúdo são obrigatórios', 'warning')
      return
    }
    setSavingPreview(true)
    try {
      await api('/api/documents', 'POST', {
        name: preview.name.trim(),
        content: preview.markdown,
        source_type: preview.source_type,
        replace,
      })
      toast(`Documento "${preview.name}" salvo!`)
      setPreview(null)
      setFile(null)
      loadDocs()
      if (loadStats) loadStats()
    } catch (e) {
      if (e.status === 409 || e.duplicate) {
        if (window.confirm(`${e.error}\n\nDeseja substituir o documento existente?`)) {
          return savePreview(true)
        }
      } else {
        toast(e.message || 'Erro ao salvar documento', 'danger')
      }
    } finally {
      setSavingPreview(false)
    }
  }

  const openDoc = async (id) => {
    setLoadingView(true)
    setDocSearch('')
    setEditMode(false)
    setViewDoc({ loading: true })
    try {
      const data = await api(`/api/documents/${id}`)
      setViewDoc(data)
    } catch (e) {
      setViewDoc(null)
      toast('Erro ao abrir documento', 'danger')
    } finally {
      setLoadingView(false)
    }
  }

  const closeView = () => {
    setViewDoc(null)
    setEditMode(false)
    setDocSearch('')
  }

  // (#4) inicia edição do documento aberto
  const startEdit = () => {
    setEditName(viewDoc.name || '')
    setEditContent(viewDoc.content || '')
    setEditMode(true)
  }

  const saveEdit = async () => {
    if (!editName.trim() || !editContent.trim()) {
      toast('Nome e conteúdo são obrigatórios', 'warning')
      return
    }
    setSavingEdit(true)
    try {
      await api(`/api/documents/${viewDoc.id}`, 'PUT', { name: editName.trim(), content: editContent })
      toast('Documento atualizado!')
      setViewDoc({ ...viewDoc, name: editName.trim(), content: editContent })
      setEditMode(false)
      loadDocs()
    } catch (e) {
      toast(e.error || e.message || 'Erro ao salvar', 'danger')
    } finally {
      setSavingEdit(false)
    }
  }

  // (#5) baixa o documento como .md
  const downloadDoc = () => {
    const safe = (viewDoc.name || 'documento').replace(/[^\w.\- ]+/g, '_')
    const blob = new Blob([viewDoc.content || ''], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safe}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const delDoc = async (id) => {
    if (!window.confirm('Remover este documento? Esta ação não pode ser desfeita.')) return
    try {
      await api(`/api/documents/${id}`, 'DELETE')
      toast('Documento removido', 'warning')
      loadDocs()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao remover documento', 'danger')
    }
  }

  const queryRAG = async () => {
    if (!query.trim()) {
      toast('Digite uma pergunta', 'warning')
      return
    }
    setLoadingRAG(true)
    setRagAnswer({ loading: true })
    
    try {
      const data = await api('/api/rag/query', 'POST', { query: query.trim(), storytelling })
      setRagAnswer({ loading: false, data })
    } catch (e) {
      setRagAnswer(null)
      toast('Erro ao consultar RAG', 'danger')
    } finally {
      setLoadingRAG(false)
    }
  }

  return (
    <div className="tab-container h-100">
      <div id="tab-rag" className="h-100">
        <div className="row g-3 h-100">
          
          <div className="col-12 col-md-4">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-upload me-1"></i>Adicionar Documento</h6>

              <div className="border rounded p-2 mb-3 bg-light">
                <label className="form-label small fw-semibold mb-1">
                  <i className="bi bi-file-earmark-arrow-up me-1"></i>Subir arquivo (PDF, DOCX, TXT, MD)
                </label>
                <input
                  className="form-control form-control-sm mb-2"
                  type="file"
                  accept=".pdf,.docx,.txt,.md,application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                {uploading && (
                  <div className="progress mb-2" style={{ height: 6 }}>
                    <div
                      className="progress-bar progress-bar-striped progress-bar-animated"
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                )}
                <button
                  className="btn btn-outline-primary btn-sm w-100"
                  onClick={extractFile}
                  disabled={uploading || !file}
                >
                  {uploading ? (
                    <><span className="spinner-border spinner-border-sm me-1"></span>Processando... {progress}%</>
                  ) : (
                    <><i className="bi bi-upload me-1"></i>Extrair e revisar</>
                  )}
                </button>
                <div className="text-muted mt-1" style={{ fontSize: '0.7rem' }}>
                  PDFs escaneados passam por OCR automaticamente.
                </div>
              </div>

              <div className="text-muted small mb-2">— ou cole o texto manualmente —</div>

              <div className="mb-2">
                <input 
                  className="form-control form-control-sm" 
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                  placeholder="Nome do documento *" 
                />
              </div>
              <div className="mb-3">
                <textarea 
                  className="form-control form-control-sm" 
                  rows="8" 
                  value={docContent}
                  onChange={(e) => setDocContent(e.target.value)}
                  placeholder="Cole o conteúdo do manual, white paper ou PDF técnico aqui..."
                />
              </div>
              <button className="btn btn-primary btn-sm w-100" onClick={addDoc}>
                <i className="bi bi-plus-circle me-1"></i>Adicionar
              </button>
              
              <hr />
              
              <div className="d-flex justify-content-between align-items-center mb-2">
                <h6 className="fw-bold mb-0">Documentos carregados</h6>
                <span className="badge bg-secondary">{docs.length}</span>
              </div>

              {docs.length > 0 && (
                <div className="input-group input-group-sm mb-2">
                  <span className="input-group-text"><i className="bi bi-search"></i></span>
                  <input
                    className="form-control form-control-sm"
                    placeholder="Filtrar por nome..."
                    value={filter}
                    onChange={(e) => { setFilter(e.target.value); setVisibleCount(20) }}
                  />
                  {filter && (
                    <button className="btn btn-outline-secondary" onClick={() => setFilter('')} title="Limpar">
                      <i className="bi bi-x"></i>
                    </button>
                  )}
                </div>
              )}

              <div>
                {docs.length > 0 ? (
                  filteredDocs.length > 0 ? (
                    <>
                      {shownDocs.map(d => (
                        <div key={d.id} className="d-flex justify-content-between align-items-center mb-1 small">
                          <button
                            type="button"
                            className="btn btn-link p-0 text-start text-decoration-none flex-grow-1 text-truncate"
                            title="Ver conteúdo"
                            onClick={() => openDoc(d.id)}
                          >
                            <i className="bi bi-file-earmark-text me-1"></i>
                            <span className="text-decoration-underline">{esc(d.name)}</span>
                            {d.source_type && (
                              <span className="badge bg-light text-dark border ms-1" style={{ fontSize: '0.62rem' }}>
                                {d.source_type}
                              </span>
                            )}
                            <span className="text-muted d-block" style={{ fontSize: '0.68rem' }}>
                              {Math.round(d.size/1000)}kb
                              {d.created_at && <> · {String(d.created_at).slice(0, 10)}</>}
                            </span>
                          </button>
                          <button className="btn btn-link text-danger btn-sm p-0 ms-1" onClick={() => delDoc(d.id)} title="Remover">
                            <i className="bi bi-trash"></i>
                          </button>
                        </div>
                      ))}
                      {filteredDocs.length > visibleCount && (
                        <button
                          className="btn btn-outline-secondary btn-sm w-100 mt-2"
                          onClick={() => setVisibleCount(c => c + 20)}
                        >
                          Mostrar mais ({filteredDocs.length - visibleCount})
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-muted small text-center py-2 mb-0">Nenhum documento corresponde ao filtro.</p>
                  )
                ) : (
                  <div className="text-center py-3">
                    <div style={{fontSize: '2rem'}}>📄</div>
                    <p className="fw-semibold small mt-1 mb-1">Nenhum documento cadastrado</p>
                    <p className="text-muted small mb-0">
                      Adicione materiais do produto (especificações, cases, proposta de valor).<br/>
                      Eles serão usados automaticamente para personalizar as mensagens geradas.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div className="col-12 col-md-8">
            <div className="card p-3 h-100">
              <h6 className="fw-bold mb-3"><i className="bi bi-search me-1"></i>Consulta RAG</h6>
              <div className="mb-2">
                <textarea 
                  className="form-control form-control-sm" 
                  rows="3" 
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Pergunta técnica ou tema para busca nos documentos..."
                />
              </div>
              <div className="form-check mb-3">
                <input 
                  className="form-check-input" 
                  type="checkbox" 
                  id="storytelling-mode" 
                  checked={storytelling}
                  onChange={(e) => setStorytelling(e.target.checked)}
                />
                <label className="form-check-label small" htmlFor="storytelling-mode">
                  <strong>Modo Storytelling</strong> — converte dados técnicos em benefícios de negócio (ROI, economia)
                </label>
              </div>
              <button 
                className="btn btn-primary btn-sm" 
                onClick={queryRAG}
                disabled={loadingRAG}
              >
                {loadingRAG ? (
                  <><span className="spinner-border spinner-border-sm me-1"></span>Aguarde...</>
                ) : (
                  <><i className="bi bi-lightning me-1"></i>Consultar</>
                )}
              </button>
              
              <div className="mt-3">
                {ragAnswer && ragAnswer.loading && (
                  <p className="text-muted small">Consultando documentos...</p>
                )}
                {ragAnswer && !ragAnswer.loading && ragAnswer.data && (
                  <div className="card mt-2">
                    <div className="card-header small text-muted">
                      Docs usados: {ragAnswer.data.docs_used ? ragAnswer.data.docs_used.join(', ') : ''}
                    </div>
                    <div className="card-body">
                      <pre style={{whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0}}>
                        {esc(ragAnswer.data.answer)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          
        </div>
      </div>

      {preview && (
        <div
          className="modal d-block"
          tabIndex="-1"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => !savingPreview && setPreview(null)}
        >
          <div
            className="modal-dialog modal-lg modal-dialog-scrollable modal-dialog-centered"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h6 className="modal-title fw-bold">
                  <i className="bi bi-eye me-1"></i>Revisar antes de salvar
                  {preview.source_type && (
                    <span className="badge bg-secondary ms-2">{preview.source_type}</span>
                  )}
                </h6>
                <button type="button" className="btn-close" onClick={() => setPreview(null)}></button>
              </div>
              <div className="modal-body">
                {preview.duplicate && (
                  <div className="alert alert-warning py-2 small mb-2">
                    <i className="bi bi-exclamation-triangle me-1"></i>
                    Já existe um documento idêntico: <strong>{esc(preview.duplicate.name)}</strong>. Salvar irá perguntar se deseja substituir.
                  </div>
                )}
                <label className="form-label small fw-semibold mb-1">Nome</label>
                <input
                  className="form-control form-control-sm mb-2"
                  value={preview.name}
                  onChange={(e) => setPreview(p => ({ ...p, name: e.target.value }))}
                />
                <label className="form-label small fw-semibold mb-1">
                  Conteúdo em Markdown ({Math.round((preview.markdown?.length || 0) / 1000)}kb) — edite se necessário
                </label>
                <textarea
                  className="form-control form-control-sm"
                  style={{ minHeight: 300, fontFamily: 'monospace', fontSize: '0.78rem' }}
                  value={preview.markdown}
                  onChange={(e) => setPreview(p => ({ ...p, markdown: e.target.value }))}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreview(null)} disabled={savingPreview}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => savePreview(false)} disabled={savingPreview}>
                  {savingPreview
                    ? <><span className="spinner-border spinner-border-sm me-1"></span>Salvando...</>
                    : <><i className="bi bi-check-circle me-1"></i>Salvar documento</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {viewDoc && (
        <div
          className="modal d-block"
          tabIndex="-1"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => !savingEdit && closeView()}
        >
          <div
            className="modal-dialog modal-lg modal-dialog-scrollable modal-dialog-centered"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h6 className="modal-title fw-bold text-truncate">
                  <i className="bi bi-file-earmark-text me-1"></i>
                  {viewDoc.loading ? 'Carregando...' : (editMode ? 'Editar documento' : esc(viewDoc.name))}
                  {!viewDoc.loading && viewDoc.source_type && !editMode && (
                    <span className="badge bg-secondary ms-2">{viewDoc.source_type}</span>
                  )}
                </h6>
                <button type="button" className="btn-close" onClick={closeView}></button>
              </div>

              {!viewDoc.loading && !editMode && (
                <div className="px-3 pt-2">
                  <div className="input-group input-group-sm">
                    <span className="input-group-text"><i className="bi bi-search"></i></span>
                    <input
                      className="form-control"
                      placeholder="Buscar dentro do documento..."
                      value={docSearch}
                      onChange={(e) => setDocSearch(e.target.value)}
                    />
                    {docSearch && (
                      <span className="input-group-text">
                        {matchCount(viewDoc.content, docSearch)} ocorrência(s)
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="modal-body">
                {viewDoc.loading ? (
                  <p className="text-muted small mb-0">
                    <span className="spinner-border spinner-border-sm me-1"></span>
                    Carregando conteúdo...
                  </p>
                ) : editMode ? (
                  <>
                    <label className="form-label small fw-semibold mb-1">Nome</label>
                    <input
                      className="form-control form-control-sm mb-2"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                    <label className="form-label small fw-semibold mb-1">Conteúdo</label>
                    <textarea
                      className="form-control form-control-sm"
                      style={{ minHeight: 320, fontFamily: 'monospace', fontSize: '0.78rem' }}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                  </>
                ) : (
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
                    {renderContent(viewDoc.content, docSearch)}
                  </pre>
                )}
              </div>

              <div className="modal-footer">
                {editMode ? (
                  <>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditMode(false)} disabled={savingEdit}>
                      Cancelar
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={saveEdit} disabled={savingEdit}>
                      {savingEdit
                        ? <><span className="spinner-border spinner-border-sm me-1"></span>Salvando...</>
                        : <><i className="bi bi-check-circle me-1"></i>Salvar alterações</>}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-outline-secondary btn-sm me-auto" onClick={downloadDoc} disabled={viewDoc.loading}>
                      <i className="bi bi-download me-1"></i>Baixar .md
                    </button>
                    <button type="button" className="btn btn-outline-primary btn-sm" onClick={startEdit} disabled={viewDoc.loading}>
                      <i className="bi bi-pencil me-1"></i>Editar
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={closeView}>
                      Fechar
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
