#!/usr/bin/env node
/**
 * 通用浏览器探针：打开页面 → 等数据落地 →（可选切 tab）→ 执行表达式 → 输出结果
 * 用法:
 *   node probe.js "<js表达式>" [--page=<html>] [--tab=hk] [--sub=astkday] [--offline] [--settle=ms]
 * 说明:
 *   --tab 点一级 tab；--sub 在切完一级 tab 后再点子 tab（用于 A股盘面的三个子版块）
 *   --offline 用 Network.emulateNetworkConditions 断网，用于复核降级路径
 *   表达式在页面上下文求值，返回值若是对象/数组会自动 JSON.stringify
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.resolve(ROOT, '..', '.workbuddy', 'tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const EXPR = args.find((a) => !a.startsWith('--'));
const pageArg = (args.find((a) => a.startsWith('--page=')) || '').split('=')[1];
const tabArg = (args.find((a) => a.startsWith('--tab=')) || '').split('=')[1];
const subArg = (args.find((a) => a.startsWith('--sub=')) || '').split('=')[1];
const settleArg = Number((args.find((a) => a.startsWith('--settle=')) || '').split('=')[1] || 0);
const OFFLINE = args.indexOf('--offline') >= 0;

/* --page 可以是本地 HTML（相对/绝对路径），也可以直接给 http(s) URL（用于验证线上站点） */
const PAGE = pageArg
  ? (/^https?:\/\//.test(pageArg) ? pageArg : path.resolve(pageArg))
  : path.resolve(ROOT, '..', '每日资讯看板.html');
const NAV = /^https?:\/\//.test(PAGE) ? PAGE : 'file:///' + PAGE.replace(/\\/g, '/');
const WIDTH = 1400;

const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
];
const findBrowser = () => { for (const c of CANDIDATES) if (c && fs.existsSync(c)) return c; throw new Error('no browser'); };

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) { for (const fn of this.listeners.get(m.method) || []) fn(m.params); }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  once(method) { return new Promise((resolve) => { const a = this.listeners.get(method) || []; const fn = (p) => { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); resolve(p); }; a.push(fn); this.listeners.set(method, a); }); }
  on(method, fn) { const a = this.listeners.get(method) || []; a.push(fn); this.listeners.set(method, a); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return '[页面异常] ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails);
    const v = r.result.value;
    /* 对象/数组必须显式序列化，否则字符串拼接会退化成 "[object Object]" */
    if (v !== null && typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
    return v;
  }
}

(async () => {
  const browser = findBrowser();
  const port = 9950 + Math.floor(Math.random() * 150);
  const profile = path.join(os.tmpdir(), 'probe-' + Date.now());
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--hide-scrollbars', '--window-size=' + WIDTH + ',1000', 'about:blank',
  ], { stdio: 'ignore' });

  const log = [];
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { targets = await r.json(); break; } } catch {}
      await sleep(300);
    }
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Win32',
    });
    if (OFFLINE) {
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    }
    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails && p.exceptionDetails.text)));
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: NAV });
    await loaded;
    /* 等实时数据落地；断网时等它转成快照态 */
    await cdp.eval(`(async () => { const until = Date.now() + 20000; while (Date.now() < until) { const p = document.getElementById('srcPill'); if (p && p.textContent.indexOf('快照') < 0) return 'ok'; await new Promise(r=>setTimeout(r,300)); } return 'timeout'; })()`);
    await sleep(700 + settleArg);
    if (tabArg) { await cdp.eval(`document.querySelector('.tabs button[data-pane="${tabArg}"]').click()`); await sleep(450); }
    if (subArg) { await cdp.eval(`document.querySelector('.subtabs button[data-sub="${subArg}"]').click()`); await sleep(450); }

    log.push('page      = ' + PAGE);
    log.push('offline   = ' + OFFLINE);
    log.push('pill      = ' + await cdp.eval(`document.getElementById('srcPill').textContent.trim()`));
    log.push('expr      = ' + String(EXPR).slice(0, 120));
    log.push('result    = ' + await cdp.eval(EXPR));
    log.push('异常      = ' + (errors.length ? errors.join(' | ') : '无'));
  } catch (e) {
    log.push('脚本错误: ' + e.message + '\n' + e.stack);
  } finally {
    try { child.kill(); } catch {}
  }
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'probe.log'), log.join('\n'), 'utf8');
  console.log(log.join('\n'));
})();
