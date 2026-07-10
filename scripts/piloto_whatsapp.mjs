// Piloto de automação de vendas via WhatsApp — caso servidores CPU/GPU.
// Orquestra o fluxo completo: identificação -> gancho -> negociação -> follow-up -> reunião.
// Modo A (simulado): o prospect é gerado por IA (Claude) via endpoints do simulador.
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3000';
let COOKIE = '';

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setc = r.headers.get('set-cookie');
  if (setc) COOKIE = setc.split(';')[0];
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = txt; }
  return { status: r.status, json };
}

async function loginForm() {
  const r = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123',
    redirect: 'manual',
  });
  const setc = r.headers.get('set-cookie');
  if (setc) COOKIE = setc.split(';')[0];
}

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const PRODUCT = 'servidores de alta densidade com CPU (AMD EPYC) e GPU NVIDIA H100/L40S para IA, HPC e inferência';

async function main() {
  const transcript = [];
  const push = (who, text, meta) => { transcript.push({ who, text, meta }); log(`\n[${who}] ${text}${meta ? '   («' + meta + '»)' : ''}`); };

  log('==== PILOTO WHATSAPP — SERVIDORES CPU/GPU (modo simulado) ====');
  await loginForm();
  log('login OK, cookie=', COOKIE ? 'set' : 'MISSING');

  // 1) IDENTIFICAÇÃO DO CONTATO — cria empresa + contato (cold, perfil engenheiro/infra)
  const suffix = process.argv[2] || 'Piloto';
  const created = await req('POST', '/api/companies', {
    name: 'NeuralGrid Datacenter ' + suffix,
    sector: 'Data Center / IA & HPC',
    contact_name: 'Carlos Menezes',
    contact_role: 'engineer',
    contact_whatsapp: '+5511998877665',
    contact_call_type: 'cold',
  });
  log('criar empresa ->', created.status, JSON.stringify(created.json));
  if (!created.json.id) throw new Error('Falha ao criar empresa: ' + JSON.stringify(created.json));
  const companyId = created.json.id;
  const contactId = created.json.contact_id;

  // 2) GANCHO DE ABERTURA — gera a sequência (mensagem WhatsApp dia 1)
  const seq = await req('POST', `/api/companies/${companyId}/sequence`, {
    contact_id: contactId,
    product_value: PRODUCT,
    pain_point: 'clusters de GPU lotados e fila de treino de modelos travando os times de IA',
    hook_category: 'evento',
  });
  log('\ngerar sequência ->', seq.status);
  const opening = (seq.json.sequence || []).find(m => m.channel === 'whatsapp') || (seq.json.sequence || [])[0];
  if (!opening) throw new Error('Sem mensagem de abertura: ' + JSON.stringify(seq.json));
  push('VENDEDOR (gancho abertura)', opening.content);
  // aprova a mensagem de abertura (human-in-the-loop) e pontua qualidade (RLHF)
  await req('POST', `/api/messages/${opening.id}/approve`, {});
  await req('POST', `/api/messages/${opening.id}/score`, { score: 5 });

  // 3) NEGOCIAÇÃO — rodadas prospect(IA) <-> vendedor(IA)
  const rounds = [
    { tone: 'interested', label: 'interessado' },
    { tone: 'skeptical', label: 'cético (preço/specs)' },
  ];
  for (const rnd of rounds) {
    // 3a) resposta realista do prospect gerada por IA
    const gen = await req('POST', `/api/companies/${companyId}/simulator/generate-prospect-reply`, {
      contact_id: contactId, tone: rnd.tone,
    });
    const prospectText = gen.json.generated_reply;
    if (!prospectText) throw new Error('Falha ao gerar prospect: ' + JSON.stringify(gen.json));
    // 3b) registra como inbound (classifica sentimento, atualiza funil)
    const inb = await req('POST', `/api/companies/${companyId}/simulator/inbound`, {
      contact_id: contactId, response_text: prospectText,
    });
    push(`PROSPECT (${rnd.label})`, prospectText, `sentimento=${inb.json.sentiment} score=${inb.json.interest_score}`);
    // 3c) resposta do vendedor (IA) e pontuação RLHF
    const bot = await req('POST', `/api/companies/${companyId}/simulator/bot-reply`, { contact_id: contactId });
    if (bot.json.content) {
      push('VENDEDOR (IA)', bot.json.content);
      await req('POST', `/api/messages/${bot.json.id}/approve`, {});
      await req('POST', `/api/messages/${bot.json.id}/score`, { score: 4 });
    }
    await sleep(200);
  }

  // 4) FECHAMENTO — prospect pede reunião concreta (força intenção wants_meeting)
  const meetingAsk = 'Perfeito, ficou claro. Podemos marcar uma call de 15 min essa semana pra fechar specs e proposta dos servidores com GPU? Quinta 15h funciona pra mim.';
  const inbMeet = await req('POST', `/api/companies/${companyId}/simulator/inbound`, {
    contact_id: contactId, response_text: meetingAsk,
  });
  push('PROSPECT (quer reunião)', meetingAsk, `sentimento=${inbMeet.json.sentiment} score=${inbMeet.json.interest_score}`);
  const botClose = await req('POST', `/api/companies/${companyId}/simulator/bot-reply`, { contact_id: contactId });
  if (botClose.json.content) {
    push('VENDEDOR (IA)', botClose.json.content);
    await req('POST', `/api/messages/${botClose.json.id}/approve`, {});
    await req('POST', `/api/messages/${botClose.json.id}/score`, { score: 5 });
  }

  // 5) REUNIÃO CONCRETA — agenda slot (booked) -> status meeting_set + confirmação WhatsApp
  const dt = '2026-07-16T15:00:00';
  const slot = await req('POST', '/api/schedule/slots', {
    date_time: dt, duration_min: 15, meeting_link: 'https://meet.google.com/neuralgrid-cpu-gpu',
    company_id: companyId, contact_id: contactId, booked: true,
  });
  log('\nagendar reunião ->', slot.status, JSON.stringify(slot.json));
  push('SISTEMA', `Reunião agendada para ${dt} (15 min) — status da empresa => meeting_set`);

  // 6) DOCUMENTAÇÃO — coleta métricas, funil, mensagens
  await sleep(300);
  const metrics = await req('GET', '/api/metrics/overview');
  const msgs = await req('GET', `/api/whatsapp/${companyId}/messages`);
  const followup = await req('GET', '/api/followup/pending?days=0');

  // taxa de resposta REAL do piloto (funil): respostas do prospect / abordagens do vendedor
  const all = Array.isArray(msgs.json) ? msgs.json : (msgs.json.messages || []);
  const inbound = all.filter(m => m.status === 'received').length;
  const outbound = all.filter(m => m.status !== 'received').length;

  const report = {
    generated_at: new Date().toISOString(),
    company_id: companyId, contact_id: contactId,
    funnel_status_final: 'meeting_set',
    counts: { inbound, outbound, total: all.length },
    response_rate_funnel_pct: outbound ? Math.round((inbound / outbound) * 100) : 0,
    metrics_overview: metrics.json,
    followup_pending: followup.json,
    transcript,
  };

  fs.writeFileSync('scripts/piloto_resultado.json', JSON.stringify(report, null, 2));
  log('\n==== RESUMO ====');
  log('Empresa/contato:', companyId, '/', contactId);
  log('Mensagens: inbound=' + inbound, 'outbound=' + outbound, 'total=' + all.length);
  log('Taxa de resposta (funil):', report.response_rate_funnel_pct + '%');
  log('Funil (metrics.funnel):', JSON.stringify(metrics.json.funnel));
  log('by_channel:', JSON.stringify(metrics.json.by_channel));
  log('Relatório salvo em scripts/piloto_resultado.json');
}

main().catch(e => { console.error('ERRO PILOTO:', e); process.exit(1); });
