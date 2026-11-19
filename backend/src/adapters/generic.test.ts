import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteHlsPlaylist } from '../routes/proxy.js';
import {
  extractDirectStreamFromText,
  resolveVideoStream,
  unpackPacker,
} from '../services/videoResolver.js';
import { validateTargetUrl } from '../utils/url.js';
import { extractFromHtml } from './index.js';

test('genericAdapter extracts videos, images, and PDFs with relative URL resolution', () => {
  const baseUrl = new URL('https://media.example.org/gallery/page.html');
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Página de prueba</title>
        <meta property="og:description" content="Descripción de prueba" />
      </head>
      <body>
        <video poster="/thumbs/cover.jpg">
          <source src="../videos/clip.mp4" type="video/mp4" />
        </video>
        <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="YouTube Video"></iframe>
        <img src="/img/low.jpg" srcset="/img/mid.jpg 640w, /img/high.jpg 1280w" alt="Foto principal" />
        <img data-src="/img/lazy.png" alt="Lazy" />
        <img src="/pixel.gif" width="1" height="1" alt="tracker" />
        <a href="/docs/manual.pdf">Descargar Manual</a>
        <embed src="https://cdn.example.org/guide.pdf" type="application/pdf" />
      </body>
    </html>
  `;

  const result = extractFromHtml(baseUrl, html);

  assert.equal(result.adapter, 'generic');
  assert.equal(result.metadata.title, 'Página de prueba');
  assert.equal(result.metadata.description, 'Descripción de prueba');

  // Videos: 1 direct mp4 + 1 youtube embed
  assert.equal(result.videos.length, 2);
  assert.equal(result.videos[0].url, 'https://media.example.org/videos/clip.mp4');
  assert.equal(result.videos[0].thumbnail, 'https://media.example.org/thumbs/cover.jpg');
  assert.equal(result.videos[1].isEmbed, true);

  // Images: high.jpg from srcset + lazy.png (1x1 pixel skipped)
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].url, 'https://media.example.org/img/high.jpg');
  assert.equal(result.images[1].url, 'https://media.example.org/img/lazy.png');

  // PDFs: guide.pdf (<embed>) + manual.pdf (<a>)
  assert.equal(result.pdfs.length, 2);
  const manualPdf = result.pdfs.find((p) => p.url === 'https://media.example.org/docs/manual.pdf');
  const guidePdf = result.pdfs.find((p) => p.url === 'https://cdn.example.org/guide.pdf');
  assert.ok(manualPdf);
  assert.equal(manualPdf.title, 'Descargar Manual');
  assert.ok(guidePdf);
});

test('validateTargetUrl rejects non-http protocols and private IPs', () => {
  assert.throws(() => validateTargetUrl('ftp://example.com/file.pdf'));
  assert.throws(() => validateTargetUrl('http://localhost:3000/test'));
  assert.throws(() => validateTargetUrl('http://192.168.1.10/admin'));
  const valid = validateTargetUrl('https://example.org/path?a=1');
  assert.equal(valid.hostname, 'example.org');
});

test('animeflvAdapter decodes base64 iframe_btn video options and episode cards', () => {
  const encoded1 = Buffer.from('https://player.example.com/embed/123').toString('base64');
  const epUrl = new URL('https://animeflv.or.at/2026/11/17/test-episodio-1/');
  const epHtml = `
    <html>
      <head><title>Test Episodio 1</title></head>
      <body>
        <div id="iframePoster"><img src="https://animeflv.or.at/poster.jpg" /></div>
        <button class="iframe_btn server_btn" data-src="${encoded1}">OPCIÓN 1</button>
        <script type="application/json" class="animeflv-episodes-data">[{"post_id":1,"permalink":"https://animeflv.or.at/2026/11/17/test-episodio-1/","number":1},{"post_id":2,"permalink":"https://animeflv.or.at/2026/11/17/test-episodio-2/","number":2}]</script>
        <div class="Episode">
          <a href="https://animeflv.or.at/2026/11/17/otro-episodio-2/">
            <img src="https://animeflv.or.at/thumb2.jpg" alt="Otro" />
            <span class="Capi">Episodio 2</span>
            <h2 class="Title">Otro Anime</h2>
          </a>
        </div>
      </body>
    </html>
  `;

  const result = extractFromHtml(epUrl, epHtml);
  assert.equal(result.adapter, 'animeflv');
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].url, 'https://player.example.com/embed/123');
  assert.equal(result.videos[0].title, 'OPCIÓN 1 (player.example.com)');
  assert.equal(result.videos[0].isEmbed, true);
  assert.equal(result.pages.length, 3);
  assert.equal(result.pages[0].title, 'Capítulo 1');
  assert.equal(result.pages[1].title, 'Capítulo 2');
  assert.equal(result.pages[2].url, 'https://animeflv.or.at/2026/11/17/otro-episodio-2/');
  assert.equal(result.pages[2].title, 'Otro Anime');
});

test('resolveVideoStream recognizes HLS /m3u8/ and direct .mp4 URLs as native streams', async () => {
  const hls = await resolveVideoStream('https://player.zilla-networks.com/m3u8/abc123');
  assert.equal(hls.isEmbed, false);
  assert.equal(hls.mimeType, 'application/x-mpegURL');
  assert.equal(hls.referer, 'https://player.zilla-networks.com/');

  const mp4 = await resolveVideoStream('https://cdn.example.com/video.mp4');
  assert.equal(mp4.isEmbed, false);
  assert.equal(mp4.mimeType, 'video/mp4');
});

test('hackstoreAdapter extracts movie catalog cards and main player iframe', () => {
  const homeUrl = new URL('https://www.hackstore.fo/');
  const homeHtml = `
    <html>
      <head><title>Hackstore</title></head>
      <body>
        <div class="movie-card">
          <div class="poster">
            <a href="/peliculas/spider-man-2026/">
              <img data-src="https://image.tmdb.org/t/p/w300/abc.jpg" alt="Spider-Man" />
            </a>
          </div>
          <a class="movie-title2" href="/peliculas/spider-man-2026/">Spider-Man (2026)</a>
        </div>
      </body>
    </html>
  `;
  const homeResult = extractFromHtml(homeUrl, homeHtml);
  assert.equal(homeResult.adapter, 'hackstore');
  assert.equal(homeResult.pages.length, 1);
  assert.equal(homeResult.pages[0].title, 'Spider-Man (2026)');
  assert.equal(homeResult.pages[0].thumbnail, 'https://image.tmdb.org/t/p/w300/abc.jpg');

  const movieUrl = new URL('https://www.hackstore.fo/peliculas/spider-man-2026/');
  const movieHtml = `
    <html>
      <body>
        <h1>Spider-Man (2026)</h1>
        <iframe id="intesx" src="/play.php?u=123&b=456"></iframe>
        <iframe src="https://www.youtube.com/embed/xyz"></iframe>
      </body>
    </html>
  `;
  const movieResult = extractFromHtml(movieUrl, movieHtml);
  assert.equal(movieResult.videos.length, 2);
  assert.equal(movieResult.videos[0].url, 'https://www.hackstore.fo/play.php?u=123&b=456');
  assert.equal(movieResult.videos[0].title, 'Reproductor Principal');
  assert.equal(movieResult.videos[1].title, 'Tráiler (YouTube)');
});

test('unpackPacker decodes Dean Edwards packed JS containing HLS stream URL', () => {
  const packed = `eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('2 1="3://0.4/5.6";',7,7,'cdn|url|var|https|example|master|m3u8'.split('|'),0,{}))`;
  const unpacked = unpackPacker(packed);
  assert.equal(unpacked, 'var url="https://cdn.example/master.m3u8";');
});

test('lectortmoAdapter extracts manga detail chapters and chapter reader images', () => {
  const detailUrl = new URL('https://lectortmo.vip/manga/las-flores-son-cebo/');
  const detailHtml = `
    <html>
      <body>
        <h1>Las Flores Son Cebo</h1>
        <div class="summary_image"><img src="https://lectortmo.vip/wp-content/uploads/2026/08/cover.webp" /></div>
        <div class="description-summary"><p>Esta es una sinopsis suficientemente larga para ser extraída correctamente por el adaptador de LectorTMO.</p></div>
        <a href="https://lectortmo.vip/manga-chapter/las-flores-son-cebo-capitulo-1/">Capítulo 1</a>
      </body>
    </html>
  `;
  const detail = extractFromHtml(detailUrl, detailHtml);
  assert.equal(detail.adapter, 'lectortmo');
  assert.equal(detail.metadata.title, 'Las Flores Son Cebo');
  assert.equal(detail.pages.length, 1);
  assert.equal(detail.pages[0].title, 'Capítulo 1');

  const chapUrl = new URL('https://lectortmo.vip/manga-chapter/las-flores-son-cebo-capitulo-1/');
  const chapHtml = `
    <html>
      <body>
        <h1>Las Flores Son Cebo - Capítulo 1</h1>
        <div class="reading-content">
          <img src="https://repelishd.onl/mangax/001.webp" />
          <img src="https://repelishd.onl/mangax/002.webp" />
        </div>
      </body>
    </html>
  `;
  const chap = extractFromHtml(chapUrl, chapHtml);
  assert.equal(chap.adapter, 'lectortmo');
  assert.equal(chap.images.length, 2);
  assert.equal(chap.images[0].url, 'https://repelishd.onl/mangax/001.webp');
});

test('validateTargetUrl blocks IPv6 loopback, ULA, and IPv4-mapped loopback', () => {
  assert.throws(() => validateTargetUrl('http://[::1]:3001/secret'));
  assert.throws(() => validateTargetUrl('http://[fc00::1]/admin'));
  assert.throws(() => validateTargetUrl('http://[fe80::1]/meta'));
  assert.throws(() => validateTargetUrl('http://[::ffff:127.0.0.1]/local'));
  assert.throws(() => validateTargetUrl('http://0.0.0.0:8080/'));
});

test('rewriteHlsPlaylist sorts variants descending and preserves access pin', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ES",URI="audio/es.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080',
    'high/index.m3u8',
  ].join('\n');

  const rewritten = rewriteHlsPlaylist(
    playlist,
    new URL('https://cdn.example.com/stream/master.m3u8'),
    'https://api.myapp.com',
    'https://embed.example.com/',
    '1234',
  );

  const lines = rewritten.split('\n');
  assert.ok(lines[1].includes('pin=1234'));
  assert.ok(lines[2].includes('BANDWIDTH=3500000'));
  assert.ok(lines[3].includes('high%2Findex.m3u8'));
  assert.ok(lines[3].includes('pin=1234'));
  assert.ok(lines[4].includes('BANDWIDTH=800000'));
});

test('extractDirectStreamFromText handles JSON-escaped HLS URLs and og:video mp4', () => {
  const escaped = `{"sources":[{"file":"https:\\/\\/cdn.video.io\\/hls\\/master.m3u8?t=1"}]}`;
  const foundHls = extractDirectStreamFromText(escaped);
  assert.ok(foundHls);
  assert.equal(foundHls.url, 'https://cdn.video.io/hls/master.m3u8?t=1');
  assert.equal(foundHls.mimeType, 'application/x-mpegURL');

  const ogHtml = `<meta property="og:video" content="https://cdn.yourupload.com/file/123.mp4" />`;
  const foundMp4 = extractDirectStreamFromText(ogHtml);
  assert.ok(foundMp4);
  assert.equal(foundMp4.url, 'https://cdn.yourupload.com/file/123.mp4');
  assert.equal(foundMp4.mimeType, 'video/mp4');
});
