'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');

const BASE_DIR = __dirname;
const APP_HTML = path.resolve(BASE_DIR, '..', 'unfollowgram_v9.html');
const GETKEY_HTML = path.resolve(BASE_DIR, '..', 'getkey.html');
const GETKEY2_HTML = path.resolve(BASE_DIR, '..', 'getkey2.html');
const STORE_FILE = path.join(BASE_DIR, 'unfollowgram_store.json');
const ENV_FILE = path.join(BASE_DIR, '.env');

loadEnvFromFile(ENV_FILE);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const EVOPAY_API_URL = process.env.EVOPAY_API_URL || 'https://api.evopay.cash';
const EVOPAY_API_KEY = process.env.EVOPAY_API_KEY || '';
const EVOPAY_CHECKOUT_PATH = process.env.EVOPAY_CHECKOUT_PATH || '/v1/transactions';
const EVOPAY_PAYMENT_PATH = process.env.EVOPAY_PAYMENT_PATH || '/v1/payments/{payment_id}';
const EVOPAY_CHECKOUT_URL = process.env.EVOPAY_CHECKOUT_URL || '';
const EVOPAY_PAYMENT_URL_TEMPLATE = process.env.EVOPAY_PAYMENT_URL_TEMPLATE || '';
const EVOPAY_WEBHOOK_SECRET = process.env.EVOPAY_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;

const PLAN_CONFIG = {
  starter: { name: 'Starter', price: 15.9, uses: 1 },
  pro: { name: 'Pro', price: 35.9, uses: 3 },
  vip: { name: 'VIP', price: 85.9, uses: Infinity },
};

const APPROVED_STATUSES = new Set(['approved', 'accredited', 'paid', 'succeeded', 'success']);
const PENDING_STATUSES = new Set(['pending', 'in_process', 'processing', 'waiting_payment']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, {});
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/unfollowgram_v9.html')) {
      return serveStaticHtml(res, APP_HTML);
    }

    if (req.method === 'GET' && pathname === '/getkey.html') {
      return serveStaticHtml(res, GETKEY_HTML);
    }

    if (req.method === 'GET' && pathname === '/getkey2.html') {
      return serveStaticHtml(res, GETKEY2_HTML);
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'unfollowgram-backend' });
    }

    if (req.method === 'POST' && pathname === '/api/checkout') {
      return handleCheckout(req, res);
    }

    if (req.method === 'GET' && pathname === '/api/checkout/claim') {
      return handleClaim(req, res, url);
    }

    if (req.method === 'GET' && pathname === '/api/getkey/direct') {
      return handleDirectGetKey(req, res, url);
    }

    if (req.method === 'POST' && pathname === '/api/payment/confirm') {
      return handleConfirm(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/webhook/evopay') {
      return handleWebhook(req, res);
    }

    return sendJson(res, 404, { error: 'Rota nao encontrada' });
  } catch (error) {
    console.error('Erro no servidor:', error);
    return sendJson(res, 500, { error: 'Erro interno do servidor' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UnfollowGram backend rodando em ${PUBLIC_BASE_URL}`);
  console.log('Abra no navegador:', `${PUBLIC_BASE_URL}/`);
});

async function handleCheckout(req, res) {
  if (!EVOPAY_API_KEY) {
    return sendJson(res, 500, {
      error: 'EVOPAY_API_KEY nao configurada no backend',
    });
  }

  const body = await readJsonBody(req);
  const plan = String(body.plan || '').toLowerCase();
  const planCfg = PLAN_CONFIG[plan];
  if (!planCfg) {
    return sendJson(res, 400, { error: 'Plano invalido' });
  }

  const externalReference = makeOrderReference(plan);
  const claimToken = generateClaimToken();
  const cleanBase = PUBLIC_BASE_URL.replace(/\/+$/, '');
  const returnBase =
    `${cleanBase}/getkey.html?plan=${encodeURIComponent(plan)}` +
    `&external_reference=${encodeURIComponent(externalReference)}` +
    `&checkout_ref=${encodeURIComponent(externalReference)}` +
    `&claim=${encodeURIComponent(claimToken)}`;
  const successUrl = `${returnBase}&pay_status=approved`;
  const failureUrl = `${returnBase}&pay_status=rejected`;
  const pendingUrl = `${returnBase}&pay_status=pending`;
  const webhookUrl = `${cleanBase}/api/webhook/evopay`;

  const evopayPayload = {
    amount: Number(planCfg.price.toFixed(2)),
    currency: 'BRL',
    description: `UnfollowGram - ${planCfg.name}`,
    external_reference: externalReference,
    success_url: successUrl,
    failure_url: failureUrl,
    pending_url: pendingUrl,
    notification_url: webhookUrl,
    webhook_url: webhookUrl,
    metadata: {
      source: 'unfollowgram_v9',
      plan,
      external_reference: externalReference,
    },
  };

  const checkoutUrl = isHttpUrl(EVOPAY_CHECKOUT_URL)
    ? EVOPAY_CHECKOUT_URL
    : buildUrl(EVOPAY_API_URL, EVOPAY_CHECKOUT_PATH);
  const evopayRes = await fetch(checkoutUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': EVOPAY_API_KEY,
    },
    body: JSON.stringify(evopayPayload),
  });

  const evopayData = await parseJsonOrText(evopayRes);
  if (!evopayRes.ok) {
    return sendJson(res, 502, {
      error: 'Falha ao criar checkout na EvoPay',
      details: sanitizeForClient(evopayData),
    });
  }

  const payUrl =
    firstString(
      evopayData.checkout_url,
      evopayData.url,
      evopayData.payment_url,
      evopayData.payment_link,
      evopayData.init_point,
      evopayData.data && evopayData.data.checkout_url,
      evopayData.data && evopayData.data.url
    ) || '';

  if (!isHttpUrl(payUrl)) {
    return sendJson(res, 502, {
      error: 'EvoPay nao retornou checkout_url valido',
      details: sanitizeForClient(evopayData),
    });
  }

  const paymentId =
    firstString(
      evopayData.payment_id,
      evopayData.id,
      evopayData.transaction_id,
      evopayData.data && evopayData.data.payment_id,
      evopayData.data && evopayData.data.id
    ) || null;

  const now = new Date().toISOString();
  const store = await loadStore();
  store.orders[externalReference] = {
    externalReference,
    plan,
    amount: planCfg.price,
    status: 'pending',
    claimToken,
    paymentId,
    checkoutUrl: payUrl,
    createdAt: now,
    updatedAt: now,
    code: null,
  };
  await saveStore(store);

  return sendJson(res, 200, {
    checkout_url: payUrl,
    external_reference: externalReference,
    claim_url:
      `${cleanBase}/getkey.html?checkout_ref=${encodeURIComponent(externalReference)}` +
      `&claim=${encodeURIComponent(claimToken)}`,
  });
}

async function handleConfirm(req, res) {
  const body = await readJsonBody(req);
  const externalReference = firstString(body.external_reference, body.reference) || '';
  const paymentId = firstString(body.payment_id, body.id) || '';
  const incomingStatus = String(body.status || '').toLowerCase();

  if (!externalReference) {
    return sendJson(res, 400, { error: 'external_reference obrigatoria' });
  }

  const store = await loadStore();
  const order = store.orders[externalReference];
  if (!order) {
    return sendJson(res, 404, { error: 'Pedido nao encontrado' });
  }

  let finalStatus = order.status;
  let providerPayload = null;

  // Sempre que possivel valida status no backend com a EvoPay.
  if (paymentId && EVOPAY_API_KEY && (EVOPAY_PAYMENT_PATH || EVOPAY_PAYMENT_URL_TEMPLATE)) {
    const paymentUrl = isHttpUrl(EVOPAY_PAYMENT_URL_TEMPLATE)
      ? EVOPAY_PAYMENT_URL_TEMPLATE.replace('{payment_id}', encodeURIComponent(paymentId))
      : buildUrl(
          EVOPAY_API_URL,
          EVOPAY_PAYMENT_PATH.replace('{payment_id}', encodeURIComponent(paymentId))
        );
    try {
      const r = await fetch(paymentUrl, {
        method: 'GET',
        headers: { 'API-Key': EVOPAY_API_KEY },
      });
      providerPayload = await parseJsonOrText(r);
      if (r.ok) {
        const providerStatus = extractStatus(providerPayload);
        if (providerStatus) finalStatus = providerStatus;
      }
    } catch (error) {
      console.error('Falha ao validar pagamento na EvoPay:', error);
    }
  }

  // Nunca aprova apenas por status vindo do frontend.
  const hinted = normalizeStatus(incomingStatus);
  const normalized =
    normalizeStatus(finalStatus) === 'pending' && hinted === 'rejected'
      ? 'rejected'
      : normalizeStatus(finalStatus);
  order.status = normalized;
  order.updatedAt = new Date().toISOString();
  if (paymentId && !order.paymentId) order.paymentId = paymentId;

  ensureCodeForApprovedOrder(store, order);

  await saveStore(store);

  return sendJson(res, 200, {
    status: normalized,
    external_reference: externalReference,
    payment_id: order.paymentId || null,
    code: order.code || null,
    provider: providerPayload ? sanitizeForClient(providerPayload) : null,
  });
}

async function handleClaim(req, res, urlObj) {
  const externalReference =
    firstString(
      urlObj.searchParams.get('checkout_ref'),
      urlObj.searchParams.get('external_reference'),
      urlObj.searchParams.get('ref')
    ) || '';
  const claimToken =
    firstString(urlObj.searchParams.get('claim'), urlObj.searchParams.get('token')) || '';
  const paymentId =
    firstString(
      urlObj.searchParams.get('payment_id'),
      urlObj.searchParams.get('collection_id'),
      urlObj.searchParams.get('id')
    ) || '';
  const incomingStatus = String(
    urlObj.searchParams.get('pay_status') ||
      urlObj.searchParams.get('status') ||
      urlObj.searchParams.get('collection_status') ||
      ''
  ).toLowerCase();

  if (!externalReference || !claimToken) {
    return sendJson(res, 400, { error: 'checkout_ref e claim sao obrigatorios' });
  }

  const store = await loadStore();
  const order = store.orders[externalReference];
  if (!order) {
    return sendJson(res, 404, { error: 'Pedido nao encontrado' });
  }
  if (!order.claimToken || order.claimToken !== claimToken) {
    return sendJson(res, 401, { error: 'Link de resgate invalido' });
  }

  if (paymentId && !order.paymentId) order.paymentId = paymentId;

  let finalStatus = order.status;
  let providerPayload = null;
  if (order.paymentId && EVOPAY_API_KEY && (EVOPAY_PAYMENT_PATH || EVOPAY_PAYMENT_URL_TEMPLATE)) {
    const paymentUrl = isHttpUrl(EVOPAY_PAYMENT_URL_TEMPLATE)
      ? EVOPAY_PAYMENT_URL_TEMPLATE.replace('{payment_id}', encodeURIComponent(order.paymentId))
      : buildUrl(
          EVOPAY_API_URL,
          EVOPAY_PAYMENT_PATH.replace('{payment_id}', encodeURIComponent(order.paymentId))
        );
    try {
      const r = await fetch(paymentUrl, {
        method: 'GET',
        headers: { 'API-Key': EVOPAY_API_KEY },
      });
      providerPayload = await parseJsonOrText(r);
      if (r.ok) {
        const providerStatus = extractStatus(providerPayload);
        if (providerStatus) finalStatus = providerStatus;
      }
    } catch (error) {
      console.error('Falha ao validar pagamento na EvoPay (claim):', error);
    }
  }

  const hinted = normalizeStatus(incomingStatus);
  const normalized =
    normalizeStatus(finalStatus) === 'pending' && hinted === 'rejected'
      ? 'rejected'
      : normalizeStatus(finalStatus);

  order.status = normalized;
  order.updatedAt = new Date().toISOString();
  ensureCodeForApprovedOrder(store, order);
  await saveStore(store);

  return sendJson(res, 200, {
    status: order.status,
    external_reference: order.externalReference,
    payment_id: order.paymentId || null,
    code: order.code || null,
    message:
      order.status === 'approved'
        ? 'Pagamento aprovado e codigo liberado'
        : order.status === 'pending'
          ? 'Pagamento em analise. Abra o mesmo link novamente em instantes.'
          : 'Pagamento nao aprovado',
    provider: providerPayload ? sanitizeForClient(providerPayload) : null,
  });
}

async function handleDirectGetKey(req, res, urlObj) {
  const plan = String(urlObj.searchParams.get('plan') || '').toLowerCase();
  const planCfg = PLAN_CONFIG[plan];
  if (!planCfg) {
    return sendJson(res, 400, { error: 'Plano invalido. Use starter, pro ou vip.' });
  }

  const store = await loadStore();
  const code = generateAccessCode(store);
  const ref = `DIRECT-${plan.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  store.codes.push({
    code,
    plan,
    status: 'active',
    createdAt: new Date().toISOString(),
    externalReference: ref,
    paymentId: null,
    usesAllowed: planCfg.uses,
  });
  await saveStore(store);

  return sendJson(res, 200, {
    ok: true,
    source: 'direct_link',
    plan,
    code,
    external_reference: ref,
  });
}

async function handleWebhook(req, res) {
  if (EVOPAY_WEBHOOK_SECRET) {
    const incomingSecret = req.headers['x-webhook-secret'] || req.headers['x-evopay-signature'];
    if (!incomingSecret || String(incomingSecret) !== EVOPAY_WEBHOOK_SECRET) {
      return sendJson(res, 401, { error: 'Webhook nao autorizado' });
    }
  }

  const body = await readJsonBody(req);
  const externalReference = extractExternalReference(body);
  const paymentId = extractPaymentId(body);
  const status = normalizeStatus(extractStatus(body));

  if (!externalReference) {
    return sendJson(res, 400, { error: 'Webhook sem external_reference' });
  }

  const store = await loadStore();
  const order = store.orders[externalReference];
  if (!order) {
    return sendJson(res, 404, { error: 'Pedido nao encontrado para webhook' });
  }

  order.updatedAt = new Date().toISOString();
  if (paymentId) order.paymentId = paymentId;
  if (status) order.status = status;

  ensureCodeForApprovedOrder(store, order);

  await saveStore(store);

  return sendJson(res, 200, {
    ok: true,
    external_reference: externalReference,
    status: order.status,
    code: order.code || null,
  });
}

async function serveStaticHtml(res, filePath) {
  try {
    const html = await fsp.readFile(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  } catch (error) {
    sendJson(res, 500, { error: 'Nao foi possivel carregar a pagina HTML' });
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, API-Key, x-webhook-secret, x-evopay-signature',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

async function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    return { orders: {}, codes: [] };
  }
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const cleanRaw = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(cleanRaw);
    return {
      orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
    };
  } catch {
    return { orders: {}, codes: [] };
  }
}

async function saveStore(store) {
  const payload = JSON.stringify(store, null, 2);
  await fsp.writeFile(STORE_FILE, payload, 'utf8');
}

function makeOrderReference(plan) {
  const now = Date.now().toString(36).toUpperCase();
  const id = randomUUID().slice(0, 8).toUpperCase();
  return `UFG-${plan.toUpperCase()}-${now}-${id}`;
}

function generateClaimToken() {
  return randomBytes(24).toString('hex');
}

function generateAccessCode(store) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const make = () => {
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return `${out.slice(0, 4)}-${out.slice(4)}`;
  };

  const used = new Set(store.codes.map((c) => c.code));
  let candidate = make();
  while (used.has(candidate)) {
    candidate = make();
  }
  return candidate;
}

function ensureCodeForApprovedOrder(store, order) {
  if (!order || order.status !== 'approved' || order.code) return;
  const generated = generateAccessCode(store);
  order.code = generated;
  store.codes.push({
    code: generated,
    plan: order.plan,
    status: 'active',
    createdAt: new Date().toISOString(),
    externalReference: order.externalReference,
    paymentId: order.paymentId || null,
    usesAllowed: PLAN_CONFIG[order.plan] ? PLAN_CONFIG[order.plan].uses : 1,
  });
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return 'pending';
  if (APPROVED_STATUSES.has(s)) return 'approved';
  if (PENDING_STATUSES.has(s)) return 'pending';
  return 'rejected';
}

function extractStatus(payload) {
  return (
    firstString(
      payload && payload.status,
      payload && payload.payment_status,
      payload && payload.transaction_status,
      payload && payload.data && payload.data.status,
      payload && payload.data && payload.data.payment_status,
      payload && payload.result && payload.result.status
    ) || ''
  );
}

function extractExternalReference(payload) {
  return (
    firstString(
      payload && payload.external_reference,
      payload && payload.reference,
      payload && payload.order_reference,
      payload && payload.metadata && payload.metadata.external_reference,
      payload && payload.metadata && payload.metadata.reference,
      payload && payload.data && payload.data.external_reference,
      payload && payload.data && payload.data.reference
    ) || ''
  );
}

function extractPaymentId(payload) {
  return (
    firstString(
      payload && payload.payment_id,
      payload && payload.id,
      payload && payload.transaction_id,
      payload && payload.data && payload.data.payment_id,
      payload && payload.data && payload.data.id
    ) || ''
  );
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildUrl(base, pathname) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const pathClean = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return new URL(pathClean, baseWithSlash).toString();
}

async function parseJsonOrText(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function sanitizeForClient(data) {
  if (!data || typeof data !== 'object') return data;
  const text = JSON.stringify(data);
  if (text.length > 1500) return { message: 'Resposta do gateway recebida (detalhes omitidos)' };
  return data;
}

function loadEnvFromFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
