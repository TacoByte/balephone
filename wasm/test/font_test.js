// Check on-screen message text renders correctly (a/e were broken in OGL font atlas).
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '../build');
const PORT = 8793;
const MESSAGE = 'A careful reader can see a and e: aaaa eeee';
const MESSAGE_LUA = `
Triggers = {}

local function show_message()
  Players.print("${MESSAGE}")
end

function Triggers.init()
  show_message()
end

function Triggers.idle()
  show_message()
end
`;

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(BUILD_DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(file);
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function click(page, fx, fy) {
  const box = await (await page.$('canvas')).boundingBox();
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
}

(async () => {
  const server = await startServer(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 810 } })).newPage();
  const logs = [];
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

  // Boot once to create preferences, then force OpenGL and install a solo
  // script that continuously displays the glyph regression message.
  await page.goto(`http://127.0.0.1:${PORT}/?scenario=marathon2`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);
  await page.evaluate(async ({ messageLua }) => {
    const module = window.__module;
    const directory = '/home/web_user/.alephone';
    const preferencesPath = `${directory}/Marathon 2 Preferences`;
    const luaPath = `${directory}/font-regression.lua`;
    let preferences = module.FS.readFile(preferencesPath, { encoding: 'utf8' });

    preferences = preferences.replace(/scmode_accel="\d+"/, 'scmode_accel="1"');
    preferences = preferences.replace(/use_solo_lua="[^"]*"/, 'use_solo_lua="true"');
    preferences = preferences.replace(
      /solo_lua_file="[^"]*"/,
      `solo_lua_file="${luaPath}"`,
    );

    module.FS.writeFile(luaPath, messageLua);
    module.FS.writeFile(preferencesPath, preferences);
    await new Promise((resolve, reject) => {
      module.FS.syncfs(false, (error) => error ? reject(error) : resolve());
    });
  }, { messageLua: MESSAGE_LUA });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);

  // New Game -> start first level
  await click(page, 0.325, 0.403);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'font_message.png' });
  fs.writeFileSync('font_console.log', logs.join('\n'));

  if (!logs.some((line) => line.includes('GL_RENDERER: GL4ES using WebKit WebGL'))) {
    throw new Error('OpenGL renderer did not initialize');
  }
  const fatalLogs = logs.filter((line) =>
    /CRASH|Aborted|Failed to initialize OpenGL|Retrying with Software renderer/i.test(line),
  );
  if (fatalLogs.length) throw new Error(fatalLogs.join('\n'));

  await browser.close().catch(() => {});
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
