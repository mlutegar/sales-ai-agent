// Teste E2E de regressão do fluxo de vendas via WhatsApp (itens #2–#11).
// Requer o servidor rodando (npm start). Asserts com exit code != 0 em falha.
// Uso: node scripts/test_e2e.mjs
const BASE = 'http://127.0.0.1:3000';
let COOKIE = '';
let pass = 0, fail = 0;

async function req(method, path, body, form) {
  const headers = { ...(COOKIE ? { Cookie: COOKIE } : {}) };
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = form; }
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const setc = r.headers.get('set-cookie'); if (setc) COOKIE = setc.split(';')[0];
  const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch { json = txt; }
  return { status: r.status, json };
}
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

async function main() {
  console.log('== E2E: automação de vendas WhatsApp ==');
  await req('POST', '/login', null, 'username=admin&password=admin123');
  ok('login', !!COOKIE);

  // Métrica de engajamento (#4)
  const m0 = await req('GET', '/api/metrics/overview');
  ok('metrics.engagement existe (#4)', m0.json && m0.json.engagement && typeof m0.json.engagement.response_rate_pct === 'number', m0.json?.engagement);

  // Cria empresa/contato
  const tag = 'E2E-' + (process.hrtime.bigint() % 1000000n).toString();
  const c = await req('POST', '/api/companies', {
    name: 'DataForge ' + tag, sector: 'IA & HPC',
    contact_name: 'Ana Prado', contact_role: 'engineer', contact_whatsapp: '+5511977001122', contact_call_type: 'cold',
  });
  ok('cria empresa', c.status === 200 && c.json.id, c.json);
  const companyId = c.json.id, contactId = c.json.contact_id;

  // Gera sequência (depende de IA). Se 502, pula asserts de IA mas segue nos guardrails.
  const seq = await req('POST', `/api/companies/${companyId}/sequence`, {
    contact_id: contactId, product_value: 'servidores CPU/GPU para IA', pain_point: 'fila de treino de GPU',
  });
  const aiUp = seq.status === 200;
  let openingId = null;
  if (aiUp) {
    const opening = (seq.json.sequence || []).find(x => x.channel === 'whatsapp') || (seq.json.sequence || [])[0];
    openingId = opening?.id;
    ok('sequência gerada sem texto de erro (#2)', opening && !String(opening.content).startsWith('[ERRO API:'), opening?.content?.slice(0, 40));
  } else {
    ok('sequência falhou de forma limpa 502 (#2)', seq.status === 502, seq.status);
  }

  if (aiUp) {
    // Rodada de negociação
    const g = await req('POST', `/api/companies/${companyId}/simulator/generate-prospect-reply`, { contact_id: contactId, tone: 'interested' });
    ok('gera resposta prospect', g.status === 200 && g.json.generated_reply, g.status);
    const inb = await req('POST', `/api/companies/${companyId}/simulator/inbound`, { contact_id: contactId, response_text: g.json.generated_reply || 'tenho interesse' });
    ok('inbound classificado', inb.status === 200 && !!inb.json.sentiment, inb.json);

    // Intenção de reunião com horário explícito → sugere slot (#7)
    const inbMeet = await req('POST', `/api/companies/${companyId}/simulator/inbound`, {
      contact_id: contactId, response_text: 'podemos marcar quinta 15h uma call de 15 min?',
    });
    ok('detecta wants_meeting (#7)', inbMeet.json.sentiment === 'wants_meeting', inbMeet.json.sentiment);
    ok('sugere slot com horário (#7)', inbMeet.json.meeting_suggestion && inbMeet.json.meeting_suggestion.date_time, inbMeet.json.meeting_suggestion);

    // bot-reply coerente (#5) não deve retornar erro
    const bot = await req('POST', `/api/companies/${companyId}/simulator/bot-reply`, { contact_id: contactId });
    ok('bot-reply ok (#5)', bot.status === 200 && bot.json.content, bot.status);
  }

  // Agenda reunião → meeting_set
  const slot = await req('POST', '/api/schedule/slots', {
    date_time: '2026-07-16T15:00:00', duration_min: 15, meeting_link: 'https://meet.example/e2e',
    company_id: companyId, contact_id: contactId, booked: true,
  });
  ok('reunião agendada', slot.status === 200, slot.status);

  // Auditoria (#9): a aprovação/agendamento deve aparecer
  const audit = await req('GET', `/api/audit?company_id=${companyId}`);
  ok('audit log registrou meeting_booked (#9)', Array.isArray(audit.json) && audit.json.some(a => a.action === 'meeting_booked'), audit.json);

  // LGPD (#10): opt-out e tentar aprovar a mensagem de abertura deve bloquear
  if (openingId) {
    await req('POST', `/api/companies/${companyId}/optout`, { reason: 'teste' });
    const appr = await req('POST', `/api/messages/${openingId}/approve`, {});
    ok('envio bloqueado após opt-out (#10)', appr.status === 403, appr.status);
  }

  // Métrica final: taxa de resposta real > 0 se houve inbound (#4)
  const m1 = await req('GET', '/api/metrics/overview');
  ok('funil contém meeting_set (#4)', (m1.json.funnel || []).some(f => f.status === 'meeting_set'));
  if (aiUp) ok('response_rate_pct > 0 (#4)', m1.json.engagement.response_rate_pct > 0, m1.json.engagement);

  console.log(`\n== Resultado: ${pass} passaram, ${fail} falharam ==`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERRO E2E:', e); process.exit(1); });
