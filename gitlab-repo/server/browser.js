'use strict';
// Real-browser engine (optional): Playwright (Chromium, Firefox, WebKit, Edge) + axe-core accessibility.
let pw = null, axePath = null;
try { pw = require('playwright'); } catch (e) {}
try { axePath = require.resolve('axe-core/axe.min.js'); } catch (e) {}

const TRACKERS = ['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'connect.facebook.net', 'facebook.com/tr', 'hotjar.com', 'clarity.ms', 'snap.licdn.com', 'px.ads.linkedin.com', 'bat.bing.com', 'analytics.tiktok.com', 'cdn.segment.com', 'api.segment.io', 'mixpanel.com', 'hs-scripts.com', 'hs-analytics.net', 'googleadservices.com', 'adservice.google.com', 'criteo', 'taboola', 'outbrain', 'quantserve', 'scorecardresearch', 'nr-data.net', 'fullstory.com', 'mouseflow', 'crazyegg', 'ct.pinterest.com', 'static.ads-twitter.com', 'redditstatic.com/ads', 'heapanalytics', 'amplitude.com'];
const TRACK_COOKIE = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|_clck|_clsk|ajs_|mp_|_uetsid|_uetvid|_pin_unauth|_ttp|hubspotutk|__hs|_li|li_|IDE|test_cookie|_rdt|_scid|amplitude)/;
const CMP = /(onetrust|optanon|cookiebot|CybotCookiebot|didomi|usercentrics|cookieyes|cky-consent|osano|trustarc|truste|iubenda|quantcast|termly|complianz|cookie-law|cookieconsent|cc-window|cc-banner|gdpr-banner|consent-banner|cookie-banner|cookie-notice)/i;
const INIT = `(() => { window.__sc = { lcp: 0, cls: 0, fcp: 0, tbt: 0, geo: false, notif: false };
 const po = (t, f) => { try { new PerformanceObserver(l => l.getEntries().forEach(f)).observe({ type: t, buffered: true }); } catch (e) {} };
 po('largest-contentful-paint', e => { window.__sc.lcp = e.startTime; });
 po('layout-shift', e => { if (!e.hadRecentInput) window.__sc.cls += e.value; });
 po('paint', e => { if (e.name === 'first-contentful-paint') window.__sc.fcp = e.startTime; });
 po('longtask', e => { window.__sc.tbt += Math.max(0, e.duration - 50); });
 try { const g = navigator.geolocation; if (g) { const a = g.getCurrentPosition.bind(g), b = g.watchPosition.bind(g); g.getCurrentPosition = (...x) => { window.__sc.geo = true; return a(...x); }; g.watchPosition = (...x) => { window.__sc.geo = true; return b(...x); }; } } catch (e) {}
 try { if (window.Notification) { const r = Notification.requestPermission.bind(Notification); Notification.requestPermission = (...x) => { window.__sc.notif = true; return r(...x); }; } } catch (e) {}
})();`;
const AXE_MAP = { 'image-alt': 'accessibility:0', 'color-contrast': 'accessibility:1', label: 'accessibility:2', 'heading-order': 'accessibility:4', 'link-name': 'accessibility:5', 'button-name': 'accessibility:6', 'html-has-lang': 'accessibility:7', 'aria-valid-attr': 'accessibility:8', 'target-size': 'accessibility:9', 'document-title': 'accessibility:10', bypass: 'accessibility:12', 'video-caption': 'accessibility:14', 'td-has-header': 'accessibility:15', 'th-has-data-cells': 'accessibility:15' };

async function visit(browser, ctxOpts, url, fn, init = INIT) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const consoleErr = [], pageErr = [], requests = [];
  page.on('pageerror', e => pageErr.push(String(e.message || e).split('\n')[0].slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error') consoleErr.push(m.text().split('\n')[0].slice(0, 160)); });
  page.on('request', r => requests.push(r.url()));
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    status = resp ? resp.status() : 0;
    await page.waitForTimeout(2500);
    const out = fn ? await fn(page, ctx) : null;
    return { status, consoleErr, pageErr, requests, out };
  } catch (e) {
    return { status, consoleErr, pageErr, requests, out: null, failed: e.message.split('\n')[0] };
  } finally { await ctx.close().catch(() => {}); }
}
const shot = async page => (await page.screenshot({ type: 'jpeg', quality: 62 })).toString('base64');

async function runBrowser(url, opts = {}) {
  if (!pw) return null;
  const R = {}; const set = (k, s, v = '', src = 'BROWSER', n) => { R[k] = { s, v: String(v).slice(0, 180), src }; if (n != null) R[k].n = n; };
  const shots = {}; let axe = false; let trackers = [];
  const chromium = await pw.chromium.launch({ headless: true });
  try {
    const desk = await visit(chromium, { viewport: { width: 1366, height: 800 } }, url, async (page, ctx) => {
      const img = await shot(page);
      const m = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { ...window.__sc, ttfb: n ? n.responseStart : 0 }; });
      const cookies = await ctx.cookies();
      const banner = await page.evaluate(src => {
        const re = new RegExp(src, 'i');
        for (const el of document.querySelectorAll('div,section,aside,dialog,form,iframe')) {
          const s = getComputedStyle(el); const r = el.getBoundingClientRect();
          if (!r.width || !r.height || s.display === 'none' || s.visibility === 'hidden') continue;
          const idc = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
          if (re.test(idc) || ((s.position === 'fixed' || s.position === 'sticky' || el.tagName === 'DIALOG') && /cookie|consent|gdpr|privacy settings/i.test((el.innerText || '').slice(0, 1500)))) return 'visible';
        }
        return re.test(document.documentElement.outerHTML.slice(0, 600000)) ? 'script' : '';
      }, CMP.source);
      let ax = null;
      if (axePath) {
        try { await page.addScriptTag({ path: axePath }); ax = await page.evaluate(async ids => { const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ids }, resultTypes: ['violations', 'passes', 'incomplete'] }); const pick = a => a.map(x => ({ id: x.id, n: x.nodes.length })); return { v: pick(r.violations), p: pick(r.passes), i: pick(r.incomplete) }; }, Object.keys(AXE_MAP)); } catch (e) { ax = null; }
      }
      const kb = [];
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        kb.push(await page.evaluate(() => {
          const a = document.activeElement; if (!a || a === document.body) return null;
          const s = getComputedStyle(a); const r = a.getBoundingClientRect();
          const cx = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)), cy = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
          const top = document.elementFromPoint(cx, cy);
          return { id: a.tagName + '|' + (a.id || '') + '|' + (a.getAttribute('href') || a.getAttribute('name') || '') + '|' + Math.round(r.top + scrollY) + ',' + Math.round(r.left),
            ring: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none',
            obscured: !!top && top !== a && !a.contains(top) && !top.contains(a) && r.bottom > 0 && r.top < innerHeight };
        }));
      }
      let search = { found: false };
      const sel = 'input[type=search], input[name=q], input[name*=search i], input[id*=search i], input[placeholder*=search i], input[aria-label*=search i]';
      const box = await page.$(sel);
      if (box) {
        const visible = await box.isVisible().catch(() => false);
        search = { found: true, visible };
        if (visible) {
          const before = page.url();
          await box.click({ timeout: 3000 }).catch(() => {});
          await box.fill('').catch(() => {});
          await box.type(opts.term || 'a', { delay: 90 }).catch(() => {});
          await page.waitForTimeout(1600);
          search.ac = await page.evaluate(() => [...document.querySelectorAll('[role=listbox],[role=option],[class*=autocomplete i],[class*=suggest i],[id*=autocomplete i],[class*=typeahead i]')].some(el => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 20; }));
          await box.press('Enter').catch(() => {});
          await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1500);
          search.after = page.url(); search.changed = search.after !== before;
          search.items = await page.evaluate(() => document.querySelectorAll('a[href] img, [class*=product i] a[href]').length);
        }
      }
      return { img, m, cookies, banner, ax, kb, search };
    });
    const mobDesc = { ...pw.devices['iPhone 13'] }; delete mobDesc.defaultBrowserType;
    const [mob, tab, narrow, gpc] = await Promise.all([
      visit(chromium, mobDesc, url, async page => {
        const r = await page.evaluate(() => {
          const W = innerWidth, H = innerHeight;
          const els = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]')].filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && r.top < H * 3; });
          const small44 = els.filter(e => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).length;
          const small24 = els.filter(e => { const r = e.getBoundingClientRect(); return (r.width < 24 || r.height < 24) && getComputedStyle(e).display !== 'inline'; }).length;
          let texts = 0, tiny = 0; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
          while ((n = w.nextNode()) && texts < 2500) { if (n.textContent.trim().length < 3) continue; const p = n.parentElement; if (!p || !p.getBoundingClientRect().width) continue; texts++; if (parseFloat(getComputedStyle(p).fontSize) < 12) tiny++; }
          let cover = 0;
          for (const el of document.querySelectorAll('body *')) { const s = getComputedStyle(el); if (s.position !== 'fixed' || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) continue; const r = el.getBoundingClientRect(); const a = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0)); cover = Math.max(cover, a / (W * H)); }
          return { total: els.length, small44, small24, texts, tiny, cover, sw: document.documentElement.scrollWidth, W };
        });
        const m = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { ...window.__sc, ttfb: n ? n.responseStart : 0 }; });
        return { ...r, m, img: await shot(page) };
      }),
      visit(chromium, { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true }, url, async page => ({ img: await shot(page) })),
      visit(chromium, { viewport: { width: 320, height: 640 } }, url, async page => page.evaluate(() => document.documentElement.scrollWidth)),
      visit(chromium, { viewport: { width: 1366, height: 800 }, extraHTTPHeaders: { 'Sec-GPC': '1' } }, url, async (page, ctx) => (await ctx.cookies()).filter(c => TRACK_COOKIE.test(c.name)).map(c => c.name), "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });")
    ]);

    if (desk.out) {
      const o = desk.out; shots.desktop = 'data:image/jpeg;base64,' + o.img;
      const mm = opts.device === 'mobile' && mob.out ? mob.out.m : o.m;
      const met = (k, v, u, g, p) => { if (v > 0 || k === 'performance:m2' || k === 'performance:m5') set(k, v <= g ? 'pass' : v <= p ? 'warn' : 'fail', u === 's' ? v.toFixed(2) + ' s' : u === 'ms' ? Math.round(v) + ' ms' : v.toFixed(3), 'BROWSER', +v.toFixed(3)); };
      met('performance:m0', mm.lcp / 1000, 's', 2.5, 4); met('performance:m2', mm.cls, '', 0.1, 0.25); met('performance:m3', mm.fcp / 1000, 's', 1.8, 3); met('performance:m5', mm.tbt, 'ms', 200, 600);
      if (mm.ttfb > 0) met('performance:m4', mm.ttfb, 'ms', 800, 1800);
      const trackCookies = [...new Set(o.cookies.filter(c => TRACK_COOKIE.test(c.name)).map(c => c.name))];
      trackers = [...new Set(desk.requests.map(r => TRACKERS.find(t => r.includes(t))).filter(Boolean))];
      if (o.banner) set('privacy:0', 'pass', o.banner === 'visible' ? 'Consent banner shown on first visit' : 'Consent platform script detected');
      else set('privacy:0', trackers.length || trackCookies.length ? 'fail' : 'pass', trackers.length || trackCookies.length ? 'Trackers load but no consent banner found' : 'No trackers found, banner not required');
      set('privacy:1', trackCookies.length ? 'fail' : 'pass', trackCookies.length ? 'Set before consent: ' + trackCookies.join(', ') : 'No tracking cookies before consent');
      if (gpc.out) set('privacy:6', gpc.out.length ? 'fail' : 'pass', gpc.out.length ? 'Still set with GPC on: ' + [...new Set(gpc.out)].join(', ') : 'No tracking cookies when GPC is sent');
      const ce = desk.consoleErr.concat(desk.pageErr);
      set('bestpractices:0', ce.length === 0 ? 'pass' : ce.length <= 3 ? 'warn' : 'fail', ce.length ? ce.length + ' error(s): ' + ce[0] : 'No console errors');
      set('bestpractices:7', o.m.geo ? 'fail' : 'pass', o.m.geo ? 'Geolocation requested on load' : 'Not requested');
      set('bestpractices:8', o.m.notif ? 'fail' : 'pass', o.m.notif ? 'Notification permission requested on load' : 'Not requested');
      const ks = o.kb.filter(Boolean);
      if (ks.length) {
        const ring = ks.filter(k => k.ring).length;
        set('accessibility:3', ring / ks.length >= 0.8 ? 'pass' : ring / ks.length >= 0.4 ? 'warn' : 'fail', ring + ' of ' + ks.length + ' focused elements show an outline or ring');
        let run = 1, maxRun = 1; for (let i = 1; i < ks.length; i++) { run = ks[i].id === ks[i - 1].id ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
        const uniq = new Set(ks.map(k => k.id)).size;
        set('accessibility:11', maxRun >= 8 || (ks.length >= 20 && uniq <= 2) ? 'fail' : 'pass', maxRun >= 8 || (ks.length >= 20 && uniq <= 2) ? 'Focus stuck on ' + uniq + ' element(s)' : 'Tab moved through ' + uniq + ' elements');
        const obs = ks.filter(k => k.obscured).length;
        set('accessibility:18', obs ? 'warn' : 'pass', obs ? obs + ' focused element(s) covered by other content' : 'Focused elements not obscured');
      } else set('accessibility:3', 'warn', 'No focusable elements reached with Tab');
      if (o.ax) {
        axe = true; const seen = {};
        o.ax.p.forEach(x => { const k = AXE_MAP[x.id]; if (k && !seen[k]) seen[k] = { s: 'pass', v: 'axe: passed (' + x.n + ' elements)' }; });
        o.ax.i.forEach(x => { const k = AXE_MAP[x.id]; if (k && (!seen[k] || seen[k].s === 'pass')) seen[k] = { s: 'warn', v: 'axe: needs review (' + x.n + ' elements)' }; });
        o.ax.v.forEach(x => { const k = AXE_MAP[x.id]; if (k) seen[k] = { s: x.n > 3 ? 'fail' : 'warn', v: 'axe: ' + x.n + ' violation(s)' }; });
        Object.entries(seen).forEach(([k, v]) => set(k, v.s, v.v, 'AXE'));
      }
      const s = o.search;
      if (!s.found) set('storefront:0', 'fail', 'No search box found');
      else if (!s.visible) set('storefront:0', 'warn', 'Search box is hidden behind a toggle; open it to test');
      else set('storefront:0', s.changed ? 'pass' : 'warn', s.changed ? 'Search submitted → ' + new URL(s.after).pathname + new URL(s.after).search.slice(0, 40) + ' (' + s.items + ' linked items)' : 'Submitting search did not change the page');
      if (s.visible) set('storefront:1', s.ac ? 'pass' : 'warn', s.ac ? 'Suggestions appeared while typing' : 'No suggestions appeared');
      const ga = desk.requests.filter(r => /google-analytics\.com\/(g\/)?collect|\/g\/collect/.test(r));
      const pv = {}; const ev = new Set();
      ga.forEach(r => { try { const q = new URL(r).searchParams; const en = q.get('en'); if (en) ev.add(en); if (en === 'page_view') { const t = q.get('tid'); pv[t] = (pv[t] || 0) + 1; } } catch (e) {} });
      if (ga.length) set('analytics:2', Object.values(pv).some(n => n > 1) ? 'fail' : 'pass', Object.values(pv).some(n => n > 1) ? 'page_view sent more than once' : 'Single page_view per tag');
      const ecom = [...ev].filter(e => /view_item|add_to_cart|begin_checkout|purchase|select_item/.test(e));
      if (ecom.length) set('analytics:3', 'pass', 'Events sent: ' + ecom.join(', '));
      if (ga.length && !R['analytics:0']) set('analytics:0', 'pass', 'GA4 hits observed');
    }
    if (mob.out) {
      const m = mob.out; shots.mobile = 'data:image/jpeg;base64,' + m.img;
      const p44 = m.total ? m.small44 / m.total : 0;
      set('mobile:1', p44 <= 0.1 ? 'pass' : p44 <= 0.3 ? 'warn' : 'fail', m.small44 + ' of ' + m.total + ' tap targets under 44px');
      if (!axe) set('accessibility:9', m.small24 === 0 ? 'pass' : m.small24 <= 3 ? 'warn' : 'fail', m.small24 + ' controls under 24px');
      const pt = m.texts ? m.tiny / m.texts : 0;
      set('mobile:2', pt <= 0.05 ? 'pass' : pt <= 0.2 ? 'warn' : 'fail', Math.round(pt * 100) + '% of text under 12px on mobile');
      set('mobile:3', m.sw > m.W + 2 ? 'fail' : 'pass', m.sw > m.W + 2 ? 'Page is ' + m.sw + 'px wide on a ' + m.W + 'px screen' : 'No horizontal scroll at ' + m.W + 'px');
      set('mobile:7', m.cover >= 0.5 ? 'fail' : m.cover >= 0.3 ? 'warn' : 'pass', m.cover >= 0.3 ? 'Fixed overlay covers ' + Math.round(m.cover * 100) + '% of screen' : 'No intrusive overlay');
    }
    if (tab.out) shots.tablet = 'data:image/jpeg;base64,' + tab.out.img;
    if (narrow.out != null) set('accessibility:13', narrow.out > 322 ? 'fail' : 'pass', narrow.out > 322 ? 'Content is ' + narrow.out + 'px wide at 320px' : 'Reflows at 320px (400% zoom)');

    // Cross-browser
    const engines = [['Chrome', 'chromium', null], ['Edge', 'chromium', 'msedge'], ['Firefox', 'firefox', null], ['Safari', 'webkit', null]];
    const keyOf = { Chrome: 'browsers:0', Safari: 'browsers:1', Firefox: 'browsers:2', Edge: 'browsers:3' };
    const cells = []; const allErr = [];
    for (const [label, type, channel] of engines) {
      let res = null;
      if (label === 'Chrome') res = desk;
      else {
        let b = null;
        try { b = await pw[type].launch({ headless: true, ...(channel ? { channel } : {}) }); } catch (e) { b = null; }
        if (b) { try { res = await visit(b, { viewport: { width: 1366, height: 800 } }, url, null, null); } finally { await b.close().catch(() => {}); } }
      }
      if (!res) { set(keyOf[label], 'na', label + ' engine not installed (run npm run setup)'); cells.push({ browser: label, label: 'Not installed', ok: null }); continue; }
      const pe = res.pageErr; pe.forEach(e => allErr.push(label + ': ' + e));
      const s = res.failed || res.status >= 400 ? 'fail' : pe.length ? 'warn' : 'pass';
      set(keyOf[label], s, res.failed ? 'Failed to load: ' + res.failed : 'HTTP ' + res.status + ' · ' + pe.length + ' JavaScript error(s)' + (pe[0] ? ': ' + pe[0] : ''));
      cells.push({ browser: label, label: res.failed ? 'Failed' : pe.length ? pe.length + ' JS errors' : 'OK', ok: s === 'pass' ? true : s === 'fail' ? false : null });
    }
    set('browsers:7', allErr.length ? 'fail' : 'pass', allErr.length ? allErr.length + ' error(s): ' + allErr[0] : 'No JavaScript errors in tested browsers');
    set('browsers:4', 'na', 'Samsung Internet cannot be automated locally');
    return { R, shots, axe, trackers, matrix: [{ device: 'Desktop', cells }], matrixHead: cells.map(c => c.browser) };
  } finally { await chromium.close().catch(() => {}); }
}
module.exports = { runBrowser, hasBrowser: () => !!pw, hasAxe: () => !!axePath };
