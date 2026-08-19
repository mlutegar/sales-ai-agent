# 🚀 Cronograma de Comercialização — Sales AI Agent
### Roadmap de 45 dias · Agosto–Setembro 2026

---

## Estado Atual do Projeto

| Item | Status |
|------|--------|
| Backend Node.js/Express | ✅ 5.671 linhas |
| Frontend React (18 páginas) | ✅ Completo |
| 50+ endpoints REST | ✅ Funcionando |
| WhatsApp Business API | ✅ Integrado |
| Anti-bot humanization | ✅ 9 testes unitários |
| RLHF + Blind Testing | ✅ Implementado |
| RAG (PDF/DOCX) | ✅ Implementado |
| Conformidade LGPD | ✅ Implementado |
| Docker + Fly.io/Render | ✅ Configurado |
| **Multi-tenancy** | ❌ Falta |
| **Billing/Pagamento** | ❌ Falta |
| **Onboarding de clientes** | ❌ Falta |
| **Landing page** | ❌ Falta |
| **Cobertura de testes ≥80%** | ❌ Falta |

---

## Semana 1 — Fundação para Produção
> **Dias 1–7**

### Banco de Dados
- [ ] Migrar SQLite → PostgreSQL (escala multi-tenant, concorrência real)
- [ ] Adicionar coluna `tenant_id` em todas as tabelas (companies, contacts, messages, documents…)
- [ ] Escrever script de migração com rollback seguro

### Segurança
- [ ] Adicionar `helmet.js` (headers HTTP seguros)
- [ ] CORS configurável por origem autorizada
- [ ] Rate limiting por usuário/tenant (não só por IP)
- [ ] Validação de input com `zod` nos endpoints críticos
- [ ] Verificar MIME type real dos uploads (não só extensão)

### Infraestrutura
- [ ] CI/CD com GitHub Actions — rodar lint + testes em toda PR
- [ ] Dockerfile multi-stage otimizado para produção
- [ ] `.env.example` completo e documentado

**Arquivos críticos:** `server.js`, `package.json`, `Dockerfile`, `.env.example`

---

## Semana 2 — Multi-Tenancy & Autenticação
> **Dias 8–14**

### Multi-Tenant
- [ ] Middleware que extrai `tenant_id` do JWT e injeta em todos os requests
- [ ] Todos os queries filtram por `tenant_id` automaticamente
- [ ] Isolamento total de dados entre clientes (tenant A não vê dados do B)

### Auth Melhorada
- [ ] Substituir `express-session + file store` → JWT (stateless, escalável)
- [ ] Roles: `super_admin` (dono da plataforma) · `admin` (cliente) · `vendedor`
- [ ] Endpoint de registro de novos clientes (tenant signup)
- [ ] Recuperação de senha por email (SendGrid ou Resend)
- [ ] 2FA opcional via TOTP

### Testes
- [ ] Testes de integração para auth (login, roles, isolamento de tenant)
- [ ] Expandir `scripts/test_e2e.mjs` para cobrir novos fluxos

**Arquivos críticos:** `server.js`, novo `lib/auth.js`, `test/`

---

## Semana 3 — API, Testes & Observabilidade
> **Dias 15–21**

### Documentação da API
- [ ] Integrar Swagger/OpenAPI (`swagger-jsdoc` + `swagger-ui-express`)
- [ ] Documentar os 50+ endpoints com exemplos de request/response
- [ ] Endpoint `/api/docs` acessível para admins

### Testes — Meta: ≥ 80% de cobertura
- [ ] `lib/humanize.js` — edge cases adicionais (já tem 9 casos)
- [ ] `lib/relationships.js` — completar cobertura
- [ ] Endpoints principais: geração de mensagem, aprovação, envio
- [ ] Testes de carga básicos com `autocannon` nos endpoints de IA

### Monitoramento
- [ ] Sentry para error tracking (frontend + backend)
- [ ] Logs estruturados com `pino` (JSON, nível configurável)
- [ ] Health check `/api/health` — retorna status de DB + APIs externas
- [ ] Rastrear tokens Anthropic consumidos por tenant

**Arquivos críticos:** `server.js`, `test/`, novo `lib/logger.js`

---

## Semana 4 — Billing & Onboarding
> **Dias 22–28**

### Sistema de Pagamento — Stripe

| Plano | Usuários | Mensagens/mês | Preço |
|-------|----------|---------------|-------|
| Starter | 1 | 200 | R$ 197/mês |
| Pro | 5 | 1.000 | R$ 497/mês |
| Enterprise | Ilimitado | Ilimitado | Sob consulta |

- [ ] Criar planos e produtos no Stripe Dashboard
- [ ] Webhook Stripe para ativar/suspender tenant automaticamente
- [ ] Tabela `subscriptions` (`tenant_id`, `plan`, `status`, `stripe_subscription_id`)
- [ ] Middleware que bloqueia uso se assinatura expirada
- [ ] Portal do cliente Stripe para autogerenciar pagamento

### Onboarding
- [ ] Tela de signup → criação de tenant → tutorial guiado (5 passos)
- [ ] Wizard para configurar: produto, setor-alvo, tom de voz, WhatsApp
- [ ] Upload do primeiro documento (knowledge base) durante onboarding
- [ ] Email de boas-vindas com credenciais + link para documentação

**Arquivos críticos:** novo `lib/billing.js`, `server.js`, `frontend/src/pages/Signup.jsx`, `frontend/src/pages/Onboarding.jsx`

---

## Semana 5 — Frontend Polido & Landing Page
> **Dias 29–35**

### Landing Page (site de vendas)
- [ ] Seção Hero — proposta de valor clara
- [ ] Seção Problema → Solução
- [ ] Seção Features (com capturas de tela ou mockups)
- [ ] Seção Prova Social (resultados do piloto — 5/5 mensagens aprovadas)
- [ ] Seção Preços com os 3 planos
- [ ] FAQ + CTA
- [ ] Meta tags OG + favicon para compartilhamento social

### Melhorias no Dashboard
- [ ] Onboarding checklist (% de configuração concluído)
- [ ] Widget de uso — mensagens consumidas vs limite do plano
- [ ] Alertas visuais: limite próximo, assinatura expirando
- [ ] Notificações por email (follow-up pendente, resposta recebida)

### UX Polish
- [ ] Loading states consistentes em todas as páginas
- [ ] Tratamento de erro padronizado (toasts + fallback UI)
- [ ] Revisão de responsividade mobile (`mobile.css`)

**Arquivos críticos:** `frontend/src/pages/`, `frontend/src/theme.css`, novo `frontend/src/pages/Landing.jsx`

---

## Semana 6 — Beta, Ajustes & Lançamento
> **Dias 36–45**

### Beta Privado · Dias 36–40
- [ ] Convidar 3–5 clientes do setor comercial/vendas
- [ ] Plano beta: acesso gratuito ou com desconto em troca de feedback estruturado
- [ ] Monitorar Sentry, logs e métricas de uso em tempo real
- [ ] Coletar feedbacks via formulário (Typeform ou similar)

### Ajustes Pós-Beta · Dias 41–43
- [ ] Corrigir bugs críticos reportados pelos beta testers
- [ ] Tuning dos prompts com base em uso real
- [ ] Documentação de usuário final (Notion ou Gitbook)

### Lançamento · Dias 44–45
- [ ] DNS, SSL e domínio customizado apontando para Fly.io/Render
- [ ] Página de status pública (`status.dominio.com.br`) — Upptime ou BetterUptime
- [ ] Anúncio em canais: LinkedIn, WhatsApp, comunidades de vendas
- [ ] Termos de Serviço + Política de Privacidade (compatíveis com LGPD)
- [ ] 🎯 **Primeiro cliente pagante convertido**

---

## Linha do Tempo (Gantt)

```
         S1          S2          S3          S4          S5          S6
         Dias 1-7    Dias 8-14   Dias 15-21  Dias 22-28  Dias 29-35  Dias 36-45
─────────────────────────────────────────────────────────────────────────────────
PostgreSQL  ████
Segurança   ████████
JWT/Roles               ████
Multi-tenant            ████
Testes E2E              ████████
Swagger                             ████
Sentry/Logs                         ████
Stripe                                          ████
Onboarding                                      ████████
Landing Page                                                ████
Dashboard UX                                                ████
Beta                                                                    ████████
Lançamento                                                              ████████
```

---

## Checklist de Verificação Final

### Testes & Qualidade
- [ ] `npm test` — todos os testes passam
- [ ] `node scripts/test_e2e.mjs` — 14/14 asserts verdes
- [ ] Cobertura ≥ 80% nos módulos `lib/humanize.js`, `lib/relationships.js`, endpoints principais
- [ ] Testes de carga sem degradação nos endpoints de geração IA

### Infraestrutura
- [ ] `docker build && docker run -p 3000:3000` — sobe sem erro
- [ ] `/api/health` retorna 200 com status de DB + Anthropic + WhatsApp

### Produto
- [ ] Isolamento multi-tenant: dados do tenant A invisíveis para tenant B
- [ ] Stripe webhook: ativar plano → acesso liberado / cancelar → acesso bloqueado
- [ ] Blind test: < 50% de acerto dos revisores humanos (anti-bot validado)
- [ ] 3+ clientes beta completam fluxo: signup → mensagem → resposta do prospect

### Legal
- [ ] Termos de Serviço publicados
- [ ] Política de Privacidade publicada (LGPD compliant)
- [ ] Opt-out funcionando end-to-end (consent_logs + bloqueio de envio)

---

## Dependências Externas Necessárias

| Serviço | Uso | Quando configurar |
|---------|-----|-------------------|
| **PostgreSQL** (Neon, Supabase ou Railway) | Banco de produção | Semana 1 |
| **Stripe** | Billing e assinaturas | Semana 4 |
| **SendGrid ou Resend** | Emails transacionais | Semana 2 |
| **Sentry** | Error tracking | Semana 3 |
| **Domínio customizado** | DNS + SSL | Semana 6 |
| **Upptime / BetterUptime** | Status page | Semana 6 |

---

*Sales AI Agent · Cronograma gerado em 03/08/2026*
