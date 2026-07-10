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
const MIN_AVG = Number(process.env.MIN_AVG || 3.5);

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

// Leads fixos (warm, contexto determinístico — não depende de timing de web search).
const LEADS = [
  { name: '[TESTE] Gooxi Lead Intel', sector: 'Semicondutores', cn: 'Ricardo Teste', role: 'c_level',
    ctx: 'Parceria Gooxi-Intel (Strategic Partner). Intel avaliando servidores rackmount na plataforma Intel para programa OEM de referência.',
    pv: 'servidores rackmount Gooxi na plataforma Intel (SL201-G5) e AI servers 8U 8-GPU',
    pain: 'time-to-market de plataformas de referência' },
  { name: '[TESTE] Gooxi Lead Ascend', sector: 'Inteligencia Artificial', cn: 'Bruno Teste', role: 'manager',
    ctx: 'Gooxi é Huawei Ascend APN Partner. Ascend busca hardware de IA doméstico com entrega rápida.',
    pv: 'servidor Gooxi 4U 8-GPU Dual-Ascend + solução DeepSeek pronta em estoque',
    pain: 'disponibilidade em estoque para deploy rápido de IA' },
  { name: '[TESTE] Gooxi Lead Hygon', sector: 'Financas/HPC', cn: 'Diego Teste', role: 'c_level',
    ctx: 'Gooxi é parceira certificada Hygon. Hygon quer servidores de alta densidade com refrigeração líquida para data centers financeiros.',
    pv: 'servidores Gooxi Hygon com refrigeração líquida para HPC e finanças',
    pain: 'dissipação térmica e densidade em data center financeiro' },
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
  return { companyId, contactId };
}

async function run() {
  console.log(`\n🔎 Regressão do gancho — ${BASE} (limiar média ≥ ${MIN_AVG})\n`);
  await login();

  const rows = [];
  for (const l of LEADS) {
    const { companyId, contactId } = await ensureLead(l);
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
  console.log(`\nMensagens avaliadas: ${rows.length} | Média: ${avg.toFixed(2)}/5 | Reprovadas: ${reprovadas.length}\n`);

  const passOk = avg >= MIN_AVG && reprovadas.length === 0;
  if (passOk) { console.log('✅ REGRESSÃO OK\n'); process.exit(0); }
  else { console.log(`❌ REGRESSÃO FALHOU (média ${avg.toFixed(2)} < ${MIN_AVG} ou ${reprovadas.length} reprovada(s))\n`); process.exit(1); }
}

run().catch(e => { console.error('Erro no teste de regressão:', e.message); process.exit(2); });
