'use strict';

/*
 * TechLar - Mock da API de Logistica (US 04)
 * Servidor HTTP sem dependencias (Node puro).
 *
 * Contrato principal:
 *   GET /tracking/:trackingCode
 *     200 -> { trackingCode, status, updatedAt, carrier, eta }
 *     503 -> { error: "Service Unavailable" }   (quando a API esta "derrubada")
 *
 * Controle para a demo (nao faz parte do contrato consumido pelo Salesforce):
 *   POST /admin/down            -> derruba a API (passa a responder 503)
 *   POST /admin/up              -> restabelece a API
 *   POST /admin/delay?ms=12000  -> injeta atraso artificial (testa o timeout de 10s)
 *   GET  /admin/status          -> estado atual (up/down e delay)
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

const STATUSES = ['Novo Pedido', 'Postado', 'Em trânsito', 'Saiu para entrega', 'Entregue', 'Aguardando retirada'];

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
  const status = STATUSES[(h >> 3) % STATUSES.length];

  const now = new Date();
  const updatedAt = new Date(now.getTime() - ((h % 72) * 3600 * 1000)); // ate 3 dias atras
  const eta = new Date(now.getTime() + (((h % 7) + 1) * 24 * 3600 * 1000)); // 1 a 7 dias a frente

  return {
    trackingCode: code,
    status,
    updatedAt: updatedAt.toISOString(),
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

const HELP = {
  service: 'TechLar Mock Logistica',
  contrato: {
    'GET /tracking/:trackingCode': '200 com {status, updatedAt, carrier, eta} ou 503 se derrubado',
  },
  controleDemo: {
    'POST /admin/down': 'derruba a API (503)',
    'POST /admin/up': 'restabelece a API',
    'POST /admin/delay?ms=12000': 'injeta atraso artificial (testa timeout)',
    'GET /admin/status': 'estado atual',
  },
  estadoAtual: state,
};

const server = http.createServer((req, res) => {
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
  console.log(`TechLar Mock Logistica ouvindo em http://localhost:${PORT}`);
  console.log(`Teste: curl http://localhost:${PORT}/tracking/BR123456789`);
});
