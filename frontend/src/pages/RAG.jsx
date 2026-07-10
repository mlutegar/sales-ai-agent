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

  const delDoc = async (id) => {
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
              
              <h6 className="fw-bold mb-2">Documentos carregados</h6>
              <div>
                {docs.length > 0 ? (
                  docs.map(d => (
                    <div key={d.id} className="d-flex justify-content-between align-items-center mb-1 small">
                      <span
                        role="button"
                        style={{ cursor: 'pointer' }}
                        title="Ver conteúdo"
                        onClick={() => openDoc(d.id)}
                      >
                        <i className="bi bi-file-earmark-text me-1"></i>
                        <span className="text-decoration-underline">{esc(d.name)}</span>{' '}
                        <span className="text-muted">({Math.round(d.size/1000)}kb)</span>
                      </span>
                      <button className="btn btn-link text-danger btn-sm p-0" onClick={() => delDoc(d.id)}>
                        <i className="bi bi-trash"></i>
                      </button>
                    </div>
                  ))
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
          onClick={() => setViewDoc(null)}
        >
          <div
            className="modal-dialog modal-lg modal-dialog-scrollable modal-dialog-centered"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-header">
                <h6 className="modal-title fw-bold">
                  <i className="bi bi-file-earmark-text me-1"></i>
                  {viewDoc.loading ? 'Carregando...' : esc(viewDoc.name)}
                </h6>
                <button type="button" className="btn-close" onClick={() => setViewDoc(null)}></button>
              </div>
              <div className="modal-body">
                {viewDoc.loading ? (
                  <p className="text-muted small mb-0">
                    <span className="spinner-border spinner-border-sm me-1"></span>
                    Carregando conteúdo...
                  </p>
                ) : (
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
                    {esc(viewDoc.content)}
                  </pre>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setViewDoc(null)}>
                  Fechar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
