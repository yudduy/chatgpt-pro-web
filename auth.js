#!/usr/bin/env node
/**
 * One-time auth for chatgpt-pro-web.
 *
 * Opens a headed Chromium window with a persistent profile under ./profile/.
 * You log in (email + password + any 2FA). Window closes once
 * /backend-api/me returns a real account (non-empty email or name).
 *
 * Usage:
 *   npm run auth
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dirname, 'profile');

if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});

let browserClosed = false;
ctx.on('close', () => { browserClosed = true; });

const page = ctx.pages()[0] || (await ctx.newPage());

console.error('Opening chatgpt.com — click "Log in" and complete sign-in.');
console.error('This window closes automatically once a real session is detected.');
console.error('Heartbeat every 10s. Close the window to abort.\n');

await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

const startedAt = Date.now();
let lastHeartbeat = 0;

while (true) {
  if (browserClosed) {
    console.error('Browser window closed before login completed. Aborting.');
    process.exit(1);
  }

  const cookies = await ctx.cookies('https://chatgpt.com').catch(() => []);
  const authCookieNames = [
    '__Secure-next-auth.session-token',
    '__Secure-next-auth.session-token.0',
    '__Secure-authjs.session-token',
  ];
  const authCookies = cookies.filter((c) => authCookieNames.includes(c.name) && c.value && c.value.length > 20);

  const me = await page
    .evaluate(async () => {
      try {
        const r = await fetch('/backend-api/me', { credentials: 'include' });
        if (!r.ok) return { status: r.status };
        const j = await r.json();
        return { id: j.id || '', email: j.email || '', name: j.name || '' };
      } catch (e) {
        return { error: String(e) };
      }
    })
    .catch(() => null);

  const meLoggedIn = me && me.id && !String(me.id).startsWith('ua-') && (me.email || me.name);
  const cookieLoggedIn = authCookies.length > 0;
  if (meLoggedIn || cookieLoggedIn) {
    const who = (me && (me.email || me.name || me.id)) || authCookies.map((c) => c.name).join(',');
    console.error(`Detected login: ${who}`);
    break;
  }

  const now = Date.now();
  if (now - startedAt > 30 * 60 * 1000) {
    console.error('Timed out after 30 minutes waiting for login.');
    await ctx.close();
    process.exit(1);
  }

  if (now - lastHeartbeat > 10_000) {
    const url = page.url();
    const secs = Math.round((now - startedAt) / 1000);
    const cookieNames = cookies.map((c) => c.name).sort().join(',');
    const meSummary = me ? JSON.stringify(me) : 'no-me';
    console.error(`[${secs}s] anonymous — page: ${url.slice(0, 60)} — me: ${meSummary} — cookies: ${cookieNames.slice(0, 200)}`);
    lastHeartbeat = now;
  }

  await new Promise((r) => setTimeout(r, 2000));
}

await page.waitForTimeout(1500);
console.error(`\nLogged in. Profile saved to:\n  ${PROFILE_DIR}`);
console.error('You can now run: chatgpt-pro-web "your prompt"');
await ctx.close();
process.exit(0);
