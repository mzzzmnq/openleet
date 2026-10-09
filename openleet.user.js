// ==UserScript==
// @name         openleet · 题目 AI 助手
// @namespace    opencode-leet
// @version      2.0.0
// @description  在 LeetCode 题目页嵌入 OpenCode Go 模型的对话面板：分步提示 / 讲代码+复杂度 / Debug 报错。纯前端，直接用你的 OpenCode Go key，不依赖任何本地服务。
// @author       opencode-leet
// @match        https://leetcode.com/problems/*
// @match        https://leetcode.cn/problems/*
// @match        https://www.leetcode.com/problems/*
// @match        https://www.leetcode.cn/problems/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      opencode.ai
// @run-at       document-idle
// ==/UserScript==

/**
 * openleet（独立版）
 * =======================
 * 一个纯前端用户脚本：在 LeetCode 题目页右下角注入对话面板，直接调用 OpenCode Go
 * 的 OpenAI 兼容接口，不需要任何本地服务（不依赖 openleet）。
 *
 *   browser (leetcode.com)  --GM_xmlhttpRequest-->  https://opencode.ai/zen/go/v1/chat/completions
 *
 * 为什么必须用 GM_xmlhttpRequest：opencode.ai 不返回 CORS 头，页面里的 fetch 会被
 * 浏览器拦（实测 OPTIONS 404、POST 无 Access-Control-Allow-Origin）；油猴的
 * GM_xmlhttpRequest 在扩展层发请求，可绕过 CORS。API key 存在油猴自己的存储里
 * （GM_setValue），不写进页面、不发往别处。
 *
 * 三种 skill：
 *   hint    分步提示（Socratic）
 *   explain 讲代码 + 复杂度
 *   debug   Debug 报错
 *
 * 注意：必须通过 Tampermonkey 安装。若检测不到 GM_xmlhttpRequest（例如被当作普通
 * 网页脚本加载），会退回 fetch —— 那样会因 CORS 失败。
 */
(function () {
  "use strict";

  const IS_LEETCODE = /(^|\.)leetcode\.(com|cn)$/.test(location.hostname);
  const IS_DEMO = new URLSearchParams(location.search).has("ocleet");
  if (!IS_LEETCODE && !IS_DEMO) return;
  if (window.__OCLEET_MOUNTED__) return;
  window.__OCLEET_MOUNTED__ = true;

  /* ------------------------------------------------------------------ shims */
  const PAGE = (() => {
    try {
      return typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
    } catch {
      return window;
    }
  })();

  function addStyle(css) {
    if (typeof GM_addStyle === "function") {
      try {
        return GM_addStyle(css);
      } catch {
        /* fall through */
      }
    }
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  }

  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === "function") return GM_getValue(key, def);
      } catch {
        /* ignore */
      }
      try {
        const raw = localStorage.getItem("ocleet:" + key);
        return raw == null ? def : JSON.parse(raw);
      } catch {
        return def;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === "function") return GM_setValue(key, value);
      } catch {
        /* ignore */
      }
      try {
        localStorage.setItem("ocleet:" + key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    },
  };

  /* ----------------------------------------------------------------- config */
  const DEFAULTS = {
    apiKey: "",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "deepseek-v4.1-flash",
    includeCode: true,
    autoRead: true,
    mode: "hint",
  };
  const cfg = { ...DEFAULTS, ...(store.get("config") || {}) };
  const saveCfg = () => store.set("config", cfg);
  const goBase = () => (cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const chatUrl = () => goBase() + "/chat/completions";
  const usageUrl = () => goBase() + "/usage";

  // 走 Go 的 OpenAI 兼容 /chat/completions 的模型（MiniMax/Qwen 走 /messages、
  // Grok/Muse 走 /responses，不在这个列表里）。
  const FALLBACK_MODELS = [
    { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp" },
    { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
    { id: "glm-5.3", label: "GLM-5.3" },
    { id: "glm-5.2", label: "GLM-5.2" },
    { id: "glm-5.1", label: "GLM-5.1" },
    { id: "glm-5", label: "GLM-5" },
    { id: "kimi-k3", label: "Kimi K3" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
    { id: "kimi-k2.6", label: "Kimi K2.6" },
    { id: "kimi-k2.5", label: "Kimi K2.5" },
    { id: "longcat-2.0", label: "LongCat-2.0" },
    { id: "longcat-2.5-preview-free", label: "LongCat 2.5 Preview Free" },
    { id: "step-5-preview-free", label: "Step 5 Preview Free" },
    { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash" },
    { id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro" },
    { id: "mimo-v2.5", label: "MiMo-V2.5" },
    { id: "mimo-v2.5-pro", label: "MiMo-V2.5-Pro" },
    { id: "mimo-v2-pro", label: "MiMo-V2 Pro" },
    { id: "mimo-v2-omni", label: "MiMo V2 Omni" },
    { id: "hy4-preview", label: "Hy4 preview" },
    { id: "hy3", label: "Hy3" },
    { id: "space-bunny", label: "Space Bunny" },
  ];

  /* ----------------------------------------------------------------- skills */
  const BASE_SYSTEM = [
    "你是一个嵌入在 LeetCode 题目页里的编程助教，只围绕当前这道题帮助用户，用简体中文回答。",
    "当前题目信息会附在本条消息后面。",
    "要求：",
    "- 不要编造题目里没有的约束；不确定就明确说不确定。",
    "- 代码放进 Markdown 代码块；行内术语用反引号；公式尽量用简单文字或反引号。",
    "- 回答保持聚焦、简短，不要复述整道题。",
  ].join("\n");

  const SKILLS = {
    hint: {
      label: "分步提示",
      tip: "我不会直接给答案，一次只推进一步。",
      placeholder: "说一下你卡在哪，或直接点发送拿第一步提示…",
      quick: "给我第一步提示",
      system: [
        "模式：分步提示（Socratic）。",
        "- 目标是引导用户自己想到解法，而不是直接给答案。",
        "- 先给一条最关键的观察 / 第一步，然后问用户是否继续。",
        "- 除非用户明确说“给完整解法”，不要输出可直接提交的完整代码。",
        "- 用户卡住时，用一个小例子或反例来引导。",
      ].join("\n"),
    },
    explain: {
      label: "讲代码+复杂度",
      tip: "结合你现在的代码逐段解释，并给出复杂度。",
      placeholder: "可以贴一段代码，或直接让我讲当前编辑器里的代码…",
      quick: "解释我现在的代码，并分析时间复杂度与空间复杂度",
      system: [
        "模式：讲代码 + 复杂度。",
        "- 结合用户当前代码逐段解释它在做什么、用了什么数据结构 / 思路。",
        "- 明确给出时间复杂度和空间复杂度，并解释是怎么推导出来的。",
        "- 代码没写完或有问题就点出来，再解释思路。",
        "- 除非用户要求，不要直接重写整段代码。",
      ].join("\n"),
    },
    debug: {
      label: "Debug 报错",
      tip: "把报错或失败用例贴进来，我来定位问题。",
      placeholder: "贴上报错信息 / 失败的用例（输入、期望输出、实际输出）…",
      quick: "帮我找出当前代码里的 bug",
      system: [
        "模式：Debug 报错。",
        "- 优先根据用户给的报错、失败用例和当前代码定位根因。",
        "- 先说清你认为的根因，再给最小的修改建议（尽量只改必要的几行）。",
        "- 缺少信息时，明确列出需要用户补什么：哪组输入、期望输出、实际输出。",
        "- 不要顺手重写整个解法。",
      ].join("\n"),
    },
  };

  /* ---------------------------------------------------------------- markdown */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function renderMarkdown(src) {
    const codeBlocks = [];
    let text = String(src || "").replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
      codeBlocks.push(code.replace(/\n$/, ""));
      return `\u0000CB${codeBlocks.length - 1}\u0000`;
    });

    const inline = (s) =>
      escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code class="ocleet-ic">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    const out = [];
    let list = null;
    const flushList = () => {
      if (list) {
        out.push(`<ul>${list.join("")}</ul>`);
        list = null;
      }
    };

    for (const line of text.split("\n")) {
      const cb = line.match(/^\u0000CB(\d+)\u0000$/);
      if (cb) {
        flushList();
        out.push(`<pre class="ocleet-pre"><code>${escapeHtml(codeBlocks[+cb[1]])}</code></pre>`);
        continue;
      }
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) {
        (list || (list = [])).push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      flushList();
      if (!line.trim()) continue;
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = Math.min(4, h[1].length + 1);
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        continue;
      }
      out.push(`<p>${inline(line)}</p>`);
    }
    flushList();
    return out.join("");
  }

  /* --------------------------------------------------------- problem reader */
  function readTitle() {
    for (const sel of ['[data-cy="question-title"]', 'div[class*="text-title-large"]', "h1"]) {
      const el = document.querySelector(sel);
      const text = el && el.textContent.trim();
      if (text && text.length < 200) return text;
    }
    const m = document.title.match(/^\d+\.\s*([^-]+?)\s*[-|]/);
    return m ? m[1].trim() : document.title.split(" - ")[0];
  }

  function readDifficulty() {
    const el = document.querySelector(
      '[class*="text-difficulty-"], [class*="text-olive"], [class*="text-yellow"], [class*="text-pink"]',
    );
    const text = el && el.textContent.trim();
    return text && /^(Easy|Medium|Hard|简单|中等|困难)$/i.test(text) ? text : null;
  }

  function readTags() {
    return Array.from(document.querySelectorAll('a[href*="/tag/"]'))
      .map((a) => a.textContent.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  function readDescription() {
    let best = "";
    for (const sel of [
      '[data-track-load="description_content"]',
      ".question-content",
      'div[class*="question-content"]',
      'div[class*="description__"]',
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.innerText || "").trim();
        if (text.length > best.length) best = text;
      }
    }
    return best.slice(0, 12_000);
  }

  function readLanguageLabel() {
    const el = document.querySelector('button[class*="lang"], [class*="lang-select"], #lang-select');
    const text = el && el.textContent.trim();
    return text || null;
  }

  function readCode() {
    try {
      const monaco = PAGE.monaco;
      if (monaco && monaco.editor && typeof monaco.editor.getModels === "function") {
        const candidates = [];
        for (const model of monaco.editor.getModels()) {
          let value = "";
          let lang = "";
          try {
            value = model.getValue();
          } catch {
            continue;
          }
          try {
            lang = model.getLanguageId ? model.getLanguageId() : "";
          } catch {
            lang = "";
          }
          if (value && value.trim()) candidates.push({ value, lang });
        }
        const codey = candidates.filter((c) => c.lang && c.lang !== "markdown" && c.lang !== "plaintext");
        const pick = (codey.length ? codey : candidates).sort((a, b) => b.value.length - a.value.length)[0];
        if (pick) return { code: pick.value, lang: pick.lang || null };
      }
    } catch {
      /* fall through to DOM */
    }
    const lines = Array.from(document.querySelectorAll(".monaco-editor .view-line")).map((l) => l.textContent);
    if (lines.length) return { code: lines.join("\n"), lang: readLanguageLabel() };
    return { code: "", lang: readLanguageLabel() };
  }

  function currentSlug() {
    return (location.pathname.match(/\/problems\/([^/]+)/) || [])[1] || null;
  }

  function readProblem() {
    const { code, lang } = readCode();
    return {
      title: readTitle(),
      slug: currentSlug(),
      difficulty: readDifficulty(),
      tags: readTags(),
      description: readDescription(),
      code,
      lang,
      url: location.href,
    };
  }

  /* ------------------------------------------------------------- upstream API */
  function errorText(status, body) {
    let msg = "";
    try {
      const parsed = JSON.parse(body);
      msg = parsed?.message || parsed?.error?.message || parsed?.error?.type || "";
    } catch {
      msg = String(body || "");
    }
    msg = String(msg).slice(0, 300);
    return `请求失败（HTTP ${status}）${msg ? "：" + msg : ""}`;
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  function hasGM() {
    return typeof GM_xmlhttpRequest === "function";
  }
  function cleanKey() {
    return String(cfg.apiKey || "").trim().replace(/^Bearer\s+/i, "");
  }

  /**
   * Call OpenCode Go directly via GM_xmlhttpRequest, which bypasses the missing
   * CORS headers. Streams incrementally when the userscript manager exposes
   * partial `responseText` in `onprogress`; otherwise the whole answer lands at
   * `onload` (still parsed and rendered).
   */
  function directChat(payload, onDelta, onReasoning) {
    return new Promise((resolve, reject) => {
      if (!hasGM()) {
        reject(new Error("没有 GM_xmlhttpRequest：请用 Tampermonkey 安装本脚本（普通网页脚本无法绕过 opencode.ai 的 CORS）。"));
        return;
      }
      const key = cleanKey();
      if (!key) {
        reject(new Error("还没填 API key：点右上角 ⚙ 填入你的 OpenCode Go key。"));
        return;
      }

      let lastLen = 0;
      let buffer = "";
      let received = false;
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      const consume = (text) => {
        buffer += text;
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            const json = safeJson(data);
            if (!json) continue;
            if (json.error) {
              settle(reject, new Error(json.error.message || "上游返回错误"));
              return;
            }
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (!delta) continue;
            if (delta.reasoning_content) {
              received = true;
              onReasoning(delta.reasoning_content);
            }
            if (delta.content) {
              received = true;
              onDelta(delta.content);
            }
          }
        }
      };

      GM_xmlhttpRequest({
        method: "POST",
        url: chatUrl(),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          accept: "text/event-stream",
          "x-opencode-session": "ocleet-" + Date.now(),
        },
        data: JSON.stringify({ ...payload, stream: true }),
        timeout: 180_000,
        onprogress: (r) => {
          if (typeof r.responseText === "string" && r.responseText.length > lastLen) {
            consume(r.responseText.slice(lastLen));
            lastLen = r.responseText.length;
          }
        },
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            settle(reject, Object.assign(new Error(errorText(r.status, r.responseText)), { ocleetHttp: true }));
            return;
          }
          if (typeof r.responseText === "string" && r.responseText.length > lastLen) {
            consume(r.responseText.slice(lastLen));
            lastLen = r.responseText.length;
          }
          // Manager buffered the whole response: use a normal completion body.
          if (!received) {
            const body = safeJson(r.responseText);
            const msg = body && body.choices && body.choices[0] && body.choices[0].message;
            if (msg) {
              if (msg.reasoning_content) onReasoning(msg.reasoning_content);
              if (msg.content) onDelta(msg.content);
            }
          }
          settle(resolve, true);
        },
        onerror: () => settle(reject, new Error("无法连接 opencode.ai（网络问题或 key 无效）。")),
        ontimeout: () => settle(reject, new Error("请求超时（180 秒）。")),
      });
    });
  }

  /** Verify the stored key against the usage endpoint (200 = good, 401 = bad). */
  function checkKey() {
    const key = cleanKey();
    if (!key) return Promise.resolve({ ok: false, reason: "no-key" });
    if (!hasGM()) return Promise.resolve({ ok: false, reason: "no-gm" });
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: usageUrl(),
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        timeout: 20_000,
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, reason: "http", status: r.status }),
        onerror: () => resolve({ ok: false, reason: "network" }),
        ontimeout: () => resolve({ ok: false, reason: "timeout" }),
      });
    });
  }

  /* ------------------------------------------------------------------- style */
  const CSS = `
.ocleet-launcher{position:fixed;right:22px;bottom:22px;z-index:2147483000;height:44px;padding:0 18px;border:none;border-radius:22px;cursor:pointer;
  background:linear-gradient(135deg,#5b7cfa,#8a5cf6);color:#fff;font:600 14px/1 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  box-shadow:0 10px 26px rgba(70,90,220,.4);transition:transform .12s ease,filter .12s ease}
.ocleet-launcher:hover{filter:brightness(1.08);transform:translateY(-1px)}
.ocleet-panel{position:fixed;right:22px;bottom:78px;z-index:2147483000;width:420px;max-width:calc(100vw - 32px);height:min(78vh,780px);display:flex;flex-direction:column;
  background:#12141c;color:#e7e9f0;border:1px solid rgba(255,255,255,.1);border-radius:16px;overflow:hidden;
  box-shadow:0 22px 70px rgba(0,0,0,.55);font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.ocleet-panel[hidden]{display:none}
.ocleet-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02)}
.ocleet-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px}
.ocleet-dot{width:8px;height:8px;border-radius:50%;background:#8b90a3}
.ocleet-dot.ok{background:#37d67a;box-shadow:0 0 0 3px rgba(55,214,122,.18)}
.ocleet-dot.err{background:#ff5f6d;box-shadow:0 0 0 3px rgba(255,95,109,.18)}
.ocleet-actions{display:flex;gap:4px}
.ocleet-icon{background:transparent;border:none;color:#9aa0b4;cursor:pointer;font-size:15px;padding:4px 7px;border-radius:8px}
.ocleet-icon:hover{background:rgba(255,255,255,.08);color:#fff}
.ocleet-settings{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02);display:flex;flex-direction:column;gap:8px}
.ocleet-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#9aa0b4}
.ocleet-field input,.ocleet-field select{background:#0c0e15;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e7e9f0;padding:6px 8px;font:inherit;font-size:12.5px}
.ocleet-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#c3c7d4}
.ocleet-tabs{display:flex;gap:6px;padding:9px 12px 0}
.ocleet-tab{flex:1;padding:7px 8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#aeb3c4;border-radius:9px;cursor:pointer;font:600 12px/1.2 inherit}
.ocleet-tab.active{background:linear-gradient(135deg,rgba(91,124,250,.3),rgba(138,92,246,.3));border-color:rgba(138,120,255,.55);color:#fff}
.ocleet-problem{margin:9px 12px 0;padding:7px 10px;border-radius:9px;background:rgba(91,124,250,.1);border:1px solid rgba(91,124,250,.25);font-size:12px;color:#c9cfe4;display:flex;gap:6px;align-items:center}
.ocleet-problem[hidden]{display:none}
.ocleet-diff{font-size:11px;padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.1)}
.ocleet-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.ocleet-msg{max-width:100%;padding:9px 11px;border-radius:12px;white-space:normal;word-break:break-word}
.ocleet-msg.user{align-self:flex-end;background:linear-gradient(135deg,#5b7cfa,#7b5cf5);color:#fff;border-bottom-right-radius:4px}
.ocleet-msg.assistant{align-self:flex-start;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-bottom-left-radius:4px}
.ocleet-msg.error{align-self:flex-start;background:rgba(255,95,109,.12);border:1px solid rgba(255,95,109,.35);color:#ffc4ca}
.ocleet-msg p{margin:0 0 7px}.ocleet-msg p:last-child{margin-bottom:0}
.ocleet-msg ul{margin:4px 0 7px;padding-left:20px}
.ocleet-msg h2,.ocleet-msg h3,.ocleet-msg h4{margin:8px 0 5px;font-size:13.5px}
.ocleet-ic{background:rgba(255,255,255,.12);padding:1px 5px;border-radius:5px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.ocleet-pre{position:relative;background:#0a0b11;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 10px;overflow-x:auto;margin:5px 0}
.ocleet-pre code{font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre}
.ocleet-copy{position:absolute;top:5px;right:5px;background:rgba(255,255,255,.1);border:none;color:#c3c7d4;border-radius:6px;font-size:11px;padding:2px 7px;cursor:pointer}
.ocleet-copy:hover{background:rgba(255,255,255,.2);color:#fff}
.ocleet-reason{margin-bottom:7px;border-left:2px solid rgba(255,255,255,.18);padding-left:8px}
.ocleet-reason summary{cursor:pointer;color:#8f95a8;font-size:11.5px;outline:none}
.ocleet-reason-body{color:#8f95a8;font-size:12px;white-space:pre-wrap;margin-top:5px;max-height:200px;overflow:auto}
.ocleet-muted{color:#8f95a8}
.ocleet-composer{border-top:1px solid rgba(255,255,255,.08);padding:10px 12px 12px;background:rgba(255,255,255,.02)}
.ocleet-composer textarea{width:100%;resize:vertical;min-height:56px;max-height:200px;background:#0c0e15;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e7e9f0;padding:9px 10px;font:inherit;font-size:13px}
.ocleet-composer textarea:focus{outline:none;border-color:rgba(138,120,255,.6)}
.ocleet-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
.ocleet-hint{font-size:11.5px;color:#8f95a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocleet-btns{display:flex;gap:6px;flex-shrink:0}
.ocleet-btn{border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#dfe2ec;padding:6px 11px;cursor:pointer;font:600 12.5px/1 inherit}
.ocleet-btn:hover{background:rgba(255,255,255,.12)}
.ocleet-btn.primary{background:linear-gradient(135deg,#5b7cfa,#8a5cf6);border-color:transparent;color:#fff}
.ocleet-btn.primary[disabled]{opacity:.55;cursor:default}
.ocleet-cursor{display:inline-block;width:7px;height:14px;background:#8a5cf6;vertical-align:-2px;animation:ocleet-blink 1s steps(2) infinite}
@keyframes ocleet-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
`;

  /* ---------------------------------------------------------------------- UI */
  addStyle(CSS);

  const launcher = document.createElement("button");
  launcher.className = "ocleet-launcher";
  launcher.type = "button";
  launcher.textContent = "⌘ AI 助手";
  document.body.appendChild(launcher);

  const panel = document.createElement("div");
  panel.className = "ocleet-panel";
  panel.setAttribute("data-ocleet", "panel");
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ocleet-head">
      <div class="ocleet-brand"><span class="ocleet-dot" data-ocleet="dot"></span><span>openleet</span></div>
      <div class="ocleet-actions">
        <button class="ocleet-icon" type="button" data-ocleet="settings" title="设置">⚙</button>
        <button class="ocleet-icon" type="button" data-ocleet="close" title="关闭">✕</button>
      </div>
    </div>
    <div class="ocleet-settings" data-ocleet="settings-box" hidden>
      <label class="ocleet-field"><span>OpenCode Go API key</span><input type="password" data-ocleet="apikey" placeholder="oc_sk_…" autocomplete="off" /></label>
      <label class="ocleet-field"><span>接口地址（一般不用改）</span><input type="text" data-ocleet="baseurl" /></label>
      <label class="ocleet-field"><span>模型</span><select data-ocleet="model"></select></label>
      <label class="ocleet-check"><input type="checkbox" data-ocleet="include-code" /><span>把当前编辑器里的代码发给模型</span></label>
      <label class="ocleet-check"><input type="checkbox" data-ocleet="auto-read" /><span>打开面板时自动读取题目</span></label>
    </div>
    <div class="ocleet-tabs" data-ocleet="tabs"></div>
    <div class="ocleet-problem" data-ocleet="problem" hidden></div>
    <div class="ocleet-messages" data-ocleet="messages"></div>
    <div class="ocleet-composer">
      <textarea data-ocleet="input" rows="3"></textarea>
      <div class="ocleet-composer-row">
        <span class="ocleet-hint" data-ocleet="tip"></span>
        <div class="ocleet-btns">
          <button class="ocleet-btn" type="button" data-ocleet="read">读取题目</button>
          <button class="ocleet-btn" type="button" data-ocleet="clear">清空</button>
          <button class="ocleet-btn primary" type="button" data-ocleet="send">发送</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (name) => panel.querySelector(`[data-ocleet="${name}"]`);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("send");
  const dot = $("dot");
  const problemEl = $("problem");
  const tabsEl = $("tabs");
  const modelSelect = $("model");
  const apiKeyInput = $("apikey");
  const baseUrlInput = $("baseurl");
  const includeCodeEl = $("include-code");
  const autoReadEl = $("auto-read");
  const settingsBox = $("settings-box");

  let history = [];
  let busy = false;

  function setStatus(state) {
    dot.classList.remove("ok", "err");
    if (state) dot.classList.add(state);
    dot.title = state === "ok" ? "API key 可用" : state === "err" ? "key 未配置或无效" : "未检测";
  }

  function scroll() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = `ocleet-msg ${role}`;
    if (role === "assistant") el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
    if (role === "assistant") addCopyButtons(el);
    messagesEl.appendChild(el);
    scroll();
    return el;
  }

  function addCopyButtons(container) {
    for (const pre of container.querySelectorAll("pre")) {
      const btn = document.createElement("button");
      btn.className = "ocleet-copy";
      btn.type = "button";
      btn.textContent = "复制";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? "";
        navigator.clipboard?.writeText(code).then(
          () => {
            btn.textContent = "已复制";
            setTimeout(() => (btn.textContent = "复制"), 1200);
          },
          () => (btn.textContent = "失败"),
        );
      });
      pre.appendChild(btn);
    }
  }

  function addAssistant() {
    const wrap = document.createElement("div");
    wrap.className = "ocleet-msg assistant";

    const reason = document.createElement("details");
    reason.className = "ocleet-reason";
    reason.hidden = true;
    const reasonSummary = document.createElement("summary");
    reasonSummary.textContent = "思考过程";
    const reasonBody = document.createElement("div");
    reasonBody.className = "ocleet-reason-body";
    reason.append(reasonSummary, reasonBody);

    const body = document.createElement("div");
    body.className = "ocleet-body";
    body.innerHTML = '<span class="ocleet-cursor"></span>';
    wrap.append(reason, body);
    messagesEl.appendChild(wrap);
    scroll();

    const state = { content: "", reasoning: "" };
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        body.innerHTML = renderMarkdown(state.content) || '<span class="ocleet-cursor"></span>';
        addCopyButtons(body);
        scroll();
      });
    };
    return {
      onDelta: (d) => {
        state.content += d;
        schedule();
      },
      onReasoning: (d) => {
        state.reasoning += d;
        reason.hidden = false;
        reasonBody.textContent = state.reasoning;
        scroll();
      },
      text: () => state.content,
      done: () => {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        body.innerHTML = renderMarkdown(state.content) || '<span class="ocleet-muted">（无内容）</span>';
        addCopyButtons(body);
        scroll();
      },
      fail: (msg) => {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        wrap.classList.remove("assistant");
        wrap.classList.add("error");
        body.textContent = msg;
        scroll();
      },
    };
  }

  function renderProblemChip(problem) {
    if (!problem || !problem.title) {
      problemEl.hidden = true;
      return;
    }
    problemEl.hidden = false;
    problemEl.textContent = "";
    const name = document.createElement("span");
    name.textContent = `已读取：${problem.title}`;
    problemEl.appendChild(name);
    if (problem.difficulty) {
      const diff = document.createElement("span");
      diff.className = "ocleet-diff";
      diff.textContent = problem.difficulty;
      problemEl.appendChild(diff);
    }
    const codeLen = (problem.code || "").trim().length;
    const meta = document.createElement("span");
    meta.className = "ocleet-muted";
    meta.textContent = cfg.includeCode ? `· 代码 ${codeLen} 字符` : "· 不发送代码";
    problemEl.appendChild(meta);
  }

  const WELCOME = "选一个模式，点「读取题目」，然后开始提问。我会自动带上当前题目的描述和你编辑器里的代码（可在设置里关掉）。";

  function resetMessages() {
    messagesEl.textContent = "";
    addMessage("assistant", WELCOME);
  }

  function buildSystem(mode, problem) {
    const lines = [BASE_SYSTEM, SKILLS[mode].system, "", "----- 当前题目上下文 -----"];
    lines.push(`【题目】${problem.title || "(未识别)"}${problem.difficulty ? `（${problem.difficulty}）` : ""}`);
    if (problem.url) lines.push(`【链接】${problem.url}`);
    if (problem.tags && problem.tags.length) lines.push(`【标签】${problem.tags.join("、")}`);
    lines.push("", "【题目描述】");
    lines.push((problem.description || "(未读取到题目描述；如果题目不是这道，请让用户把题目贴过来)").slice(0, 8000));
    if (cfg.includeCode) {
      lines.push("", `【用户当前代码${problem.lang ? `（${problem.lang}）` : ""}】`);
      lines.push("```" + (problem.lang || ""));
      lines.push((problem.code || "(暂未读取到编辑器代码)").slice(0, 8000));
      lines.push("```");
    }
    return lines.join("\n");
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    sendBtn.textContent = value ? "生成中…" : "发送";
  }

  async function onSend() {
    if (busy) return;
    const text = inputEl.value.trim();
    if (!text) return;
    setBusy(true);
    inputEl.value = "";
    addMessage("user", text);
    history.push({ role: "user", content: text });

    const bubble = addAssistant();
    const problem = readProblem();
    renderProblemChip(problem);
    const payload = {
      model: cfg.model,
      stream: true,
      messages: [{ role: "system", content: buildSystem(cfg.mode, problem) }, ...history],
    };
    try {
      await directChat(payload, bubble.onDelta, bubble.onReasoning);
      bubble.done();
      setStatus("ok");
      history.push({ role: "assistant", content: bubble.text() });
      if (history.length > 24) history.splice(0, history.length - 24);
    } catch (err) {
      bubble.fail(err.message || String(err));
      setStatus("err");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------- wiring */
  function renderTabs() {
    tabsEl.textContent = "";
    for (const [key, skill] of Object.entries(SKILLS)) {
      const tab = document.createElement("button");
      tab.className = `ocleet-tab${key === cfg.mode ? " active" : ""}`;
      tab.type = "button";
      tab.textContent = skill.label;
      tab.addEventListener("click", () => {
        cfg.mode = key;
        saveCfg();
        renderTabs();
        inputEl.placeholder = skill.placeholder;
        $("tip").textContent = skill.tip;
      });
      tabsEl.appendChild(tab);
    }
    inputEl.placeholder = SKILLS[cfg.mode].placeholder;
    $("tip").textContent = SKILLS[cfg.mode].tip;
  }

  function fillModels(models) {
    modelSelect.textContent = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      modelSelect.appendChild(opt);
    }
    if (!models.some((m) => m.id === cfg.model) && models.length) cfg.model = models[0].id;
    modelSelect.value = cfg.model;
  }

  async function verifyKey() {
    if (!hasGM()) {
      setStatus("err");
      addMessage("assistant", "没有检测到 GM_xmlhttpRequest：请通过 Tampermonkey 安装并启用本脚本。");
      return;
    }
    const result = await checkKey();
    setStatus(result.ok ? "ok" : "err");
    if (result.ok) return;
    if (result.reason === "no-key") {
      if (!verifyKey._greeted) {
        verifyKey._greeted = true;
        addMessage("assistant", "还没有配置 API key。点右上角 ⚙，把 OpenCode Go 的 key（`oc_sk_…`）填进去就能开始。");
      }
    } else if (result.reason === "http") {
      addMessage("assistant", `API key 校验失败（HTTP ${result.status}）：key 可能无效或已过期。`);
    } else if (result.reason === "network" || result.reason === "timeout") {
      addMessage("assistant", "连不上 opencode.ai，检查一下网络或代理。");
    }
  }

  launcher.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && cfg.autoRead) {
      const problem = readProblem();
      renderProblemChip(problem);
    }
  });
  $("close").addEventListener("click", () => (panel.hidden = true));
  $("settings").addEventListener("click", () => (settingsBox.hidden = !settingsBox.hidden));
  $("send").addEventListener("click", onSend);
  $("clear").addEventListener("click", () => {
    history = [];
    resetMessages();
  });
  $("read").addEventListener("click", () => {
    const problem = readProblem();
    renderProblemChip(problem);
    addMessage("assistant", `已读取题目 **${problem.title || "(未识别)"}**。${problem.code ? "也读到了你编辑器里的代码。" : "没读到编辑器代码，可以手动贴给我。"}`);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  apiKeyInput.addEventListener("change", () => {
    cfg.apiKey = apiKeyInput.value.trim();
    saveCfg();
    verifyKey();
  });
  baseUrlInput.addEventListener("change", () => {
    cfg.baseUrl = baseUrlInput.value.trim() || DEFAULTS.baseUrl;
    saveCfg();
    verifyKey();
  });
  modelSelect.addEventListener("change", () => {
    cfg.model = modelSelect.value;
    saveCfg();
  });
  includeCodeEl.addEventListener("change", () => {
    cfg.includeCode = includeCodeEl.checked;
    saveCfg();
  });
  autoReadEl.addEventListener("change", () => {
    cfg.autoRead = autoReadEl.checked;
    saveCfg();
  });

  // Reflect stored config into the controls.
  apiKeyInput.value = cfg.apiKey;
  baseUrlInput.value = cfg.baseUrl;
  includeCodeEl.checked = cfg.includeCode;
  autoReadEl.checked = cfg.autoRead;
  renderTabs();
  fillModels(FALLBACK_MODELS);
  resetMessages();

  verifyKey();

  // LeetCode is a SPA: reset the conversation when the problem changes.
  let lastSlug = currentSlug();
  setInterval(() => {
    const slug = currentSlug();
    if (slug === lastSlug) return;
    lastSlug = slug;
    history = [];
    resetMessages();
    if (!panel.hidden && cfg.autoRead) renderProblemChip(readProblem());
  }, 1200);
})();
