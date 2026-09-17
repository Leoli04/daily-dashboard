#!/usr/bin/env node
/**
 * 定点验证：点击「刷新数据」是否真的强制重新拉取（而不是落回缓存分支）
 * - 第 1 次加载：等待实时拉取完成（写入当日缓存）
 * - 第 2 次加载：命中缓存（0 请求）
 * - 点击刷新按钮：应重新发起网络请求，且 pill 回到「实时拉取」
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.resolve(ROOT, '..', '每日资讯看板.html');
const TMP = path.resolve(ROOT, '..', '.workbuddy', 'tmp');
const OUT = path.join(TMP, 'probe-refresh.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(TMP, { recursive: true });

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
  on(method, fn) { const a = this.listeners.get(method) || []; a.push(fn); this.listeners.set(method, a); }
  once(method) { return new Promise((resolve) => { const a = this.listeners.get(method) || []; const fn = (p) => { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); resolve(p); }; a.push(fn); this.listeners.set(method, a); }); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return '[页面异常] ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails);
    return r.result.value;
  }
}

/* 等待「拉取中…」结束：按钮文案回到「刷新数据」即视为空闲 */
const IDLE = `(async () => {
  const btn = document.getElementById('refreshBtn');
  const until = Date.now() + 25000;
  await new Promise(r => setTimeout(r, 400));
  while (Date.now() < until) {
    const t = btn.textContent.trim();
    if (t === '刷新数据') return 'idle';
    await new Promise(r => setTimeout(r, 300));
  }
  return 'TIMEOUT:' + btn.textContent.trim();
})()`;

const PILL = `document.getElementById('srcPill').textContent.trim()`;

(async () => {
  const browser = findBrowser();
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = path.join(os.tmpdir(), 'probe-refresh-' + Date.now());
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--hide-scrollbars', '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const log = [];
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { targets = await r.json(); break; } } catch {}
      await sleep(300);
    }
    if (!targets) throw new Error('调试端口未就绪');
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8', platform: 'Win32',
    });

    let reqCount = 0;
    cdp.on('Network.requestWillBeSent', (p) => { if (/^https?:/.test(p.request.url)) reqCount++; });
    const url = 'file:///' + PAGE.replace(/\\/g, '/');

    /* ---- 第 1 次：冷启动，等实时拉取写完缓存 ---- */
    log.push('---- 第 1 次加载（冷启动）');
    await cdp.eval('localStorage.clear()');
    let loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    reqCount = 0;
    log.push('  等待拉取结束: ' + await cdp.eval(IDLE));
    log.push('  网络请求数   = ' + reqCount);
    log.push('  pill         = ' + await cdp.eval(PILL));
    log.push('  缓存已写入   = ' + await cdp.eval(`(localStorage.getItem('mb.cache.v2') ? 'YES' : 'NO')`));

    /* ---- 第 2 次：应命中缓存 ---- */
    log.push('');
    log.push('---- 第 2 次加载（应命中当日缓存）');
    loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    reqCount = 0;
    log.push('  等待空闲     = ' + await cdp.eval(IDLE));
    log.push('  网络请求数   = ' + reqCount);
    log.push('  pill         = ' + await cdp.eval(PILL));

    /* ---- 点击刷新按钮 ---- */
    log.push('');
    log.push('---- 点击「刷新数据」（应强制重新拉取）');
    reqCount = 0;
    await cdp.eval(`document.getElementById('refreshBtn').click()`);
    log.push('  点击后 pill  = ' + await cdp.eval(PILL));
    log.push('  等待空闲     = ' + await cdp.eval(IDLE));
    log.push('  网络请求数   = ' + reqCount);
    log.push('  结束时 pill  = ' + await cdp.eval(PILL));
  } catch (e) {
    log.push('脚本错误: ' + e.message + '\n' + e.stack);
  } finally {
    try { child.kill(); } catch {}
  }
  fs.writeFileSync(OUT, log.join('\n'), 'utf8');
  console.log('written -> ' + OUT);
  console.log(log.join('\n'));
})();
