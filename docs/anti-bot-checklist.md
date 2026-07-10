# Checklist anti-detecção de bot — WhatsApp (`/whatsapp`)

Objetivo: as mensagens geradas pela automação **não devem ser percebidas como bot**.
Critério de sucesso do teste cego: taxa de acerto dos testadores **< 50%**.

## 1. Critérios de escrita (aplicados na automação)

Implementados em `server.js` (camada de humanização, antes de `WA_SYSTEM`):

| Dimensão | Critério humano | Onde é aplicado |
|---|---|---|
| **Tom** | Casual, 1ª pessoa, sem jargão de marketing | `humanizationBlock()` no prompt + lista `BOT_WORDS` / `botWordScan()` |
| **Comprimento** | Varia ~28 / 45 / 70 palavras por mensagem (não fixo) | `styleProfile().lengthTarget` |
| **Abertura** | Rotaciona: com nome / sem nome / direto / por contexto | `styleProfile().opener` |
| **Variação de frase** | Não repete saudação/estrutura já usada na thread | `buildThreadHistory` + perfil aleatório por mensagem |
| **Tempo de resposta** | Delay real e variável (8s + ~380ms/palavra + jitter até 25s, teto 4min) | `humanDelayMs()` na rota `/api/messages/:id/send` |
| **Bolhas** | Mensagem longa dividida em 2 bolhas (comportamento humano) | `splitBubbles()` |
| **Erros humanos sutis** | Minúsculas iniciais ocasionais, "vc/pra/tá/tbm/pq", sem ponto final, reticências | `humanizeWhatsapp()` (probabilístico e reversível) |
| **Emojis** | No máx. 1, em ~30% das mensagens | `styleProfile().emoji` |
| **Pontuação** | Sem travessão "—" e sem listas numeradas (marcas de IA) | `humanizeWhatsapp()` + `botWordScan()` |

Aplicação no fluxo:
- Geração/regeneração (`generateWhatsapp`): perfil de estilo aleatório → prompt com
  `humanBlock` → pós-processamento `humanizeWhatsapp(out, profile)`.
- Auto-reply do webhook: `humanizeWhatsapp(draft, styleProfile())`.
- Envio: delay humano variável + contagem de bolhas retornados por `/api/messages/:id/send`.

## 2. Protocolo do teste cego (3–5 pessoas)

1. Escolha **3 a 5 pessoas que não conhecem o projeto**.
2. Na aba **Teste cego** (`/blindtest`) → **Semear mensagens**: cole ~10 mensagens
   **reais** (humanas) e ~10 **da automação**, separadas por uma linha com `---`.
   (Reais podem ser exportadas de conversas verdadeiras; automação, geradas em `/whatsapp`.)
3. Cada pessoa abre **Rodar teste**, informa o nome e classifica cada mensagem como
   *Pessoa real* ou *Automação*. A origem nunca é revelada durante a rodada.
4. Em **Resultados**, confira a taxa de acerto agregada e por testador.

### Leitura do resultado
- **Acerto < 50%** → ✅ sucesso: a automação está indistinguível de mensagens humanas.
- **Acerto ≥ 50%** → ⚠️ ajustar: colete as mensagens mais "denunciadas", rode
  `botWordScan()` mentalmente/nos logs, e refine `humanizeWhatsapp` / `humanizationBlock`
  (ou registre correções como `learned_patterns` via curadoria RLHF). Repita o teste.

## 3. Endpoints
- `POST /api/blindtest/seed` — `{ real: [...], auto: [...], reset, batch }`
- `GET  /api/blindtest/items` — itens embaralhados, sem origem
- `POST /api/blindtest/guess` — `{ item_id, tester_name, guess: 'real'|'auto' }`
- `GET  /api/blindtest/results` — taxa agregada + por testador + `success` (bool)
