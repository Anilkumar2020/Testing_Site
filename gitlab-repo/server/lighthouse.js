'use strict';
// Google PageSpeed Insights (Lighthouse) — optional. Works without a key at low volume; set PSI_KEY for more.
const LH = {
  'performance:0': 'uses-text-compression', 'performance:1': 'uses-long-cache-ttl', 'performance:2': 'render-blocking-resources',
  'performance:3': 'unused-javascript', 'performance:4': 'unused-css-rules', 'performance:5': 'modern-image-formats',
  'performance:6': 'uses-responsive-images', 'performance:7': 'offscreen-images', 'performance:8': 'unminified-javascript',
  'performance:9': 'unminified-css', 'performance:10': 'font-display', 'performance:11': 'uses-rel-preconnect',
  'performance:12': 'total-byte-weight', 'performance:13': 'dom-size', 'performance:14': 'third-party-summary',
  'accessibility:0': 'image-alt', 'accessibility:1': 'color-contrast', 'accessibility:2': 'label', 'accessibility:4': 'heading-order',
  'accessibility:5': 'link-name', 'accessibility:6': 'button-name', 'accessibility:7': 'html-has-lang', 'accessibility:8': 'aria-valid-attr',
  'accessibility:9': 'target-size', 'accessibility:10': 'document-title', 'accessibility:12': 'bypass', 'accessibility:14': 'video-caption',
  'accessibility:15': 'td-has-header', 'seo:0': 'document-title', 'seo:1': 'meta-description', 'seo:2': 'canonical', 'seo:3': 'robots-txt',
  'seo:11': 'is-crawlable', 'seo:12': 'hreflang', 'seo:15': 'crawlable-anchors', 'seo:16': 'http-status-code',
  'mobile:0': 'viewport', 'mobile:2': 'font-size', 'browsers:6': 'deprecations', 'links:2': 'redirects',
  'bestpractices:0': 'errors-in-console', 'bestpractices:1': 'doctype', 'bestpractices:2': 'charset', 'bestpractices:4': 'image-aspect-ratio',
  'bestpractices:5': 'no-document-write', 'bestpractices:6': 'uses-passive-event-listeners', 'bestpractices:7': 'geolocation-on-start',
  'bestpractices:8': 'notification-on-start', 'infra:1': 'uses-http2'
};
const METRIC = {
  'performance:m0': ['largest-contentful-paint', 's', 1000, 2.5, 4], 'performance:m2': ['cumulative-layout-shift', '', 1, 0.1, 0.25],
  'performance:m3': ['first-contentful-paint', 's', 1000, 1.8, 3], 'performance:m4': ['server-response-time', 'ms', 1, 800, 1800],
  'performance:m5': ['total-blocking-time', 'ms', 1, 200, 600], 'performance:m6': ['speed-index', 's', 1000, 3.4, 5.8]
};
const fmt = (u, v) => u === 's' ? v.toFixed(2) + ' s' : u === 'ms' ? Math.round(v) + ' ms' : v.toFixed(3);
const st = (v, g, p) => v <= g ? 'pass' : v <= p ? 'warn' : 'fail';

async function runPsi(url, strategy, key) {
  const q = new URLSearchParams({ url, strategy });
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c => q.append('category', c));
  if (key) q.set('key', key);
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q, { signal: ctl.signal });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
    const A = d.lighthouseResult.audits, R = {};
    for (const [k, [id, u, div, g, p]] of Object.entries(METRIC)) {
      const a = A[id]; if (a && a.numericValue != null) { const v = a.numericValue / div; R[k] = { s: st(v, g, p), v: fmt(u, v), n: +v.toFixed(3), src: 'LIGHTHOUSE' }; }
    }
    const inp = d.loadingExperience && d.loadingExperience.metrics && d.loadingExperience.metrics.INTERACTION_TO_NEXT_PAINT;
    if (inp && inp.percentile != null) R['performance:m1'] = { s: st(inp.percentile, 200, 500), v: inp.percentile + ' ms (real users)', n: inp.percentile, src: 'CHROME UX REPORT' };
    for (const [k, id] of Object.entries(LH)) {
      const a = A[id];
      if (!a || a.score == null || ['manual', 'notApplicable', 'informative'].includes(a.scoreDisplayMode)) continue;
      R[k] = { s: a.score >= 0.9 ? 'pass' : a.score >= 0.5 ? 'warn' : 'fail', v: a.displayValue || '', src: 'LIGHTHOUSE' };
    }
    const rs = A['resource-summary'] && A['resource-summary'].details && A['resource-summary'].details.items;
    const weight = rs ? rs.filter(i => !['total', 'third-party'].includes(i.resourceType) && i.transferSize > 0).map(i => ({ label: i.label, bytes: i.transferSize, count: i.requestCount })) : null;
    return { R, weight };
  } finally { clearTimeout(to); }
}
module.exports = { runPsi };
