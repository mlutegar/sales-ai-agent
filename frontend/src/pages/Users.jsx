import { useState, useEffect, useCallback } from 'react'
import { api, esc } from '../api.js'

const TYPE_LABEL = { vendas: 'Vendas', marketing: 'Marketing' }
const TYPE_BADGE = { vendas: 'bg-primary', marketing: 'bg-success' }

export default function Users({ toast }) {
  const [users, setUsers] = useState([])
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(false)

  const [form, setForm] = useState({
    username: '',
    password: '',
    name: '',
    user_type: 'vendas',
    company_name: '',
    signature_name: '',
  })

  const load = useCallback(async () => {
    try {
      const [u, m] = await Promise.all([api('/api/users'), api('/api/me')])
      setUsers(u || [])
      setMe(m)
    } catch (e) {
      toast('Erro ao carregar usuários', 'danger')
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const create = async () => {
    if (!form.username.trim() || !form.password.trim()) {
      toast('Usuário e senha são obrigatórios', 'warning'); return
    }
    if (form.user_type === 'vendas' && !form.name.trim()) {
      toast('Perfil vendas exige o nome do vendedor', 'warning'); return
    }
    if (form.user_type === 'marketing' && !form.company_name.trim()) {
      toast('Perfil marketing exige o nome da empresa/marca', 'warning'); return
    }
    setLoading(true)
    try {
      await api('/api/users', 'POST', {
        username: form.username.trim(),
        password: form.password,
        name: form.name.trim(),
        user_type: form.user_type,
        company_name: form.company_name.trim(),
        signature_name: form.signature_name.trim(),
      })
      toast('Usuário criado!')
      setForm({ username: '', password: '', name: '', user_type: 'vendas', company_name: '', signature_name: '' })
      load()
    } catch (e) {
      toast(e.error || e.message || 'Erro ao criar usuário', 'danger')
    } finally {
      setLoading(false)
    }
  }

  const remove = async (id, username) => {
    if (!window.confirm(`Remover o usuário "${username}"?`)) return
    try {
      await api(`/api/users/${id}`, 'DELETE')
      toast('Usuário removido', 'warning')
      load()
    } catch (e) {
      toast(e.error || e.message || 'Erro ao remover', 'danger')
    }
  }

  const isMkt = form.user_type === 'marketing'

  // (#10) prévia da assinatura conforme o perfil e os campos preenchidos
  const signaturePreview = isMkt
    ? (form.company_name.trim()
        ? (form.signature_name.trim() ? `${form.company_name.trim()} — ${form.signature_name.trim()}` : form.company_name.trim())
        : '(defina a marca)')
    : (form.name.trim() || '(defina o nome do vendedor)')

  return (
    <div className="row g-3">
      {/* Formulário */}
      <div className="col-12 col-md-4 order-2 order-md-1">
        <div className="card p-3">
          <h6 className="fw-bold mb-3"><i className="bi bi-person-plus me-1"></i>Novo Usuário</h6>

          <div className="mb-2">
            <label className="form-label small fw-semibold mb-1">Tipo de perfil</label>
            <div className="btn-group w-100" role="group">
              <button
                type="button"
                className={`btn btn-sm ${form.user_type === 'vendas' ? 'btn-primary' : 'btn-outline-primary'}`}
                onClick={() => set('user_type', 'vendas')}
              >
                <i className="bi bi-person-badge me-1"></i>Vendas
              </button>
              <button
                type="button"
                className={`btn btn-sm ${form.user_type === 'marketing' ? 'btn-success' : 'btn-outline-success'}`}
                onClick={() => set('user_type', 'marketing')}
              >
                <i className="bi bi-megaphone me-1"></i>Marketing
              </button>
            </div>
            <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>
              {isMkt
                ? 'As mensagens se apresentam como a EMPRESA/marca (sem nome de pessoa).'
                : 'As mensagens se apresentam e assinam com o NOME do vendedor.'}
            </div>
          </div>

          <div className="mb-2">
            <input className="form-control form-control-sm" placeholder="Usuário (login) *"
              value={form.username} onChange={e => set('username', e.target.value)} />
          </div>
          <div className="mb-2">
            <input className="form-control form-control-sm" type="password" placeholder="Senha *"
              value={form.password} onChange={e => set('password', e.target.value)} />
          </div>

          {isMkt ? (
            <>
              <div className="mb-2">
                <input className="form-control form-control-sm" placeholder="Nome da empresa/marca *"
                  value={form.company_name} onChange={e => set('company_name', e.target.value)} />
              </div>
              <div className="mb-2">
                <input className="form-control form-control-sm" placeholder="Pessoa para assinatura (opcional)"
                  value={form.signature_name} onChange={e => set('signature_name', e.target.value)} />
              </div>
            </>
          ) : (
            <div className="mb-2">
              <input className="form-control form-control-sm" placeholder="Nome do vendedor *"
                value={form.name} onChange={e => set('name', e.target.value)} />
            </div>
          )}

          {/* (#10) prévia ao vivo de como as mensagens serão assinadas */}
          <div className="border rounded bg-light px-2 py-1 mb-2" style={{ fontSize: '0.75rem' }}>
            <span className="text-muted">As mensagens sairão assinadas como:</span>{' '}
            <strong>{esc(signaturePreview)}</strong>
          </div>

          <button className="btn btn-primary btn-sm w-100" onClick={create} disabled={loading}>
            {loading
              ? <><span className="spinner-border spinner-border-sm me-1"></span>Aguarde...</>
              : <><i className="bi bi-plus-circle me-1"></i>Criar usuário</>}
          </button>
        </div>
      </div>

      {/* Lista */}
      <div className="col-12 col-md-8 order-1 order-md-2">
        <div className="card p-3">
          <h6 className="fw-bold mb-2"><i className="bi bi-people me-1"></i>Usuários</h6>
          <div className="table-responsive">
            <table className="table table-hover table-sm align-middle">
              <thead className="table-light">
                <tr>
                  <th>Login</th>
                  <th>Perfil</th>
                  <th>Apresenta-se como</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan={4} className="text-muted text-center py-4">Nenhum usuário.</td></tr>
                ) : users.map(u => {
                  const type = u.user_type || 'vendas'
                  const presents = type === 'marketing'
                    ? ((u.company_name || '—') + (u.signature_name ? ` — ${u.signature_name}` : ''))
                    : (u.name || u.username)
                  const isMe = me && me.username === u.username
                  return (
                    <tr key={u.id}>
                      <td>{esc(u.username)}{isMe && <span className="badge bg-secondary ms-1">você</span>}</td>
                      <td><span className={`badge ${TYPE_BADGE[type] || 'bg-secondary'}`}>{TYPE_LABEL[type] || type}</span></td>
                      <td>
                        {type === 'marketing'
                          ? <><i className="bi bi-building me-1"></i>{esc(presents)}</>
                          : <><i className="bi bi-person me-1"></i>{esc(presents)}</>}
                      </td>
                      <td>
                        <button className="btn btn-outline-danger btn-sm" disabled={isMe}
                          title={isMe ? 'Não é possível remover o próprio usuário' : 'Remover'}
                          onClick={() => remove(u.id, u.username)}>
                          <i className="bi bi-trash"></i>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
