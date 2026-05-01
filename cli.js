#!/usr/bin/env node
/**
 * chatgpt-pro-web — CLI for chatgpt.com (Pro/Plus quota).
 *
 * Usage:
 *   chatgpt-pro-web "prompt"
 *   chatgpt-pro-web "prompt" --model gpt-5-pro
 *   chatgpt-pro-web "prompt" -o out.md                         # writes response to file, prints conv URL
 *   chatgpt-pro-web "prompt" --continue <conv_url> -o out.md   # multi-turn
 *   chatgpt-pro-web "prompt" --timeout 45                      # minutes; default 45
 *   chatgpt-pro-web "prompt" --headless                        # hide window (may be blocked by anti-bot)
 *
 * Default runs headed because chatgpt.com blocks headless Chromium.
 *
 * Auth: run `npm run auth` (or the `chatgpt-pro-web-auth` shim) first to create
 * a persistent Playwright profile under ./profile/. cli.js reuses it headless.
 */
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dirname, 'profile');

const COMPOSER = '#prompt-textarea';
const STOP_BUTTON = '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]';
const ASSISTANT_TURN = '[data-message-author-role="assistant"]';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    prompt: null,
    model: null,
    output: null,
    convUrl: null,
    timeoutMs: 45 * 60 * 1000,
    headless: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--model' || a === '-m') && args[i + 1]) opts.model = args[++i];
    else if ((a === '-o' || a === '--output') && args[i + 1]) opts.output = args[++i];
    else if (a === '--continue' && args[i + 1]) opts.convUrl = args[++i];
    else if (a === '--timeout' && args[i + 1]) opts.timeoutMs = parseInt(args[++i], 10) * 60 * 1000;
    else if (a === '--headless') opts.headless = true;
    else if (a === '--headed') opts.headless = false;
    else if (!a.startsWith('-') && !opts.prompt) opts.prompt = a;
  }
  if (!opts.prompt) {
    console.error(`Usage: chatgpt-pro-web "prompt" [--model name] [--continue <conv_url>] [-o file] [--timeout minutes] [--headed]

  --model    Examples: gpt-5-pro, gpt-5-thinking, o3-pro, gpt-5 (omit for account default)
  --continue Conversation URL printed by a previous run (e.g. https://chatgpt.com/c/abc-123)
  --timeout  Max minutes to wait for response (default 45)
  --headless Hide the browser window (default: headed; chatgpt.com blocks headless)

First-time setup: run \`npm run auth\` inside ${__dirname} to log in.`);
    process.exit(1);
  }
  return opts;
}

async function waitForComposer(page) {
  try {
    await page.waitForSelector(COMPOSER, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function fillComposer(page, prompt) {
  // ProseMirror contenteditable — pasting via clipboard is fast and reliable for long prompts.
  const composer = await page.waitForSelector(COMPOSER);
  await composer.click();
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, prompt);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+V`);
  // Give ProseMirror a tick to settle before submit.
  await page.waitForTimeout(200);
}

async function submitAndWait(page, timeoutMs) {
  // Count assistant turns before send — we want the NEW one.
  const turnsBefore = await page.$$eval(ASSISTANT_TURN, (els) => els.length);

  await page.keyboard.press('Enter');

  // Wait for a new assistant turn to appear.
  await page.waitForFunction(
    ([sel, before]) => document.querySelectorAll(sel).length > before,
    [ASSISTANT_TURN, turnsBefore],
    { timeout: 60_000 }
  );

  // Stop button may appear and disappear multiple times during Pro's thinking/searching/writing phases.
  // Wait until it has been absent for a sustained window (5s) — signals true completion.
  const deadline = Date.now() + timeoutMs;
  const QUIET_MS = 5_000;
  let quietSince = null;
  while (Date.now() < deadline) {
    const present = (await page.$(STOP_BUTTON)) !== null;
    if (present) {
      quietSince = null;
    } else {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= QUIET_MS) return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Response did not finish within ${Math.round(timeoutMs / 60000)} min.`);
}

async function extractLastAssistant(page) {
  // Preferred path: click the per-turn copy button, read clipboard for original markdown.
  const clipboardText = await page
    .evaluate(async () => {
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (!turns.length) return null;
      const last = turns[turns.length - 1];
      // ChatGPT wraps each turn in a <section data-testid="conversation-turn-N">.
      const turnSection = last.closest('[data-testid^="conversation-turn-"]') || last.parentElement;
      if (!turnSection) return null;
      const btn = turnSection.querySelector(
        '[data-testid="copy-turn-action-button"], button[aria-label="Copy"], button[data-testid*="copy"]'
      );
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    })
    .catch(() => null);

  if (clipboardText && clipboardText.trim()) return clipboardText;

  // Fallback: innerText of the last assistant turn's content area.
  return page.$$eval(ASSISTANT_TURN, (els) => {
    const last = els[els.length - 1];
    return last ? last.innerText : '';
  });
}

async function main() {
  const opts = parseArgs();
  if (!existsSync(PROFILE_DIR) || readdirSync(PROFILE_DIR).length === 0) {
    console.error(`No profile at ${PROFILE_DIR}. Run: npm run auth`);
    process.exit(2);
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://chatgpt.com',
  });

  const page = ctx.pages()[0] || (await ctx.newPage());

  let targetUrl;
  if (opts.convUrl) targetUrl = opts.convUrl;
  else if (opts.model) targetUrl = `https://chatgpt.com/?model=${encodeURIComponent(opts.model)}`;
  else targetUrl = 'https://chatgpt.com/';

  console.error(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  if (!(await waitForComposer(page))) {
    console.error('Composer never appeared. Likely hit a Cloudflare challenge. Try: chatgpt-pro-web-auth');
    await ctx.close();
    process.exit(2);
  }

  const cookies = await ctx.cookies('https://chatgpt.com').catch(() => []);
  const authCookieNames = [
    '__Secure-next-auth.session-token',
    '__Secure-next-auth.session-token.0',
    '__Host-next-auth.csrf-token',
    '__Secure-authjs.session-token',
    'auth0_compat',
  ];
  const hasAuthCookie = cookies.some((c) => authCookieNames.includes(c.name) && c.value && c.value.length > 20);
  if (!hasAuthCookie) {
    console.error('Not logged in (no session cookie). Run: chatgpt-pro-web-auth');
    await ctx.close();
    process.exit(2);
  }

  console.error('Submitting prompt...');
  await fillComposer(page, opts.prompt);

  console.error(`Waiting up to ${Math.round(opts.timeoutMs / 60000)} min for response...`);
  try {
    await submitAndWait(page, opts.timeoutMs);
  } catch (err) {
    console.error(`Fatal: ${err.message}`);
    await ctx.close();
    process.exit(1);
  }

  // After the stream finishes, wait briefly for the URL to land on /c/<id>
  // (ChatGPT redirects a few hundred ms after streaming starts, but not always before).
  if (!/\/c\//.test(page.url())) {
    await page.waitForURL(/\/c\//, { timeout: 10_000 }).catch(() => {});
  }

  const text = await extractLastAssistant(page);
  const convUrl = page.url();

  if (!text || !text.trim()) {
    console.error('Empty response extracted. The conversation is saved at:', convUrl);
    await ctx.close();
    process.exit(1);
  }

  if (opts.output) {
    writeFileSync(opts.output, text);
    process.stdout.write(convUrl);
    console.error(`\nWritten to ${opts.output}`);
  } else {
    process.stdout.write(text);
    process.stdout.write(`\n\nCONVERSATION_URL: ${convUrl}\n`);
  }

  await ctx.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
