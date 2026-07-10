#!/usr/bin/env node
/**
 * (#8) Teste de regressão do "gancho da primeira mensagem".
 *
 * Gera ganchos para um conjunto fixo de leads, avalia cada mensagem com o
 * LLM-judge da rubrica "não parece bot" (POST /api/style-score) e imprime um
 * placar. Sai com código != 0 se a qualidade cair abaixo do limiar — assim
 * um `npm run test:hooks` pega degradação quando alguém mexe no prompt.
 *
 * Uso:  node test_hook_regression.js
 * Env:  BASE_URL (default http://localhost:3000), ADMIN_USER, ADMIN_PASS,
 *       MIN_AVG (default 3.5)  — média mínima aceitável (0-5).
 *
 * Requer o servidor rodando (npm start) e ANTHROPIC_API_KEY configurada.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123';
// Baseline calibrado com leads realistas (warm) — média observada ~3.8/5, com 1-2
// variantes "ajustar/reprovar" por rodada (o juiz é rígido de propósito). Ajuste via env.
const MIN_AVG = Number(process.env.MIN_AVG || 3.5);
const MAX_REPROVADAS = Number(process.env.MAX_REPROVADAS || 2); // quantas reprovações são toleradas
const KEEP = process.env.KEEP === '1'; // KEEP=1 não apaga os leads de teste ao final

let COOKIE = '';

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (COOKIE) headers['Cookie'] = COOKIE;
  const res = await fetch(BASE + path, {
    method, headers, redirect: 'manual',
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) COOKIE = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

async function login() {
  const res = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) COOKIE = setCookie.split(';')[0];
  if (!COOKIE) throw new Error('Falha no login: sem cookie de sessão');
}

// Leads REALISTAS (empresas-alvo fictícias que comprariam servidores Gooxi), warm com
// contexto determinístico — o gancho não depende de timing de web search e a personalização
// vem do contexto real do operador (não de um placeholder que zera a nota do juiz).
// O prefixo REG_TEST_TAG marca os leads criados por este teste para limpeza ao final.
const REG_TEST_TAG = 'Regressão-Gancho';
const LEADS = [
  { name: 'Datacom Servers Brasil', sector: 'Integrador de Data Center', cn: 'Ricardo Nunes', role: 'c_level',
    ctx: 'Integrador montando um novo data center regional em Campinas; avalia fornecedores de servidores rackmount com cadeia industrial completa, customização e suporte local rápido. Já usa Gooxi em um piloto.',
    pv: 'servidores rackmount Gooxi (plataforma Intel/AMD) com customização de sistema e suporte pós-venda 48h no local',
    pain: 'prazo de entrega e suporte pós-venda no data center novo' },
  { name: 'NuvemX Cloud', sector: 'Provedor Cloud/IA', cn: 'Fernanda Lopes', role: 'manager',
    ctx: 'Provedor de cloud expandindo cluster de GPU para inferência de LLM; precisa de mais densidade de GPU por rack e melhor eficiência energética para segurar o custo por token.',
    pv: 'AI server Gooxi 8U 8-GPU OAM na plataforma AMD EPYC para treino e inferência',
    pain: 'densidade de GPU e custo por token no cluster de inferência' },
  { name: 'FinServer Capital', sector: 'Banco/HPC', cn: 'Diego Prado', role: 'c_level',
    ctx: 'Banco modernizando o data center financeiro; estuda refrigeração líquida de alta densidade para grid computing de risco, com foco em eficiência energética e confiabilidade.',
    pv: 'servidores Gooxi com refrigeração líquida de alta densidade para HPC financeiro',
    pain: 'dissipação térmica e eficiência energética em alta densidade' },
];

async function ensureLead(l) {
  const created = await api('/api/companies', { method: 'POST', body: {
    name: l.name, sector: l.sector, contact_name: l.cn, contact_role: l.role, contact_call_type: 'warm', contact_whatsapp: '+5511999990000',
  }});
  let companyId, contactId;
  if (created.status === 200 || created.status === 201) {
    companyId = created.json.id; contactId = created.json.contact_id;
  } else if (created.status === 409) {
    companyId = created.json.existing_id;
    const detail = await api(`/api/companies/${companyId}`);
    const contacts = detail.json.contacts || detail.json.company?.contacts || [];
    const primary = contacts.find(c => c.is_primary) || contacts[0];
    contactId = primary && primary.id;
  } else {
    throw new Error(`Falha ao criar lead ${l.name}: ${created.status} ${JSON.stringify(created.json)}`);
  }
  if (!contactId) throw new Error(`Sem contato para ${l.name}`);
  await api(`/api/contacts/${contactId}/call-type`, { method: 'PUT', body: { call_type: 'warm' } });
  await api(`/api/contacts/${contactId}/context`, { method: 'PUT', body: { context: l.ctx } });
  return { companyId, contactId, created: created.status === 200 || created.status === 201 };
}

async function run() {
  console.log(`\n🔎 Regressão do gancho — ${BASE} (limiar média ≥ ${MIN_AVG})\n`);
  await login();

  const rows = [];
  const createdIds = [];
  for (const l of LEADS) {
    const { companyId, contactId, created } = await ensureLead(l);
    if (created) createdIds.push(companyId);
    const seq = await api(`/api/companies/${companyId}/sequence`, { method: 'POST', body: {
      contact_id: contactId, product_value: l.pv, pain_point: l.pain,
    }});
    const msgs = seq.json.sequence || seq.json.messages || [];
    if (!msgs.length) { console.warn(`⚠ Sem mensagens para ${l.name}: ${JSON.stringify(seq.json).slice(0,200)}`); continue; }
    for (const m of msgs) {
      const score = await api('/api/style-score', { method: 'POST', body: {
        message: m.content, company: l.name, sector: l.sector, role: l.role, product: l.pv,
      }});
      rows.push({
        lead: l.name.replace('[TESTE] Gooxi Lead ', ''),
        variante: m.variant_no ? `v${m.variant_no}${m.variant_angle ? ' ' + m.variant_angle.slice(0, 22) : ''}` : '-',
        total: score.json.total,
        verdict: score.json.verdict,
        fact: m.needs_fact_check ? '⚠' : '',
        notes: (score.json.notes || '').slice(0, 60),
      });
    }
  }

  // Placar
  console.log('LEAD            | VARIANTE                 | NOTA | VEREDITO | FACT | OBS');
  console.log('-'.repeat(100));
  for (const r of rows) {
    console.log(
      `${r.lead.padEnd(15)} | ${String(r.variante).padEnd(24)} | ${String(r.total ?? '?').padEnd(4)} | ${String(r.verdict).padEnd(8)} | ${r.fact.padEnd(4)} | ${r.notes}`
    );
  }

  const valid = rows.filter(r => typeof r.total === 'number');
  const avg = valid.length ? valid.reduce((a, b) => a + b.total, 0) / valid.length : 0;
  const reprovadas = rows.filter(r => r.verdict === 'reprovou');
  console.log('-'.repeat(100));
  console.log(`\nMensagens avaliadas: ${rows.length} | Média: ${avg.toFixed(2)}/5 | Reprovadas: ${reprovadas.length} (tolerância ${MAX_REPROVADAS})\n`);

  // Limpeza: remove os leads de teste criados nesta execução (a menos que KEEP=1).
  if (!KEEP && createdIds.length) {
    for (const id of createdIds) { try { await api(`/api/companies/${id}`, { method: 'DELETE' }); } catch {} }
    console.log(`🧹 ${createdIds.length} lead(s) de teste removido(s) (use KEEP=1 para manter).\n`);
  }

  const passOk = avg >= MIN_AVG && reprovadas.length <= MAX_REPROVADAS;
  if (passOk) { console.log('✅ REGRESSÃO OK\n'); process.exit(0); }
  else { console.log(`❌ REGRESSÃO FALHOU (média ${avg.toFixed(2)} < ${MIN_AVG} ou reprovadas ${reprovadas.length} > ${MAX_REPROVADAS})\n`); process.exit(1); }
}

run().catch(e => { console.error('Erro no teste de regressão:', e.message); process.exit(2); });
