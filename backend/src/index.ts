import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { listAdapters } from './adapters/index.js';
import { extractRouter } from './routes/extract.js';
import { proxyRouter } from './routes/proxy.js';
import { resolveVideoStream } from './services/videoResolver.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    adapters: listAdapters(),
  });
});

app.use('/api/extract', extractRouter);
app.use('/api/proxy', proxyRouter);

app.get('/api/resolve', async (req, res) => {
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
