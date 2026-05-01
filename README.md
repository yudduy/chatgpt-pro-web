# chatgpt-pro-web

A tiny CLI for [chatgpt.com](https://chatgpt.com) that drives a real Pro/Plus browser session via Playwright. No API key, no API cost — uses your existing ChatGPT subscription quota.

Useful when you want `gpt-5-pro` / `o3-pro` / `gpt-5-thinking` from a terminal, shell pipeline, or agent workflow.

```bash
chatgpt-pro-web "Explain Banach fixed-point in one sentence" --model gpt-5
chatgpt-pro-web "Hard problem here…" --model gpt-5-pro --timeout 60 -o reply.md
chatgpt-pro-web "follow up" --continue https://chatgpt.com/c/<id>
```

## Why

The Pro models aren't on the public API. This bridges the gap by automating the web UI through a persistent, signed-in Playwright profile.

Tolerates Pro's 2–30 minute "thinking" phase by polling for the stop-button to be absent for a sustained 5 s window before extracting the reply.

## Install

```bash
git clone https://github.com/yudduy/chatgpt-pro-web.git
cd chatgpt-pro-web
npm install
npx playwright install chromium

# Optional: put it on your PATH
ln -s "$PWD/cli.js"  ~/.local/bin/chatgpt-pro-web
ln -s "$PWD/auth.js" ~/.local/bin/chatgpt-pro-web-auth
```

Requires Node ≥ 18 and a [ChatGPT](https://chatgpt.com) account (Pro recommended for `gpt-5-pro` / `o3-pro`).

## First-time auth

```bash
npm run auth        # or: chatgpt-pro-web-auth
```

A Chromium window opens. Log in normally (email + password + 2FA). The window auto-closes once the session cookie is detected. Your login is saved to `./profile/` — a persistent Playwright user-data-dir scoped to this checkout. **Do not share or commit `profile/`.**

## Usage

```
chatgpt-pro-web "prompt" [--model NAME] [--continue URL] [-o FILE] [--timeout MIN] [--headless]
```

| Flag | Default | Notes |
|---|---|---|
| `--model` | account default | `gpt-5-pro`, `gpt-5-thinking`, `o3-pro`, `gpt-5`, … |
| `--continue` | new chat | conversation URL printed by a previous run |
| `-o` / `--output` | stdout | write reply to file; URL still goes to stdout |
| `--timeout` | `45` | minutes to wait for completion |
| `--headless` | off | chatgpt.com blocks headless — leave it off |

Stdout always ends with `CONVERSATION_URL: https://chatgpt.com/c/<id>` so you can pipe or capture it for `--continue` follow-ups.

```bash
URL=$(chatgpt-pro-web "first question" -o reply1.md)
chatgpt-pro-web "follow-up" --continue "$URL" -o reply2.md
```

## How it works

1. `auth.js` — opens chatgpt.com in a headed Chromium with a persistent profile dir, polls `/backend-api/me` until a real session is detected, then closes.
2. `cli.js` — relaunches that profile, navigates to `chatgpt.com/?model=<name>` (or your `--continue` URL), pastes the prompt into the ProseMirror composer via clipboard, presses Enter, and waits for the stop-button to disappear for 5 s straight (Pro's thinking → searching → writing phases each toggle it).
3. The reply is extracted by clicking the per-turn "Copy" button and reading the clipboard (preserves markdown), with `innerText` fallback.

About 340 lines total. Dependencies: `playwright`.

## Caveats

- **Headless is blocked.** chatgpt.com aborts headless Chromium. The CLI runs headed by default; expect a brief window to flash open per call.
- **Sandboxed agents may fail.** Restrictive macOS sandbox profiles (e.g. some agentic CLIs running with `--full-auto`) block Chromium's Mach port rendezvous and crash the launch with `Permission denied (1100)` / `SIGTRAP`. Workaround: run from a normal shell, or write the prompt to a file and shell out unsandboxed.
- **Selectors track ChatGPT's DOM.** OpenAI changes the UI occasionally. If extraction breaks, the selectors at the top of `cli.js` (`COMPOSER`, `STOP_BUTTON`, `ASSISTANT_TURN`) are the things to update.
- **Account quota applies.** This consumes your normal Pro/Plus message limit. It is not a way around rate limits.
- **ToS.** Browser automation of chatgpt.com may violate OpenAI's terms in some contexts. Use against your own account, at your own risk.

## License

MIT
