'use strict';

/*
 * TechLar - Mock de Logistica (US 04) + ERP/Estoque
 * Servidor HTTP sem dependencias (Node puro).
 *
 * Contrato de LOGISTICA (consumido pela LWC + Service Apex na org):
 *   GET /tracking/:trackingCode
 *     200 -> { trackingCode, status, updatedAt, carrier, eta }
 *     503 -> { error }   (quando a API esta "derrubada")
 *
 * Contrato de ERP/ESTOQUE (para o projeto Agentforce; SKUs espelham o catalogo do site):
 *   GET  /estoque/:sku          -> 200 { sku, nome, precoUnitario, moeda, quantidadeDisponivel, ... } ou 503
 *   POST /estoque/baixa         -> body { itens:[{sku,qtd}] }: 200 baixa o estoque, 409 se faltar
 *   POST /estoque/entrada       -> body { itens:[{sku,qtd}] }: repoe/estorna estoque
 *
 * Controle para a demo (nao faz parte do contrato consumido pelo Salesforce):
 *   POST /admin/down            -> derruba a logistica (passa a responder 503)
 *   POST /admin/up              -> restabelece a logistica
 *   POST /admin/delay?ms=12000  -> injeta atraso artificial na logistica (testa o timeout de 10s)
 *   GET  /admin/status          -> estado atual da logistica (up/down e delay)
 *   GET  /admin/erp/status      -> estado do ERP + snapshot do estoque
 *   POST /admin/erp/down|up     -> derruba / restabelece o ERP
 *   POST /admin/erp/delay?ms=.. -> injeta atraso artificial no ERP
 *   POST /admin/erp/reset       -> volta o estoque ao seed (repetir a demo)
 *   GET  /                      -> ajuda
 */

const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// Estado em memoria, alternavel em runtime pelos endpoints /admin.
const state = {
  available: true, // false => responde 503
  delayMs: 0,      // atraso artificial antes de responder /tracking
};

// ---------------------------------------------------------------------------
// ERP (Estoque) - bloco aditivo, independente da logistica.
// Estado proprio: derrubar/atrasar/baixar o ERP nunca afeta /tracking.
// ---------------------------------------------------------------------------
const erpState = {
  available: true, // false => /estoque responde 503
  delayMs: 0,      // atraso artificial antes de responder /estoque
};

// Catalogo espelha os produtos reais do site
// (techlar-ecommerce: server/src/db/products.js -> ORG_PRODUCTS, que reflete o
// Price Book da org). `estoqueInicial` e o seed da demo. Estoque NAO existe no
// site (a tabela products nao tem coluna de quantidade), entao o inventario e
// responsabilidade deste ERP. Re-sincronize aqui se o catalogo do site mudar.
const CATALOGO = [
  { sku: 'GSGH2J23213',        nome: 'iPhone 17',                  precoUnitario: 8608.0,  estoqueInicial: 5 },
  { sku: 'GSGH2J232111',       nome: 'iPhone 17 Pro Max',          precoUnitario: 18902.0, estoqueInicial: 3 },
  { sku: 'MacBookM4Air',       nome: 'MacBook Air M4',             precoUnitario: 10000.0, estoqueInicial: 4 },
  { sku: 'GSGH2J232xxsssssss', nome: 'MacBook Air M5',             precoUnitario: 18902.0, estoqueInicial: 2 },
  { sku: 'IMP-3D-PREMIUM',     nome: 'Impressora 3D Premium',      precoUnitario: 5500.0,  estoqueInicial: 6 },
  { sku: 'IMP-3D-PLUS',        nome: 'Impressora 3D Plus Premium', precoUnitario: 7865.0,  estoqueInicial: 4 },
  { sku: 'CABO-USB',           nome: 'Cabo USB',                   precoUnitario: 20.0,    estoqueInicial: 50 },
];
const CATALOGO_BY_SKU = new Map(CATALOGO.map((p) => [p.sku, p]));
const MOEDA = 'BRL';

// Estoque MUTAVEL em memoria (fonte da verdade do inventario para site e org).
// reseedEstoque() volta ao seed para repetir a demo do zero.
let erpStock = new Map();
function reseedEstoque() {
  erpStock = new Map(CATALOGO.map((p) => [p.sku, p.estoqueInicial]));
}
reseedEstoque();

function viewEstoque(sku) {
  const p = CATALOGO_BY_SKU.get(sku);
  const quantidadeDisponivel = erpStock.has(sku) ? erpStock.get(sku) : 0;
  return {
    sku,
    nome: p ? p.nome : null,                   // null => SKU fora do catalogo do site
    precoUnitario: p ? p.precoUnitario : null,
    moeda: MOEDA,
    quantidadeDisponivel,
    disponivel: quantidadeDisponivel > 0,
    updatedAt: new Date().toISOString(),
  };
}

// Snapshot do estoque atual (para /admin/erp/status), como objeto simples.
function estoqueSnapshot() {
  const out = {};
  for (const [sku, qtd] of erpStock) out[sku] = qtd;
  return out;
}

const CARRIERS = ['Correios', 'Jadlog', 'Loggi', 'Total Express', 'Azul Cargo'];
// Vocabulario de status = as 4 etapas da barra do Workspace (LWC).
// Manter alinhado com o front: qualquer valor fora desta lista quebra a barra.
const STATUSES = ['Aguardando', 'Confirmado', 'Em Transporte', 'Entregue'];

// Gera dados deterministicos a partir do codigo de rastreio,
// para que o mesmo codigo sempre retorne o mesmo status na demo.
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function buildTracking(code) {
  const h = hash(code || 'DEFAULT');
  const carrier = CARRIERS[h % CARRIERS.length];
  const status = STATUSES[(h >>> 3) % STATUSES.length];

  const now = new Date();
  const updatedAt = new Date(now.getTime() - ((h % 72) * 3600 * 1000)); // ate 3 dias atras
  const eta = new Date(now.getTime() + (((h % 7) + 1) * 24 * 3600 * 1000)); // 1 a 7 dias a frente

  return {
    trackingCode: code,
    status,
    updatedAt: updatedAt.toISOString(),
    carrier,
    eta: eta.toISOString().slice(0, 10), // YYYY-MM-DD
  };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// Le o corpo da requisicao e faz JSON.parse. Node puro: acumula os chunks e
// resolve com o objeto (ou {} se o corpo vier vazio). Rejeita se o JSON for
// invalido, para o chamador responder 400.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Normaliza a lista de itens de um POST de estoque. Aceita tanto o corpo JSON
// { itens: [{ sku, qtd }] } quanto os query params ?sku=X&qtd=1 (curl manual).
// Retorna { itens, error }: se `error` vier preenchido, o chamador responde 400.
function parseItens(body, url) {
  let itens = Array.isArray(body && body.itens) ? body.itens : null;
  if (!itens) {
    const sku = url.searchParams.get('sku');
    if (sku) {
      const qtd = parseInt(url.searchParams.get('qtd'), 10);
      itens = [{ sku, qtd: Number.isFinite(qtd) ? qtd : 1 }];
    }
  }
  if (!itens || !itens.length) {
    return { itens: null, error: 'Informe itens: [{ sku, qtd }] no corpo ou ?sku=..&qtd=..' };
  }
  const norm = [];
  for (const it of itens) {
    const sku = it && it.sku;
    const qtd = parseInt(it && it.qtd, 10);
    if (!sku || !Number.isFinite(qtd) || qtd <= 0) {
      return { itens: null, error: 'Cada item precisa de sku (string) e qtd (inteiro > 0).' };
    }
    norm.push({ sku: String(sku), qtd });
  }
  return { itens: norm, error: null };
}

const HELP = {
  service: 'TechLar Mock Logistica + ERP (Estoque)',
  contrato: {
    'GET /tracking/:trackingCode': '200 com {status, updatedAt, carrier, eta} ou 503 se derrubado',
    'GET /estoque/:sku': '200 com {sku, nome, precoUnitario, moeda, quantidadeDisponivel, disponivel, updatedAt} ou 503',
    'POST /estoque/baixa': 'body {itens:[{sku,qtd}]} -> 200 baixa o estoque, ou 409 se faltar (nada e baixado)',
    'POST /estoque/entrada': 'body {itens:[{sku,qtd}]} -> 200 devolve/repoe estoque',
  },
  controleDemo: {
    'POST /admin/down': 'derruba a logistica (503)',
    'POST /admin/up': 'restabelece a logistica',
    'POST /admin/delay?ms=12000': 'injeta atraso artificial na logistica (testa timeout)',
    'GET /admin/status': 'estado atual da logistica',
    'GET /admin/erp/status': 'estado atual do ERP + snapshot do estoque',
    'POST /admin/erp/down': 'derruba o ERP (503)',
    'POST /admin/erp/up': 'restabelece o ERP',
    'POST /admin/erp/delay?ms=12000': 'injeta atraso artificial no ERP (testa timeout)',
    'POST /admin/erp/reset': 'volta o estoque ao seed (repetir a demo)',
  },
  estadoAtual: { logistica: state, erp: erpState },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  // Ajuda
  if (method === 'GET' && path === '/') {
    return sendJson(res, 200, HELP);
  }

  // Controle da demo
  if (path === '/admin/status' && method === 'GET') {
    return sendJson(res, 200, { available: state.available, delayMs: state.delayMs });
  }
  if (path === '/admin/down' && method === 'POST') {
    state.available = false;
    console.log('[admin] API DERRUBADA (503)');
    return sendJson(res, 200, { ok: true, available: false });
  }
  if (path === '/admin/up' && method === 'POST') {
    state.available = true;
    state.delayMs = 0;
    console.log('[admin] API RESTABELECIDA (200)');
    return sendJson(res, 200, { ok: true, available: true });
  }
  if (path === '/admin/delay' && method === 'POST') {
    const ms = parseInt(url.searchParams.get('ms'), 10);
    state.delayMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
    console.log(`[admin] delay = ${state.delayMs}ms`);
    return sendJson(res, 200, { ok: true, delayMs: state.delayMs });
  }

  // Controle da demo do ERP (mexe so em erpState/erpStock; nao afeta a logistica)
  if (path === '/admin/erp/status' && method === 'GET') {
    return sendJson(res, 200, {
      available: erpState.available,
      delayMs: erpState.delayMs,
      estoque: estoqueSnapshot(),
    });
  }
  if (path === '/admin/erp/down' && method === 'POST') {
    erpState.available = false;
    console.log('[erp] ERP DERRUBADO (503)');
    return sendJson(res, 200, { ok: true, available: false });
  }
  if (path === '/admin/erp/up' && method === 'POST') {
    erpState.available = true;
    erpState.delayMs = 0;
    console.log('[erp] ERP RESTABELECIDO (200)');
    return sendJson(res, 200, { ok: true, available: true });
  }
  if (path === '/admin/erp/delay' && method === 'POST') {
    const ms = parseInt(url.searchParams.get('ms'), 10);
    erpState.delayMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
    console.log(`[erp] delay = ${erpState.delayMs}ms`);
    return sendJson(res, 200, { ok: true, delayMs: erpState.delayMs });
  }
  if (path === '/admin/erp/reset' && method === 'POST') {
    reseedEstoque();
    console.log('[erp] estoque RESETADO para o seed');
    return sendJson(res, 200, { ok: true, estoque: estoqueSnapshot() });
  }

  // ERP - leitura de estoque: GET /estoque/:sku
  const mEstoque = path.match(/^\/estoque\/([^/]+)$/);
  if (mEstoque && method === 'GET') {
    const sku = decodeURIComponent(mEstoque[1]);
    const respond = () => {
      if (!erpState.available) {
        console.log(`[estoque] ${sku} -> 503 (ERP derrubado)`);
        return sendJson(res, 503, { error: 'ERP temporariamente indisponível.' });
      }
      console.log(`[estoque] ${sku} -> 200`);
      return sendJson(res, 200, viewEstoque(sku));
    };
    if (erpState.delayMs > 0) {
      return setTimeout(respond, erpState.delayMs);
    }
    return respond();
  }

  // ERP - baixa de estoque: POST /estoque/baixa  { itens: [{ sku, qtd }] }
  // Atomico: valida tudo antes; se algum item nao tem saldo, retorna 409 e NAO
  // baixa nada (Node e single-thread, entao check-and-decrement nao intercala).
  if (path === '/estoque/baixa' && method === 'POST') {
    if (!erpState.available) {
      return sendJson(res, 503, { error: 'ERP temporariamente indisponível.' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'JSON inválido no corpo da requisição.' });
    }
    const { itens, error } = parseItens(body, url);
    if (error) return sendJson(res, 400, { error });

    const faltantes = [];
    for (const it of itens) {
      const disponivel = erpStock.has(it.sku) ? erpStock.get(it.sku) : 0;
      if (disponivel < it.qtd) {
        faltantes.push({ sku: it.sku, solicitado: it.qtd, disponivel });
      }
    }
    if (faltantes.length) {
      console.log(`[estoque] baixa NEGADA (409): ${JSON.stringify(faltantes)}`);
      return sendJson(res, 409, { error: 'Estoque insuficiente.', faltantes });
    }
    const resultado = itens.map((it) => {
      const novo = erpStock.get(it.sku) - it.qtd;
      erpStock.set(it.sku, novo);
      return { sku: it.sku, quantidadeDisponivel: novo };
    });
    console.log(`[estoque] baixa OK: ${JSON.stringify(resultado)}`);
    return sendJson(res, 200, { ok: true, itens: resultado });
  }

  // ERP - entrada/estorno: POST /estoque/entrada  { itens: [{ sku, qtd }] }
  // Repoe estoque (compensacao de uma baixa ou restock manual). Só repõe SKUs
  // conhecidos do catalogo, para nao criar itens fantasmas.
  if (path === '/estoque/entrada' && method === 'POST') {
    if (!erpState.available) {
      return sendJson(res, 503, { error: 'ERP temporariamente indisponível.' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'JSON inválido no corpo da requisição.' });
    }
    const { itens, error } = parseItens(body, url);
    if (error) return sendJson(res, 400, { error });

    const desconhecidos = itens.filter((it) => !CATALOGO_BY_SKU.has(it.sku)).map((it) => it.sku);
    if (desconhecidos.length) {
      return sendJson(res, 400, { error: 'SKU fora do catálogo.', desconhecidos });
    }
    const resultado = itens.map((it) => {
      const novo = (erpStock.has(it.sku) ? erpStock.get(it.sku) : 0) + it.qtd;
      erpStock.set(it.sku, novo);
      return { sku: it.sku, quantidadeDisponivel: novo };
    });
    console.log(`[estoque] entrada OK: ${JSON.stringify(resultado)}`);
    return sendJson(res, 200, { ok: true, itens: resultado });
  }

  // Contrato principal: GET /tracking/:code
  const match = path.match(/^\/tracking\/([^/]+)$/);
  if (match && method === 'GET') {
    const code = decodeURIComponent(match[1]);
    const respond = () => {
      if (!state.available) {
        console.log(`[tracking] ${code} -> 503 (derrubada)`);
        return sendJson(res, 503, { error: 'Serviço temporariamente indisponível.' });
      }
      console.log(`[tracking] ${code} -> 200`);
      return sendJson(res, 200, buildTracking(code));
    };
    if (state.delayMs > 0) {
      return setTimeout(respond, state.delayMs);
    }
    return respond();
  }

  return sendJson(res, 404, { error: 'Não encontrado.', path });
});

server.listen(PORT, () => {
  console.log(`TechLar Mock Logistica + ERP ouvindo em http://localhost:${PORT}`);
  console.log(`Teste logistica: curl http://localhost:${PORT}/tracking/BR123456789`);
  console.log(`Teste estoque:   curl http://localhost:${PORT}/estoque/GSGH2J23213`);
});
