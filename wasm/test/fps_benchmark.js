// Deterministic OpenGL throughput benchmark for the browser build.
//
// The engine is forced to a fixed 1280x720 OpenGL mode with VSync disabled
// and fps_target=0 (Unlimited). Results measure actual SDL_GL_SwapWindow
// calls through the wasm_perf_frame_count() test hook, not browser rAF.
//
// Configure the build with -DA1_WASM_PERF_TESTING=ON before running.
//
// Usage:
//   node fps_benchmark.js <label>
// Environment:
//   SAMPLES=3 SAMPLE_SECONDS=10 WARMUP_SECONDS=15 HEADLESS=1
//   CHROME_CHANNEL=chrome (optional; use installed hardware Chrome)

const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '../build');
const RESULTS_DIR = path.resolve(__dirname, 'results');
const PORT = 8792;
const LABEL = process.argv[2] || 'unnamed';
const SAMPLES = Number.parseInt(process.env.SAMPLES || '3', 10);
const SAMPLE_SECONDS = Number.parseInt(process.env.SAMPLE_SECONDS || '10', 10);
const WARMUP_SECONDS = Number.parseInt(process.env.WARMUP_SECONDS || '15', 10);
const HEADLESS = process.env.HEADLESS !== '0';
const WIDTH = Number.parseInt(process.env.WIDTH || '1280', 10);
const HEIGHT = Number.parseInt(process.env.HEIGHT || '720', 10);
const COUNT_GL = process.env.COUNT_GL === '1';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
};

const FREEZE_LUA = `
Triggers = {}
local saved = nil

local function stabilize_player()
  local player = Players[0]
  if not saved then
    local polygon = Polygons[0]
    for candidate in Polygons() do
      if candidate.area > polygon.area then
        polygon = candidate
      end
    end
    saved = {
      x = polygon.x,
      y = polygon.y,
      z = polygon.z,
      polygon = polygon
    }
  end

  for monster in Monsters() do
    if monster.player == nil and monster.active then
      monster.active = false
    end
  end

  player:position(saved.x, saved.y, saved.z, saved.polygon)
  player.yaw = 0
  player.pitch = 0
  player.energy = 450
end

function Triggers.idle()
  stabilize_player()
end

function Triggers.postidle()
  stabilize_player()
end
`;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const relative = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
      const file = path.join(BUILD_DIR, relative);
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function configurePreferences(page) {
  return page.evaluate(async ({ lua, width, height }) => {
    const module = window.__module;
    const dir = '/home/web_user/.alephone';
    const prefsPath = `${dir}/Marathon 2 Preferences`;
    const luaPath = `${dir}/fps-benchmark.lua`;
    let text = module.FS.readFile(prefsPath, { encoding: 'utf8' });

    const attrs = {
      scmode_width: width,
      scmode_height: height,
      scmode_auto_resolution: 'false',
      scmode_high_dpi: 'false',
      scmode_accel: 1,
      scmode_fullscreen: 'false',
      fps_target: 0,
      wait_for_vsync: 'false',
      multisamples: 0,
    };

    for (const [name, value] of Object.entries(attrs)) {
      const re = new RegExp(`${name}="[^"]*"`);
      if (!re.test(text)) throw new Error(`missing preference attribute ${name}`);
      text = text.replace(re, `${name}="${value}"`);
    }

    text = text.replace(/use_solo_lua="[^"]*"/, 'use_solo_lua="true"');
    if (/solo_lua_file="[^"]*"/.test(text)) {
      text = text.replace(/solo_lua_file="[^"]*"/, `solo_lua_file="${luaPath}"`);
    } else {
      text = text.replace(/<environment /, `<environment solo_lua_file="${luaPath}" `);
    }

    module.FS.writeFile(luaPath, lua);
    module.FS.writeFile(prefsPath, text);
    await new Promise((resolve, reject) => {
      module.FS.syncfs(false, (error) => error ? reject(error) : resolve());
    });
    return Object.fromEntries(
      Object.keys(attrs).map((name) => {
        const match = text.match(new RegExp(`${name}="([^"]*)"`));
        return [name, match && match[1]];
      }),
    );
  }, { lua: FREEZE_LUA, width: WIDTH, height: HEIGHT });
}

async function startGame(page) {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');

  // Begin New Game in Marathon 2's 1024x640 menu layout.
  await page.mouse.click(box.x + 0.325 * box.width, box.y + 0.403 * box.height);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(7000);

  // Do not send gameplay mouse movement: it would alter the camera pose.
  // The benchmark hook below bypasses the inactive-controller FPS cap.
  await canvas.focus();
  await page.bringToFront();
}

async function measureSample(page) {
  return page.evaluate(async ({ seconds }) => {
    const module = window.__module;
    if (typeof module._wasm_perf_frame_count !== 'function' ||
        typeof module._wasm_perf_reset_frame_count !== 'function') {
      throw new Error('wasm frame counter exports are unavailable');
    }

    window.__a1GlStats = {};
    module._wasm_perf_reset_frame_count();

    const windows = [];
    let previousFrames = 0;
    let previousTime = performance.now();
    const start = previousTime;

    for (let second = 0; second < seconds; ++second) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const now = performance.now();
      const frames = module._wasm_perf_frame_count() >>> 0;
      windows.push({
        seconds: (now - previousTime) / 1000,
        frames: frames - previousFrames,
      });
      previousTime = now;
      previousFrames = frames;
    }

    const end = performance.now();
    const frames = module._wasm_perf_frame_count() >>> 0;
    const secondsElapsed = (end - start) / 1000;
    const windowFps = windows.map((window) => window.frames / window.seconds);
    return {
      frames,
      seconds: secondsElapsed,
      fps: frames / secondsElapsed,
      lowOneSecondFps: Math.min(...windowFps),
      highOneSecondFps: Math.max(...windowFps),
      glCalls: window.__a1GlStats,
    };
  }, { seconds: SAMPLE_SECONDS });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const server = await startServer();
  const launchOptions = {
    headless: HEADLESS,
    args: process.env.SOFTWARE_GPU === '1'
      ? ['--enable-unsafe-swiftshader']
      : [
          '--use-angle=metal',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
  };
  if (process.env.CHROME_CHANNEL) launchOptions.channel = process.env.CHROME_CHANNEL;

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    screen: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });

  // Count native WebGL work independently of engine frame count.
  await context.addInitScript(({ countGl }) => {
    window.__a1GlStats = {};
    if (!countGl) return;
    const wrap = (prototype, name) => {
      if (!prototype || typeof prototype[name] !== 'function') return;
      const original = prototype[name];
      prototype[name] = function(...args) {
        const stats = window.__a1GlStats;
        stats[name] = (stats[name] || 0) + 1;
        return original.apply(this, args);
      };
    };
    const methods = [
      'bindTexture',
      'drawArrays',
      'drawElements',
      'enable',
      'disable',
      'uniform1f',
      'uniform1i',
      'uniformMatrix4fv',
      'useProgram',
      'vertexAttribPointer',
    ];
    for (const method of methods) {
      wrap(globalThis.WebGLRenderingContext && WebGLRenderingContext.prototype, method);
      wrap(globalThis.WebGL2RenderingContext && WebGL2RenderingContext.prototype, method);
    }
  }, { countGl: COUNT_GL });

  const page = await context.newPage();
  const logs = [];
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
  page.on('crash', () => logs.push('[CRASH]'));

  const url = `http://127.0.0.1:${PORT}/index.html?scenario=marathon2`;

  // First boot creates the scenario's preference file in IDBFS.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__module && window.__module.FS, null, { timeout: 30000 });
  await page.waitForTimeout(10000);
  const preferences = await configurePreferences(page);

  // Second boot creates the OpenGL context with benchmark preferences.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__module && window.__module.FS, null, { timeout: 30000 });
  await page.waitForTimeout(12000);
  await startGame(page);
  await page.waitForFunction(
    () => typeof window.__module._wasm_perf_set_ignore_inactive_fps_cap === 'function',
    null,
    { timeout: 10000 },
  );
  await page.evaluate(() => {
    window.__module._wasm_perf_set_ignore_inactive_fps_cap(1);
  });
  await page.waitForTimeout(WARMUP_SECONDS * 1000);

  const runtime = await page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
      canvas: `${canvas.width}x${canvas.height}`,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : 'unavailable',
    };
  });

  const samples = [];
  for (let index = 0; index < SAMPLES; ++index) {
    const sample = await measureSample(page);
    samples.push(sample);
    console.log(
      `${LABEL} sample ${index + 1}/${SAMPLES}: ` +
      `${sample.fps.toFixed(2)} FPS (low 1s ${sample.lowOneSecondFps.toFixed(2)})`,
    );
    await page.waitForTimeout(1000);
  }

  await page.screenshot({
    path: path.join(RESULTS_DIR, `${LABEL}.png`),
    timeout: 10000,
  });

  const fps = samples.map((sample) => sample.fps);
  const lowOneSecondFps = samples.map((sample) => sample.lowOneSecondFps);
  const summary = {
    label: LABEL,
    timestamp: new Date().toISOString(),
    benchmark: {
      samples: SAMPLES,
      sampleSeconds: SAMPLE_SECONDS,
      warmupSeconds: WARMUP_SECONDS,
      countGl: COUNT_GL,
      preferences,
      runtime,
      inactiveCapOverride: await page.evaluate(
        () => window.__module._wasm_perf_get_ignore_inactive_fps_cap(),
      ),
    },
    medianFps: median(fps),
    minFps: Math.min(...fps),
    maxFps: Math.max(...fps),
    medianLowOneSecondFps: median(lowOneSecondFps),
    samples,
    relevantLogs: logs.filter((line) =>
      /pageerror|CRASH|abort|exception|WebGL.*error|INVALID_OPERATION/i.test(line)),
  };

  fs.writeFileSync(
    path.join(RESULTS_DIR, `${LABEL}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `${LABEL} median: ${summary.medianFps.toFixed(2)} FPS; ` +
    `median low 1s: ${summary.medianLowOneSecondFps.toFixed(2)} FPS`,
  );
  console.log(`renderer: ${runtime.renderer}`);
  console.log(`preferences: ${JSON.stringify(preferences)}`);

  await browser.close();
  server.close();
})().catch((error) => {
  console.error('BENCHMARK ERROR:', error);
  process.exitCode = 1;
});
