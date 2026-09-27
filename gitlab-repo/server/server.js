'use strict';
// URL Tester local server: serves the app and runs real scans at /api/scan
const http = require('http'), fs = require('fs'), path = require('path');
const { runCore } = require('./checks');
const { runPsi } = require('./lighthouse');
const { runBrowser, hasBrowser, hasAxe } = require('./browser');
const PORT = +process.env.PORT || 8080;
const APP = path.join(__dirname, '..', 'url-tester.html');

const NA = {
  'performance:m1': 'Needs real-user data (Chrome UX Report via PageSpeed key)',
  'performance:m6': 'Needs Lighthouse (PageSpeed)', 'performance:3': 'Needs Lighthouse (PageSpeed)', 'performance:4': 'Needs Lighthouse (PageSpeed)', 'performance:6': 'Needs Lighthouse (PageSpeed)',
  'accessibility:1': 'Needs axe or Lighthouse (install Playwright)', 'accessibility:16': 'Manual review: submit forms with errors', 'accessibility:17': 'Manual review across several pages',
  'mobile:5': 'Needs a site-specific test script', 'browsers:5': 'Manual review', 'browsers:6': 'Needs Lighthouse (PageSpeed)',
  'bestpractices:4': 'Needs Lighthouse (PageSpeed)', 'bestpractices:6': 'Needs Lighthouse (PageSpeed)', 'analytics:3': 'No ecommerce events on this page (scan a product page)',
  'storefront:2': 'Needs a site-specific test script', 'storefront:3': 'Scan a product page URL with a test script', 'storefront:4': 'Needs a test account login',
  'storefront:5': 'Needs a test account login', 'storefront:6': 'Needs a site-specific test script', 'storefront:7': 'Needs a site-specific test script',
  'storefront:9': 'Needs a test account and cart', 'storefront:11': 'Needs a test account login', 'storefront:12': 'Needs a test account login', 'storefront:13': 'Scan a product page URL with a test script'
};

async function scan(url, q) {
  const device = q.get('device') || 'desktop';
  const key = q.get('psiKey') || process.env.PSI_KEY || '';
  const t0 = Date.now(); const notes = [];
  const [core, br, psi] = await Promise.all([
    runCore(url).catch(e => ({ fatal: e.message })),
    q.get('browser') === '0' ? null : runBrowser(url, { device, term: q.get('term') || '' }).catch(e => ({ error: e.message })),
    q.get('lighthouse') === '0' ? null : runPsi(url, device === 'mobile' ? 'mobile' : 'desktop', key).catch(e => ({ error: e.message }))
  ]);
  if (core.fatal) throw new Error(core.fatal);
  const R = { ...core.R };
  if (br && br.R) Object.assign(R, br.R); else if (br && br.error) notes.push('Browser engine: ' + br.error);
  if (!hasBrowser()) notes.push('Browser engine not installed (npm run setup)');
  if (psi && psi.R) {
    for (const [k, v] of Object.entries(psi.R)) {
      const cat = k.split(':')[0];
      const override = cat === 'performance' || (cat === 'accessibility' && !(br && br.axe)) || k === 'bestpractices:4' || k === 'bestpractices:6' || k === 'browsers:6';
      if (override || !R[k] || R[k].s === 'na') R[k] = v;
    }
  } else if (psi && psi.error) notes.push('Lighthouse: ' + psi.error.slice(0, 140));
  if (br && br.trackers) {
    const policy = R['privacy:2'] && R['privacy:2'].s === 'pass'; const n = br.trackers.length;
    R['privacy:4'] = !n ? { s: 'pass', v: 'No third-party trackers detected', src: 'BROWSER' } : { s: policy ? 'pass' : 'fail', v: n + ' tracker(s): ' + br.trackers.slice(0, 5).join(', ') + (policy ? ' · privacy policy linked' : ' · no privacy policy link'), src: 'BROWSER' };
  }
  for (const [k, v] of Object.entries(NA)) if (!R[k]) R[k] = { s: 'na', v };
  return {
    url, finalUrl: core.finalUrl, tests: R,
    weight: (psi && psi.weight) || core.weight, broken: core.broken,
    shots: br && br.shots, matrix: br && br.matrix, matrixHead: br && br.matrixHead,
    engines: { http: true, browser: !!(br && br.R), axe: !!(br && br.axe), lighthouse: !!(psi && psi.R) },
    notes, ms: Date.now() - t0
  };
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, browser: hasBrowser(), axe: hasAxe(), psiKey: !!process.env.PSI_KEY });
  if (u.pathname === '/api/scan') {
    let target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    try { new URL(target); } catch (e) { return send(res, 400, { error: 'Invalid URL' }); }
    console.log(new Date().toISOString(), 'scan', target);
    try { const out = await scan(target, u.searchParams); console.log('  done in', out.ms, 'ms'); return send(res, 200, out); }
    catch (e) { console.log('  failed:', e.message); return send(res, 502, { error: e.message }); }
  }
  if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/url-tester.html') {
    if (!fs.existsSync(APP)) return send(res, 404, 'url-tester.html not found next to the server folder', 'text/plain');
    return send(res, 200, fs.readFileSync(APP), 'text/html; charset=utf-8');
  }
  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => {
  console.log('\n  URL Tester running at http://localhost:' + PORT);
  console.log('  Browser engine:', hasBrowser() ? 'on' : 'off (run: npm run setup)', '| axe-core:', hasAxe() ? 'on' : 'off', '| PageSpeed key:', process.env.PSI_KEY ? 'set' : 'not set (optional)\n');
});
