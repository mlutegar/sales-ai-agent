import React, { useState, useEffect } from 'react'

export default function Login({ toast }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const err = params.get('error')
    if (err) setError(decodeURIComponent(err))
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }),
        redirect: 'follow',
      })
      if (res.url && res.url.includes('/login')) {
        // Houve redirecionamento de volta para /login = erro
        const url = new URL(res.url)
        const err = url.searchParams.get('error')
        setError(err ? decodeURIComponent(err) : 'Usuário ou senha inválidos')
      } else {
        window.location.href = '/'
      }
    } catch (err) {
      setError('Erro de conexão com o servidor')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'rgba(255,255,255,0.05)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 20, padding: '2.5rem 2rem',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        color: '#fff',
      }}>
        <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#a78bfa', letterSpacing: '-0.5px' }}>
          <i className="bi bi-robot me-2" />Sales AI Agent
        </div>
        <div style={{ fontSize: '.85rem', color: 'rgba(255,255,255,0.5)', marginBottom: '2rem', marginTop: 4 }}>
          Plataforma de prospecção inteligente B2B
        </div>

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
            color: '#fca5a5', borderRadius: 10, padding: '.7rem 1rem', fontSize: '.85rem',
            marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <i className="bi bi-exclamation-circle-fill" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: '.85rem', fontWeight: 600, marginBottom: 6, display: 'block' }}>Usuário</label>
            <div className="input-group">
              <span style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRight: 'none', color: 'rgba(255,255,255,0.5)', borderRadius: '10px 0 0 10px', padding: '0 .75rem', display: 'flex', alignItems: 'center' }}>
                <i className="bi bi-person-fill" />
              </span>
              <input
                type="text" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="Digite seu usuário" required autoFocus
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderLeft: 'none', color: '#fff', borderRadius: '0 10px 10px 0', padding: '.65rem 1rem', width: '100%', outline: 'none' }}
              />
            </div>
          </div>

          <div className="mb-3">
            <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: '.85rem', fontWeight: 600, marginBottom: 6, display: 'block' }}>Senha</label>
            <div className="input-group">
              <span style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRight: 'none', color: 'rgba(255,255,255,0.5)', borderRadius: '10px 0 0 10px', padding: '0 .75rem', display: 'flex', alignItems: 'center' }}>
                <i className="bi bi-lock-fill" />
              </span>
              <input
                type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Digite sua senha" required
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderLeft: 'none', borderRight: 'none', color: '#fff', padding: '.65rem 1rem', flex: 1, outline: 'none' }}
              />
              <button type="button" onClick={() => setShowPwd(!showPwd)}
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderLeft: 'none', color: 'rgba(255,255,255,0.5)', borderRadius: '0 10px 10px 0', padding: '0 .75rem', cursor: 'pointer' }}>
                <i className={`bi ${showPwd ? 'bi-eye-slash-fill' : 'bi-eye-fill'}`} />
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading}
            style={{ background: 'linear-gradient(135deg, #7c3aed, #a78bfa)', border: 'none', borderRadius: 10, color: '#fff', fontWeight: 600, fontSize: '.95rem', padding: '.7rem', width: '100%', marginTop: '.5rem', cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? <><span className="spinner-border spinner-border-sm me-2" />Entrando...</> : <><i className="bi bi-box-arrow-in-right me-2" />Entrar</>}
          </button>
        </form>

        <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '1.75rem 0' }} />
        <div style={{ fontSize: '.78rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>
          Primeiro acesso? <strong style={{ color: 'rgba(255,255,255,0.5)' }}>admin</strong> / <strong style={{ color: 'rgba(255,255,255,0.5)' }}>admin123</strong>
        </div>
      </div>
    </div>
  )
}
