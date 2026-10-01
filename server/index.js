import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { assertMasterKey, sha256 } from './security.js';
import { activeLink, monthReport, isMonth } from './report.js';
import { todayBR } from './metrics.js';
import { attachSession, csrfGuard, requireAuth, purgeExpired, SECURE } from './session.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import { syncAll } from './sync.js';
import { evaluateAlerts } from './alerts.js';

assertMasterKey();

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: SECURE ? [] : null,
    },
  },
  hsts: SECURE ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

app.use(express.json({ limit: '50kb' }));
app.use(attachSession);

/* API */
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/api', csrfGuard);
app.use('/api/auth', authRoutes);
app.use('/api', requireAuth, apiRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Não encontrado.' }));

/* Relatório público (somente leitura): acesso por token não adivinhável, com expiração e revogação */
const reportLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
const noIndex = (_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'no-store'); next(); };
app.get('/r/:token', reportLimit, noIndex, (_req, res) => res.sendFile(path.join(pub, 'report.html')));
app.get('/r/:token/data', reportLimit, noIndex, (req, res) => {
  const link = /^[A-Za-z0-9_-]{20,64}$/.test(req.params.token) ? activeLink(sha256(req.params.token)) : null;
  if (!link) return res.status(404).json({ error: 'Link inválido ou expirado.' });
  const month = isMonth(req.query.month) ? req.query.month : todayBR().slice(0, 7);
  res.json(monthReport(link.client_id, month));
});

/* Páginas: o shell do painel só é entregue para sessões válidas */
app.get('/', (req, res) => (req.user ? res.sendFile(path.join(pub, 'app.html')) : res.redirect('/login')));
app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.sendFile(path.join(pub, 'login.html'))));
app.use('/images', express.static(path.join(pub, 'images'), { maxAge: '1d', index: false, dotfiles: 'ignore' }));
app.use('/assets', express.static(path.join(pub, 'assets'), { maxAge: '1h', index: false, dotfiles: 'ignore' }));
app.use((_req, res) => res.status(404).send('Não encontrado'));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  console.error('[erro]', err);
  res.status(500).json({ error: 'Erro interno.' });
});

const port = +process.env.PORT || 3000;
app.listen(port, () => console.log(`KCOM Monitor em http://localhost:${port}`));

/* Agendador: sincroniza com Google/Meta e reavalia alertas */
const every = Math.max(5, +process.env.SYNC_INTERVAL_MIN || 15) * 60 * 1000;
const safely = (fn) => () => Promise.resolve().then(fn).catch((e) => console.error('[cron]', e.message));
setTimeout(safely(syncAll), 10_000);
setInterval(safely(syncAll), every);
setInterval(safely(evaluateAlerts), 5 * 60 * 1000);
setInterval(safely(purgeExpired), 60 * 60 * 1000);
