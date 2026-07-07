import React, { useState, useEffect } from 'react'
import { api, esc } from '../api.js'

export default function RAG({ toast, loadStats }) {
  const [docs, setDocs] = useState([])
  const [docName, setDocName] = useState('')
  const [docContent, setDocContent] = useState('')
  
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
                      <span>
                        <i className="bi bi-file-earmark-text me-1"></i>
                        {esc(d.name)} <span className="text-muted">({Math.round(d.size/1000)}kb)</span>
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
    </div>
  )
}
