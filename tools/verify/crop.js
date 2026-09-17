#!/usr/bin/env node
/**
 * 1:1 元素级裁切截图（复核布局/图表，不靠缩略图眼估）
 * 用法: node crop.js <tabKey> "<selector>" <index> <outFile> [width] [--sub=<子tab>] [--page=<html>]
 *   index 传 list 时列出全部匹配元素（不截图）
 *   --sub 指定分组 tab 内的子 tab（如 --sub=astkday），需把 width 写在 --sub 之前
 *   --page 指定要打开的 HTML（默认工作区根目录的 每日资讯看板.html），用于复核降级构建
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.resolve(ROOT, '..', '.workbuddy', 'tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [tabKey, selector, idxArg, outName, widthArg] = process.argv.slice(2);
const IDX = Number(idxArg || 0);
/* 宽度参数可能被 --sub / --page 占位，取到开关时必须回落默认值，否则 WIDTH 变成 NaN */
const WIDTH = Number(widthArg && !widthArg.startsWith('--') ? widthArg : 1400);
const subArg = (process.argv.find((a) => a.startsWith('--sub=')) || '').split('=')[1];
const pageArg = (process.argv.find((a) => a.startsWith('--page=')) || '').split('=')[1];
const PAGE = pageArg ? path.resolve(pageArg) : path.resolve(ROOT, '..', '每日资讯看板.html');

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
    return r.result.value;
  }
}

(async () => {
  const browser = findBrowser();
  const port = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(os.tmpdir(), 'crop-' + Date.now());
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
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/') });
    await loaded;
    // 等实时数据落地
    await cdp.eval(`(async () => { const until = Date.now() + 20000; while (Date.now() < until) { const p = document.getElementById('srcPill'); if (p && p.textContent.indexOf('快照') < 0) return 'ok'; await new Promise(r=>setTimeout(r,300)); } return 'timeout'; })()`);
    await sleep(700);
    if (tabKey && tabKey !== '-') { await cdp.eval(`document.querySelector('.tabs button[data-pane="${tabKey}"]').click()`); await sleep(500); }
    if (subArg) { await cdp.eval(`document.querySelector('.subtabs button[data-sub="${subArg}"]').click()`); await sleep(500); }

    const box = await cdp.eval(`(() => {
      const list = document.querySelectorAll(${JSON.stringify(selector)});
      if (${JSON.stringify(idxArg)} === 'list') {
        return JSON.stringify(Array.from(list).map((el, i) => {
          const r = el.getBoundingClientRect();
          return { i, text: el.innerText.trim().replace(/\\s+/g,' ').slice(0, 40), x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
        }));
      }
      const el = list[${IDX}];
      if (!el) return JSON.stringify({ err: 'not found, count=' + list.length });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), scrollW: document.documentElement.scrollWidth });
    })()`);
    log.push('box = ' + box);
    if (idxArg === 'list') { log.push('（list 模式：以上为全部匹配元素，不截图）'); fs.writeFileSync(path.join(TMP, 'crop.log'), log.join('\n'), 'utf8'); console.log(log.join('\n')); return; }
    const b = JSON.parse(box);
    if (b.err) { log.push('ERR ' + b.err); } else {
      const r = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: Math.max(0, b.x - 4), y: b.y - 4, width: Math.min(b.w + 8, WIDTH), height: b.h + 8, scale: 1 },
      });
      const out = path.join(TMP, outName);
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      log.push('WROTE ' + out + '  ' + b.w + 'x' + b.h);
    }
  } catch (e) {
    log.push('脚本错误: ' + e.message + '\n' + e.stack);
  } finally {
    try { child.kill(); } catch {}
  }
  fs.writeFileSync(path.join(TMP, 'crop.log'), log.join('\n'), 'utf8');
  console.log(log.join('\n'));
})();
