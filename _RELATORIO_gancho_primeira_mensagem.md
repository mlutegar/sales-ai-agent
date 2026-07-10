# Relatório — Teste "Definir gancho da primeira mensagem"

**Data:** 2026-07-09 · **App:** http://localhost:3000/whatsapp · **Base de produto:** PDF Gooxi (carregado no RAG, doc id 8)
**Rota testada:** `POST /api/companies/:id/sequence` (gera a 1ª mensagem WhatsApp)
**Leads:** parceiros/empresas citados no PDF Gooxi · **Mix:** 3 warm (contexto manual) + 2 cold (web search real)
**Revisores:** A = vendedor sênior B2B · B = prospect/destinatário · Aceite = contexto específico presente **E** ambos "não parece bot".

---

## As 5 mensagens geradas

### 1. Intel — Ricardo Almeida (warm) · Produto: rackmount Intel Platform + AI 8U 8-GPU Eagle Stream
> Oi Ricardo, tudo bem? Somos parceiros estratégicos da Intel no programa OEM para plataformas de referência Eagle Stream / Birch Stream — e sei que acelerar time-to-market com um fabricante de cadeia completa é crítico nesse tipo de avaliação. A Gooxi tem cadeia industrial L1-L11 e já entrega os servidores rackmount e AI servers 8-GPU nessa plataforma. Vale uma conversa rápida de 15 min pra ver se faz sentido pra vocês?

### 2. AMD — Fernanda Costa (cold) · Produto: AI server EPYC Turin 8U 8-GPU OAM
> Fala Fernanda! Vi que a AMD bateu US$ 5,8 bi em Data Center só no Q1 — impressionante. Nessa corrida por capacidade de treino e inferência de LLM, densidade de GPU e eficiência energética viram gargalo rápido. A gente tem ajudado times a resolver exatamente isso com servidores Gooxi 8U/8-GPU OAM na plataforma EPYC Turin — mais compute por rack, menor custo por token. Vale 15 min pra trocar ideia?

### 3. Huawei Ascend — Bruno Tanaka (warm) · Produto: 4U 8-GPU Dual-Ascend + solução DeepSeek
> Oi Bruno! Como parceiro oficial APN da Huawei Ascend, vi que o time está buscando hardware para servidores de IA com aceleradores Ascend e entrega rápida. A Gooxi tem o servidor 4U 8-GPU Dual-Ascend em estoque — com a solução DeepSeek pronta para deploy imediato, sem dependência externa. Soberania tecnológica e disponibilidade real, não promessa. Vale uma conversa de 15 min pra te mostrar como isso se encaixa no que vocês precisam?

### 4. Loongson — Camila Ribeiro (cold) · Produto: servidor "indigenous & controllable" Loongson
> Camila, vi que a Loongson está no centro da política de substituição doméstica em órgãos públicos — o 3C3000 abrindo um ciclo importante de licitações. A Gooxi já entrega servidores prontos sobre essa plataforma, com stack 100% homologável para conformidade no setor público. Vale 15 min pra ver o que isso representa em ROI e agilidade no seu pipeline de contratos?

### 5. Hygon — Diego Moraes (warm) · Produto: servidor Hygon liquid-cooling HPC/finanças
> Olá Diego, tudo bem? Soube que a Hygon está buscando parceiros para servidores de alta densidade com refrigeração líquida para data centers financeiros — exatamente onde a gente atua. A Gooxi é parceira certificada Hygon e temos resolvido justamente o problema de dissipação térmica em ambientes de alta densidade, com impacto direto em eficiência energética e custo operacional. Vale um papo rápido de 15 minutos para te mostrar como isso se aplica ao contexto de vocês?

---

## Validação (2 revisores)

| # | Lead | Contexto específico do lead | Produto Gooxi correto | Revisor A (vendedor sênior) | Revisor B (prospect) | Veredito |
|---|------|------------------------------|-----------------------|------------------------------|-----------------------|----------|
| 1 | Intel | ✓ parceria OEM, Eagle/Birch Stream | ✓ rackmount + AI 8-GPU | Passou — gancho ligado à parceria, CTA progressivo, sem vender direto | Passou — soa humano ("tudo bem?"), pessoal | ✅ **Passou** |
| 2 | AMD | ✓ dado financeiro Q1 Data Center + LLM | ✓ EPYC Turin 8U 8-GPU OAM | Passou — forte, "custo por token" fala a língua do cargo. ⚠ validar o número US$ 5,8 bi (veio de web search) | Passou — abertura natural, energética | ✅ **Passou** (verificar o dado antes de enviar) |
| 3 | Huawei Ascend | ✓ APN Partner, busca de hardware Ascend | ✓ 4U 8-GPU Dual-Ascend + DeepSeek | Passou — "disponibilidade real, não promessa" é bom diferencial | Passou — humano, embora "soberania tecnológica" seja levemente buzzword | ✅ **Passou** |
| 4 | Loongson | ✓ substituição doméstica + CPU 3C3000 + licitações | ✓ servidor Loongson homologável | Passou — muito específico; ⚠ confirmar menção ao "3C3000" | Passou — parece pesquisa real, não template | ✅ **Passou** (verificar o "3C3000") |
| 5 | Hygon | ✓ liquid-cooling p/ data center financeiro | ✓ servidor Hygon refrigeração líquida | Passou — aderente à dor; é a mais formulaica das 5 | Passou (limítrofe) — soa humano, mas estrutura mais "modelo" | ✅ **Passou** |

**Resultado: 5/5 aprovadas.** Todas contêm contexto específico do lead **e** do produto Gooxi, e passaram no teste "não parece bot" nos 2 revisores.

## Observações e recomendações
- **cold vs warm:** as 2 cold (AMD, Loongson) trouxeram fatos externos concretos (números, nome de CPU) via web search — ótimos ganchos, mas **exigem checagem factual antes do envio** (risco de alucinação). As 3 warm ficaram fiéis ao contexto do operador.
- **Ponto de atenção:** a msg da Hygon é a mais próxima de um template ("tudo bem? ... exatamente onde a gente atua"). Se repetir muito esse padrão entre leads, começa a "cheirar a bot". Sugestão: variar a abertura via `hook_library`.
- **Estabilidade:** 1ª tentativa cold do Loongson caiu por timeout de conexão na web search; reexecução funcionou. Vale um retry automático no fluxo cold.
- Todas respeitaram o CTA progressivo ("conversa de 15 min"), sem tentativa de venda direta — conforme a regra do prompt (server.js ~2425).
