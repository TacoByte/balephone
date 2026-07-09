// Transparent liquids probe. Uses a solo Lua script to teleport the player
// into deep water right after level load, then screenshots. Runs three
// configurations:
//   1. OpenGL renderer (LiqSeeThru is on by default)
//   2. Software renderer, alpha blending "nice"
//   3. Software renderer, alpha blending off (opaque control)
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '../build');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
};

const LUA = `
Triggers = {}
local done = false
function Triggers.idle()
  if done then return end
  local best = nil
  for p in Polygons() do
    if p.media and (p.media.height - p.floor.height) > 1.2 then
      best = p
      break
    end
  end
  if best then
    local pl = Players[0]
    pl:position(best.x, best.y, best.floor.height, best)
    done = true
  end
end
`;

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(BUILD_DIR, req.url.split('?')[0].replace(/^\//, '') || 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function bootAndWait(page) {
  await page.goto('http://127.0.0.1:8785/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
}

// Edit prefs + drop the lua file in the persisted dir, then sync.
async function configure(page, attrs, enablePlugin) {
  return page.evaluate(async ({ attrs, lua, enablePlugin }) => {
    const M = window.__module;
    const dir = '/home/web_user/.alephone';
    M.FS.writeFile(dir + '/water.lua', lua);
    const p = dir + '/Marathon 2 Preferences';
    let txt = M.FS.readFile(p, { encoding: 'utf8' });
    if (enablePlugin) {
      // The M2 scenario's default prefs disable the Transparent Liquids
      // plugin; drop that line so its opacity MML loads.
      txt = txt.replace(/^.*<disable_plugin[^>]*Transparent Liquids[^>]*>.*\n/m, '');
    }
    for (const [k, v] of Object.entries(attrs)) {
      const re = new RegExp(k + '="[^"]*"');
      if (re.test(txt)) txt = txt.replace(re, `${k}="${v}"`);
      else txt = txt.replace(/<graphics /, `<graphics ${k}="${v}" `);
    }
    // environment attrs live on <environment>
    if (!/use_solo_lua=/.test(txt)) throw new Error('no use_solo_lua attr');
    txt = txt.replace(/use_solo_lua="[^"]*"/, 'use_solo_lua="true"');
    if (/solo_lua_file=/.test(txt))
      txt = txt.replace(/solo_lua_file="[^"]*"/, `solo_lua_file="${dir}/water.lua"`);
    else
      txt = txt.replace(/<environment /, `<environment solo_lua_file="${dir}/water.lua" `);
    M.FS.writeFile(p, txt);
    await new Promise((res, rej) => M.FS.syncfs(false, (e) => e ? rej(e) : res()));
    return txt.match(/scmode_accel="\d+"|software_alpha_blending="\d+"|ogl_flags="\d+"/g).join(' ')
      + (txt.includes('Transparent Liquids') ? ' [plugin DISABLED]' : ' [plugin enabled]');
  }, { attrs, lua: LUA, enablePlugin });
}

async function startGame(page) {
  const box = await (await page.$('canvas')).boundingBox();
  await page.mouse.click(box.x + 0.325 * box.width, box.y + 0.403 * box.height);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(9000); // level load + lua teleport + settle
}

async function shots(page, prefix) {
  await page.screenshot({ path: `${prefix}_a.png`, timeout: 8000 }).catch(() => console.log('HUNG at ' + prefix));
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowLeft');
  await page.screenshot({ path: `${prefix}_b.png`, timeout: 8000 }).catch(() => {});
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowLeft');
  await page.screenshot({ path: `${prefix}_c.png`, timeout: 8000 }).catch(() => {});
}

(async () => {
  const server = await startServer(8785);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  // Boot once to create prefs.
  await bootAndWait(page);

  // ogl_flags 19329 = scenario default 19073 + LiqSeeThru (0x100)
  const runs = [
    ['water_gl', { scmode_accel: 1, ogl_flags: 19329 }, true],
    ['water_sw_nice', { scmode_accel: 0, software_alpha_blending: 2 }, true],
    ['water_sw_off', { scmode_accel: 0, software_alpha_blending: 0 }, true],
  ];

  for (const [name, attrs, enablePlugin] of runs) {
    const state = await configure(page, attrs, enablePlugin);
    console.log(name, '->', state);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(13000);
    await startGame(page);
    await shots(page, name);
  }

  fs.writeFileSync('water_console.log', logs.join('\n'));
  const interesting = logs.filter(l => /lua|plugin|mml|error|warn/i.test(l) && !/INVALID_ENUM|ScriptProcessor|pointer lock|GL Driver/.test(l));
  console.log('--- interesting ---');
  console.log(interesting.slice(-20).join('\n'));

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
