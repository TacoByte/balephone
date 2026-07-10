const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const BUILD_DIR = path.resolve(__dirname, '../build');
const PORT = 8794;
const REMOTE = Boolean(process.env.GAME_ORIGIN);
const GAME_ORIGIN = (process.env.GAME_ORIGIN || `http://127.0.0.1:${PORT}`)
  .replace(/\/+$/, '');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const requested =
        decodeURIComponent(request.url.split('?')[0]).replace(/^\//, '') || 'index.html';
      const file = path.join(BUILD_DIR, requested);
      fs.readFile(file, (error, data) => {
        if (error) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        });
        response.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function boot(page, scenario) {
  await page.goto(`${GAME_ORIGIN}/index.html?scenario=${scenario}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => {
      const M = window.__module;
      if (!M || !M.FS) return false;
      try {
        return M.FS.readdir('/home/web_user/.alephone')
          .some((name) => name.endsWith(' Preferences'));
      } catch (_) {
        return false;
      }
    },
    null,
    { timeout: 60000 },
  );
}

async function readPreferences(page) {
  return page.evaluate(() => {
    const M = window.__module;
    const directory = '/home/web_user/.alephone';
    const name = M.FS.readdir(directory)
      .find((candidate) => candidate.endsWith(' Preferences'));
    return {
      name,
      text: M.FS.readFile(`${directory}/${name}`, { encoding: 'utf8' }),
    };
  });
}

async function seedLegacyDisabledHud(page) {
  await page.evaluate(async () => {
    const M = window.__module;
    const directory = '/home/web_user/.alephone';
    const name = M.FS.readdir(directory)
      .find((candidate) => candidate.endsWith(' Preferences'));
    const preferencesPath = `${directory}/${name}`;
    const text = M.FS.readFile(preferencesPath, { encoding: 'utf8' });
    const updated = text.replace(
      '</environment>',
      '\t<disable_plugin path="$default$/Plugins/Enhanced HUD"/>\n  </environment>',
    );
    if (updated === text) throw new Error('could not seed legacy Enhanced HUD preference');
    M.FS.writeFile(preferencesPath, updated);
    await new Promise((resolve, reject) => {
      M.FS.syncfs(false, (error) => error ? reject(error) : resolve());
    });
  });
}

(async () => {
  const server = REMOTE ? null : await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });

  try {
    for (const scenario of ['marathon', 'marathon2', 'infinity']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const runtimeErrors = [];
      page.on('pageerror', (error) => {
        if (!error.message.includes('not valid for pointer lock')) {
          runtimeErrors.push(error.message);
        }
      });

      await boot(page, scenario);
      const preferences = await readPreferences(page);
      assert(
        !/<disable_plugin[^>]*Enhanced HUD[^>]*>/.test(preferences.text),
        `${scenario} disables Enhanced HUD in ${preferences.name}`,
      );

      if (scenario === 'marathon2') {
        await seedLegacyDisabledHud(page);
        await boot(page, scenario);
        const migrated = await readPreferences(page);
        assert(
          !/<disable_plugin[^>]*Enhanced HUD[^>]*>/.test(migrated.text),
          'legacy browser preferences did not migrate to Enhanced HUD',
        );
      }

      assert.deepStrictEqual(runtimeErrors, []);
      await context.close();
      console.log(`${scenario}: Enhanced HUD enabled`);
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) server.close();
  }
})().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
