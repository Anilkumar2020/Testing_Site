'use strict';
// Core engine: real HTTP, TLS, DNS, HTML and link checks. Node 18+, no dependencies.
const tls = require('tls'), http2 = require('http2'), dnsP = require('dns').promises;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 URLTester/1.0';
const now = () => performance.now();

async function req(url, o = {}) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), o.timeout || 15000);
  try {
    return await fetch(url, { method: o.method || 'GET', redirect: o.redirect || 'follow', signal: ctl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(o.headers || {}) } });
  } finally { clearTimeout(to); }
}
async function discard(r) { try { await r.body?.cancel(); } catch (e) {} }
async function readText(res, max = 3e6, ms = 20000) {
  const work = (async () => {
    const rd = res.body && res.body.getReader(); if (!rd) return { text: '', size: 0 };
    const chunks = []; let size = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value)); size += value.length; if (size > max) { rd.cancel().catch(() => {}); break; } }
    return { text: Buffer.concat(chunks).toString('utf8'), size };
  })();
  return Promise.race([work, new Promise(r => setTimeout(() => r({ text: '', size: 0, timeout: true }), ms))]);
}
async function follow(url, max = 8) {
  const chain = []; let cur = url;
  for (let i = 0; i < max; i++) {
    const t0 = now();
    const r = await req(cur, { redirect: 'manual', headers: { 'accept-encoding': 'br, gzip, deflate' } });
    const ttfb = now() - t0; chain.push({ url: cur, status: r.status, ttfb });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { await discard(r); cur = new URL(loc, cur).href; continue; }
    return { res: r, chain, finalUrl: cur, ttfb };
  }
  throw new Error('Too many redirects');
}
async function status(url, timeout = 10000) {
  try {
    let r = await req(url, { method: 'HEAD', redirect: 'manual', timeout });
    if ([403, 405, 501].includes(r.status)) { await discard(r); r = await req(url, { redirect: 'manual', timeout }); }
    await discard(r);
    return { status: r.status, location: r.headers.get('location'), headers: r.headers };
  } catch (e) { return { status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message }; }
}
async function statusFollow(url, max = 5) {
  let cur = url;
  for (let hops = 0; hops <= max; hops++) {
    const s = await status(cur);
    if (s.status >= 300 && s.status < 400 && s.location) { cur = new URL(s.location, cur).href; continue; }
    return { ...s, hops, final: cur };
  }
  return { status: 0, hops: max, error: 'redirect loop' };
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
function tlsInfo(host) {
  return new Promise(res => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
      const c = s.getPeerCertificate();
      res({ ok: true, authorized: s.authorized, err: s.authorizationError, protocol: s.getProtocol(), validTo: c && c.valid_to, issuer: c && c.issuer && (c.issuer.O || c.issuer.CN) });
      s.end();
    });
    s.on('error', e => res({ ok: false, err: e.message }));
    s.on('timeout', () => { s.destroy(); res({ ok: false, err: 'timeout' }); });
  });
}
function tlsLegacy(host) {
  return new Promise(res => {
    let s;
    try {
      s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0', timeout: 8000 }, () => { res(s.getProtocol()); s.end(); });
    } catch (e) { return res(null); }
    s.on('error', () => res(null));
    s.on('timeout', () => { s.destroy(); res(null); });
  });
}
function h2check(origin) {
  return new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; res(v); } };
    try {
      const c = http2.connect(origin, { rejectUnauthorized: false });
      c.setTimeout(7000, () => { c.destroy(); fin(false); });
      c.on('connect', () => { fin(true); c.close(); });
      c.on('error', () => fin(false));
    } catch (e) { fin(false); }
  });
}

const attrs = tag => { const o = {}; tag.replace(/([a-zA-Z_:@][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (m, k, _, a, b, c) => { o[k.toLowerCase()] = a != null ? a : b != null ? b : c || ''; }); return o; };
const tags = (h, name) => [...h.matchAll(new RegExp('<' + name + '\\b[^>]*>', 'gi'))].map(m => ({ raw: m[0], a: attrs(m[0].replace(/^<\S+/, '')), index: m.index }));
const pairs = (h, name) => [...h.matchAll(new RegExp('<' + name + '\\b([^>]*)>([\\s\\S]*?)</' + name + '\\s*>', 'gi'))].map(m => ({ a: attrs(m[1]), inner: m[2], index: m.index }));
const plain = s => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const abs = (u, base) => { try { return new URL(u, base).href; } catch (e) { return null; } };
const vcmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const SLD = ['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.in', 'com.br', 'co.jp', 'co.nz', 'com.mx', 'co.za', 'com.sg', 'com.cn'];
function baseDomain(host) { const p = host.split('.'); const last2 = p.slice(-2).join('.'); return SLD.includes(last2) ? p.slice(-3).join('.') : last2; }
const ARIA = new Set('activedescendant atomic autocomplete busy checked colcount colindex colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowspan selected setsize sort valuemax valuemin valuenow valuetext braillelabel brailleroledescription'.split(' '));

async function runCore(input) {
  const R = {}, notes = [];
  const set = (k, s, v = '', src = 'HTTP', n) => { R[k] = { s, v: String(v).slice(0, 180), src }; if (n != null) R[k].n = n; };
  const u = new URL(input); const host = u.hostname; const isHttps = u.protocol === 'https:';

  // DNS
  const resolver = new dnsP.Resolver({ timeout: 5000, tries: 2 });
  const t0 = now(); let a4 = null;
  try { a4 = await resolver.resolve4(host); } catch (e) { try { a4 = await dnsP.lookup(host, { all: true }); } catch (e2) { a4 = null; } }
  const dnsMs = Math.round(now() - t0);
  if (!a4 || !a4.length) {
    set('infra:7', 'fail', 'DNS lookup failed for ' + host);
    set('seo:16', 'fail', 'Host not resolvable');
    throw new Error('Host ' + host + ' could not be resolved');
  }
  set('infra:0', dnsMs < 100 ? 'pass' : dnsMs < 300 ? 'warn' : 'fail', dnsMs + ' ms', 'DNS');
  const base = baseDomain(host);
  const [a6, txt, dmarc] = await Promise.all([
    resolver.resolve6(host).catch(() => []), resolver.resolveTxt(base).catch(() => []), resolver.resolveTxt('_dmarc.' + base).catch(() => [])
  ]);
  set('infra:2', a6.length ? 'pass' : 'fail', a6.length ? 'AAAA ' + a6[0] : 'No AAAA record', 'DNS');
  const spf = txt.map(t => t.join('')).find(t => /^v=spf1/i.test(t));
  set('security:20', spf ? 'pass' : 'fail', spf ? spf.slice(0, 120) : 'No SPF record on ' + base, 'DNS');
  const dm = dmarc.map(t => t.join('')).find(t => /^v=DMARC1/i.test(t));
  const pol = dm && (dm.match(/;\s*p=(\w+)/i) || [])[1];
  set('security:21', !dm ? 'fail' : pol === 'none' ? 'warn' : 'pass', dm ? 'Policy p=' + (pol || '?') : 'No DMARC record on _dmarc.' + base, 'DNS');

  // Main document
  let main;
  try { main = await follow(input); } catch (e) {
    set('infra:7', 'fail', 'No response: ' + e.message); set('seo:16', 'fail', 'No response');
    throw new Error('The site did not respond: ' + e.message);
  }
  const { res, chain, finalUrl } = main; const H = res.headers; const fu = new URL(finalUrl);
  const ttfb = Math.round(main.ttfb);
  set('infra:7', 'pass', 'HTTP ' + res.status + ' in ' + ttfb + ' ms');
  set('seo:16', res.status === 200 ? 'pass' : 'fail', 'HTTP ' + res.status + (chain.length > 1 ? ' after ' + (chain.length - 1) + ' redirect(s)' : ''));
  set('infra:4', ttfb < 600 ? 'pass' : ttfb < 1200 ? 'warn' : 'fail', ttfb + ' ms');
  set('performance:m4', ttfb <= 800 ? 'pass' : ttfb <= 1800 ? 'warn' : 'fail', ttfb + ' ms', 'HTTP', ttfb);
  const body = await readText(res); const html = body.text || '';
  const htmlBytes = +(H.get('content-length') || 0) || body.size;
  const enc = (H.get('content-encoding') || '').toLowerCase();
  set('performance:0', /br|gzip|deflate|zstd/.test(enc) ? 'pass' : htmlBytes < 1400 ? 'pass' : 'fail', enc ? 'HTML served with ' + enc : 'HTML not compressed');
  set('infra:5', /close/i.test(H.get('connection') || '') ? 'fail' : 'pass', H.get('connection') ? 'Connection: ' + H.get('connection') : 'Persistent connections allowed');

  // Security headers
  const hsts = H.get('strict-transport-security');
  const maxAge = hsts ? +((hsts.match(/max-age=(\d+)/i) || [])[1] || 0) : 0;
  set('security:4', !hsts ? 'fail' : maxAge >= 15552000 ? 'pass' : 'warn', hsts || 'Header not set');
  const csp = H.get('content-security-policy'), cspRO = H.get('content-security-policy-report-only');
  set('security:5', csp ? (/script-src[^;]*'unsafe-inline'/.test(csp) && !/nonce-|sha256-/.test(csp) ? 'warn' : 'pass') : cspRO ? 'warn' : 'fail', csp ? csp.slice(0, 120) : cspRO ? 'Report-only policy' : 'Header not set');
  const xfo = H.get('x-frame-options'); const fa = csp && /frame-ancestors/i.test(csp);
  set('security:6', xfo || fa ? 'pass' : 'fail', xfo ? 'X-Frame-Options: ' + xfo : fa ? 'CSP frame-ancestors set' : 'Not protected');
  const xcto = H.get('x-content-type-options');
  set('security:7', /nosniff/i.test(xcto || '') ? 'pass' : 'fail', xcto || 'Header not set');
  const rp = H.get('referrer-policy');
  set('security:8', !rp ? 'fail' : /unsafe-url/i.test(rp) ? 'warn' : 'pass', rp || 'Header not set');
  const pp = H.get('permissions-policy') || H.get('feature-policy');
  set('security:9', pp ? 'pass' : 'fail', pp ? pp.slice(0, 120) : 'Header not set');
  const coop = H.get('cross-origin-opener-policy');
  set('security:10', coop ? 'pass' : 'fail', coop || 'Header not set');
  const leak = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version'].map(h => H.get(h) ? h + ': ' + H.get(h) : null).filter(Boolean);
  const verLeak = leak.filter(l => /\d/.test(l));
  set('security:16', verLeak.length ? 'fail' : 'pass', verLeak.length ? verLeak.join('; ') : leak.length ? leak.join('; ') + ' (no version)' : 'No server banner');
  const cookies = typeof H.getSetCookie === 'function' ? H.getSetCookie() : [];
  if (!cookies.length) { ['security:12', 'security:13', 'security:14'].forEach(k => set(k, 'pass', 'No cookies set on first response')); }
  else {
    const nm = c => c.split('=')[0].trim();
    const noSec = cookies.filter(c => !/;\s*secure/i.test(c)).map(nm);
    const sess = cookies.filter(c => /sess|sid|auth|token|jsession|phpsessid|asp\.net|laravel|connect\.sid/i.test(nm(c)));
    const noHttp = sess.filter(c => !/;\s*httponly/i.test(c)).map(nm);
    const noSS = cookies.filter(c => !/;\s*samesite=/i.test(c)).map(nm);
    set('security:12', noSec.length ? 'fail' : 'pass', noSec.length ? 'Missing Secure: ' + noSec.join(', ') : cookies.length + ' cookie(s), all Secure');
    set('security:13', noHttp.length ? 'fail' : 'pass', noHttp.length ? 'Missing HttpOnly: ' + noHttp.join(', ') : sess.length ? 'Session cookies are HttpOnly' : 'No session cookies detected');
    set('security:14', noSS.length ? 'warn' : 'pass', noSS.length ? 'Missing SameSite: ' + noSS.join(', ') : 'All cookies set SameSite');
  }
  // CDN
  const cdn = H.get('cf-ray') ? 'Cloudflare' : H.get('x-amz-cf-id') ? 'Amazon CloudFront' : /akamai/i.test((H.get('server') || '') + (H.get('x-akamai-transformed') || '')) || H.get('x-akamai-request-id') ? 'Akamai' : H.get('x-served-by') && /cache/i.test(H.get('x-served-by')) ? 'Fastly' : H.get('x-vercel-id') ? 'Vercel' : H.get('x-azure-ref') ? 'Azure Front Door' : H.get('x-nf-request-id') ? 'Netlify' : /cloudflare|gws|kinsta|sucuri|imperva|incapsula/i.test(H.get('server') || '') ? H.get('server') : H.get('x-cache') || H.get('via') ? 'Cache layer (' + (H.get('x-cache') || H.get('via')).slice(0, 40) + ')' : null;
  set('infra:3', cdn ? 'pass' : 'warn', cdn || 'No CDN headers detected');

  // Parallel network probes
  const origin = fu.origin; const probeRand = '/url-tester-404-' + Math.random().toString(36).slice(2, 10);
  const altHost = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
  const [tlsI, legacy, h2, httpR, cors, robots, sectxt, nf, alt, favicon] = await Promise.all([
    isHttps ? tlsInfo(fu.hostname) : null, isHttps ? tlsLegacy(fu.hostname) : null, h2check(origin),
    status('http://' + fu.host + fu.pathname), req(finalUrl, { headers: { origin: 'https://url-tester-probe.example' }, timeout: 10000 }).then(async r => { await discard(r); return r.headers; }).catch(() => null),
    req(origin + '/robots.txt', { timeout: 10000 }).then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', text: (await readText(r, 5e5)).text })).catch(() => null),
    req(origin + '/.well-known/security.txt', { timeout: 8000 }).then(async r => ({ status: r.status, text: (await readText(r, 1e5)).text })).catch(() => null),
    status(origin + probeRand), statusFollow(fu.protocol + '//' + altHost + '/', 3).catch(() => null), null
  ]);
  if (isHttps) {
    if (tlsI && tlsI.ok) {
      set('security:0', tlsI.authorized ? 'pass' : 'fail', tlsI.authorized ? 'Trusted chain · issuer ' + (tlsI.issuer || '?') + ' · ' + tlsI.protocol : 'Untrusted: ' + tlsI.err, 'TLS');
      const days = tlsI.validTo ? Math.floor((new Date(tlsI.validTo) - Date.now()) / 864e5) : null;
      if (days != null) set('security:1', days > 30 ? 'pass' : days > 14 ? 'warn' : 'fail', days + ' days left (expires ' + new Date(tlsI.validTo).toISOString().slice(0, 10) + ')', 'TLS');
    } else set('security:0', 'fail', 'TLS handshake failed: ' + (tlsI && tlsI.err), 'TLS');
    set('security:2', legacy ? 'fail' : 'pass', legacy ? 'Server accepts ' + legacy : 'TLS 1.0/1.1 rejected · negotiated ' + ((tlsI && tlsI.protocol) || '?'), 'TLS');
  } else {
    set('security:0', 'fail', 'Page is not served over HTTPS', 'TLS');
  }
  if (httpR.status >= 300 && httpR.status < 400 && /^https:/i.test(httpR.location || '')) set('security:3', 'pass', 'HTTP ' + httpR.status + ' → ' + httpR.location.slice(0, 80));
  else if (httpR.status === 0) set('security:3', 'warn', 'Port 80 not reachable (' + (httpR.error || 'no response') + ')');
  else set('security:3', 'fail', 'HTTP returned ' + httpR.status + ' without redirect to HTTPS');
  const altSvc = H.get('alt-svc') || '';
  set('infra:1', h2 ? 'pass' : 'fail', h2 ? 'HTTP/2 supported' + (/h3/.test(altSvc) ? ' · HTTP/3 advertised' : '') : 'HTTP/1.1 only');
  if (cors) {
    const acao = cors.get('access-control-allow-origin'), acac = /true/i.test(cors.get('access-control-allow-credentials') || '');
    if (!acao) set('security:15', 'pass', 'No CORS headers for foreign origins');
    else if ((acao === '*' || acao === 'https://url-tester-probe.example') && acac) set('security:15', 'fail', 'Allows ' + acao + ' with credentials');
    else if (acao === 'https://url-tester-probe.example') set('security:15', 'warn', 'Reflects any Origin (no credentials)');
    else set('security:15', 'pass', 'Access-Control-Allow-Origin: ' + acao);
  }
  let sitemapUrl = null;
  if (robots && robots.status === 200 && /user-agent/i.test(robots.text) && !/<html/i.test(robots.text.slice(0, 500))) {
    const blocksAll = /user-agent:\s*\*[^]*?disallow:\s*\/\s*(\n|$)/i.test(robots.text);
    set('seo:3', blocksAll ? 'fail' : 'pass', blocksAll ? 'robots.txt disallows all crawlers' : 'robots.txt found');
    sitemapUrl = (robots.text.match(/^\s*sitemap:\s*(\S+)/im) || [])[1] || null;
  } else set('seo:3', 'fail', robots ? 'robots.txt returned ' + robots.status : 'robots.txt not reachable');
  const smUrl = sitemapUrl || origin + '/sitemap.xml';
  const sm = await req(smUrl, { timeout: 12000 }).then(async r => ({ status: r.status, text: (await readText(r, 2e6)).text })).catch(() => null);
  if (sm && sm.status === 200 && /<(urlset|sitemapindex)/i.test(sm.text)) set('seo:4', 'pass', (sitemapUrl ? 'Listed in robots.txt · ' : 'Found at /sitemap.xml · ') + (sm.text.match(/<loc>/gi) || []).length + ' entries');
  else set('seo:4', sitemapUrl ? 'fail' : 'warn', sitemapUrl ? 'Sitemap in robots.txt returns ' + (sm ? sm.status : 'no response') : 'No sitemap in robots.txt or at /sitemap.xml');
  set('security:19', sectxt && sectxt.status === 200 && /contact:/i.test(sectxt.text) ? 'pass' : 'fail', sectxt && sectxt.status === 200 && /contact:/i.test(sectxt.text) ? 'Found with Contact field' : 'Not found');
  set('seo:13', nf.status === 404 || nf.status === 410 ? 'pass' : nf.status === 200 ? 'fail' : 'warn', 'Random missing URL returned ' + (nf.status || nf.error));
  if (!alt || alt.status === 0) set('infra:6', 'pass', altHost + ' not configured');
  else if (alt.hops > 0 && new URL(alt.final).hostname === fu.hostname) set('infra:6', 'pass', altHost + ' redirects to ' + fu.hostname);
  else set('infra:6', 'fail', altHost + ' serves content (HTTP ' + alt.status + ') without redirecting');

  // HTML checks
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0];
  set('bestpractices:1', /^\s*(<!--[\s\S]*?-->\s*)*<!doctype html/i.test(html) ? 'pass' : 'fail', /<!doctype html/i.test(html.slice(0, 2000)) ? '<!DOCTYPE html>' : 'Doctype missing', 'HTML');
  const cs = /<meta[^>]+charset/i.test(html.slice(0, 1024)) || /charset=/i.test(H.get('content-type') || '');
  set('bestpractices:2', cs ? 'pass' : 'fail', cs ? 'Charset declared' : 'No early charset', 'HTML');
  const htmlTag = tags(html, 'html')[0];
  const lang = htmlTag && htmlTag.a.lang;
  set('accessibility:7', lang ? 'pass' : 'fail', lang ? 'lang="' + lang + '"' : 'No lang attribute', 'HTML');
  const title = plain((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  set('seo:0', !title ? 'fail' : title.length > 60 || title.length < 10 ? 'warn' : 'pass', title ? '"' + title.slice(0, 80) + '" (' + title.length + ' chars)' : 'No title', 'HTML');
  set('accessibility:10', title ? 'pass' : 'fail', title ? 'Title present' : 'No title', 'HTML');
  const metas = tags(head || html, 'meta');
  const meta = n => { const m = metas.find(x => (x.a.name || x.a.property || '').toLowerCase() === n); return m ? m.a.content || '' : null; };
  const desc = meta('description');
  set('seo:1', desc == null ? 'fail' : desc.length < 50 || desc.length > 160 ? 'warn' : 'pass', desc == null ? 'No meta description' : desc.length + ' chars', 'HTML');
  const links = tags(html, 'link');
  const canon = links.find(l => /(^|\s)canonical(\s|$)/i.test(l.a.rel || ''));
  set('seo:2', canon ? 'pass' : 'fail', canon ? canon.a.href : 'No canonical tag', 'HTML');
  const vp = meta('viewport');
  set('mobile:0', vp && /width=device-width/i.test(vp) ? 'pass' : 'fail', vp || 'No viewport meta', 'HTML');
  const og = ['og:title', 'og:description', 'og:image'].filter(k => meta(k));
  set('seo:8', og.length === 3 ? 'pass' : og.length ? 'warn' : 'fail', og.length ? og.join(', ') : 'No Open Graph tags', 'HTML');
  set('seo:9', meta('twitter:card') ? 'pass' : 'fail', meta('twitter:card') ? 'twitter:card=' + meta('twitter:card') : 'Not set', 'HTML');
  const h1s = pairs(html, 'h1');
  set('seo:10', h1s.length === 1 ? 'pass' : h1s.length ? 'warn' : 'fail', h1s.length + ' H1 tag(s)', 'HTML');
  const robotsMeta = (meta('robots') || '') + ' ' + (H.get('x-robots-tag') || '');
  set('seo:11', /noindex/i.test(robotsMeta) ? 'fail' : 'pass', /noindex/i.test(robotsMeta) ? 'noindex: ' + robotsMeta.trim() : 'Indexable', 'HTML');
  const hl = links.filter(l => l.a.hreflang);
  const badHl = hl.filter(l => !/^(x-default|[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Za-z]{2})?)$/.test(l.a.hreflang));
  set('seo:12', badHl.length ? 'fail' : 'pass', hl.length ? hl.length + ' hreflang link(s)' + (badHl.length ? ', invalid: ' + badHl.map(l => l.a.hreflang).join(', ') : '') : 'Not used', 'HTML');
  const types = new Set();
  const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); const t = o['@type']; (Array.isArray(t) ? t : [t]).forEach(x => x && types.add(String(x))); Object.values(o).forEach(walk); };
  pairs(html, 'script').filter(s => /ld\+json/i.test(s.a.type || '')).forEach(s => { try { walk(JSON.parse(s.inner.trim())); } catch (e) {} });
  const T = [...types];
  set('seo:5', T.some(t => /Organization|WebSite|LocalBusiness|Store/.test(t)) ? 'pass' : T.length ? 'warn' : 'fail', T.length ? 'Types: ' + T.slice(0, 8).join(', ') : 'No JSON-LD found', 'HTML');
  set('seo:6', T.includes('Product') ? 'pass' : 'warn', T.includes('Product') ? 'Product schema found' : 'Not on this page (scan a product page URL)', 'HTML');
  set('seo:7', T.includes('BreadcrumbList') ? 'pass' : 'warn', T.includes('BreadcrumbList') ? 'BreadcrumbList found' : 'Not on this page', 'HTML');
  const params = [...fu.searchParams.keys()];
  set('seo:14', params.some(p => /jsessionid|phpsessid|sid|sessionid/i.test(p)) || /;jsessionid=/i.test(finalUrl) ? 'fail' : params.length > 3 ? 'warn' : 'pass', params.length ? params.length + ' query parameter(s)' : 'Clean URL', 'HTML');
  const anchors = pairs(html, 'a');
  const uncrawl = anchors.filter(a => a.a.href == null || /^javascript:/i.test(a.a.href || '')).length;
  set('seo:15', uncrawl > 5 ? 'warn' : 'pass', uncrawl ? uncrawl + ' link(s) without a crawlable href' : 'All links crawlable', 'HTML');
  const fav = links.find(l => /icon/i.test(l.a.rel || ''));
  let favOk = !!fav;
  if (!favOk) { const f = await status(origin + '/favicon.ico', 6000); favOk = f.status === 200; }
  set('bestpractices:3', favOk ? 'pass' : 'fail', favOk ? (fav ? fav.a.href : '/favicon.ico') : 'No favicon', 'HTML');
  const scripts = pairs(html, 'script');
  const inline = scripts.filter(s => !s.a.src).map(s => s.inner).join('\n');
  set('bestpractices:5', /document\.write\s*\(/.test(inline) ? 'fail' : 'pass', /document\.write\s*\(/.test(inline) ? 'document.write in inline script' : 'Not used inline', 'HTML');
  if (isHttps) {
    const mixed = [...html.matchAll(/<(img|script|iframe|source|video|audio|embed)\b[^>]*\ssrc=["']http:\/\/[^"']+/gi), ...html.matchAll(/<link\b[^>]*rel=["']?stylesheet[^>]*href=["']http:\/\/[^"']+/gi)].length;
    set('security:11', mixed ? 'fail' : 'pass', mixed ? mixed + ' HTTP resource(s) on HTTPS page' : 'No mixed content in HTML', 'HTML');
    const forms = tags(html, 'form').filter(f => /^http:\/\//i.test(f.a.action || ''));
    set('privacy:7', forms.length ? 'fail' : 'pass', forms.length ? forms.length + ' form(s) post to HTTP' : 'Forms post over HTTPS', 'HTML');
  }
  const extScripts = scripts.filter(s => s.a.src).map(s => ({ url: abs(s.a.src, finalUrl), a: s.a })).filter(s => s.url);
  const xo = extScripts.filter(s => new URL(s.url).hostname !== fu.hostname);
  const noSri = xo.filter(s => !s.a.integrity);
  set('security:22', !xo.length ? 'pass' : noSri.length === xo.length ? 'warn' : noSri.length ? 'warn' : 'pass', xo.length ? (xo.length - noSri.length) + ' of ' + xo.length + ' third-party scripts use integrity' : 'No third-party scripts', 'HTML');
  const imgs = tags(html, 'img');
  const noAlt = imgs.filter(i => i.a.alt == null).length;
  set('accessibility:0', noAlt === 0 ? 'pass' : noAlt <= 2 ? 'warn' : 'fail', noAlt ? noAlt + ' of ' + imgs.length + ' images missing alt' : imgs.length + ' images, all have alt', 'HTML');
  const inputs = tags(html, 'input').filter(i => !/hidden|submit|button|image|reset/i.test(i.a.type || '')).concat(tags(html, 'select'), tags(html, 'textarea'));
  const labelFor = new Set(tags(html, 'label').map(l => l.a.for).filter(Boolean));
  const unl = inputs.filter(i => !(i.a.id && labelFor.has(i.a.id)) && !i.a['aria-label'] && !i.a['aria-labelledby'] && !i.a.title);
  set('accessibility:2', unl.length === 0 ? 'pass' : unl.length <= 1 ? 'warn' : 'fail', inputs.length ? unl.length + ' of ' + inputs.length + ' fields without label' : 'No form fields', 'HTML');
  const hs = [...html.matchAll(/<h([1-6])\b/gi)].map(m => +m[1]);
  let skip = 0; for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) skip++;
  set('accessibility:4', skip ? 'warn' : 'pass', skip ? skip + ' skipped heading level(s)' : 'Headings in order', 'HTML');
  const emptyA = anchors.filter(a => a.a.href != null && !plain(a.inner) && !a.a['aria-label'] && !a.a.title && !/alt=["'][^"']+/i.test(a.inner) && !/aria-label=/i.test(a.inner)).length;
  set('accessibility:5', emptyA === 0 ? 'pass' : emptyA <= 2 ? 'warn' : 'fail', emptyA ? emptyA + ' link(s) without a name' : 'All links named', 'HTML');
  const btns = pairs(html, 'button');
  const emptyB = btns.filter(b => !plain(b.inner) && !b.a['aria-label'] && !b.a['aria-labelledby'] && !b.a.title && !/alt=["'][^"']+/i.test(b.inner)).length;
  set('accessibility:6', emptyB === 0 ? 'pass' : emptyB <= 1 ? 'warn' : 'fail', emptyB ? emptyB + ' button(s) without a name' : btns.length + ' buttons, all named', 'HTML');
  const badAria = [...new Set([...html.matchAll(/\saria-([a-z]+)\s*=/gi)].map(m => m[1].toLowerCase()).filter(a => !ARIA.has(a)))];
  set('accessibility:8', badAria.length ? 'fail' : 'pass', badAria.length ? 'Invalid: aria-' + badAria.join(', aria-') : 'All aria-* names valid', 'HTML');
  const firstA = anchors.slice(0, 5);
  const skipLink = firstA.some(a => /^#/.test(a.a.href || '') && /skip|main content|jump/i.test(plain(a.inner) + (a.a.class || '')));
  set('accessibility:12', skipLink ? 'pass' : 'fail', skipLink ? 'Skip link found' : 'No skip link among first links', 'HTML');
  const videos = pairs(html, 'video');
  const noCap = videos.filter(v => !/<track[^>]+kind=["']?(captions|subtitles)/i.test(v.inner)).length;
  set('accessibility:14', !videos.length ? 'pass' : noCap ? 'fail' : 'pass', !videos.length ? 'No video on page' : noCap ? noCap + ' video(s) without captions' : 'Captions provided', 'HTML');
  const tables = pairs(html, 'table');
  const noTh = tables.filter(t => !/<th\b/i.test(t.inner) && !/role=["']presentation/i.test(JSON.stringify(t.a))).length;
  set('accessibility:15', noTh ? 'warn' : 'pass', tables.length ? noTh + ' of ' + tables.length + ' tables without headers' : 'No tables', 'HTML');
  const srcset = /<img[^>]+srcset=|<source[^>]+srcset=/i.test(html);
  set('mobile:4', srcset || imgs.length === 0 ? 'pass' : 'warn', srcset ? 'srcset used' : imgs.length ? 'No srcset on images' : 'No images', 'HTML');
  const badType = tags(html, 'input').filter(i => (!i.a.type || i.a.type === 'text') && /e-?mail|phone|tel|mobile/i.test((i.a.name || '') + (i.a.id || '') + (i.a.placeholder || ''))).length;
  set('mobile:6', badType ? 'fail' : 'pass', badType ? badType + ' email/phone field(s) use type="text"' : 'Input types OK', 'HTML');
  const headScripts = pairs(head, 'script').filter(s => s.a.src && s.a.async == null && s.a.defer == null && !/module/i.test(s.a.type || '')).length;
  const headCss = tags(head, 'link').filter(l => /stylesheet/i.test(l.a.rel || '') && !/print/i.test(l.a.media || '')).length;
  set('performance:2', headScripts === 0 && headCss <= 3 ? 'pass' : headScripts <= 2 ? 'warn' : 'fail', headScripts + ' blocking script(s), ' + headCss + ' stylesheet(s) in <head>', 'HTML');
  const modern = imgs.filter(i => /\.(webp|avif)(\?|$)/i.test(i.a.src || '')).length + (html.match(/<source[^>]+type=["']image\/(webp|avif)/gi) || []).length;
  set('performance:5', imgs.length === 0 ? 'pass' : modern / imgs.length >= 0.5 ? 'pass' : modern ? 'warn' : 'fail', imgs.length ? modern + ' of ' + imgs.length + ' images in WebP/AVIF' : 'No images', 'HTML');
  const later = imgs.slice(3); const lazy = later.filter(i => /lazy/i.test(i.a.loading || '') || i.a['data-src'] || /lazy/i.test(i.a.class || '')).length;
  set('performance:7', later.length === 0 || lazy / later.length >= 0.5 ? 'pass' : 'warn', later.length ? lazy + ' of ' + later.length + ' below-fold images lazy' : 'Few images', 'HTML');
  set('performance:11', links.some(l => /preconnect|dns-prefetch/i.test(l.a.rel || '')) ? 'pass' : 'warn', links.some(l => /preconnect/i.test(l.a.rel || '')) ? 'preconnect hints present' : 'No preconnect hints', 'HTML');
  const domN = (html.match(/<[a-zA-Z][a-zA-Z0-9-]*[\s>]/g) || []).length;
  set('performance:13', domN < 1500 ? 'pass' : domN < 3000 ? 'warn' : 'fail', '≈' + domN + ' elements in HTML', 'HTML');
  const tpHosts = [...new Set(xo.map(s => new URL(s.url).hostname))];
  set('performance:14', tpHosts.length <= 5 ? 'pass' : tpHosts.length <= 10 ? 'warn' : 'fail', tpHosts.length + ' third-party script host(s)' + (tpHosts.length ? ': ' + tpHosts.slice(0, 5).join(', ') : ''), 'HTML');
  const aText = anchors.map(a => (plain(a.inner) + ' ' + (a.a.href || '')).toLowerCase());
  set('privacy:2', aText.some(t => /privacy/.test(t)) ? 'pass' : 'fail', aText.some(t => /privacy/.test(t)) ? 'Privacy policy link found' : 'No privacy link', 'HTML');
  set('privacy:3', aText.some(t => /terms|conditions|legal/.test(t)) ? 'pass' : 'fail', aText.some(t => /terms|conditions|legal/.test(t)) ? 'Terms link found' : 'No terms link', 'HTML');
  const dns = aText.some(t => /do not sell|do-not-sell|your privacy choices|opt[- ]?out|donotsell/.test(t));
  set('privacy:5', dns ? 'pass' : 'fail', dns ? 'Opt-out link found' : 'No "Do Not Sell or Share" link', 'HTML');
  const ga = [...new Set((html.match(/G-[A-Z0-9]{6,12}/g) || []))];
  const gtm = [...new Set((html.match(/GTM-[A-Z0-9]{4,10}/g) || []))];
  set('analytics:0', ga.length ? 'pass' : gtm.length ? 'warn' : 'fail', ga.length ? 'GA4: ' + ga.join(', ') : gtm.length ? 'Not in HTML (may load via GTM)' : 'No GA4 tag', 'HTML');
  set('analytics:1', gtm.length ? 'pass' : 'fail', gtm.length ? gtm.join(', ') : 'No Google Tag Manager', 'HTML');
  const gtagLoads = (html.match(/googletagmanager\.com\/gtag\/js\?id=([A-Z0-9-]+)/g) || []);
  const dup = gtagLoads.length !== new Set(gtagLoads).size || (html.match(/googletagmanager\.com\/gtm\.js/g) || []).length > 1;
  set('analytics:2', dup ? 'fail' : 'pass', dup ? 'Same tag loaded more than once' : 'No duplicate tags in HTML', 'HTML');
  if (ga.length || gtm.length) set('analytics:4', /gtag\(\s*['"]consent|consent_mode|ad_storage|analytics_storage/.test(html) ? 'pass' : 'warn', /ad_storage|analytics_storage|gtag\(\s*['"]consent/.test(html) ? 'Consent Mode signals found' : 'No Consent Mode in HTML (may be set in GTM)', 'HTML');
  else set('analytics:4', 'na', 'No Google tags on page');
  set('analytics:5', meta('google-site-verification') ? 'pass' : 'warn', meta('google-site-verification') ? 'Verification meta found' : 'No meta tag (may be verified by DNS)', 'HTML');
  if (/add_to_cart|begin_checkout|view_item|"purchase"|'purchase'|ecommerce/.test(html)) set('analytics:3', 'pass', 'Ecommerce event code found', 'HTML');

  // Assets
  const css = links.filter(l => /stylesheet/i.test(l.a.rel || '') && l.a.href).map(l => abs(l.a.href, finalUrl)).filter(Boolean).slice(0, 20);
  const js = extScripts.map(s => s.url).slice(0, 25);
  const im = imgs.map(i => abs(i.a.src || i.a['data-src'] || '', finalUrl)).filter(x => x && /^https?:/.test(x)).slice(0, 40);
  const assets = [...css.map(u => ({ u, t: 'Stylesheet' })), ...js.map(u => ({ u, t: 'Script' })), ...im.map(u => ({ u, t: 'Image' }))];
  const heads = await pool(assets, 10, async a => { const s = await statusFollow(a.u, 3); return { ...a, ...s, len: s.headers ? +(s.headers.get('content-length') || 0) : 0, cc: s.headers ? s.headers.get('cache-control') || '' : '' }; });
  const bodies = await pool([...css.slice(0, 6), ...js.slice(0, 6)], 6, async x => { try { const r = await req(x, { timeout: 12000 }); const t = await readText(r, 1.5e6, 12000); return { u: x, text: t.text, size: t.size, css: css.includes(x) }; } catch (e) { return { u: x, text: '', size: 0, css: css.includes(x) }; } });
  bodies.forEach(b => { const h = heads.find(x => x.u === b.u); if (h && !h.len) h.len = b.size; });
  const badRes = heads.filter(h => h.t !== 'Image' && (h.status >= 400 || h.status === 0));
  set('links:4', badRes.length ? 'fail' : 'pass', badRes.length ? badRes.length + ' failed: ' + badRes.slice(0, 3).map(h => h.u.split('/').pop().slice(0, 40) + ' (' + (h.status || h.error) + ')').join(', ') : (css.length + js.length) + ' CSS/JS files load', 'LINKS');
  const badImg = heads.filter(h => h.t === 'Image' && (h.status >= 400 || h.status === 0));
  set('links:3', badImg.length ? 'fail' : 'pass', badImg.length ? badImg.length + ' of ' + im.length + ' images fail to load' : im.length + ' images load', 'LINKS');
  const statics = heads.filter(h => h.status === 200);
  const cached = statics.filter(h => /immutable/.test(h.cc) || +((h.cc.match(/max-age=(\d+)/) || [])[1] || 0) >= 604800).length;
  if (statics.length) set('performance:1', cached / statics.length >= 0.8 ? 'pass' : cached / statics.length >= 0.4 ? 'warn' : 'fail', cached + ' of ' + statics.length + ' assets cached ≥ 7 days', 'HTTP');
  const unmin = b => { const t = b.text.slice(0, 20000); if (t.length < 2000) return false; const lines = t.split('\n').length; return lines / (t.length / 1000) > 25 && /\n\s{2,}\S/.test(t); };
  const umJs = bodies.filter(b => !b.css && unmin(b)), umCss = bodies.filter(b => b.css && unmin(b));
  if (bodies.some(b => !b.css && b.text)) set('performance:8', umJs.length ? 'warn' : 'pass', umJs.length ? umJs.length + ' script(s) look unminified' : 'Sampled scripts are minified', 'HTTP');
  if (bodies.some(b => b.css && b.text)) set('performance:9', umCss.length ? 'warn' : 'pass', umCss.length ? umCss.length + ' stylesheet(s) look unminified' : 'Sampled CSS is minified', 'HTTP');
  const allCss = bodies.filter(b => b.css).map(b => b.text).join('\n') + pairs(html, 'style').map(s => s.inner).join('\n');
  const faces = allCss.match(/@font-face\s*{[^}]*}/gi) || [];
  const noFd = faces.filter(f => !/font-display/i.test(f)).length;
  set('performance:10', !faces.length ? 'pass' : noFd ? 'fail' : 'pass', faces.length ? (faces.length - noFd) + ' of ' + faces.length + ' @font-face rules set font-display' : 'No web fonts in sampled CSS', 'HTTP');
  const fontUrls = [...new Set(faces.flatMap(f => [...f.matchAll(/url\(["']?([^"')]+\.(woff2?|ttf|otf))/gi)].map(m => m[1])))].slice(0, 8);
  const fontHeads = await pool(fontUrls.map(f => abs(f, css[0] || finalUrl)).filter(Boolean), 6, async u2 => { const s = await status(u2, 8000); return s.headers ? +(s.headers.get('content-length') || 0) : 0; });
  const sum = t => heads.filter(h => h.t === t).reduce((a, h) => a + (h.len || 0), 0);
  const weight = [{ label: 'Document', bytes: htmlBytes, count: 1 }, { label: 'Script', bytes: sum('Script'), count: js.length }, { label: 'Stylesheet', bytes: sum('Stylesheet'), count: css.length }, { label: 'Image', bytes: sum('Image'), count: im.length }, { label: 'Font', bytes: fontHeads.reduce((a, b) => a + b, 0), count: fontHeads.length }].filter(w => w.bytes > 0);
  const total = weight.reduce((a, w) => a + w.bytes, 0);
  set('performance:12', total < 2 * 1048576 ? 'pass' : total < 4 * 1048576 ? 'warn' : 'fail', (total / 1048576).toFixed(2) + ' MB from ' + (1 + assets.length + fontHeads.length) + ' resources found in HTML', 'HTTP');
  // Vulnerable libraries
  const libText = extScripts.map(s => s.url).join(' ') + ' ' + bodies.filter(b => !b.css).map(b => b.text.slice(0, 600)).join(' ') + ' ' + inline.slice(0, 20000);
  const vulns = [];
  const jq = libText.match(/jquery[\s/@.-]*v?(\d+\.\d+\.\d+)/i); if (jq && vcmp(jq[1], '3.5.0') < 0) vulns.push('jQuery ' + jq[1]);
  const bs = libText.match(/bootstrap[\s/@.-]*v?(\d+\.\d+\.\d+)/i); if (bs && (vcmp(bs[1], '3.4.1') < 0 || (bs[1][0] === '4' && vcmp(bs[1], '4.3.1') < 0))) vulns.push('Bootstrap ' + bs[1]);
  const ng = libText.match(/angular(?:js)?[\s/@.-]*v?(1\.\d+\.\d+)/i); if (ng) vulns.push('AngularJS ' + ng[1] + ' (end of life)');
  const ld = libText.match(/lodash[\s/@.-]*v?(\d+\.\d+\.\d+)/i); if (ld && vcmp(ld[1], '4.17.21') < 0) vulns.push('lodash ' + ld[1]);
  const mo = libText.match(/moment[\s/@.-]*v?(\d+\.\d+\.\d+)/i); if (mo && vcmp(mo[1], '2.29.4') < 0) vulns.push('Moment.js ' + mo[1]);
  set('security:17', vulns.length ? 'fail' : 'pass', vulns.length ? vulns.join(', ') : (jq || bs ? 'Detected ' + [jq && 'jQuery ' + jq[1], bs && 'Bootstrap ' + bs[1]].filter(Boolean).join(', ') + ' (patched)' : 'No known-vulnerable versions detected'), 'HTTP');
  // Source maps + directory listing
  const sameJs = js.filter(x => new URL(x).hostname === fu.hostname).slice(0, 2);
  const maps = await pool(sameJs, 2, async x => { const b = bodies.find(b2 => b2.u === x); const ref = b && (b.text.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/) || [])[1]; const mu = abs(ref || x + '.map', x); if (!mu || /^data:/.test(mu)) return null; try { const r = await req(mu, { timeout: 8000 }); const t = (await readText(r, 2e5, 8000)).text; return r.status === 200 && /"mappings"/.test(t) ? mu : null; } catch (e) { return null; } });
  const exposed = maps.filter(Boolean);
  set('bestpractices:9', exposed.length ? 'fail' : 'pass', exposed.length ? 'Public: ' + exposed[0].split('/').pop() : sameJs.length ? 'No public source maps found' : 'No first-party scripts', 'HTTP');
  const dirs = await pool(['/images/', '/assets/', '/uploads/', '/wp-content/uploads/', '/static/'], 5, async d => { try { const r = await req(origin + d, { timeout: 8000 }); const t = (await readText(r, 2e5, 8000)).text; return r.status === 200 && /<title>\s*Index of \//i.test(t) ? d : null; } catch (e) { return null; } });
  const listed = dirs.filter(Boolean);
  set('security:18', listed.length ? 'fail' : 'pass', listed.length ? 'Open: ' + listed.join(', ') : 'No open directory listings found', 'HTTP');

  // Links
  const hrefs = anchors.map(a => a.a.href).filter(Boolean);
  const absLinks = [...new Set(hrefs.map(h => abs(h, finalUrl)).filter(x => x && /^https?:/.test(x)).map(x => x.split('#')[0]))];
  const internal = absLinks.filter(x => new URL(x).hostname === fu.hostname).slice(0, 80);
  const external = absLinks.filter(x => new URL(x).hostname !== fu.hostname).slice(0, 40);
  const [ir, er] = await Promise.all([pool(internal, 8, statusFollow), pool(external, 8, statusFollow)]);
  const brokenI = internal.map((x, i) => ({ url: x, status: ir[i].status, error: ir[i].error })).filter(x => x.status >= 400 || x.status === 0);
  const brokenE = external.map((x, i) => ({ url: x, status: er[i].status })).filter(x => (x.status >= 400 && ![401, 403, 429, 999].includes(x.status)));
  const chains = internal.filter((x, i) => ir[i].hops >= 2).length;
  set('links:0', brokenI.length ? 'fail' : 'pass', brokenI.length + ' of ' + internal.length + ' internal links broken', 'LINKS');
  set('links:1', brokenE.length ? 'warn' : 'pass', brokenE.length + ' of ' + external.length + ' external links broken', 'LINKS');
  set('links:2', chains ? 'warn' : chain.length > 2 ? 'warn' : 'pass', chains ? chains + ' internal link(s) with 2+ redirects' : chain.length > 2 ? 'Page itself redirects ' + (chain.length - 1) + ' times' : 'No redirect chains', 'LINKS');
  const ids = new Set([...html.matchAll(/\s(?:id|name)=["']([^"']+)["']/gi)].map(m => m[1]));
  const badAnchors = [...new Set(hrefs.filter(h => /^#[^!/]/.test(h) && h.length > 1 && !ids.has(decodeURIComponent(h.slice(1)))))];
  set('links:5', badAnchors.length ? 'warn' : 'pass', badAnchors.length ? badAnchors.length + ' anchor(s) point to missing IDs: ' + badAnchors.slice(0, 3).join(', ') : 'All #anchors resolve', 'LINKS');
  const badMt = hrefs.filter(h => (/^tel:/i.test(h) && !/^tel:\+?[\d\s().-]{6,}$/i.test(decodeURIComponent(h))) || (/^mailto:/i.test(h) && !/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(decodeURIComponent(h))));
  set('links:6', badMt.length ? 'fail' : 'pass', badMt.length ? badMt.length + ' malformed: ' + badMt.slice(0, 2).join(', ') : 'mailto/tel links valid', 'LINKS');
  const docs = absLinks.filter(x => /\.(pdf|docx?|xlsx?|zip)(\?|$)/i.test(x)).slice(0, 20);
  const dr = await pool(docs, 6, statusFollow);
  const badDocs = docs.filter((x, i) => dr[i].status >= 400 || dr[i].status === 0);
  set('links:7', badDocs.length ? 'fail' : 'pass', docs.length ? badDocs.length + ' of ' + docs.length + ' documents broken' : 'No document links', 'LINKS');
  const path = fu.pathname || '/';
  const broken = [...brokenI.map(b => ({ url: b.url, status: b.status || 'ERR', from: path })), ...brokenE.map(b => ({ url: b.url, status: b.status, from: path + ' (external)' }))].slice(0, 30);

  // Storefront reachability (HTTP)
  const find = re => anchors.find(a => re.test(plain(a.inner) + ' ' + (a.a.href || '') + ' ' + (a.a['aria-label'] || '')) && a.a.href && !/^(#|javascript:)/i.test(a.a.href));
  const loginA = find(/log ?in|sign ?in|my account|\/account|\/login/i);
  if (loginA) { const lu = abs(loginA.a.href, finalUrl); const lr = await req(lu, { timeout: 12000 }).then(async r => ({ s: r.status, t: (await readText(r, 1e6)).text })).catch(() => null); set('storefront:10', lr && lr.s < 400 && /type=["']?password/i.test(lr.t) ? 'pass' : lr && lr.s < 400 ? 'warn' : 'fail', lr ? (lr.s < 400 ? (/type=["']?password/i.test(lr.t) ? 'Login form found at ' : 'Page loads but no password field (may be JS-rendered): ') + new URL(lu).pathname : 'Login page returns ' + lr.s) : 'Login page not reachable', 'HTTP'); }
  else set('storefront:10', 'warn', 'No login/account link found on this page', 'HTTP');
  const cartA = find(/\bcart\b|basket|checkout|\/cart|\/checkout/i);
  if (cartA) { const cu = abs(cartA.a.href, finalUrl); const cr = await statusFollow(cu, 4); set('storefront:8', cr.status > 0 && cr.status < 400 ? 'pass' : 'fail', (cr.status < 400 && cr.status > 0 ? 'Cart/checkout reachable: ' : 'Cart/checkout returns ' + (cr.status || cr.error) + ': ') + new URL(cu).pathname, 'HTTP'); }
  else set('storefront:8', 'warn', 'No cart or checkout link found on this page', 'HTTP');

  return { R, notes, finalUrl, weight, broken, html };
}
module.exports = { runCore };
