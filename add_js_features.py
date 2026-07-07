with open(r'C:\Users\mlute\PycharmProjects\fabioProject\templates\index.html', 'r', encoding='utf-8') as f:
    content = f.read()

new_js = """
// ════════════════════════════════════════════════════════════
// FEATURE 7 — Metricas Dashboard
// ════════════════════════════════════════════════════════════
let chartChannel = null, chartRole = null, chartFunnel = null;

async function loadMetrics() {
  const [overview, timing] = await Promise.all([
    api('/api/metrics/overview').catch(() => null),
    api('/api/metrics/timing').catch(() => null),
  ]);
  if (!overview) return;

  const channelEl = document.getElementById('chart-channel');
  const labels = (overview.by_channel || []).map(r => r.channel || 'N/A');
  const rates  = (overview.by_channel || []).map(r => r.response_rate || 0);
  const sent   = (overview.by_channel || []).map(r => r.sent || 0);
  const emptyEl = document.getElementById('chart-channel-empty');
  if (labels.length === 0) {
    if (emptyEl) emptyEl.classList.remove('d-none');
  } else {
    if (emptyEl) emptyEl.classList.add('d-none');
    if (chartChannel) chartChannel.destroy();
    chartChannel = new Chart(channelEl, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Taxa de Resposta (%)', data: rates, backgroundColor: ['#0077b5','#ea4335','#25d366'], yAxisID: 'y' },
          { label: 'Msgs Enviadas', data: sent, backgroundColor: '#e9ecef', yAxisID: 'y2', type: 'line', borderColor: '#6c757d', fill: false }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } },
                  y2: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } }
    });
  }

  const roleEl = document.getElementById('chart-role');
  const roleMap = { c_level:'C-Level', manager:'Gerente', engineer:'Engenheiro', other:'Outro' };
  const roleLabs = (overview.by_role || []).map(r => roleMap[r.role] || r.role);
  const roleTots = (overview.by_role || []).map(r => r.total || 0);
  if (chartRole) chartRole.destroy();
  chartRole = new Chart(roleEl, {
    type: 'doughnut',
    data: { labels: roleLabs, datasets: [{ data: roleTots, backgroundColor: ['#7c6af7','#0dcaf0','#198754','#ffc107'] }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });

  const STATUS_L = { new:'Novo', researched:'Pesquisado', sequence_created:'Sequencia criada',
    contacted:'Contactado', needs_followup:'Follow-up', hot_lead:'Hot Lead',
    rejected:'Rejeitado', meeting_set:'Reuniao', opted_out:'Opt-out' };
  const funnelEl = document.getElementById('chart-funnel');
  const fLabels = (overview.funnel || []).map(r => STATUS_L[r.status] || r.status);
  const fData   = (overview.funnel || []).map(r => r.total || 0);
  if (chartFunnel) chartFunnel.destroy();
  chartFunnel = new Chart(funnelEl, {
    type: 'bar',
    data: { labels: fLabels, datasets: [{ label: 'Leads', data: fData, backgroundColor: '#7c6af7' }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
  });

  const ab = overview.ab_stats || {};
  const abEl = document.getElementById('ab-stats-panel');
  if (ab.decided > 0) {
    const bRate = ((ab.b_won / ab.decided) * 100).toFixed(0);
    abEl.innerHTML =
      '<div class="text-center mb-2"><div class="display-6 fw-bold" style="color:#7c6af7">' + bRate + '%</div>' +
      '<div class="text-muted small">variante B venceu</div></div>' +
      '<div class="small"><div class="d-flex justify-content-between"><span>Testes realizados</span><strong>' + ab.decided + '</strong></div>' +
      '<div class="d-flex justify-content-between"><span>Variante B venceu</span><strong>' + ab.b_won + '</strong></div></div>';
  } else {
    abEl.innerHTML = '<p class="text-muted small">Nenhum teste A/B concluido ainda.</p>';
  }

  renderTimingHeatmap(timing || []);
  loadFollowupPending();
}

function renderTimingHeatmap(rows) {
  var el = document.getElementById('timing-heatmap');
  if (!rows || !rows.length) { el.innerHTML = '<p class="text-muted small">Envie mensagens para gerar dados de timing.</p>'; return; }
  var byChannel = {};
  rows.forEach(function(r) {
    if (!byChannel[r.channel]) byChannel[r.channel] = {};
    byChannel[r.channel][r.day_of_week + '_' + r.hour_of_day] = r.response_rate || 0;
  });
  var days = ['Seg','Ter','Qua','Qui','Sex','Sab','Dom'];
  var html = '';
  Object.keys(byChannel).forEach(function(ch) {
    var data = byChannel[ch];
    var vals = Object.values(data);
    var maxRate = vals.length ? Math.max.apply(null, vals) : 1;
    if (!maxRate) maxRate = 1;
    html += '<div class="mb-3"><strong class="small">' + ch.toUpperCase() + '</strong><div style="overflow-x:auto"><table class="table table-bordered table-sm" style="font-size:.7rem;min-width:600px"><thead><tr><th style="width:40px">Dia</th>';
    for (var h = 8; h <= 20; h++) html += '<th class="text-center">' + h + 'h</th>';
    html += '</tr></thead><tbody>';
    for (var di = 0; di < 7; di++) {
      html += '<tr><td><strong>' + days[di] + '</strong></td>';
      for (var hr = 8; hr <= 20; hr++) {
        var rate = data[di + '_' + hr] || 0;
        var alpha = rate > 0 ? Math.max(0.15, rate / maxRate) : 0;
        var bg = rate > 0 ? 'rgba(124,106,247,' + alpha.toFixed(2) + ')' : '#f8f9fa';
        var tc = rate > 50 ? '#fff' : 'inherit';
        var lab = rate > 0 ? rate.toFixed(0) + '%' : '-';
        html += '<td class="text-center" style="background:' + bg + ';color:' + tc + '">' + lab + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
  });
  el.innerHTML = html || '<p class="text-muted small">Dados insuficientes.</p>';
}

// ════════════════════════════════════════════════════════════
// FEATURE 6 — Follow-up Automatico
// ════════════════════════════════════════════════════════════
async function loadFollowupPending() {
  var daysEl = document.getElementById('followup-days');
  var days = daysEl ? daysEl.value : 5;
  var el = document.getElementById('followup-list');
  if (!el) return;
  el.innerHTML = '<p class="text-muted small">Carregando...</p>';
  var rows = await api('/api/followup/pending?days=' + days).catch(function() { return []; });
  if (!rows.length) {
    el.innerHTML = '<p class="text-muted small"><i class="bi bi-check-circle text-success me-1"></i>Nenhum follow-up pendente.</p>';
    return;
  }
  var ROLE = { c_level:'C-Level', manager:'Gerente', engineer:'Engenheiro', other:'Outro' };
  var html = '<div class="table-responsive"><table class="table table-sm table-hover"><thead class="table-light"><tr><th>Lead</th><th>Empresa</th><th>Setor</th><th>Dias sem resp.</th><th>Canal</th><th>Acao</th></tr></thead><tbody>';
  rows.forEach(function(r) {
    html += '<tr>' +
      '<td>' + esc(r.name) + ' <span class="badge bg-secondary">' + (ROLE[r.role]||r.role) + '</span></td>' +
      '<td>' + esc(r.company||'') + '</td><td>' + esc(r.sector||'') + '</td>' +
      '<td><span class="badge ' + (r.days_since >= 7 ? 'bg-danger' : 'bg-warning text-dark') + '">' + r.days_since + ' dias</span></td>' +
      '<td><select class="form-select form-select-sm" id="fu-channel-' + r.id + '" style="width:110px">' +
        '<option value="email">Email</option><option value="linkedin">LinkedIn</option><option value="whatsapp">WhatsApp</option>' +
      '</select></td>' +
      '<td><button class="btn btn-warning btn-sm" onclick="genFollowup(' + r.id + ', this)"><i class="bi bi-send me-1"></i>Gerar</button></td></tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

async function genFollowup(lid, btn) {
  var chEl = document.getElementById('fu-channel-' + lid);
  var ch = chEl ? chEl.value : 'email';
  setLoading(btn, true);
  var res = await api('/api/followup/' + lid + '/generate', 'POST', { channel: ch }).catch(function() { return null; });
  setLoading(btn, false);
  if (res) { toast('Follow-up gerado! Verifique na aba RLHF.', 'success'); loadFollowupPending(); }
}

// ════════════════════════════════════════════════════════════
// FEATURE 1 — A/B Testing
// ════════════════════════════════════════════════════════════
async function generateABVariants() {
  if (!currentCompanyId) return;
  var btn = document.getElementById('btn-ab-variants');
  setLoading(btn, true);
  var res = await api('/api/leads/' + currentCompanyId + '/variants/generate', 'POST', {}).catch(function() { return null; });
  if (!res && currentCompanyData && currentCompanyData.contacts && currentCompanyData.contacts.length) {
    res = await api('/api/leads/' + currentCompanyData.contacts[0].id + '/variants/generate', 'POST', {}).catch(function() { return null; });
  }
  setLoading(btn, false);
  if (!res || !res.variants) { toast('Gere a sequencia principal primeiro.', 'warning'); return; }
  var section = document.getElementById('ab-variants-section');
  if (section) section.classList.remove('d-none');
  renderABVariants(res.variants);
  toast(res.variants.length + ' variantes B geradas!', 'success');
}

function renderABVariants(variants) {
  var el = document.getElementById('ab-variants-list');
  if (!el || !variants.length) return;
  var COLORS = { linkedin:'0077b5', email:'ea4335', whatsapp:'25d366' };
  var html = '';
  variants.forEach(function(v) {
    var color = COLORS[v.channel] || '6c757d';
    html += '<div class="border rounded p-2 mb-3">' +
      '<div class="d-flex justify-content-between align-items-center mb-2">' +
        '<span class="badge" style="background:#' + color + '">' + (v.channel||'').toUpperCase() + '</span>' +
        '<small class="text-muted">Escolha a melhor variante para este lead</small>' +
      '</div>' +
      '<div class="row g-2">' +
        '<div class="col-6">' +
          '<div class="small fw-bold text-muted mb-1">Variante A (original)</div>' +
          '<div class="msg-box" style="font-size:.78rem;max-height:120px;overflow-y:auto">' + esc(v.variant_a||'') + '</div>' +
          '<button class="btn btn-outline-primary btn-sm w-100 mt-1" onclick="setABWinner(' + v.id + ',\'a\')"><i class="bi bi-check-circle me-1"></i>Usar A</button>' +
        '</div>' +
        '<div class="col-6">' +
          '<div class="small fw-bold text-muted mb-1">Variante B (alternativa)</div>' +
          '<div class="msg-box" style="font-size:.78rem;max-height:120px;overflow-y:auto">' + esc(v.variant_b||'') + '</div>' +
          '<button class="btn btn-primary btn-sm w-100 mt-1" onclick="setABWinner(' + v.id + ',\'b\')"><i class="bi bi-stars me-1"></i>Usar B</button>' +
        '</div>' +
      '</div></div>';
  });
  el.innerHTML = html;
}

async function setABWinner(vid, winner) {
  await api('/api/ab-variants/' + vid + '/winner', 'POST', { winner: winner });
  toast('Variante ' + winner.toUpperCase() + ' selecionada!', 'success');
}

// ════════════════════════════════════════════════════════════
// FEATURE 4 — CRM Export
// ════════════════════════════════════════════════════════════
function exportCRM(format) {
  window.open('/api/crm/export?format=' + format, '_blank');
  toast('Exportando CSV formato ' + format + '...');
}

// ════════════════════════════════════════════════════════════
// FEATURE 3 — Timeline / Historico
// ════════════════════════════════════════════════════════════
async function loadInteractionsForCompany(companyId) {
  var el = document.getElementById('company-timeline');
  if (!el) return;
  var rows = await api('/api/companies/' + companyId + '/timeline').catch(function() { return []; });
  if (!rows.length) { el.innerHTML = '<p class="text-muted small">Nenhuma interacao registrada.</p>'; return; }
  var ICONS = {
    sent:      { icon: 'send',          color: '#0077b5' },
    response:  { icon: 'chat-dots',     color: '#198754' },
    followup:  { icon: 'reply',         color: '#ffc107' },
    meeting:   { icon: 'calendar-check',color: '#7c6af7' },
    ab_winner: { icon: 'shuffle',       color: '#0dcaf0' },
    note:      { icon: 'journal-text',  color: '#6c757d' },
  };
  var html = '';
  rows.forEach(function(r) {
    var ic = ICONS[r.interaction_type] || ICONS.note;
    var typeLabel = (r.interaction_type||'').replace(/_/g,' ').toUpperCase();
    var chLabel = r.channel ? ' &middot; ' + r.channel.toUpperCase() : '';
    var ts = (r.created_at||'').replace('T',' ').substring(0,16);
    html += '<div class="timeline-item">' +
      '<div class="timeline-icon" style="background:' + ic.color + '20">' +
        '<i class="bi bi-' + ic.icon + '" style="color:' + ic.color + '"></i>' +
      '</div>' +
      '<div style="flex:1">' +
        '<div class="small fw-bold">' + typeLabel + chLabel + '</div>' +
        '<div class="small text-muted">' + esc(r.notes||'') + '</div>' +
        '<div style="font-size:.72rem;color:#adb5bd">' + ts + '</div>' +
      '</div></div>';
  });
  el.innerHTML = html;
}

"""

insert_pos = content.rfind('</script>')
content = content[:insert_pos] + new_js + content[insert_pos:]

with open(r'C:\Users\mlute\PycharmProjects\fabioProject\templates\index.html', 'w', encoding='utf-8') as f:
    f.write(content)
print('OK - total chars:', len(content))
