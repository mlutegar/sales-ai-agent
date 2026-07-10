# Melhorias implementadas (itens 2–11)

Todas em `server.js`, validadas por `scripts/test_e2e.mjs` (**14/14 asserts passando**).

| # | Melhoria | O que mudou |
|---|----------|-------------|
| **2** | Falha da IA não polui dados | `callClaude` ganhou **retry com backoff** (429/5xx/rede, 3 tentativas). Sentinela `isAiError()`. Endpoints que persistem (sequência, bot-reply, prospect-reply, follow-up) **abortam com 502** em vez de gravar `[ERRO API]`. Inbound marca `needs_review` sem rebaixar o funil. |
| **3** | Guardrails antes do envio | `/api/messages/:id/approve` bloqueia (422) **placeholders não resolvidos** (`[Nome]`, `{empresa}`, `<link>`) via `findUnresolvedPlaceholders()` — override consciente com `override_placeholder:true`. Também barra texto de erro da IA. |
| **4** | Taxa de resposta real | `/api/metrics/overview` agora retorna bloco `engagement`: `response_rate_pct` (contatos que responderam / abordados), `meeting_conversion_pct`, contagens. O antigo `response_rate` (score×20) virou `quality_score` (mantido p/ compat). |
| **5** | Coerência de agenda | `bot-reply` extrai horários já citados na conversa (`parseMeetingDateTime`) e injeta nota anti-contradição: não reabrir/duplicar horário combinado; pedir 1 confirmação se houver dois. |
| **6** | Follow-up real + agendador | `/api/followup/:id/generate` agora gera texto **real com IA e contexto** (rascunho pendente, sem duplicar). Novo agendador opcional (`FOLLOWUP_SCHEDULER=on`) e gatilho manual `POST /api/followup/sweep`. |
| **7** | Intenção → slot automático | No inbound, `wants_meeting` com horário explícito **cria slot sugerido** + notificação; sem horário, retorna dica p/ propor opções. Campo `meeting_suggestion` na resposta. |
| **8** | Concorrência SQLite | `getDb()` aplica `PRAGMA journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`. **Ver ressalva abaixo.** |
| **9** | Rate limit + auditoria | Middleware de **rate limit** em `/api` (janela deslizante, `RATE_LIMIT_MAX/WINDOW_MS`). Tabela `audit_logs` + `audit()` registra aprovar/agendar; leitura em `GET /api/audit`. |
| **10** | LGPD no envio | `sendingBlockedByConsent()` bloqueia (403) envio a empresa/contato com opt-out ou flag "não contatar", com log em `consent_logs`. |
| **11** | Teste E2E de regressão | `scripts/test_e2e.mjs` — cobre #2,#4,#5,#7,#9,#10 com asserts e exit code. |

## Ressalva importante — item 8 (SQLite → PostgreSQL)

Fiz a melhoria **pragmática e segura** (WAL + busy_timeout), que resolve a maior parte dos
`database is locked` sob concorrência. A **migração completa para PostgreSQL não foi feita** por ser
um projeto à parte, de alto risco: todo o acesso usa a API **síncrona** `node:sqlite`
(`db.prepare(...).get/all/run`) em **centenas de call sites**, com placeholders `?`. Portar para
Postgres exige reescrever a camada de dados para **assíncrona** (`pg` pool, `await`, placeholders
`$1`) em todo o arquivo — algo que deve ser feito de forma isolada e testada, não junto deste lote.
Recomendo tratá-la como uma tarefa dedicada.

## Novas variáveis de ambiente (todas opcionais)

```
RATE_LIMIT_MAX=120            # máx. requisições por janela (default 120)
RATE_LIMIT_WINDOW_MS=60000    # janela do rate limit (default 60s)
FOLLOWUP_SCHEDULER=on         # liga o agendador de follow-up (default desligado)
FOLLOWUP_DAYS=3               # dias parado antes de gerar follow-up (default 3)
FOLLOWUP_INTERVAL_MS=21600000 # intervalo da varredura (default 6h)
```

## Como rodar o teste

```bash
npm start                    # servidor na porta 3000
node scripts/test_e2e.mjs    # 14/14 esperado; exit 0 = ok
```
