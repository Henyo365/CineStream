import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { listAdapters } from './adapters/index.js';
import { extractRouter, extractUrl } from './routes/extract.js';
import { proxyRouter } from './routes/proxy.js';
import { resolveVideoStream } from './services/videoResolver.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_PIN = process.env.ACCESS_PIN?.trim() || '';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function requireAccessPin(req: Request, res: Response, next: NextFunction): void {
  if (!ACCESS_PIN) {
    next();
    return;
  }
  const provided =
    (typeof req.headers['x-access-pin'] === 'string' ? req.headers['x-access-pin'] : '') ||
    (typeof req.query.pin === 'string' ? req.query.pin : '');
  if (provided !== ACCESS_PIN) {
    res.status(401).json({ error: 'PIN de acceso requerido o incorrecto' });
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: '1.1.0',
    requiresPin: Boolean(ACCESS_PIN),
    adapters: listAdapters(),
  });
});

app.get('/api/ping', requireAccessPin, (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/extract', requireAccessPin, extractRouter);
app.use('/api/proxy', requireAccessPin, proxyRouter);

app.get('/api/resolve', requireAccessPin, async (req, res) => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({ error: 'Falta el parámetro "url"' });
    return;
  }
  try {
    const resolved = await resolveVideoStream(rawUrl);
    res.json(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error al resolver el video';
    res.status(422).json({ error: message });
  }
});

app.get('/api/search', requireAccessPin, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.status(400).json({ error: 'Falta el parámetro "q"' });
    return;
  }

  const encoded = encodeURIComponent(q);
  const filter = typeof req.query.source === 'string' ? req.query.source.toLowerCase() : 'all';
  const allSources = [
    { key: 'animeflv', name: 'AnimeFLV', url: `https://animeflv.or.at/?s=${encoded}` },
    { key: 'jkanime', name: 'JKAnime', url: `https://jkanime.net/buscar/${encoded}/` },
    { key: 'hackstore', name: 'Hackstore', url: `https://www.hackstore.fo/?s=${encoded}` },
    {
      key: 'leercapitulo',
      name: 'LeerCapitulo',
      url: `https://www.leercapitulo.co/manga/?q=${encoded}`,
    },
  ];
  const sources =
    filter === 'all' ? allSources : allSources.filter((s) => s.key === filter);

  const settled = await Promise.allSettled(
    sources.map(async (src) => {
      const data = await extractUrl(src.url);
      return data.pages.map((p) => ({
        ...p,
        subtitle: p.subtitle ? `${src.name} • ${p.subtitle}` : src.name,
      }));
    }),
  );

  const combined = settled.flatMap((item) =>
    item.status === 'fulfilled' ? item.value : [],
  );

  res.json({
    adapter: 'global-search',
    metadata: {
      title: `Resultados para "${q}"`,
      siteName: 'Búsqueda global',
      sourceUrl: `search://${encoded}`,
    },
    videos: [],
    images: [],
    pdfs: [],
    pages: combined,
  });
});

// Serve exported Expo Web app from backend/public if present (for Railway / production)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

function getLocalLanIps(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

app.listen(PORT, HOST, () => {
  console.log(`CineStream Backend escuchando en http://localhost:${PORT}`);
  for (const ip of getLocalLanIps()) {
    console.log(`  Red local (para tu teléfono): http://${ip}:${PORT}`);
  }
});
