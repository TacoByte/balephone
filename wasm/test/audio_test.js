// Checks the Web Audio pipeline: AudioContext state and whether the SDL
// audio callback is producing non-silent samples (menu music playing).
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '../build');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(BUILD_DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startServer(8780);
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8780/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);

  const result = await page.evaluate(async () => {
    const M = window.__module;
    const sdl = M && M.SDL2;
    if (!sdl || !sdl.audioContext) return { error: 'no SDL audio context' };
    const ctx = sdl.audioContext;
    const node = sdl.scriptProcessorNode
      || (sdl.audio && sdl.audio.scriptProcessorNode)
      || null;
    // Also peek at the raw output buffer SDL fills each callback.
    let peak = 0;
    if (node) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      node.connect(analyser);
      await new Promise(r => setTimeout(r, 2000));
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
    return {
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      sdlKeys: Object.keys(sdl),
      audioKeys: sdl.audio ? Object.keys(sdl.audio) : null,
      peakSample: peak,
    };
  }).catch(e => ({ error: e.message }));

  console.log(JSON.stringify(result, null, 2));
  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
