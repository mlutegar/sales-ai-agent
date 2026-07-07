import React, { useState, useEffect } from 'react'
import { api, esc } from '../api.js'

export default function GoldenCases({ toast, loadStats }) {
  const [cases, setCases] = useState([])
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [content, setContent] = useState('')
  const [score, setScore] = useState(5)
  const [loading, setLoading] = useState(false)

  const loadGoldenCases = async () => {
    try {
      const data = await api('/api/golden-cases')
      setCases(data || [])
    } catch (e) {
      toast('Erro ao carregar casos de ouro', 'danger')
    }
  }

  useEffect(() => {
    loadGoldenCases()
  }, [])

  const addGoldenCase = async () => {
    if (!title.trim() || !content.trim()) {
      toast('Título e conteúdo são obrigatórios', 'warning')
      return
    }
    setLoading(true)
    try {
      await api('/api/golden-cases', 'POST', {
        title: title.trim(),
        content: content.trim(),
        context: context.trim(),
        score,
      })
      setTitle('')
      setContext('')
      setContent('')
      toast('Caso de ouro salvo!', 'success')
      loadGoldenCases()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao salvar', 'danger')
    } finally {
      setLoading(false)
    }
  }

  const delGoldenCase = async (id) => {
    try {
      await api(`/api/golden-cases/${id}`, 'DELETE')
      toast('Removido', 'warning')
      loadGoldenCases()
      if (loadStats) loadStats()
    } catch (e) {
      toast('Erro ao remover', 'danger')
    }
  }

  return (
    <div className="tab-container">
      <div id="tab-golden">
        <div className="row g-3">
          
          <div className="col-12 col-md-4">
            <div className="card p-3">
              <h6 className="fw-bold mb-3"><i className="bi bi-trophy me-1"></i>Novo Caso de Ouro</h6>
              <div className="mb-2">
                <input 
                  className="form-control form-control-sm" 
                  value={title} 
                  onChange={e => setTitle(e.target.value)} 
                  placeholder="Título *" 
                />
              </div>
              <div className="mb-2">
                <input 
                  className="form-control form-control-sm" 
                  value={context} 
                  onChange={e => setContext(e.target.value)} 
                  placeholder="Contexto (setor, cargo, produto)" 
                />
              </div>
              <div className="mb-2">
                <textarea 
                  className="form-control form-control-sm" 
                  rows="6" 
                  value={content} 
                  onChange={e => setContent(e.target.value)} 
                  placeholder="Conversa ou mensagem que gerou resultado real..."
                />
              </div>
              <div className="mb-3">
                <label className="small fw-bold">Score de sucesso</label>
                <div className="d-flex gap-2 mt-1">
                  {[3, 4, 5].map(s => (
                    <button 
                      key={s}
                      className={`btn btn-sm ${score === s ? 'btn-warning active' : 'btn-outline-warning'}`} 
                      onClick={() => setScore(s)}
                    >
                      {s}★
                    </button>
                  ))}
                </div>
              </div>
              <button 
                className="btn btn-warning btn-sm w-100" 
                onClick={addGoldenCase}
                disabled={loading}
              >
                {loading ? (
                  <span className="spinner-border spinner-border-sm me-1"></span>
                ) : (
                  <i className="bi bi-star-fill me-1"></i>
                )}
                Salvar Caso
              </button>
            </div>
          </div>
          
          <div className="col-12 col-md-8">
            <div className="card p-3">
              <div className="d-flex justify-content-between mb-2">
                <h6 className="fw-bold mb-0">Biblioteca de Casos de Ouro</h6>
                <button className="btn btn-outline-secondary btn-sm" onClick={loadGoldenCases}>
                  <i className="bi bi-arrow-clockwise"></i>
                </button>
              </div>
              
              <div>
                {cases.length > 0 ? (
                  cases.map(c => (
                    <div key={c.id} className="border rounded p-2 mb-2">
                      <div className="d-flex justify-content-between">
                        <strong>{esc(c.title)}</strong>
                        <div className="d-flex gap-1 align-items-center">
                          <span className="badge bg-warning text-dark">{c.score}★</span>
                          <button className="btn btn-link text-danger btn-sm p-0 ms-2" onClick={() => delGoldenCase(c.id)}>
                            <i className="bi bi-trash"></i>
                          </button>
                        </div>
                      </div>
                      {c.context && <div className="text-muted small">{esc(c.context)}</div>}
                      <div className="msg-box mt-1 small" style={{whiteSpace: 'pre-wrap'}}>{esc(c.content)}</div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-4">
                    <div style={{fontSize: '2.5rem'}}>🏆</div>
                    <h6 className="fw-semibold mt-2">Nenhum caso de sucesso cadastrado</h6>
                    <p className="text-muted small">
                      Adicione exemplos reais de mensagens que geraram resposta positiva.<br/>
                      Eles serão usados como referência nas próximas gerações de mensagens.
                    </p>
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
