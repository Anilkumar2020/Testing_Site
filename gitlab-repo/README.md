# URL Tester (Anil's 1st AI project)

Website testing tool: 151 tests across performance, security, accessibility, SEO, mobile, cross-browser, links, privacy, best practices, network/DNS, analytics and B2B storefront flows.

## Repository layout
```
url-tester.html          Web app (single self-contained file, served by the server)
server/                  Test engine (Node.js 18+)
  server.js              HTTP server: serves the app, /api/health, /api/scan
  checks.js              HTTP / TLS / DNS / HTML / link checks (no dependencies)
  browser.js             Playwright (Chrome, Edge, Firefox, WebKit) + axe-core checks
  lighthouse.js          Google PageSpeed Insights (optional)
  package.json
deploy/
  install-linux.sh       One-command install as a systemd service
  url-tester.service     systemd unit (reference)
src/
  URL Tester v3.dc.html  Editable design source (rebuild url-tester.html from it)
Dockerfile, docker-compose.yml, .dockerignore
.env.example             Config template (PORT, PSI_KEY)
.gitlab-ci.yml           CI: syntax check → Docker image → manual VM deploy
```

## Run
**Linux service**
```bash
sudo bash deploy/install-linux.sh              # installs to /opt/url-tester, port 8080
```
**Docker**
```bash
cp .env.example .env
docker compose up -d --build
```
**Local dev**
```bash
cd server && npm run setup && npm start        # http://localhost:8080
```

## Config
| Variable | Default | Purpose |
|---|---|---|
| PORT | 8080 | HTTP port |
| PSI_KEY | (empty) | Google PageSpeed API key (optional) |

## Operations
```bash
systemctl status url-tester
systemctl restart url-tester
journalctl -u url-tester -f
curl -s http://localhost:8080/api/health
```

## Updating the web app
Edit `src/URL Tester v3.dc.html` in the design tool, export the standalone HTML, replace `url-tester.html`, commit, then run the `deploy-vm` job.

## Security
- The app has no login. Restrict port 8080 to trusted IPs, or put it behind NGINX/HAProxy with auth + TLS.
- Only scan sites you own or are authorized to test.
- Never commit `.env` or API keys. Use GitLab CI/CD variables.
