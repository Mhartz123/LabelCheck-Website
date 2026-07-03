/**
 * LabelCheck Report Server
 * ─────────────────────────
 * Lightweight Node.js server that:
 *  1. Receives POST /api/report from the Flutter app
 *  2. Serves GET  /api/reports for the dashboard to poll
 *  3. Serves the dashboard HTML at GET /
 *
 * Setup:
 *   npx kill-port 8080
 *   node labelcheck_server.js
 *
 * Or with a custom port:
 *   PORT=8080 node labelcheck_server.js
 *
 * Requirements: Node.js 18+ (no extra packages needed — uses built-ins only)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT         = process.env.PORT || 8080;
const DASHBOARD_FILE = path.join(__dirname, 'labelcheck_dashboard.html');
const DATA_FILE    = path.join(__dirname, 'reports.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadReports() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveReports(reports) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(reports, null, 2));
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',            // allow Flutter app from any origin
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── GET / — serve dashboard HTML ──────────────────────────────────────────
  if (method === 'GET' && url === '/') {
    try {
      const html = fs.readFileSync(DASHBOARD_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(404); return res.end('Dashboard HTML not found');
    }
  }

  // ── GET /api/reports — return stored reports ──────────────────────────────
  if (method === 'GET' && url === '/api/reports') {
    const reports = loadReports();
    return json(res, 200, { ok: true, reports });
  }

  // ── POST /api/report — receive a new report from the Flutter app ──────────
  if (method === 'POST' && url === '/api/report') {
    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { ok: false, reason: 'invalid JSON' }); }

    const allowed = ['NON-COMPLIANT', 'WARNING / BANNED'];
    if (!allowed.includes(body.status)) {
      return json(res, 200, { ok: false, reason: 'status not flagged — not stored' });
    }

    const reports = loadReports();
    const existIdx = reports.findIndex(r => r.id === body.id);
    if (existIdx >= 0) reports[existIdx] = body;
    else reports.unshift(body); // newest first

    saveReports(reports);
    console.log(`[+] Report received: ${body.productName} — ${body.status}`);
    return json(res, 200, { ok: true, id: body.id });
  }

  // ── POST /api/reports/delete — delete reports by id array ──────────────────
  if (method === 'POST' && url === '/api/reports/delete') {
    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { ok: false, reason: 'invalid JSON' }); }

    const ids = new Set(body.ids || []);
    const reports = loadReports().filter(r => !ids.has(r.id));
    saveReports(reports);
    console.log(`[-] Deleted ${ids.size} report(s)`);
    return json(res, 200, { ok: true, deleted: ids.size });
  }

  // 404 fallback
  json(res, 404, { ok: false, reason: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅  LabelCheck server running at http://0.0.0.0:${PORT}`);
  console.log(`    Dashboard : http://localhost:${PORT}/`);
  console.log(`    Reports   : http://localhost:${PORT}/api/reports`);
  console.log(`    Submit    : POST http://localhost:${PORT}/api/report`);
  console.log('');
  console.log('    Point your Flutter app\'s ReportService._endpoint to:');
  console.log(`    http://<YOUR_LAN_IP>:${PORT}/api/report`);
});