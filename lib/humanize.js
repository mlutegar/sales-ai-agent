'use strict';
// Camada de humanização anti-detecção de bot para mensagens de WhatsApp.
// Funções puras e testáveis (ver test/humanize.test.js). Ver docs/anti-bot-checklist.md.

// ── PRNG determinístico (para variação estável por thread — item 12) ───────────
function hashStr(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Palavras que "denunciam" IA / marketing genérico ──────────────────────────
const BOT_WORDS = [
  'solução', 'soluções', 'otimizar', 'potencializar', 'alavancar', 'sinergia',
  'inovador', 'inovadora', 'revolucionar', 'revolucionário', 'transformar sua',
  'agregar valor', 'ecossistema', 'end-to-end', 'personalizado para você',
  'nossa equipe está', 'não hesite', 'fico à disposição', 'atenciosamente',
  'espero que esta mensagem', 'gostaria de apresentar', 'de forma eficiente',
];

// Detecta marcas textuais de IA numa mensagem (auditoria/relatório).
function botWordScan(text) {
  const low = (text || '').toLowerCase();
  const hits = BOT_WORDS.filter(w => low.includes(w));
  if (/—/.test(text || '')) hits.push('travessão (—)');
  if (/^\s*\d+[\.\)]\s/m.test(text || '')) hits.push('lista numerada');
  return hits;
}

// ── Similaridade (anti auto-similaridade em escala — item 2) ───────────────────
function trigrams(text) {
  const norm = (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = norm.split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i < words.length - 2; i++) set.add(words.slice(i, i + 3).join(' '));
  if (!set.size) words.forEach(w => set.add(w)); // fallback p/ textos muito curtos
  return set;
}
function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter); // Jaccard
}
function maxSimilarity(text, others) {
  let mx = 0;
  for (const o of (others || [])) { const s = similarity(text, o); if (s > mx) mx = s; }
  return mx;
}

// ── Perfil de estilo por mensagem ─────────────────────────────────────────────
// Item 12: quando `seed` (ex.: thread_id) é passado, a ABERTURA e o REGISTRO
// (uso de abreviações/minúsculas) ficam estáveis dentro da conversa; o resto varia.
function styleProfile(seed) {
  const rnd = (seed === undefined || seed === null) ? Math.random : mulberry32(hashStr(seed));
  const openers = ['nome', 'sem_nome', 'direto', 'contexto'];
  const opener = openers[Math.floor(rnd() * openers.length)];
  const abbreviations = rnd() < 0.45;
  const lowercaseStart = rnd() < 0.35;
  // partes que variam a cada mensagem, mesmo na mesma thread:
  return {
    opener, abbreviations, lowercaseStart,
    lengthTarget: [28, 45, 70][Math.floor(Math.random() * 3)],
    emoji: Math.random() < 0.3,
    dropFinalPeriod: Math.random() < 0.5,
    ellipsis: Math.random() < 0.15,
    typo: Math.random() < 0.18, // micro-imperfeição sutil (item 4)
  };
}

// ── Bloco de critérios injetado no prompt ─────────────────────────────────────
function humanizationBlock(profile) {
  const openers = {
    nome: 'comece chamando a pessoa pelo primeiro nome',
    sem_nome: 'NÃO comece com o nome da pessoa; vá direto ao assunto',
    direto: 'abra direto no ponto, sem saudação formal',
    contexto: 'abra referenciando um contexto/situação real da pessoa ou empresa',
  };
  return `\n# CRITÉRIOS DE HUMANIZAÇÃO (siga para não parecer bot)
- Abertura: ${openers[profile.opener]}.
- Comprimento alvo: ~${profile.lengthTarget} palavras (varie o ritmo, nem toda frase completa).
- Tom casual de WhatsApp, 1a pessoa. PROIBIDO jargão de marketing (ex.: solução, otimizar, potencializar, alavancar, sinergia, à disposição, atenciosamente).
- Não use travessão "—", nem listas numeradas, nem emojis em excesso${profile.emoji ? ' (no máx. 1 emoji, se fizer sentido)' : ' (sem emoji desta vez)'}.
- Não repita saudações/estruturas já usadas na conversa; traga uma abordagem nova.
- Escreva como alguém digitando rápido no celular: direto, natural, sem soar publicitário.\n`;
}

// ── Pós-processador: informalidades SUTIS e reversíveis + remoção de marcas IA ──
function humanizeWhatsapp(text, profile) {
  let t = (text || '').trim();
  if (!t) return t;
  const p = profile || {};
  t = t.replace(/^["“”']+|["“”']+$/g, '').trim();
  t = t.replace(/([.!?…])\s*—\s*/g, '$1\n');             // travessão após fim de frase (ex.: assinatura) → quebra de linha
  t = t.replace(/\s*—\s*/g, ', ');                       // travessão de IA no meio da frase
  if (p.abbreviations) {
    // Fronteiras cientes de acento (\b do JS não delimita ê/á/…).
    const BB = '(?<![0-9A-Za-zÀ-ÿ])', AA = '(?![0-9A-Za-zÀ-ÿ])';
    const abbr = [['você', 'vc'], ['para', 'pra'], ['está', 'tá'], ['também', 'tbm'], ['por que', 'pq']];
    for (const [from, to] of abbr) {
      const re = new RegExp(BB + from + AA, 'i');
      t = t.replace(re, m => (/[A-ZÀ-Ú]/.test(m[0]) ? to[0].toUpperCase() + to.slice(1) : to));
    }
  }
  // Micro-imperfeição (item 4): remove o acento de UMA palavra (típico de quem digita
  // rápido no celular). Subtil e não compromete a leitura.
  if (p.typo) {
    t = t.replace(/\b(\w*[áàâãéêíóôõúç]\w*)\b/i, (w) => {
      const bare = w.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ç/gi, m => (m === 'Ç' ? 'C' : 'c'));
      return bare === w ? w : bare;
    });
  }
  if (p.lowercaseStart && /^[A-ZÀ-Ú]/.test(t)) t = t[0].toLowerCase() + t.slice(1);
  if (p.ellipsis) t = t.replace(/\.(\s|$)/, '...$1');
  if (p.dropFinalPeriod) t = t.replace(/\.\s*$/, '').trim();
  return t;
}

// Divide mensagens longas em 2 "bolhas", como um humano no WhatsApp.
function splitBubbles(text) {
  const t = (text || '').trim();
  if (t.length < 160) return [t];
  const sentences = t.split(/(?<=[.!?])\s+/);
  if (sentences.length < 2) return [t];
  const mid = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, mid).join(' ').trim(), sentences.slice(mid).join(' ').trim()].filter(Boolean);
}

// ── Delay de envio realista (item 3: depende do horário e da "presença") ───────
// hour: 0-23 (hora local do envio). Fora do horário comercial, respostas demoram
// muito mais (ou devem ficar pendentes). Nem toda mensagem responde na hora.
function humanDelayMs(text, opts = {}) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  const base = 8000, typing = words * 380, jitter = Math.floor(Math.random() * 25000);
  let ms = base + typing + jitter;
  const hour = (opts.hour === undefined || opts.hour === null) ? 12 : opts.hour;
  if (hour < 8 || hour >= 20) ms *= 6;            // madrugada/noite: bem mais lento
  else if (hour < 9 || hour >= 18) ms *= 2;       // início/fim de expediente
  if (Math.random() < 0.25) ms *= (1.5 + Math.random() * 2); // "estava ocupado"
  return Math.min(Math.round(ms), (hour < 8 || hour >= 20) ? 3600000 : 600000);
}
function offHours(hour) { return hour < 8 || hour >= 20; }

// ── Avaliação de qualidade (itens 1 + 2) ──────────────────────────────────────
// Retorna problemas que justificam uma regeneração antes de enfileirar.
function qualityIssues(text, recentTexts = [], opts = {}) {
  const maxSim = opts.maxSim === undefined ? 0.6 : opts.maxSim;
  const botMarks = botWordScan(text);
  const simScore = maxSimilarity(text, recentTexts);
  return {
    botMarks,
    simScore,
    tooSimilar: simScore >= maxSim,
    ok: botMarks.length === 0 && simScore < maxSim,
  };
}

// ── Placeholders não resolvidos ───────────────────────────────────────────────
// Detecta [Colchetes], {chaves} e <angulares> com conteúdo alfabético
// (ex.: [Nome], {empresa}, <link>, [seu nome]) que jamais devem ir ao cliente.
const PLACEHOLDER_RE = /\[[^\]\n]*[A-Za-zÀ-ÿ][^\]\n]*\]|\{[^}\n]*[A-Za-zÀ-ÿ][^}\n]*\}|<[^>\n]*[A-Za-zÀ-ÿ][^>\n]*>/g;
function findUnresolvedPlaceholders(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) found.add(m[0]);
  return [...found];
}

// Última linha de defesa: remove placeholders que escaparam do prompt, junto de
// frases de auto-apresentação que só existiam por causa deles ("Aqui é [seu nome]...").
function stripPlaceholders(text) {
  if (!text || !findUnresolvedPlaceholders(text).length) return text;
  let t = text;
  t = t.replace(/\b(aqui é|aqui quem fala é|meu nome é|sou o|sou a|sou)\s*(\[[^\]\n]*\]|\{[^}\n]*\}|<[^>\n]*>)\s*[.…]*/gi, '');
  t = t.replace(PLACEHOLDER_RE, '');
  t = t.replace(/\s{2,}/g, ' ')
       .replace(/\s+([,.!?…])/g, '$1')
       .replace(/([,.!?])\1+/g, '$1')
       .replace(/\.\.\./g, '…')
       .trim();
  return t;
}

// Verifica se o texto menciona o produto: extrai termos significativos do nome do
// produto (>=4 letras, sem stopwords) e checa se ao menos um aparece no texto.
// Usado para garantir que o gancho gire em torno do produto, não só da empresa.
const PRODUCT_STOPWORDS = new Set([
  'com', 'para', 'sem', 'dos', 'das', 'uma', 'uns', 'que', 'por', 'sua', 'seu',
  'nossa', 'nosso', 'de', 'da', 'do', 'em', 'ia', 'e', 'a', 'o', 'as', 'os',
  'solução', 'solucao', 'plataforma', 'sistema', 'ferramenta', 'produto', 'serviço', 'servico',
]);
function productTerms(productValue) {
  return String(productValue || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !PRODUCT_STOPWORDS.has(w));
}
function productMentioned(text, productValue) {
  const terms = productTerms(productValue);
  if (!terms.length) return true; // produto genérico/sem termos fortes: não força
  const low = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return terms.some(t => low.includes(t));
}

// Saneador único de mensagem de saída ao cliente: humaniza (tira "—", aspas de IA,
// aplica micro-informalidades) e remove placeholders. Use em TODO ponto que gera
// mensagem para o lead, para não depender de cada caminho lembrar de cada limpeza.
function sanitizeOutbound(text, profile) {
  return stripPlaceholders(humanizeWhatsapp(text, profile));
}

module.exports = {
  hashStr, mulberry32,
  BOT_WORDS, botWordScan,
  similarity, maxSimilarity, trigrams,
  styleProfile, humanizationBlock, humanizeWhatsapp,
  splitBubbles, humanDelayMs, offHours,
  qualityIssues,
  findUnresolvedPlaceholders, stripPlaceholders, sanitizeOutbound,
  productTerms, productMentioned,
};
