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
4. Click **⚙** in the panel, choose a **供应商 (provider)**, and paste that provider's key:
   - **智谱 GLM**（默认，免费）— key from <https://open.bigmodel.cn/>
   - **OpenCode Go** — key `oc_sk_…`

   切换供应商时，**接口地址、模型列表、key 都会自动跟着切**；而且**每家各存一把 key**，
   来回切换不会把一家的 key 发到另一家。

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

## Providers & models

在 **⚙ → 供应商** 里切换；接口地址、模型列表、API key 都随供应商自动切换。

| 供应商 | 默认模型 | 备注 |
| --- | --- | --- |
| **智谱 GLM**（默认） | `glm-4.5-flash` | 永久免费、国内直连；`glm-4.7-flash` 也免费但常被限流 |
| **OpenCode Go** | `longcat-2.5-preview-free` | 需自己的 key（脚本不读本机凭据）；自动带 `x-opencode-session` |

OpenAI-compatible `/chat/completions` only. MiniMax / Qwen use `/v1/messages`,
Grok / Muse use `/v1/responses` — 未实现，选了会报错。
模型清单在脚本里（`ZHIPU_MODELS` / `OPENCODE_MODELS`）。

## Offline demo

Open `demo.html?ocleet=1` in a browser. It stubs the Tampermonkey APIs with a canned
streaming reply, so you can preview the panel with **no key and no network**.

## 存入 LeetNote（可选）

配合本机的 [LeetNote](https://github.com/mzzzmnq/leetnote)，可以把**当前题目 + 编辑器代码 +
最近一次 AI 讲解**一键存成一篇笔记，并按 `slug` 关联题单里已有的题目（重复导入会更新同一篇，不会重复建）。

1. 在 LeetNote 里生成一把长期令牌（明文只显示一次）：

   ```powershell
   cd leetnote-api
   go run ./cmd/token -user <你的用户名> -name "openleet 插件"
   ```

2. 在本脚本面板点 **⚙**，填入 **LeetNote 地址**（默认 `http://127.0.0.1:8080`）和 **令牌**（`ln_…`）。
3. 点面板里的 **存入 LeetNote**。

令牌只留在 Tampermonkey 存储里；请求经 `GM_xmlhttpRequest` 直达本机 LeetNote
（脚本元数据里因此加了 `@connect 127.0.0.1` / `@connect localhost`，以扩展层绕过 CORS）。
LeetNote 没在跑或令牌无效时，面板会给出明确提示。

## Notes / limits

- The userscript must be installed via Tampermonkey (or a compatible manager);
  loaded as a plain page script it cannot bypass CORS.
- The request has a 180-second timeout.
- Live model listing from `/v1/models` needs no key, but the endpoint protocol is not
  exposed there, which is why the chat-model list is maintained by hand.
