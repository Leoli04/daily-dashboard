#!/usr/bin/env node
/* 多断点几何复核：顶栏（品牌 / 4 个 tab / 时间元信息）在各宽度下
   是否换行、是否重叠、是否横向溢出。
   判据全部用 getBoundingClientRect —— 缩略图看不出「tab 掉到第二行」这类问题。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RW = 'F:/workspace/WorkBuddy/freelancer';
const PAGE = path.join(RW, '每日资讯看板.html');
const PORT = 9455;
const PROFILE = path.join(RW, '.workbuddy', 'tmp', 'chrome-width-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
];

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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return '[异常] ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails);
    return r.result.value;
  }
}

const EXPR = `(() => {
  const rect = (e) => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), h: Math.round(b.height) }; };
  const tabs = document.getElementById('tabs');
  const meta = document.querySelector('.topmeta');
  const btns = Array.from(tabs.querySelectorAll('button'));
  const tops = btns.map(b => Math.round(b.getBoundingClientRect().top));
  /* 两个分组页签各有一条子页签条（原先全局只有一个 #subtabs）：
     只量「当前可见」的那一条，隐藏的那条 getBoundingClientRect 全为 0，混进来会把行数算错。 */
  const subBars = Array.from(document.querySelectorAll('.subtabs')).filter(b => b.getClientRects().length > 0);
  const subs = subBars.length ? Array.from(subBars[0].querySelectorAll('button')) : [];
  const subTops = subs.map(b => Math.round(b.getBoundingClientRect().top));
  const cards = document.querySelectorAll('.wrap .card');
  let cardL = -1;
  if (cards.length) cardL = Math.round(cards[0].getBoundingClientRect().left);
  const tb = rect(tabs), mb = rect(meta), bb = rect(document.querySelector('.brand'));
  /* 重叠判定必须**同行才算**：flex-wrap 换行后，第二行元素的左右范围会与第一行相交，
     但那不是视觉重叠（踩过：只看 left/right 会把换行误报成重叠）。 */
  const sameRowTM = Math.abs(tb.t - mb.t) < Math.max(tb.h, mb.h) / 2;
  const sameRowBT = Math.abs(bb.t - tb.t) < Math.max(bb.h, tb.h) / 2;
  /* 顶栏行数：按 top 聚类（阈值 12px）。不能拿「不同 top 值的个数」当行数 ——
     brand / tabs / 元信息因高度不同、align-items:center 而各有各的 top，恒为 3。 */
  const ys = [bb.t, tb.t, mb.t].sort((a, b) => a - b);
  let barRows = 0, lastY = -1e9;
  ys.forEach((y) => { if (y - lastY > 12) { barRows++; lastY = y; } });
  return JSON.stringify({
    vw: window.innerWidth,
    barH: rect(document.querySelector('.topbar-in')).h,
    barRows: barRows,
    tabsH: tb.h,
    tabRows: new Set(tops).size,
    overlapTabMeta: sameRowTM && tb.r > mb.l,
    overlapBrandTabs: sameRowBT && bb.r > tb.l,
    subRows: subs.length ? new Set(subTops).size : 0,
    firstCardLeft: cardL,
    overflowX: document.documentElement.scrollWidth > window.innerWidth
  });
})()`;

(async () => {
  const browser = CANDIDATES.find((c) => c && fs.existsSync(c));
  if (!browser) throw new Error('未找到浏览器');
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--hide-scrollbars', '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { targets = await r.json(); break; } } catch { }
      await sleep(300);
    }
    if (!targets) throw new Error('调试端口未就绪');
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8', platform: 'Win32',
    });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/') });
    await loaded;
    /* 等首屏渲染完成 */
    for (let i = 0; i < 50; i++) {
      if (await cdp.eval(`document.querySelector('#pane-hk .hkstrip .cell') ? true : false`)) break;
      await sleep(400);
    }

    for (const w of [1600, 1440, 1400, 1366, 1280, 1180, 1024, 900, 760, 620]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(450);
      const v = JSON.parse(await cdp.eval(EXPR));
      const ok = (v.barRows === 1 && !v.overlapTabMeta && !v.overflowX) ? 'OK ' : '!! ';
      console.log(ok + String(w).padStart(4)
        + '  顶栏行数=' + v.barRows + '  高=' + v.barH
        + '  tab行数=' + v.tabRows + '  子tab行数=' + v.subRows
        + '  重叠(tab×元信息)=' + v.overlapTabMeta + '  溢出=' + v.overflowX);
      if (w === 1280) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: 130, scale: 2 } });
        fs.writeFileSync(path.join(RW, '.workbuddy', 'tmp', 'shot-topbar-1280.png'), Buffer.from(shot.data, 'base64'));
      }
      if (w === 1400) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: 72, scale: 2 } });
        fs.writeFileSync(path.join(RW, '.workbuddy', 'tmp', 'shot-topbar-1400.png'), Buffer.from(shot.data, 'base64'));
      }
    }
  } finally {
    try { child.kill(); } catch { }
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { }
  }
})();
