# Checklist anti-detecção de bot — WhatsApp (`/whatsapp`)

Objetivo: as mensagens geradas pela automação **não devem ser percebidas como bot**.
Critério de sucesso do teste cego: taxa de acerto dos testadores **< 50%**.

A lógica de humanização vive em **`lib/humanize.js`** (funções puras, testadas em
`test/humanize.test.js` — rode `npm test`). O `server.js` importa e aplica essas funções.

## 1. Critérios de escrita (aplicados na automação)

| Dimensão | Critério humano | Onde é aplicado |
|---|---|---|
| **Tom** | Casual, 1ª pessoa, sem jargão de marketing | `humanizationBlock()` no prompt + `BOT_WORDS`/`botWordScan()` |
| **Comprimento** | Varia ~28 / 45 / 70 palavras por mensagem | `styleProfile().lengthTarget` |
| **Abertura** | Rotaciona: com nome / sem nome / direto / por contexto | `styleProfile().opener` |
| **Variação de frase** | Não repete saudação/estrutura já usada na thread | `buildThreadHistory` + perfil por mensagem |
| **Anti auto-similaridade** (item 2) | Rejeita/regenera se ficar parecida demais com mensagens recentes (Jaccard de trigramas ≥ 0.6) | `similarity()` / `qualityIssues()` + `recentTexts` |
| **Auto-regeneração** (item 1) | Até 3 tentativas: regenera se sair do papel, usar jargão ou repetir | loop em `generateWhatsapp` |
| **Tempo de resposta** (item 3) | Delay real e variável; **muito mais lento fora do horário comercial**; nem toda msg na hora | `humanDelayMs(text, {hour})` / `offHours()` |
| **Bolhas** | Mensagem longa dividida em 2 bolhas | `splitBubbles()` |
| **Erros humanos sutis** (item 4) | Minúsculas iniciais, "vc/pra/tá/tbm/pq", sem ponto final, reticências, **remoção ocasional de acento** de uma palavra | `humanizeWhatsapp()` |
| **Emojis** | No máx. 1, ~30% das mensagens | `styleProfile().emoji` |
| **Pontuação** | Sem travessão "—" e sem listas numeradas | `humanizeWhatsapp()` + `botWordScan()` |
| **Consistência por conversa** (item 12) | Abertura e registro (abreviações) ficam estáveis dentro da mesma thread | `styleProfile(threadSeed = thread_id)` |
| **Perfil auditável** (item 11) | O perfil de estilo usado é salvo em `messages.style_profile` | rotas de geração |

Aplicação nos dois fluxos de geração:
- **1ª abordagem** (`generateSequenceForCompany`): humaniza + regenera se houver jargão + salva perfil.
- **Regeneração / auto-reply**: `generateWhatsapp` com loop de qualidade + `humanizeWhatsapp`.
- **Envio** (`/api/messages/:id/send`): delay humano por horário + nº de bolhas.

## 2. Protocolo do teste cego (3–5 pessoas)

1. Escolha **3 a 5 pessoas que não conhecem o projeto**.
2. Aba **Teste cego** (`/blindtest`) → **Semear**: informe um **Cenário** e cole ~10 mensagens
   **reais** e ~10 **da automação** (separadas por uma linha com `---`).
   **Semeie um cenário por vez** (item 6): mensagens reais e automáticas sobre o mesmo assunto,
   senão o testador acerta pelo *tema* e não pelo *estilo*.
3. Cada pessoa abre **Rodar teste**, informa o nome, e classifica cada mensagem como
   *Pessoa real* ou *Automação*. Ao marcar "Automação", pode indicar **por que** achou (tags).
4. Em **Resultados**: taxa agregada, por testador, e o ranking de motivos ("por que acharam bot").

### Leitura do resultado
- **Acerto < 50%** → ✅ sucesso: automação indistinguível de humano.
- **Acerto ≥ 50%** → ⚠️ ajustar. Use o botão **"Aprender com as falhas"** (item 8): as mensagens
  automáticas mais detectadas viram `learned_patterns` negativos e passam a ser evitadas nas
  próximas gerações. Depois refine `humanizeWhatsapp` / `humanizationBlock` e repita.

> Rigor estatístico (a melhorar): com ~60–100 palpites, diferenças perto de 50% podem ser ruído.
> Trate 45–55% como "empate" e rode mais rodadas antes de declarar sucesso.

## 3. Endpoints
- `POST /api/blindtest/seed` — `{ real:[...], auto:[...], scenario, reset, batch }`
- `GET  /api/blindtest/items` — itens embaralhados, sem origem (inclui `scenario`)
- `POST /api/blindtest/guess` — `{ item_id, tester_name, guess:'real'|'auto', reason }`
- `GET  /api/blindtest/results` — taxa agregada + por testador + `reasons` + `success`
- `POST /api/blindtest/harvest` — `{ min_guesses, min_rate }` → cria regras aprendidas

## 4. Testes
`npm test` roda `test/humanize.test.js` (9 casos cobrindo scan de jargão, similaridade,
perfil por seed, abreviações acentuadas, bolhas, delay por horário e `qualityIssues`).
