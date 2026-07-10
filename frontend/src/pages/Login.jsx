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
      background: '#f6f7f9',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', maxWidth: 400,
        background: '#ffffff',
        border: '1px solid #e4e7ec',
        borderRadius: 12, padding: '2.5rem 2rem',
        boxShadow: '0 1px 2px rgba(16,24,40,.05), 0 12px 32px rgba(16,24,40,.08)',
        color: '#1a2233',
      }}>
        <div style={{ fontSize: '1.35rem', fontWeight: 600, color: '#1a2233', letterSpacing: '-0.01em' }}>
          <i className="bi bi-robot me-2" style={{ color: '#1d4ed8' }} />Sales AI Agent
        </div>
        <div style={{ fontSize: '.85rem', color: '#667085', marginBottom: '2rem', marginTop: 4 }}>
          Plataforma de prospecção inteligente B2B
        </div>

        {error && (
          <div style={{
            background: '#fdecea', border: '1px solid #f2d0cc',
            color: '#b42318', borderRadius: 8, padding: '.7rem 1rem', fontSize: '.85rem',
            marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <i className="bi bi-exclamation-circle-fill" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label style={{ color: '#344054', fontSize: '.85rem', fontWeight: 500, marginBottom: 6, display: 'block' }}>Usuário</label>
            <div className="input-group" style={{ flexWrap: 'nowrap' }}>
              <span style={{ background: '#f9fafb', border: '1px solid #d6dae1', borderRight: 'none', color: '#667085', borderRadius: '8px 0 0 8px', padding: '0 .75rem', display: 'flex', alignItems: 'center' }}>
                <i className="bi bi-person-fill" />
              </span>
              <input
                type="text" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="Digite seu usuário" required autoFocus
                style={{ background: '#fff', border: '1px solid #d6dae1', borderLeft: 'none', color: '#1a2233', borderRadius: '0 8px 8px 0', padding: '.65rem 1rem', flex: 1, minWidth: 0, outline: 'none' }}
              />
            </div>
          </div>

          <div className="mb-3">
            <label style={{ color: '#344054', fontSize: '.85rem', fontWeight: 500, marginBottom: 6, display: 'block' }}>Senha</label>
            <div className="input-group" style={{ flexWrap: 'nowrap' }}>
              <span style={{ background: '#f9fafb', border: '1px solid #d6dae1', borderRight: 'none', color: '#667085', borderRadius: '8px 0 0 8px', padding: '0 .75rem', display: 'flex', alignItems: 'center' }}>
                <i className="bi bi-lock-fill" />
              </span>
              <input
                type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Digite sua senha" required
                style={{ background: '#fff', border: '1px solid #d6dae1', borderLeft: 'none', borderRight: 'none', color: '#1a2233', padding: '.65rem 1rem', flex: 1, minWidth: 0, outline: 'none' }}
              />
              <button type="button" onClick={() => setShowPwd(!showPwd)}
                style={{ background: '#fff', border: '1px solid #d6dae1', borderLeft: 'none', color: '#667085', borderRadius: '0 8px 8px 0', padding: '0 .75rem', cursor: 'pointer' }}>
                <i className={`bi ${showPwd ? 'bi-eye-slash-fill' : 'bi-eye-fill'}`} />
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading}
            style={{ background: '#1d4ed8', border: '1px solid #1d4ed8', borderRadius: 8, color: '#fff', fontWeight: 500, fontSize: '.9rem', padding: '.65rem', width: '100%', marginTop: '.5rem', cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? <><span className="spinner-border spinner-border-sm me-2" />Entrando...</> : <><i className="bi bi-box-arrow-in-right me-2" />Entrar</>}
          </button>
        </form>

        <hr style={{ borderColor: '#eef0f3', margin: '1.75rem 0' }} />
        <div style={{ fontSize: '.72rem', color: '#98a2b3', textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600, marginBottom: 8 }}>
          Contas de demonstração
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[
            { user: 'vendas',    pass: 'vendas123',    label: 'Vendas',    desc: 'assina com o nome do vendedor', icon: 'bi-person-badge', color: '#1d4ed8' },
            { user: 'marketing', pass: 'marketing123', label: 'Marketing', desc: 'assina com o nome da empresa',   icon: 'bi-megaphone',    color: '#059669' },
            { user: 'admin',     pass: 'admin123',     label: 'Admin',     desc: 'acesso completo',                icon: 'bi-shield-lock',  color: '#475467' },
          ].map(a => (
            <button
              key={a.user}
              type="button"
              onClick={() => { setUsername(a.user); setPassword(a.pass); setError('') }}
              title={`Preencher com ${a.user}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                background: '#f9fafb', border: '1px solid #e4e7ec', borderRadius: 8,
                padding: '.55rem .75rem', cursor: 'pointer', width: '100%',
              }}
            >
              <i className={`bi ${a.icon}`} style={{ color: a.color, fontSize: '1rem' }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '.82rem', fontWeight: 600, color: '#1a2233' }}>
                  {a.label} <span style={{ color: '#98a2b3', fontWeight: 400 }}>— {a.desc}</span>
                </span>
                <span style={{ fontSize: '.75rem', color: '#667085' }}>
                  {a.user} / {a.pass}
                </span>
              </span>
              <i className="bi bi-box-arrow-in-right" style={{ color: '#98a2b3' }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
