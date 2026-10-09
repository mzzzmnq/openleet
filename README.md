# openleet

A Tampermonkey userscript that drops a problem-aware AI chat panel into LeetCode,
powered by your own **OpenCode Go** models — hints, code explanation, and debugging,
like LeetCode's built-in assistant but on your own quota.

```
leetcode.com  --GM_xmlhttpRequest-->  https://opencode.ai/zen/go/v1/chat/completions
```

**No server, no build step.** The script talks to OpenCode Go directly. The API key
is stored in Tampermonkey's own storage (`GM_setValue`) and never leaves your browser
except in requests to `opencode.ai`.

## Why a userscript (and why `GM_xmlhttpRequest`)

`opencode.ai` does **not** send CORS headers (`OPTIONS` → 404, `POST` has no
`Access-Control-Allow-Origin`), so a page `fetch` is blocked by the browser.
Tampermonkey's `GM_xmlhttpRequest` issues the request from the extension layer and
bypasses CORS — that is what makes a pure client-side plugin possible.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `openleet.user.js` (or drag it into the browser) and confirm the install,
   or create a new script and paste its contents.
3. Open any `https://leetcode.com/problems/...`.
4. Click **⚙** in the panel and paste your **OpenCode Go API key** (`oc_sk_…`).
   The status dot turns green when it checks out.

## Usage

- Pick a mode, click **读取题目**, then ask (Enter to send, Shift+Enter for newline).
- Every request automatically includes the problem title, difficulty, tags, link,
  description, and your editor code (read from the page's Monaco model, falling back
  to DOM text; can be turned off in settings).

### Three skills

| Mode | Behavior |
| --- | --- |
| 分步提示 (step-by-step hints) | Socratic: one key step at a time; no ready-to-submit code unless you ask |
| 讲代码+复杂度 (explain) | Walks through your code and derives time/space complexity |
| Debug 报错 (debug) | Locates the root cause from the error / failing case + code, suggests a minimal fix |

The panel supports streaming output, a collapsible reasoning trace, one-click code
copy, a dark theme, and resets the conversation when you switch problems (LeetCode
is an SPA).

## Supported models

OpenAI-compatible `/chat/completions` models only (25 of them: DeepSeek, GLM, Kimi,
MiMo, Hy, LongCat, …). MiniMax / Qwen use `/v1/messages` and Grok / Muse use
`/v1/responses`; those protocols are not implemented, and picking them errors out.
The model list is in the script (`FALLBACK_MODELS`).

## Offline demo

Open `demo.html?ocleet=1` in a browser. It stubs the Tampermonkey APIs with a canned
streaming reply, so you can preview the panel with **no key and no network**.

## Notes / limits

- The userscript must be installed via Tampermonkey (or a compatible manager);
  loaded as a plain page script it cannot bypass CORS.
- The request has a 180-second timeout.
- Live model listing from `/v1/models` needs no key, but the endpoint protocol is not
  exposed there, which is why the chat-model list is maintained by hand.
