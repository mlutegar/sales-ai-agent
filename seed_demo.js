#!/usr/bin/env node
/**
 * seed_demo.js — recria a base de DEMONSTRACAO no prototype.db.
 *
 * Uso (uma vez, apos 'npm install'):
 *   1) npm start       # cria o prototype.db com as tabelas; pare com Ctrl+C
 *   2) npm run seed    # popula os dados de demo
 *   3) npm start       # rode de novo e abra http://localhost:3000
 *
 * Idempotente: limpa os dados de demo e recria. Nao precisa de internet/IA
 * (a pesquisa da TOTVS/Magalu ja vem salva).
 */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, 'prototype.db'));

const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'").get();
if (!has) {
  console.error('\n❌ Banco sem schema. Rode `npm start` uma vez para criar as tabelas e depois rode: npm run seed\n');
  process.exit(1);
}

// limpa dados antigos (so as tabelas que existem)
for (const t of ['messages','sentiment_logs','consent_logs','schedule_slots','opportunities','documents','golden_cases','contacts','companies']) {
  try { db.prepare('DELETE FROM ' + t).run(); } catch {}
}

const COMPANIES = [
  {
    "name": "Aurora Sistemas",
    "sector": "Tecnologia",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Ana Dias",
        "role": "c_level",
        "email": "ana.dias@aurora.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Brava Log",
    "sector": "Logística",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Bruno Klein",
        "role": "c_level",
        "email": "bruno.klein@brava.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Cedro Tech",
    "sector": "Tecnologia",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Carla Ramos",
        "role": "c_level",
        "email": "carla.ramos@cedro.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Delta Foods",
    "sector": "Alimentos",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Diego Yamada",
        "role": "c_level",
        "email": "diego.yamada@delta.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Eixo Capital",
    "sector": "Financeiro",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Eduarda Ferreira",
        "role": "c_level",
        "email": "eduarda.ferreira@eixo.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Forte Energia",
    "sector": "Energia",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Felipe Moraes",
        "role": "c_level",
        "email": "felipe.moraes@forte.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Granito Saude",
    "sector": "Saúde",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Gabriela Teixeira",
        "role": "c_level",
        "email": "gabriela.teixeira@granito.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      },
      {
        "name": "João Oliveira",
        "role": "c_level",
        "email": "joao.oliveira@granito.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Sofia Zanetti",
        "role": "other",
        "email": "sofia.zanetti@granito.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      }
    ]
  },
  {
    "name": "Horizonte Retail",
    "sector": "Varejo",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Henrique Almeida",
        "role": "c_level",
        "email": "henrique.almeida@horizonte.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      },
      {
        "name": "Tiago Gomes",
        "role": "other",
        "email": "tiago.gomes@horizonte.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      }
    ]
  },
  {
    "name": "Iguatu Agro",
    "sector": "Agronegócio",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Isabela Henriques",
        "role": "c_level",
        "email": "isabela.henriques@iguatu.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      },
      {
        "name": "Ursula Nunes",
        "role": "other",
        "email": "ursula.nunes@iguatu.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Vitor Uchoa",
        "role": "other",
        "email": "vitor.uchoa@iguatu.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      }
    ]
  },
  {
    "name": "Junco Telecom",
    "sector": "Telecom",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Karina Vieira",
        "role": "other",
        "email": "karina.vieira@junco.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      },
      {
        "name": "Lucas Cardoso",
        "role": "other",
        "email": "lucas.cardoso@junco.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Mariana Jardim",
        "role": "other",
        "email": "mariana.jardim@junco.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Nelson Queiroz",
        "role": "other",
        "email": "nelson.queiroz@junco.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Queila Lopes",
        "role": "other",
        "email": "queila.lopes@junco.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Rafael Santos",
        "role": "other",
        "email": "rafael.santos@junco.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      }
    ]
  },
  {
    "name": "Kalmar Industria",
    "sector": "Indústria",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Olivia Xavier",
        "role": "other",
        "email": "olivia.xavier@kalmar.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      },
      {
        "name": "Paulo Esteves",
        "role": "other",
        "email": "paulo.esteves@kalmar.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      }
    ]
  },
  {
    "name": "Lumini Educacao",
    "sector": "Educação",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Wagner Barbosa",
        "role": "other",
        "email": "wagner.barbosa@lumini.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Marola Seguros",
    "sector": "Seguros",
    "status": "new",
    "interest_score": null,
    "research_hook": null,
    "research_context": null,
    "contacts": [
      {
        "name": "Yara Ibrahim",
        "role": "other",
        "email": "yara.ibrahim@marola.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      },
      {
        "name": "Bianca Pereira",
        "role": "other",
        "email": "bianca.pereira@marola.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Caio Werneck",
        "role": "other",
        "email": "caio.werneck@marola.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      },
      {
        "name": "Daniela Dias",
        "role": "other",
        "email": "daniela.dias@marola.com",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 0
      }
    ]
  },
  {
    "name": "TOTVS",
    "sector": "Tecnologia / ERP",
    "status": "researched",
    "interest_score": null,
    "research_hook": "A TOTVS acaba de lançar agentes de IA nativos no ERP e expandir para large enterprise — exatamente quando a pressão por eficiência em vendas nunca foi tão alta. Posso mostrar como nossa solução de automação com IA acelera o ciclo comercial e entrega ROI mensurável já nos primeiros 90 dias.",
    "research_context": "{\"research_context\":[{\"gancho\":\"Lançamento de agentes de IA nativos no ERP\",\"fato\":\"No evento Universo TOTVS 2025, a empresa anunciou os primeiros agentes de IA (TOTVS Copilot) cobrindo áreas de vendas, finanças, compras, RH e jurídico — sistemas autônomos integrados ao ERP que executam tarefas com base em dados reais. O rollout para toda a base de clientes está previsto para o final de 2025.\",\"fonte\":\"https://revna.com.br/noticias-de-tecnologia/technology/totvs-revoluciona-com-agentes-de-ia-no-universo-totvs\"},{\"gancho\":\"Expansão agressiva para large enterprise via parcerias estratégicas\",\"fato\":\"Em abril de 2025 a TOTVS fechou parceria com a Engineering Brasil e com a CLA Brasil para ampliar sua presença em empresas de grande porte, estabelecendo um novo canal de comercialização com integradores de tecnologia e consultorias de médio e grande porte.\",\"fonte\":\"https://inforchannel.com.br/2025/04/09/totvs-mira-em-grandes-empresa-e-fecha-parceria-com-a-engineering-brasil/\"},{\"gancho\":\"Lucro +44% no 4T25 e recompra de ações — momento de reinvestimento em crescimento\",\"fato\":\"A TOTVS encerrou o 4º trimestre de 2025 com lucro 44,3% maior em base anual e anunciou programa de recompra de ações, sinalizando solidez financeira e capacidade de investimento em novas tecnologias, incluindo IA.\",\"fonte\":\"https://www.seudinheiro.com/2026/empresas/retorno-aos-acionistas-totvs-tots3-anuncia-recompra-de-acoes-apos-lucro-subir-44-no-4t25-lvgb/\"}],\"hook\":\"A TOTVS acaba de lançar agentes de IA nativos no ERP e expandir para large enterprise — exatamente quando a pressão por eficiência em vendas nunca foi tão alta. Posso mostrar como nossa solução de automação com IA acelera o ciclo comercial e entrega ROI mensurável já nos primeiros 90 dias.\",\"pain_points\":[{\"dor\":\"Ciclo de vendas longo e improdutividade do time comercial\",\"contexto\":\"Com a expansão para grandes empresas (parceria com Engineering Brasil e CLA Brasil), o time de vendas da TOTVS opera em deals complexos e longos. Sem automação inteligente, vendedores gastam até 60% do tempo em tarefas administrativas (CRM manual, follow-up, propostas) em vez de vender — comprimindo a capacidade de escalar o novo canal enterprise.\"},{\"dor\":\"Pressão para extrair valor real da IA já implantada\",\"contexto\":\"A TOTVS está no meio de um grande rollout de IA (TOTVS Copilot) e precisa demonstrar ROI concreto para seus clientes — e internamente. Um Diretor Comercial que já consome IA no produto precisa ver o mesmo nível de inteligência aplicado ao próprio processo de vendas, ou corre o risco de inconsistência entre o que vende e o que usa.\"},{\"dor\":\"Escalabilidade da receita recorrente (SaaS/ARR) sem crescimento proporcional de headcount\",\"contexto\":\"Com lucro crescendo 44% no 4T25 e um CEO declaradamente focado em expansão da própria base, o desafio é crescer ARR sem inflar custo de aquisição (CAC). Automação de vendas com IA é o único alavancador que reduz CAC e aumenta velocidade de pipeline simultaneamente.\"}],\"value_proposition\":\"Nossa solução de automação de vendas com IA foi desenhada para operações comerciais B2B complexas como a da TOTVS: integra ao CRM existente, automatiza prospecção, scoring de leads, follow-up e geração de propostas — liberando o time para focar em fechamento. Para um negócio que acabou de crescer 44% no lucro e está escalando para large enterprise, o impacto é direto: redução de até 35% no CAC, aumento de 20–30% na taxa de conversão e visibilidade total do pipeline para decisões estratégicas em tempo real. ROI demonstrável em 90 dias, sem substituir o ERP — trabalhando junto a ele.\",\"sources\":[\"https://revna.com.br/noticias-de-tecnologia/technology/totvs-revoluciona-com-agentes-de-ia-no-universo-totvs\",\"https://inforchannel.com.br/2025/04/09/totvs-mira-em-grandes-empresa-e-fecha-parceria-com-a-engineering-brasil/\",\"https://portalerp.com/br/noticia/totvs-anuncia-parceria-com-cla-brasil\",\"https://www.seudinheiro.com/2026/empresas/retorno-aos-acionistas-totvs-tots3-anuncia-recompra-de-acoes-apos-lucro-subir-44-no-4t25-lvgb/\",\"https://www.bloomberglinea.com.br/tech/ceo-da-totvs-mira-expansao-na-propria-base-e-espera-segundo-semestre-saudavel/\",\"https://portalerp.com/totvs-lanca-solucoes-com-ia-para-o-setor-de-distribuicao\",\"https://abaccus.com.br/blog-posts/totvs-ia-como-novo-motor-do-crescimento\",\"https://www.totvs.com/inteligencia-artificial/\"]}",
    "contacts": [
      {
        "name": "Diretor Comercial (demo)",
        "role": "c_level",
        "email": "",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  },
  {
    "name": "Magazine Luiza",
    "sector": "Varejo / E-commerce",
    "status": "researched",
    "interest_score": null,
    "research_hook": "O Magalu já declarou publicamente que IA e automação são seus vetores centrais de crescimento para 2026 — a questão não é se adotar, mas quais soluções vão gerar ROI real antes que a concorrência (Amazon, Shopee, TikTok Shop) tome mais espaço.",
    "research_context": "{\"research_context\":[\"O Magalu anunciou parceria com Amazon Brasil (junho/2026) para vender mais de 12 mil produtos próprios na plataforma, além de acordos prévios com AliExpress e Americanas, sinalizando forte expansão multicanal.\",\"Em 2025, o Magalu declarou que a IA será integrada em todas as frentes do negócio, com o WhatsApp da Lu reportando conversão em vendas até 3x maior e foco explícito em automação para ganho de produtividade e rentabilidade.\",\"O lucro líquido ajustado caiu para R$ 158,9 milhões em 2025 (vs. R$ 294,8 mi no 4T24 isolado), pressionado pela Selic alta e competição acirrada com Shopee, Amazon e TikTok Shop, levando a empresa a priorizar margem em vez de volume.\"],\"hook\":\"O Magalu já declarou publicamente que IA e automação são seus vetores centrais de crescimento para 2026 — a questão não é se adotar, mas quais soluções vão gerar ROI real antes que a concorrência (Amazon, Shopee, TikTok Shop) tome mais espaço.\",\"pain_points\":[\"Pressão de margem severa: despesas com vendas consumiram 19,2% da receita líquida no 3T25, com lucro caindo ~70% no trimestre — cada ponto de ineficiência no processo comercial vira prejuízo direto no bottom line.\",\"Competição multicanal extrema com players globais (Amazon, Shopee, TikTok Shop) forçando o Magalu a firmar parcerias em plataformas rivais e reformular posicionamento, o que exige times de vendas mais ágeis e dados em tempo real para tomada de decisão.\",\"Escala operacional complexa com mais de 1.300 lojas físicas, 281 mil sellers no marketplace e múltiplas marcas (KaBuM!, Netshoes, Época Cosméticos) — sem automação de vendas com IA, a gestão de pipeline e priorização de oportunidades se torna inviável na velocidade exigida.\"],\"value_proposition\":\"Nossa solução de automação de vendas com IA reduz o custo de aquisição e aumenta a conversão do time comercial do Magalu, entregando ROI mensurável em um cenário onde cada ponto de margem conta — alinhado diretamente à estratégia declarada pela liderança de usar IA para fortalecer produtividade e rentabilidade em 2026.\",\"sources\":[\"https://www.infomoney.com.br/mercados/magazine-luiza-mglu3-resultados-quarto-trimestre-2025/\",\"https://investnews.com.br/negocios/magazine-luiza-mglu3-online-e-commerce/\",\"https://canaltech.com.br/mercado/magalu-fecha-parceria-para-vender-mais-de-12-mil-produtos-na-amazon/\",\"https://www.seudinheiro.com/2025/empresas/magazine-luiza-mglu3-e-americanas-amer3-fecham-parceria-para-o-e-commerce-veja-mlim/\",\"https://exame.com/invest/mercados/magazine-luiza-magalu-mglu3-balanco-terceiro-trimestre-2025/\"]}",
    "contacts": [
      {
        "name": "Diretora de Vendas (demo)",
        "role": "c_level",
        "email": "",
        "linkedin": "",
        "whatsapp": "",
        "is_primary": 1
      }
    ]
  }
];
const OPPORTUNITIES = [
  {
    "company": "TOTVS",
    "name": "Implantação de automação de vendas — TOTVS",
    "stage": "qualified",
    "value": 48000,
    "notes": "Diretor demonstrou interesse após a abordagem sobre agentes de IA no ERP."
  }
];
const DOCUMENTS = [
  {
    "name": "Ficha técnica — Sales AI Agent",
    "content": "O Sales AI Agent integra-se via API REST a CRMs (Salesforce, HubSpot, RD Station) e ao WhatsApp Cloud API oficial da Meta. Segurança: criptografia em trânsito (TLS 1.3) e em repouso (AES-256), conformidade LGPD com logs de consentimento e opt-out automático. Implantação média: 2 semanas. SLA de 99,9%. Suporta enriquecimento de leads, geração de sequências multicanal (LinkedIn, e-mail, WhatsApp) e classificação de intenção por IA."
  }
];
const GOLDEN = [
  {
    "title": "Reunião agendada com diretor de varejo em 2 mensagens",
    "context": "Setor: Varejo | Cargo: C-Level | Produto: automação de vendas com IA",
    "content": "SDR: Vi que vocês abriram 12 lojas esse ano e a área comercial cresceu junto. Muitos varejistas nesse ritmo perdem lead por follow-up lento. Tenho um case de +30% em conversão num cenário parecido. Vale 15 min?\nCliente: Faz sentido. Pode ser quinta 10h.\nSDR: Fechado! Mando o convite agora.",
    "score": 5
  }
];
const SLOTS = [
  {
    "date_time": "2026-07-01 14:00",
    "duration_min": 15,
    "meeting_link": "https://meet.google.com/demo-sales-ai"
  }
];

const idByName = {};
const insCo = db.prepare('INSERT INTO companies (name,sector,status,interest_score,research_hook,research_context) VALUES (?,?,?,?,?,?)');
const insCt = db.prepare('INSERT INTO contacts (company_id,name,role,email,linkedin,whatsapp,is_primary) VALUES (?,?,?,?,?,?,?)');
let nCo=0,nCt=0;
for (const c of COMPANIES) {
  const r = insCo.run(c.name, c.sector, c.status, c.interest_score, c.research_hook, c.research_context);
  idByName[c.name] = r.lastInsertRowid; nCo++;
  for (const ct of c.contacts) { insCt.run(r.lastInsertRowid, ct.name, ct.role, ct.email, ct.linkedin||'', ct.whatsapp||'', ct.is_primary||0); nCt++; }
}
const insOp = db.prepare('INSERT INTO opportunities (company_id,name,stage,value,notes) VALUES (?,?,?,?,?)');
for (const o of OPPORTUNITIES) { if (idByName[o.company]) insOp.run(idByName[o.company], o.name, o.stage, o.value, o.notes||''); }
const insDoc = db.prepare('INSERT INTO documents (name,content) VALUES (?,?)');
for (const d of DOCUMENTS) insDoc.run(d.name, d.content);
const insG = db.prepare('INSERT INTO golden_cases (title,context,content,score) VALUES (?,?,?,?)');
for (const g of GOLDEN) insG.run(g.title, g.context||'', g.content, g.score||5);
const insS = db.prepare('INSERT INTO schedule_slots (date_time,duration_min,meeting_link) VALUES (?,?,?)');
for (const s of SLOTS) insS.run(s.date_time, s.duration_min||15, s.meeting_link||'');

console.log('\n✅ Demo populada:');
console.log('   ' + nCo + ' empresas, ' + nCt + ' contatos');
console.log('   ' + OPPORTUNITIES.length + ' oportunidade(s), ' + DOCUMENTS.length + ' doc(s) RAG, ' + GOLDEN.length + ' caso(s) de ouro, ' + SLOTS.length + ' slot(s) de agenda');
console.log('\nAgora rode: npm start  →  http://localhost:3000 (login admin / admin123)\n');
