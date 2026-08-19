import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, '..', 'cronograma_comercializacao.pdf');

// ── Paleta de cores ────────────────────────────────────────────────
const COLORS = {
  primary:    '#1A1A2E',   // azul-noite (cabeçalhos)
  accent:     '#E94560',   // vermelho-vibrante (destaques)
  teal:       '#0F3460',   // azul-escuro (semanas)
  bg:         '#F4F6FB',   // fundo cinza suave
  white:      '#FFFFFF',
  text:       '#2D2D2D',
  muted:      '#6B7280',
  line:       '#E2E8F0',
  s1:         '#3B82F6',   // azul
  s2:         '#8B5CF6',   // roxo
  s3:         '#10B981',   // verde
  s4:         '#F59E0B',   // âmbar
  s5:         '#EC4899',   // rosa
  s6:         '#EF4444',   // vermelho
};

const WEEK_COLORS = [COLORS.s1, COLORS.s2, COLORS.s3, COLORS.s4, COLORS.s5, COLORS.s6];

// ── Dados do cronograma ────────────────────────────────────────────
const weeks = [
  {
    num: 1,
    title: 'Fundação para Produção',
    icon: '🏗️',
    period: 'Dias 1–7',
    items: [
      { cat: 'Banco de Dados', tasks: [
        'Migrar SQLite → PostgreSQL (multi-tenant, concorrência real)',
        'Adicionar coluna tenant_id em todas as tabelas',
        'Script de migração com rollback seguro',
      ]},
      { cat: 'Segurança', tasks: [
        'Adicionar helmet.js (headers HTTP seguros)',
        'CORS configurável por origem',
        'Rate limiting por usuário (não só por IP)',
        'Validação de input (zod/joi) nos endpoints críticos',
      ]},
      { cat: 'Infraestrutura', tasks: [
        'CI/CD com GitHub Actions (lint + tests na PR)',
        'Dockerfile multi-stage otimizado para produção',
        '.env.example completo documentado',
      ]},
    ],
  },
  {
    num: 2,
    title: 'Multi-Tenancy & Autenticação',
    icon: '🔐',
    period: 'Dias 8–14',
    items: [
      { cat: 'Multi-Tenant', tasks: [
        'Middleware de tenant extrai tenant_id do JWT',
        'Todos os queries filtram por tenant_id automaticamente',
        'Isolamento total de dados entre clientes',
      ]},
      { cat: 'Auth Melhorada', tasks: [
        'Trocar express-session + file store → JWT (stateless)',
        'Roles: super_admin / admin (cliente) / vendedor',
        'Endpoint de registro de novos clientes (tenant signup)',
        'Recuperação de senha por email (SendGrid / Resend)',
        '2FA opcional via TOTP',
      ]},
      { cat: 'Testes', tasks: [
        'Testes de integração para auth (login, roles, isolamento)',
        'Expansão do test_e2e.mjs para novos fluxos',
      ]},
    ],
  },
  {
    num: 3,
    title: 'API, Testes & Observabilidade',
    icon: '📡',
    period: 'Dias 15–21',
    items: [
      { cat: 'Documentação da API', tasks: [
        'Integrar Swagger/OpenAPI (swagger-jsdoc + swagger-ui-express)',
        'Documentar os 50+ endpoints com exemplos',
        'Endpoint /api/docs acessível a admins',
      ]},
      { cat: 'Testes (meta ≥80% cobertura)', tasks: [
        'lib/humanize.js — edge cases adicionais (já tem 9)',
        'lib/relationships.js — cobertura completa',
        'Endpoints principais: geração, aprovação, envio',
        'Testes de carga (k6 ou autocannon)',
      ]},
      { cat: 'Monitoramento', tasks: [
        'Sentry para error tracking (frontend + backend)',
        'Logs estruturados com pino (JSON)',
        'Health check /api/health (DB + APIs externas)',
        'Métricas de tokens Anthropic consumidos por tenant',
      ]},
    ],
  },
  {
    num: 4,
    title: 'Billing & Onboarding',
    icon: '💳',
    period: 'Dias 22–28',
    items: [
      { cat: 'Sistema de Pagamento — Stripe', tasks: [
        'Plano Starter — 1 usuário, 200 msgs/mês — R$ 197/mês',
        'Plano Pro — 5 usuários, 1.000 msgs/mês — R$ 497/mês',
        'Plano Enterprise — ilimitado, suporte dedicado',
        'Webhook Stripe para ativar / suspender tenant',
        'Tabela subscriptions (tenant_id, plan, status)',
        'Middleware que bloqueia uso se assinatura expirada',
        'Portal do cliente Stripe para gerenciar pagamento',
      ]},
      { cat: 'Onboarding', tasks: [
        'Tela de signup → criação de tenant → tutorial (5 passos)',
        'Wizard: produto, setor-alvo, tom de voz, WhatsApp',
        'Upload do 1º documento (knowledge base) no onboarding',
        'Email de boas-vindas com credenciais + link para docs',
      ]},
    ],
  },
  {
    num: 5,
    title: 'Frontend Polido & Landing Page',
    icon: '🎨',
    period: 'Dias 29–35',
    items: [
      { cat: 'Landing Page (site de vendas)', tasks: [
        'Seções: Hero, Problema, Solução, Features, Prova Social',
        'Seções: Preços (3 planos), FAQ, CTA',
        'Design baseado no theme.css existente, profissional',
        'Meta tags OG + favicon para compartilhamento',
      ]},
      { cat: 'Melhorias no Dashboard', tasks: [
        'Onboarding checklist (% de configuração completo)',
        'Widget de uso (mensagens usadas / limite do plano)',
        'Alertas: limite próximo, assinatura expirando',
        'Notificações por email (follow-up, resposta recebida)',
      ]},
      { cat: 'UX Polish', tasks: [
        'Loading states consistentes em todas as páginas',
        'Tratamento de erro padronizado (toasts + fallback UI)',
        'Revisão responsividade mobile (mobile.css)',
      ]},
    ],
  },
  {
    num: 6,
    title: 'Beta, Ajustes & Lançamento',
    icon: '🚀',
    period: 'Dias 36–45',
    items: [
      { cat: 'Beta Privado (dias 36–40)', tasks: [
        'Convidar 3–5 clientes do setor comercial',
        'Acesso gratuito em troca de feedback estruturado',
        'Monitorar Sentry, logs e métricas de uso',
        'Coletar feedbacks via formulário (Typeform)',
      ]},
      { cat: 'Ajustes Pós-Beta (dias 41–43)', tasks: [
        'Corrigir bugs críticos reportados',
        'Tuning dos prompts com base em uso real',
        'Documentação de usuário final (Notion / Gitbook)',
      ]},
      { cat: 'Lançamento (dias 44–45)', tasks: [
        'DNS, SSL, domínio customizado → Fly.io / Render',
        'Página de status (Upptime ou BetterUptime)',
        'Anúncio: LinkedIn, WhatsApp, comunidades',
        'Termos de Serviço + Política de Privacidade (LGPD)',
        '🎯 Primeiro cliente pagante!',
      ]},
    ],
  },
];

const metrics = [
  { label: 'Endpoints REST', value: '50+', desc: 'já documentados' },
  { label: 'Linhas de Código', value: '5.671', desc: 'backend (server.js)' },
  { label: 'Testes Existentes', value: '14+', desc: 'unit + e2e' },
  { label: 'Páginas Frontend', value: '18+', desc: 'componentes React' },
  { label: 'Meta Cobertura', value: '≥80%', desc: 'após semana 3' },
  { label: 'Clientes Beta', value: '3–5', desc: 'semana 6' },
];

const plans = [
  { name: 'Starter', price: 'R$ 197/mês', color: COLORS.s1, features: ['1 usuário', '200 mensagens/mês', 'WhatsApp + IA', 'Suporte por email'] },
  { name: 'Pro', price: 'R$ 497/mês', color: COLORS.s3, features: ['5 usuários', '1.000 mensagens/mês', 'RLHF + Blind Test', 'Suporte prioritário'], highlight: true },
  { name: 'Enterprise', price: 'Sob consulta', color: COLORS.s6, features: ['Ilimitado', 'SLA garantido', 'Integração custom', 'Suporte dedicado'] },
];

// ── Helpers ────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}

function applyColor(doc, hex) {
  const [r,g,b] = hexToRgb(hex);
  doc.fillColor([r,g,b]);
}

function strokeColor(doc, hex) {
  const [r,g,b] = hexToRgb(hex);
  doc.strokeColor([r,g,b]);
}

// ── Document ───────────────────────────────────────────────────────
const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 0, bottom: 40, left: 0, right: 0 },
  info: {
    Title: 'Cronograma de Comercialização — Sales AI Agent',
    Author: 'Sales AI Agent Team',
    Subject: 'Roadmap de 45 dias para lançamento comercial',
  },
  bufferPages: true,
});

doc.pipe(fs.createWriteStream(OUTPUT));

const W = doc.page.width;   // 595
const ML = 50;              // margin left
const MR = 50;              // margin right
const CW = W - ML - MR;    // content width

// ══════════════════════════════════════════════════════════════════
// PÁGINA 1 — CAPA
// ══════════════════════════════════════════════════════════════════
function drawCover() {
  // Fundo gradiente simulado com retângulos
  applyColor(doc, COLORS.primary);
  doc.rect(0, 0, W, 420).fill();

  applyColor(doc, COLORS.teal);
  doc.rect(0, 300, W, 120).fill();

  // Detalhe decorativo — linha accent
  applyColor(doc, COLORS.accent);
  doc.rect(ML, 90, 6, 60).fill();

  // Título
  applyColor(doc, COLORS.white);
  doc.font('Helvetica-Bold').fontSize(32);
  doc.text('Cronograma de', ML + 20, 95, { width: CW });
  doc.text('Comercialização', ML + 20, 132, { width: CW });

  applyColor(doc, COLORS.accent);
  doc.font('Helvetica-Bold').fontSize(22);
  doc.text('Sales AI Agent', ML + 20, 178, { width: CW });

  // Subtítulo
  applyColor(doc, '#A0AEC0');
  doc.font('Helvetica').fontSize(12);
  doc.text('Roadmap de 45 dias para transformar o protótipo em produto comercializável', ML + 20, 215, { width: CW - 20 });

  // Badge "45 dias"
  applyColor(doc, COLORS.accent);
  doc.roundedRect(ML + 20, 255, 120, 34, 8).fill();
  applyColor(doc, COLORS.white);
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text('6 SEMANAS', ML + 24, 263, { width: 112, align: 'center' });

  applyColor(doc, '#A0AEC0');
  doc.font('Helvetica').fontSize(10);
  doc.text('Início estimado: Agosto 2026', ML + 20, 298, { width: CW });

  // Métricas rápidas na faixa teal
  const mW = CW / 3;
  const metricsTop = 310;
  const shortMetrics = metrics.slice(0, 6);
  shortMetrics.forEach((m, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = ML + col * mW;
    const y = metricsTop + row * 52;

    applyColor(doc, COLORS.white);
    doc.font('Helvetica-Bold').fontSize(18);
    doc.text(m.value, x, y + 2, { width: mW, align: 'center' });

    applyColor(doc, '#90CDF4');
    doc.font('Helvetica').fontSize(8);
    doc.text(m.label, x, y + 22, { width: mW, align: 'center' });
    doc.text(m.desc, x, y + 33, { width: mW, align: 'center' });
  });

  // Seção inferior — tech stack
  applyColor(doc, COLORS.bg);
  doc.rect(0, 420, W, doc.page.height - 420).fill();

  applyColor(doc, COLORS.primary);
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text('Stack Tecnológico Atual', ML, 440);

  strokeColor(doc, COLORS.accent);
  doc.moveTo(ML, 456).lineTo(ML + 60, 456).lineWidth(2).stroke();

  const stackItems = [
    { icon: '⚙️', label: 'Node.js 22 + Express' },
    { icon: '⚛️', label: 'React 18 + Vite' },
    { icon: '🗄️', label: 'SQLite → PostgreSQL' },
    { icon: '🤖', label: 'Anthropic Claude API' },
    { icon: '📱', label: 'WhatsApp Business API' },
    { icon: '🐳', label: 'Docker / Fly.io / Render' },
  ];

  const sW = CW / 3;
  stackItems.forEach((s, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = ML + col * sW;
    const y = 468 + row * 48;

    applyColor(doc, COLORS.white);
    doc.roundedRect(x, y, sW - 10, 38, 6).fill();

    applyColor(doc, COLORS.primary);
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(`${s.icon}  ${s.label}`, x + 8, y + 13, { width: sW - 26 });
  });

  // Rodapé
  applyColor(doc, COLORS.muted);
  doc.font('Helvetica').fontSize(8);
  doc.text('Gerado automaticamente • Sales AI Agent © 2026', 0, doc.page.height - 30, { width: W, align: 'center' });
}

drawCover();

// ══════════════════════════════════════════════════════════════════
// FUNÇÃO: desenha um card de semana (pode adicionar nova página)
// ══════════════════════════════════════════════════════════════════
function estimateWeekHeight(week) {
  let h = 80; // cabeçalho
  week.items.forEach(cat => {
    h += 26;                   // categoria
    h += cat.tasks.length * 18; // tarefas
    h += 10;                   // espaço
  });
  h += 20; // padding inferior
  return h;
}

let curY = 0;

function ensurePage(neededHeight) {
  const pageH = doc.page.height;
  const footerH = 50;
  if (curY + neededHeight > pageH - footerH) {
    doc.addPage({ size: 'A4', margins: { top: 0, bottom: 40, left: 0, right: 0 } });
    // Fundo suave
    applyColor(doc, COLORS.bg);
    doc.rect(0, 0, W, doc.page.height).fill();
    curY = ML;
  }
}

function drawWeekCard(week) {
  const wcolor = WEEK_COLORS[week.num - 1];
  const est = estimateWeekHeight(week);

  ensurePage(est + 20);

  const cardX = ML;
  const cardW = CW;
  const cardY = curY;

  // Sombra simulada
  applyColor(doc, '#D1D5DB');
  doc.roundedRect(cardX + 3, cardY + 3, cardW, est, 10).fill();

  // Card branco
  applyColor(doc, COLORS.white);
  doc.roundedRect(cardX, cardY, cardW, est, 10).fill();

  // Barra lateral colorida
  applyColor(doc, wcolor);
  doc.roundedRect(cardX, cardY, 8, est, 6).fill();
  doc.rect(cardX + 4, cardY, 4, est).fill(); // quadrado direito da barra

  // Header da semana
  applyColor(doc, wcolor);
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text(`SEMANA ${week.num}  •  ${week.period}`, cardX + 20, cardY + 12);

  // Ícone + Título
  applyColor(doc, COLORS.primary);
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text(`${week.icon}  ${week.title}`, cardX + 20, cardY + 26, { width: cardW - 40 });

  // Linha separadora
  strokeColor(doc, COLORS.line);
  doc.moveTo(cardX + 20, cardY + 48).lineTo(cardX + cardW - 20, cardY + 48).lineWidth(0.5).stroke();

  let itemY = cardY + 58;

  week.items.forEach(cat => {
    // Categoria
    applyColor(doc, wcolor);
    doc.font('Helvetica-Bold').fontSize(8.5);
    doc.text(cat.cat.toUpperCase(), cardX + 20, itemY);
    itemY += 14;

    cat.tasks.forEach(task => {
      // Bullet
      applyColor(doc, wcolor);
      doc.circle(cardX + 24, itemY + 4, 2.5).fill();

      applyColor(doc, COLORS.text);
      doc.font('Helvetica').fontSize(8.5);
      doc.text(task, cardX + 32, itemY, { width: cardW - 52 });
      itemY += 15;
    });

    itemY += 8;
  });

  curY = cardY + est + 16;
}

// ══════════════════════════════════════════════════════════════════
// PÁGINA 2+ — VISÃO GERAL
// ══════════════════════════════════════════════════════════════════
doc.addPage({ size: 'A4', margins: { top: 0, bottom: 40, left: 0, right: 0 } });
applyColor(doc, COLORS.bg);
doc.rect(0, 0, W, doc.page.height).fill();

// Header da seção
applyColor(doc, COLORS.primary);
doc.rect(0, 0, W, 70).fill();
applyColor(doc, COLORS.white);
doc.font('Helvetica-Bold').fontSize(20);
doc.text('Visão Geral do Cronograma', ML, 22);
applyColor(doc, COLORS.accent);
doc.font('Helvetica').fontSize(10);
doc.text('Roadmap completo de 45 dias — Da fundação ao primeiro cliente pagante', ML, 46);

curY = 88;

// Gantt visual simplificado
applyColor(doc, COLORS.white);
doc.roundedRect(ML, curY, CW, 130, 8).fill();

applyColor(doc, COLORS.primary);
doc.font('Helvetica-Bold').fontSize(11);
doc.text('Linha do Tempo — Gantt', ML + 14, curY + 12);

const ganttTop = curY + 34;
const ganttLeft = ML + 14;
const ganttRight = ML + CW - 14;
const ganttW = ganttRight - ganttLeft;
const weekW = ganttW / 6;

// Labels de semanas
WEEK_COLORS.forEach((c, i) => {
  const x = ganttLeft + i * weekW;
  applyColor(doc, c);
  doc.roundedRect(x + 2, ganttTop, weekW - 4, 18, 4).fill();
  applyColor(doc, COLORS.white);
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text(`S${i+1}`, x + 2, ganttTop + 5, { width: weekW - 4, align: 'center' });
});

// Linhas de atividades
const ganttItems = [
  { label: 'Banco de Dados', start: 0, span: 1 },
  { label: 'Segurança & Infra', start: 0, span: 2 },
  { label: 'Multi-Tenancy + JWT', start: 1, span: 1 },
  { label: 'Testes & Swagger', start: 2, span: 1 },
  { label: 'Monitoramento', start: 2, span: 2 },
  { label: 'Billing (Stripe)', start: 3, span: 1 },
  { label: 'Onboarding', start: 3, span: 2 },
  { label: 'Landing Page + UX', start: 4, span: 1 },
  { label: 'Beta → Lançamento', start: 5, span: 1 },
];

ganttItems.forEach((item, i) => {
  const rowY = ganttTop + 24 + i * 9;
  const barX = ganttLeft + item.start * weekW + 2;
  const barW = item.span * weekW - 4;
  const c = WEEK_COLORS[item.start];

  // Fundo da linha
  if (i % 2 === 0) {
    applyColor(doc, '#F8FAFC');
    doc.rect(ganttLeft, rowY - 1, ganttW, 9).fill();
  }

  // Barra
  applyColor(doc, c);
  const [r,g,b] = hexToRgb(c);
  doc.fillOpacity(0.25);
  doc.roundedRect(barX, rowY, barW, 7, 2).fill();
  doc.fillOpacity(1);

  // Label
  applyColor(doc, COLORS.text);
  doc.font('Helvetica').fontSize(6.5);
  doc.text(item.label, barX + 3, rowY + 1, { width: barW - 6 });
});

curY += 148;

// Cards das semanas
weeks.forEach(w => drawWeekCard(w));

// ══════════════════════════════════════════════════════════════════
// PÁGINA — PLANOS DE PREÇO
// ══════════════════════════════════════════════════════════════════
doc.addPage({ size: 'A4', margins: { top: 0, bottom: 40, left: 0, right: 0 } });
applyColor(doc, COLORS.bg);
doc.rect(0, 0, W, doc.page.height).fill();

// Header
applyColor(doc, COLORS.primary);
doc.rect(0, 0, W, 70).fill();
applyColor(doc, COLORS.white);
doc.font('Helvetica-Bold').fontSize(20);
doc.text('Planos de Preço', ML, 22);
applyColor(doc, COLORS.accent);
doc.font('Helvetica').fontSize(10);
doc.text('Estrutura de monetização via Stripe — integração na Semana 4', ML, 46);

curY = 88;

const pCardW = (CW - 20) / 3;
plans.forEach((plan, i) => {
  const px = ML + i * (pCardW + 10);
  const pColor = plan.color;
  const cardH = 210;

  // Sombra
  applyColor(doc, '#D1D5DB');
  doc.roundedRect(px + 3, curY + 3, pCardW, cardH, 10).fill();

  // Card
  applyColor(doc, plan.highlight ? pColor : COLORS.white);
  doc.roundedRect(px, curY, pCardW, cardH, 10).fill();

  // Header colorido
  if (!plan.highlight) {
    applyColor(doc, pColor);
    doc.roundedRect(px, curY, pCardW, 54, 10).fill();
    doc.rect(px, curY + 34, pCardW, 20).fill();
  }

  // Badge "Popular"
  if (plan.highlight) {
    applyColor(doc, COLORS.accent);
    doc.roundedRect(px + pCardW/2 - 28, curY - 12, 56, 18, 9).fill();
    applyColor(doc, COLORS.white);
    doc.font('Helvetica-Bold').fontSize(7);
    doc.text('✦ POPULAR', px + pCardW/2 - 28, curY - 8, { width: 56, align: 'center' });
  }

  // Nome do plano
  applyColor(doc, COLORS.white);
  doc.font('Helvetica-Bold').fontSize(14);
  doc.text(plan.name, px + 14, curY + 14, { width: pCardW - 28 });

  // Preço
  const priceColor = plan.highlight ? COLORS.white : COLORS.white;
  applyColor(doc, priceColor);
  doc.font('Helvetica-Bold').fontSize(plan.highlight ? 16 : 13);
  doc.text(plan.price, px + 14, curY + 32, { width: pCardW - 28 });

  // Features
  plan.features.forEach((feat, fi) => {
    const fy = curY + 66 + fi * 28;
    // Ícone check
    applyColor(doc, pColor);
    doc.circle(px + 22, fy + 7, 7).fill();
    applyColor(doc, COLORS.white);
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('✓', px + 18, fy + 3, { width: 14, align: 'center' });

    applyColor(doc, plan.highlight ? COLORS.white : COLORS.text);
    doc.font('Helvetica').fontSize(9);
    doc.text(feat, px + 36, fy + 3, { width: pCardW - 50 });
  });
});

curY += 240;

// ── Checklist de verificação ───────────────────────────────────────
applyColor(doc, COLORS.white);
doc.roundedRect(ML, curY, CW, 200, 10).fill();

applyColor(doc, COLORS.primary);
doc.font('Helvetica-Bold').fontSize(13);
doc.text('✅  Checklist de Verificação — Critérios de Pronto', ML + 16, curY + 16);

strokeColor(doc, COLORS.line);
doc.moveTo(ML + 16, curY + 34).lineTo(ML + CW - 16, curY + 34).lineWidth(0.5).stroke();

const checks = [
  { done: true,  text: 'npm test — todos os testes existentes passam (14+ asserts)' },
  { done: true,  text: 'node scripts/test_e2e.mjs — 14/14 asserts verdes' },
  { done: false, text: 'Cobertura ≥ 80% nos módulos críticos (humanize, relationships, endpoints)' },
  { done: false, text: 'docker build && docker run -p 3000:3000 — sobe sem erro' },
  { done: false, text: 'Stripe webhook testado (stripe listen --forward-to localhost:3000/api/stripe/webhook)' },
  { done: false, text: 'Blind test: < 50% de acerto dos revisores humanos (anti-bot validado)' },
  { done: false, text: 'Multi-tenant: dados de tenant A invisíveis para tenant B' },
  { done: false, text: 'Health check /api/health retorna 200 com status de DB + APIs externas' },
  { done: false, text: '3+ clientes beta aprovam fluxo completo (signup → mensagem → resposta)' },
];

const col1 = checks.slice(0, 5);
const col2 = checks.slice(5);
const colW = (CW - 32) / 2;

[col1, col2].forEach((col, ci) => {
  col.forEach((c, i) => {
    const cx = ML + 16 + ci * (colW + 16);
    const cy = curY + 46 + i * 26;

    // Checkbox
    applyColor(doc, c.done ? COLORS.s3 : COLORS.line);
    doc.roundedRect(cx, cy, 14, 14, 3).fill();
    if (c.done) {
      applyColor(doc, COLORS.white);
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('✓', cx, cy + 2, { width: 14, align: 'center' });
    }

    applyColor(doc, c.done ? COLORS.muted : COLORS.text);
    doc.font('Helvetica').fontSize(8);
    doc.text(c.text, cx + 20, cy + 2, { width: colW - 24 });
  });
});

curY += 220;

// ── Próximos passos ─────────────────────────────────────────────
applyColor(doc, COLORS.primary);
doc.roundedRect(ML, curY, CW, 68, 10).fill();

applyColor(doc, COLORS.accent);
doc.font('Helvetica-Bold').fontSize(12);
doc.text('🎯  Meta Final — Semana 6', ML + 16, curY + 12);

applyColor(doc, COLORS.white);
doc.font('Helvetica').fontSize(9);
doc.text(
  'Ao final das 6 semanas o Sales AI Agent estará no ar com: PostgreSQL em produção, ' +
  'multi-tenancy completo, billing via Stripe, documentação Swagger, monitoramento Sentry, ' +
  'landing page publicada e os primeiros clientes pagantes convertidos. ' +
  'O projeto passou de protótipo a produto comercial.',
  ML + 16, curY + 30, { width: CW - 32 }
);

// ══════════════════════════════════════════════════════════════════
// Rodapés em todas as páginas
// ══════════════════════════════════════════════════════════════════
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  const pageNum = i + 1;
  const total = range.count;

  applyColor(doc, COLORS.muted);
  doc.font('Helvetica').fontSize(7);
  const footerY = doc.page.height - 22;
  doc.text(
    `Sales AI Agent — Cronograma de Comercialização 2026   |   Página ${pageNum} de ${total}`,
    0, footerY, { width: W, align: 'center' }
  );
}

doc.end();
console.log(`✅  PDF gerado: ${OUTPUT}`);
