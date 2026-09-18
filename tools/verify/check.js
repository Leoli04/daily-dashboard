#!/usr/bin/env node
/**
 * 真实浏览器验证：渲染 / 两个一级 tab + 财经市场四个子版块 / 更新时间 / 当日缓存不重复拉取 / 页面异常 / 截图
 * file:// 打开 + 普通 Chrome UA（CDN 按 UA 拦截 headless，必须覆盖）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.resolve(ROOT, '..', '每日资讯看板.html');
const TMP = path.resolve(ROOT, '..', '.workbuddy', 'tmp');
const OUT = path.join(TMP, 'tab-verify.txt');
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
  async shot(file, full) {
    const opts = { format: 'png', captureBeyondViewport: !!full };
    if (full) {
      const m = await this.send('Page.getLayoutMetrics');
      const h = Math.ceil(m.cssContentSize.height);
      opts.clip = { x: 0, y: 0, width: 1400, height: Math.min(h, 12000), scale: 1 };
    }
    const r = await this.send('Page.captureScreenshot', opts);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

const SETTLE = `(async () => {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const p = document.getElementById('srcPill');
    const t = p ? p.textContent.trim() : '';
    if (t && t.indexOf('快照') < 0) return t;
    await new Promise(r => setTimeout(r, 300));
  }
  return 'TIMEOUT';
})()`;

/* 等待刷新按钮回到空闲（按钮文案复位即代表 fetchAll 已结束） */
const IDLE = `(async () => {
  const btn = document.getElementById('refreshBtn');
  const until = Date.now() + 25000;
  await new Promise(r => setTimeout(r, 400));
  while (Date.now() < until) {
    if (btn.textContent.trim() === '刷新数据') return 'idle';
    await new Promise(r => setTimeout(r, 300));
  }
  return 'TIMEOUT:' + btn.textContent.trim();
})()`;

const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (e) => e ? e.textContent.trim().replace(/\\s+/g, ' ') : '';
  const host = (h) => { try { return new URL(h).host; } catch (e) { return '?'; } };
  const panes = ['aidyn','aihot','ai7d','astock','hk','radar','astkday','market'];
  /* 两个时间各司其职：dataDate = 当前版块的数据日期（随 tab 变），updatedAt = 抓取时刻。
     badge 是标题旁日期徽标，必须与 dataDate 同值（同一渲染源 updateChrome 写入）。 */
  const out = { url: location.href, pill: txt(q('#srcPill')), dataDate: txt(q('#dataDate')),
    updatedAt: txt(q('#updatedAt')), badge: txt(q('#editionBadge')), tabCounts: {}, panes: {} };
  qa('.tabs button[data-pane]').forEach(b => { out.tabCounts[b.dataset.pane] = txt(b.querySelector('.cnt')); });
  /* 导航结构：一级 tab 顺序 + 每个分组 tab 自己的子 tab（按 data-group 分别取，不跨组混算） */
  const subBar = (g) => qa('.subtabs[data-group="' + g + '"] button[data-sub]');
  const subSel = (g) => subBar(g).filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.sub);
  out.nav = {
    topPanes: qa('#tabs button[data-pane]').map(b => b.dataset.pane),
    topLabels: qa('#tabs button[data-pane]').map(txt),
    /* subPanes / subLabels / subSelected 保持 = 财经市场的口径（下方 SUBS 断言沿用） */
    subPanes: subBar('market').map(b => b.dataset.sub),
    subLabels: subBar('market').map(txt),
    subSelected: subSel('market'),
    subSelectedByGroup: { aidyn: subSel('aidyn'), market: subSel('market') },
    aidynSubPanes: subBar('aidyn').map(b => b.dataset.sub),
    aidynSubLabels: subBar('aidyn').map(txt),
    topSelected: qa('#tabs button[data-pane]').filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.pane)
  };
  panes.forEach(k => {
    const p = document.getElementById('pane-' + k);
    out.panes[k] = { hidden: p.classList.contains('hide'), visible: p.getClientRects().length > 0,
      len: p.innerHTML.length, textLen: p.innerText.trim().length,
      tables: p.querySelectorAll('table').length, svgs: p.querySelectorAll('svg').length,
      cards: p.querySelectorAll('.card').length, entries: p.querySelectorAll('.entry').length,
      head: p.innerText.trim().split('\\n').slice(0, 3).join(' | ') };
  });
  // AI 日报专项
  out.ai = {
    heroStats: qa('#pane-aihot .hstat .n').map(txt),
    sections: qa('#pane-aihot section.sec').map(s => txt(s.querySelector('h2')) + '=' + s.querySelectorAll('.card, details.news').length),
    idxSeq: qa('#pane-aihot .card .idx').map(txt).join(','),
    anchors: qa('#pane-aihot .anchors button').map(txt),
    over60: qa('#pane-aihot .card-summary').map(e => (e.textContent.match(/[\\u4e00-\\u9fff]/g)||[]).length).filter(n => n > 60),
    badLinks: qa('#pane-aihot a[href^="http"]').filter(a => a.target !== '_blank' || (a.rel||'').indexOf('noopener') < 0).length,
    /* 应彻底消失的 AI HOT 外链：hero 的「查看官方日报页」与卡片里的「AI HOT 条目」 */
    hotLinks: qa('#pane-aihot a[href*="aihot"]').length,
    hotLinkTexts: qa('#pane-aihot a[href*="aihot"]').map(txt),
    linkRowTexts: qa('#pane-aihot .card-links a').map(txt),
    titleHosts: qa('#pane-aihot .card-title a').map(a => host(a.href)),
    /* 近 7 日条目流已并入 AI 动态：分组、条数、筛选条、首条时间与来源 */
    d7: {
      segs: qa('#pane-ai7d #ai7dSeg button').map(txt),
      groups: qa('#pane-ai7d .newsgrp[data-agrp]').map(g => g.dataset.agrp + '=' + g.querySelectorAll('details.news').length),
      items: qa('#pane-ai7d .newsgrp[data-agrp] details.news').length,
      note: txt(q('#pane-ai7d #sec-items7d .note')),
      hero: qa('#pane-ai7d .hstat .n').map(txt),
      first: (() => { const d = q('#pane-ai7d .newsgrp[data-agrp] details.news'); return d ? (txt(d.querySelector('.nt')) + ' | ' + txt(d.querySelector('.nh')).slice(0, 46) + ' | ' + txt(d.querySelector('.nf span'))) : ''; })(),
      /* 拆走之后，AI 日报页内不得再有 7 日流的锚点 */
      leakInDaily: qa('#pane-aihot .anchors button').filter(b => b.dataset.target === 'sec-items7d').length,
      /* 倒序判定要**逐分组**做：上屏按分类分组，全局拉平的序列本来就不单调 */
      orderDesc: (() => qa('#pane-ai7d .newsgrp[data-agrp]').every(g => {
        const t = Array.from(g.querySelectorAll('details.news .nt')).map(txt);
        return t.length < 2 || t.slice(1).every((v, i) => v <= t[i]);
      }))()
    }
  };
  // 今日财经要闻专项
  const nk = document.getElementById('pane-hk');
  out.news = {
    strip: nk.querySelectorAll('.hkstrip .cell').length,
    hasStructure: nk.innerText.indexOf('开盘前结构信号') >= 0,
    newsItems: nk.querySelectorAll('details.news').length,
    groups: nk.querySelectorAll('.newsgrp').length,
    sections: qa('#pane-hk section.sec h2').map(txt)
  };
  // A股专项
  const a = document.getElementById('pane-astock');
  out.astock = {
    strip: Array.from(a.querySelectorAll('.cell .cv')).slice(0,5).map(txt),
    banner: a.querySelector('.banner') ? a.querySelector('.banner').innerText.trim().replace(/\\s+/g,' ').slice(0,140) : '',
    lhbRows: a.querySelectorAll('table tbody tr').length,
    firstLhb: a.querySelector('table tbody tr') ? a.querySelector('table tbody tr').innerText.trim().replace(/\\s+/g,' ') : '',
    maxBoard: (a.innerText.match(/最高 (\\d+) 连板/) || [])[1] || ''
  };
  // A股盘面 · 人气榜日/周榜专项（由热搜数据版块的日榜 + 逐日归档投影而来）
  const ad = document.getElementById('pane-astkday');
  const segDay = document.getElementById('seg-day');
  const segWeek = document.getElementById('seg-week');
  out.astkday = {
    h2s: qa('#pane-astkday section.sec h2').map(txt),
    notes: qa('#pane-astkday section.sec .note').map(txt),
    segs: qa('#astkSeg button').map(txt),
    segsOn: qa('#astkSeg button.on').map(txt),
    dayEntries: segDay ? segDay.querySelectorAll('.entry').length : 0,
    weekEntries: segWeek ? segWeek.querySelectorAll('.entry').length : 0,
    rowsCoded: ad.querySelectorAll('.entry[data-code]').length,
    weekFirst: segWeek && segWeek.querySelector('.entry') ? segWeek.querySelector('.entry').innerText.trim().replace(/\\s+/g,' ').slice(0, 90) : '',
    first: txt(ad.querySelector('#seg-day .entry .hl')),
    rank1: txt(ad.querySelector('#seg-day .entry .rk .no')),
    heat1: txt(ad.querySelector('#seg-day .entry .idx .val')),
    hint: txt(ad.querySelector('.panel.hint')),
    isEmptyState: !!ad.querySelector('.empty'),
    oldHotlistSegGone: !document.getElementById('hotSeg')
  };
  // 雷达专项
  const r = document.getElementById('pane-radar');
  out.radar = {
    overall: txt(r.querySelector('.gauge .num')),
    level: txt(r.querySelector('.gauge .lvl')),
    headline: txt(r.querySelector('.verdict h2')),
    scores: qa('#pane-radar .scorec').map(c => txt(c.querySelector('.sl')) + '=' + txt(c.querySelector('.sn'))),
    watch: r.querySelectorAll('.watchlist li').length,
    rules: qa('#pane-radar .evlines li').length
  };
  // 时间戳泄漏检查
  out.isoLeak = (document.body.innerText.match(/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/g) || []).length;
  out.overflowX = document.documentElement.scrollWidth > window.innerWidth;
  return JSON.stringify(out);
})()`;

(async () => {
  const browser = findBrowser();
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = path.join(os.tmpdir(), 'tabverify-' + Date.now());
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

    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push('EXC ' + (p.exceptionDetails && p.exceptionDetails.text) + ' :: ' + ((p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || '').slice(0, 200)));
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push('CONSOLE ' + (p.args || []).map((a) => a.value).join(' ').slice(0, 200)); });
    let reqCount = 0, reqUrls = [];
    cdp.on('Network.requestWillBeSent', (p) => {
      if (/^https?:/.test(p.request.url)) { reqCount++; if (reqUrls.length < 60) reqUrls.push(p.request.url.slice(0, 90)); }
    });

    const url = 'file:///' + PAGE.replace(/\\/g, '/');

    log.push('==================== 第 1 次加载（冷启动，应实时拉取）');
    let loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    const pill1 = await cdp.eval(SETTLE);
    await sleep(900);
    const req1 = reqCount;
    log.push('  来源 pill     = ' + pill1);
    log.push('  网络请求数   = ' + req1);
    let p = JSON.parse(await cdp.eval(PROBE));
    log.push('  数据日期/更新于 = ' + p.dataDate + ' / ' + p.updatedAt);
    log.push('  tab 角标     = ' + JSON.stringify(p.tabCounts));
    log.push('  AI hero      = ' + JSON.stringify(p.ai.heroStats));
    log.push('  AI 版块      = ' + JSON.stringify(p.ai.sections));
    log.push('  AI 序号      = ' + p.ai.idxSeq);
    log.push('  AI 摘要>60汉字= ' + JSON.stringify(p.ai.over60));
    log.push('  AI 外链属性不合规 = ' + p.ai.badLinks);
    log.push('  AI 残留 AI HOT 外链 = ' + p.ai.hotLinks + ' ' + JSON.stringify(p.ai.hotLinkTexts));
    log.push('  AI 卡片链接行文案 = ' + JSON.stringify(p.ai.linkRowTexts.slice(0, 4)));
    log.push('  AI 标题直连域名 = ' + JSON.stringify(p.ai.titleHosts));
    log.push('  AI 近7日      = ' + JSON.stringify(p.ai.d7.groups) + '  条目=' + p.ai.d7.items + '  组内倒序=' + p.ai.d7.orderDesc);
    log.push('  AI 近7日 筛选 = ' + JSON.stringify(p.ai.d7.segs) + '  hero=' + JSON.stringify(p.ai.d7.hero)
      + '  日报内残留锚点=' + p.ai.d7.leakInDaily + '（应为 0）');
    log.push('  AI 近7日 跨度 = ' + p.ai.d7.note);
    log.push('  AI 近7日 首条 = ' + p.ai.d7.first);
    log.push('  导航一级 tab   = ' + JSON.stringify(p.nav.topPanes) + ' ' + JSON.stringify(p.nav.topLabels));
    log.push('  导航子 tab     = ' + JSON.stringify(p.nav.subPanes) + ' ' + JSON.stringify(p.nav.subLabels));
    log.push('  A股 数据条   = ' + JSON.stringify(p.astock.strip));
    log.push('  A股 banner   = ' + p.astock.banner);
    log.push('  A股 表格行数 = ' + p.astock.lhbRows + '  首行: ' + p.astock.firstLhb);
    log.push('  A股 最高连板 = ' + p.astock.maxBoard);
    log.push('  人气榜 分段   = ' + JSON.stringify(p.astkday.segs) + '  选中=' + JSON.stringify(p.astkday.segsOn)
      + '  日榜条目=' + p.astkday.dayEntries + '  周榜条目=' + p.astkday.weekEntries
      + '  带码条目=' + p.astkday.rowsCoded);
    log.push('  人气榜 版块   = ' + JSON.stringify(p.astkday.h2s));
    log.push('  日榜 首行    = ' + p.astkday.rank1 + ' ' + p.astkday.first + '  热度=' + p.astkday.heat1);
    log.push('  周榜 首行    = ' + p.astkday.weekFirst);
    log.push('  雷达 总体    = ' + p.radar.overall + ' (' + p.radar.level + ')  ' + p.radar.headline);
    log.push('  雷达 分项    = ' + JSON.stringify(p.radar.scores));
    log.push('  雷达 观察/规则 = ' + p.radar.watch + ' / ' + p.radar.rules);
    log.push('  ISO 时间泄漏 = ' + p.isoLeak + '   横向溢出=' + p.overflowX);
    log.push('  页面异常     = ' + (errors.length ? errors.join(' | ') : '无'));
    await cdp.shot(path.join(TMP, 'tab-1-aihot.png'), true);

    log.push('');
    log.push('==================== tab 切换（一级顺序 + 两个分组 tab 各自的子 tab）');
    const TOPSEQ = ['aidyn', 'market'];
    const SUBS = ['hk', 'astock', 'radar', 'astkday'];
    const AIDYN_SUBS = ['aihot', 'ai7d'];
    /* 分组 tab 的子 tab 清单：一级 key -> 子 key 列表（非分组 tab 不在表里） */
    const SUBS_OF = { aidyn: AIDYN_SUBS, market: SUBS };
    const datePairs = [];
    log.push('  期望一级顺序   = ' + JSON.stringify(TOPSEQ) + '  实际=' + JSON.stringify(p.nav.topPanes)
      + (JSON.stringify(p.nav.topPanes) === JSON.stringify(TOPSEQ) ? ' ✅' : ' ❌'));
    log.push('  期望 aidyn 子  = ' + JSON.stringify(AIDYN_SUBS) + '  实际=' + JSON.stringify(p.nav.aidynSubPanes)
      + (JSON.stringify(p.nav.aidynSubPanes) === JSON.stringify(AIDYN_SUBS) ? ' ✅' : ' ❌'));
    log.push('  期望 market 子 = ' + JSON.stringify(SUBS) + '  实际=' + JSON.stringify(p.nav.subPanes)
      + (JSON.stringify(p.nav.subPanes) === JSON.stringify(SUBS) ? ' ✅' : ' ❌'));
    log.push('  一级 tab 标签  = ' + JSON.stringify(p.nav.topLabels));
    log.push('  aidyn 子标签   = ' + JSON.stringify(p.nav.aidynSubLabels));
    for (const k of TOPSEQ) {
      await cdp.eval(`document.querySelector('#tabs button[data-pane="${k}"]').click()`);
      await sleep(420);
      /* 分组 tab 要逐个点子 tab；非分组 tab 只有它自己 */
      const subs = SUBS_OF[k] || [null];
      for (const s of subs) {
        if (s) {
          await cdp.eval(`document.querySelector('.subtabs[data-group="${k}"] button[data-sub="${s}"]').click()`);
          await sleep(420);
        }
        const pp = JSON.parse(await cdp.eval(PROBE));
        const dk = s || k;
        const pane = pp.panes[dk];
        const visTop = TOPSEQ.filter(x => pp.panes[x] && pp.panes[x].visible);
        if (SUBS_OF[k]) {
          const visSub = SUBS_OF[k].filter(x => pp.panes[x].visible);
          log.push('  ' + k + ' / ' + s + ' → 可见一级=' + JSON.stringify(visTop) + ' 可见子=' + JSON.stringify(visSub)
            + ' 子tab选中=' + JSON.stringify(pp.nav.subSelectedByGroup[k])
            + ' 文本=' + pane.textLen + ' 表格=' + pane.tables + ' svg=' + pane.svgs + ' 条目=' + pane.entries);
        } else {
          log.push('  ' + k + ' → 可见一级=' + JSON.stringify(visTop)
            + ' 文本=' + pane.textLen + ' 表格=' + pane.tables + ' svg=' + pane.svgs + ' 卡片=' + pane.cards + ' 条目=' + pane.entries);
        }
        log.push('       顶部: ' + pane.head);
        /* 逐版块日期：dataDate 必须随版块变，且标题徽标必须与它同值（同源渲染） */
        log.push('       数据日期=' + pp.dataDate + '  徽标=' + pp.badge
          + (pp.badge === pp.dataDate ? ' ✅同源' : ' ❌徽标与顶部不一致')
          + '  pill=' + pp.pill + '  更新于=' + pp.updatedAt + '  横向溢出=' + pp.overflowX);
        datePairs.push({ key: dk, dataDate: pp.dataDate, badge: pp.badge });
        await cdp.shot(path.join(TMP, 'tab-' + dk + '.png'), true);
      }
    }

    /* 数据日期必须「逐版块各不相同」且与各版块内容里的日期口径一致 —— 这正是用户报的
       问题：顶部一律 09-17，而龙虎榜/新闻正文写的是 09-16。全页同一个值即判失败。 */
    const uniq = Array.from(new Set(datePairs.map(x => x.dataDate)));
    const badBadge = datePairs.filter(x => x.badge !== x.dataDate).map(x => x.key);
    log.push('  数据日期一览   = ' + datePairs.map(x => x.key + ':' + x.dataDate).join('  '));
    log.push('  逐版块日期判定 = ' + (uniq.length > 1 ? '✅ 各不相同（' + uniq.join(' / ') + '）' : '❌ 全页同一个值 ' + uniq[0]));
    log.push('  徽标同源判定   = ' + (badBadge.length ? '❌ ' + badBadge.join(',') : '✅ 全部与顶部同值'));

    log.push('');
    log.push('==================== 财经市场 · 人气榜（日/周榜切换 + 趋势弹层）');
    /* 必须先把版块切回可见态，否则 getBoundingClientRect 全为 0（隐藏元素无布局） */
    await cdp.eval(`document.querySelector('#tabs button[data-pane="market"]').click()`);
    await sleep(200);
    await cdp.eval(`document.querySelector('.subtabs[data-group="market"] button[data-sub="astkday"]').click()`);
    await sleep(450);
    log.push('  分段探针      = ' + await cdp.eval(`(() => {
      const bar = document.getElementById('astkSeg');
      const btns = Array.from(bar.querySelectorAll('button'));
      const visNow = ['day','week'].filter(x => document.getElementById('seg-'+x) && !document.getElementById('seg-'+x).classList.contains('hide'));
      btns[1].click();   /* 切到周榜 */
      const visWeek = ['day','week'].filter(x => document.getElementById('seg-'+x) && !document.getElementById('seg-'+x).classList.contains('hide'));
      const wEntries = document.getElementById('seg-week').querySelectorAll('.entry').length;
      const wFirst = document.querySelector('#seg-week .entry') ? document.querySelector('#seg-week .entry').innerText.trim().replace(/\\s+/g,' ').slice(0,80) : '';
      btns[0].click();   /* 切回日榜 */
      const visDay = ['day','week'].filter(x => document.getElementById('seg-'+x) && !document.getElementById('seg-'+x).classList.contains('hide'));
      return JSON.stringify({ segButtons: btns.map(b => b.textContent.trim()),
        visibleOnLoad: visNow, visibleAfterWeek: visWeek, weekEntries: wEntries, weekFirst: wFirst, visibleBackToDay: visDay });
    })()`));
    await cdp.shot(path.join(TMP, 'tab-astkday.png'), true);
    /* 弹层：切到周榜后点击首行（趋势数据源自归档，周榜个股一定在归档里） */
    log.push('  趋势弹层      = ' + await cdp.eval(`(async () => {
      const out = {};
      const pane = document.getElementById('pane-astkday');
      document.querySelector('#astkSeg button[data-kseg="week"]').click();
      await new Promise(r => setTimeout(r, 120));
      const row = document.querySelector('#seg-week .entry[data-code]');
      if (!row) return JSON.stringify({ error: 'NO-ROW' });
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      const pop = document.getElementById('heatPop');
      out.hoverShown = !!pop && !pop.classList.contains('hide');
      out.hoverHasSvg = !!pop && !!pop.querySelector('svg');
      out.hoverText = pop ? pop.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80) : '';
      out.popInViewport = !!pop && pop.getBoundingClientRect().left >= 0 && pop.getBoundingClientRect().top >= 0;
      /* 点击固定：鼠标移开后弹层仍在；再点同一行 → 收起 */
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      out.pinned = !!pop && pop.classList.contains('pin');
      pane.dispatchEvent(new MouseEvent('mouseleave'));
      await new Promise(r => setTimeout(r, 80));
      out.staysAfterLeave = !!pop && !pop.classList.contains('hide');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      out.closedBySecondClick = !!pop && pop.classList.contains('hide');
      /* 悬浮态在鼠标移开后应收起 */
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      pane.dispatchEvent(new MouseEvent('mouseleave'));
      await new Promise(r => setTimeout(r, 60));
      out.hoverClosedByLeave = pop.classList.contains('hide');
      document.querySelector('#astkSeg button[data-kseg="day"]').click();
      return JSON.stringify(out);
    })()`));
    await cdp.shot(path.join(TMP, 'astkday-popup.png'), false);

    log.push('');
    log.push('==================== 财经市场 · 今日要闻（实时行情 + 当天财经快讯；结构信号表须已移除）');
    /* hk 已是「财经市场」的子 tab：先切一级，再切子 tab（顶栏日期随之变） */
    await cdp.eval(`document.querySelector('#tabs button[data-pane="market"]').click()`);
    await sleep(200);
    await cdp.eval(`document.querySelector('.subtabs[data-group="market"] button[data-sub="hk"]').click()`);
    await sleep(420);
    const HKPROBE = `(() => {
      const r = document.getElementById('pane-hk');
      const groups = Array.from(r.querySelectorAll('.newsgrp'));
      const items = Array.from(r.querySelectorAll('details.news'));
      const first = r.querySelector('.newsgrp .ng-h');
      return JSON.stringify({
        quoteCells: r.querySelectorAll('.hkstrip .cell').length,
        groups: groups.length,
        groupsVisible: groups.filter(g => g.getClientRects().length > 0).length,
        newsItems: items.length,
        latestRows: r.querySelectorAll('.newslatest li').length,
        segments: Array.from(r.querySelectorAll('#newsSeg button')).map(b => b.textContent.trim()),
        firstGroup: first ? first.innerText.trim().replace(/\\s+/g, ' ') : '',
        headings: Array.from(r.querySelectorAll('section.sec h2')).map(h => h.textContent.trim()),
        /* 结构信号表已按用户要求移除：正文里不得再出现该标题 */
        hasStructure: r.innerText.indexOf('开盘前结构信号') >= 0,
        /* 双语残留必须为 0 —— 本版块为纯中文 */
        langNodes: r.querySelectorAll('.lang-zh, .lang-en, #hkLang').length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth
      });
    })()`;
    log.push('  版块探测      = ' + await cdp.eval(HKPROBE));
    log.push('  结构信号残留  = ' + await cdp.eval(`String(document.getElementById('pane-hk').innerText.indexOf('开盘前结构信号') >= 0)`));
    await cdp.shot(path.join(TMP, 'tab-hk.png'), true);

    /* 折叠正文：展开首条，正文必须真实出现（而非空壳） */
    log.push('  展开首条      = ' + await cdp.eval(`(() => {
      const d = document.querySelector('#pane-hk details.news');
      if (!d) return 'NO-ITEM';
      d.open = true;
      const b = d.querySelector('.nb');
      return JSON.stringify({ open: d.open, bodyChars: b ? b.innerText.trim().length : 0,
        title: d.querySelector('.nh').innerText.trim().slice(0, 40) });
    })()`));
    await sleep(200);
    await cdp.shot(path.join(TMP, 'hk-news-open.png'), true);

    /* 维度筛选：点第 2 个按钮，只应留下对应分组 */
    log.push('  维度筛选      = ' + await cdp.eval(`(() => {
      const btns = document.querySelectorAll('#pane-hk #newsSeg button');
      if (btns.length < 2) return 'NO-SEG';
      btns[1].click();
      const gs = Array.from(document.querySelectorAll('#pane-hk .newsgrp'));
      return JSON.stringify({ clicked: btns[1].textContent.trim(),
        visible: gs.filter(g => g.getClientRects().length > 0).map(g => g.dataset.dim),
        hidden: gs.filter(g => g.getClientRects().length === 0).map(g => g.dataset.dim) });
    })()`));
    await sleep(200);
    log.push('  点回全部      = ' + await cdp.eval(`(() => {
      document.querySelectorAll('#pane-hk #newsSeg button')[0].click();
      return Array.from(document.querySelectorAll('#pane-hk .newsgrp')).filter(g => g.getClientRects().length > 0).length + ' 组可见';
    })()`));

    log.push('');
    log.push('==================== AI 动态 · 近 7 日（aidyn 的第二个子页签：分类筛选 + 折叠正文）');
    /* 必须先切到该子页签：隐藏 pane 的 getBoundingClientRect 全为 0，会假失败 */
    await cdp.eval(`document.querySelector('#tabs button[data-pane="aidyn"]').click()`);
    await sleep(300);
    await cdp.eval(`document.querySelector('.subtabs[data-group="aidyn"] button[data-sub="ai7d"]').click()`);
    await sleep(420);
    log.push('  分类筛选      = ' + await cdp.eval(`(() => {
      const btns = document.querySelectorAll('#pane-ai7d #ai7dSeg button');
      if (btns.length < 2) return 'NO-SEG';
      const gs = Array.from(document.querySelectorAll('#pane-ai7d .newsgrp[data-agrp]'));
      btns[1].click();
      const res = { clicked: btns[1].textContent.trim(),
        visible: gs.filter(g => g.getClientRects().length > 0).map(g => g.dataset.agrp),
        hidden: gs.filter(g => g.getClientRects().length === 0).map(g => g.dataset.agrp) };
      btns[0].click();
      res.groupsAfterReset = gs.filter(g => g.getClientRects().length > 0).length;
      return JSON.stringify(res);
    })()`));
    log.push('  展开首条      = ' + await cdp.eval(`(() => {
      const d = document.querySelector('#pane-ai7d .newsgrp[data-agrp] details.news');
      if (!d) return 'NO-ITEM';
      d.open = true;
      const b = d.querySelector('.nb');
      return JSON.stringify({ open: d.open, bodyChars: b ? b.innerText.trim().length : 0,
        title: d.querySelector('.nh').innerText.trim().slice(0, 40),
        linkHost: (d.querySelector('.nf a') ? new URL(d.querySelector('.nf a').href).host : '—') });
    })()`));
    await sleep(200);
    await cdp.shot(path.join(TMP, 'ai-items7d-open.png'), true);

    log.push('');
    log.push('==================== 第 2 次加载（同日，应命中当日缓存，不重复拉取）');
    reqCount = 0; reqUrls = [];
    loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    const pill2 = await cdp.eval(SETTLE);
    await sleep(600);
    log.push('  来源 pill     = ' + pill2);
    log.push('  网络请求数   = ' + reqCount + '（第 1 次为 ' + req1 + '）');
    log.push('  请求明细     = ' + (reqUrls.length ? reqUrls.slice(0, 5).join(' ; ') : '无外部请求 ✅'));
    const p2 = JSON.parse(await cdp.eval(PROBE));
    log.push('  AI 序号      = ' + p2.ai.idxSeq);
    log.push('  A股 数据条   = ' + JSON.stringify(p2.astock.strip));
    log.push('  A股 表格行数 = ' + p2.astock.lhbRows);
    log.push('  人气榜 分段   = ' + JSON.stringify(p2.astkday.segs) + '  日/周=' + p2.astkday.dayEntries + '/' + p2.astkday.weekEntries);
    log.push('  雷达 总体    = ' + p2.radar.overall + ' (' + p2.radar.level + ')');
    log.push('  数据日期/更新于 = ' + p2.dataDate + ' / ' + p2.updatedAt);
    log.push('  页面异常     = ' + (errors.length ? errors.join(' | ') : '无'));
    log.push('  缓存加载后各 tab 渲染完整性:');
    for (const k of ['aihot', 'astock', 'hk', 'astkday', 'radar']) {
      log.push('    ' + k + ' 文本=' + p2.panes[k].textLen + ' 表格=' + p2.panes[k].tables + ' svg=' + p2.panes[k].svgs + ' 卡片=' + p2.panes[k].cards + ' 条目=' + p2.panes[k].entries);
    }

    log.push('');
    log.push('==================== localStorage 缓存内容');
    const ls = await cdp.eval(`(() => { const s = localStorage.getItem('mb.cache.v2'); if(!s) return 'NONE'; const o = JSON.parse(s); return JSON.stringify({ cacheDate: o.cacheDate, at: o.at, tabs: Object.keys(o.tabs), bytes: s.length, hotlistHasSegments: !!(o.tabs.hotlist && o.tabs.hotlist.segments),
      hotlistArchiveDays: o.tabs.hotlist && Array.isArray(o.tabs.hotlist.heatArchive) ? o.tabs.hotlist.heatArchive.length : 0,
      localArchiveDays: (() => { try { const a = JSON.parse(localStorage.getItem('mb.heat.v1') || '[]'); return Array.isArray(a) ? a.length : 0; } catch (e) { return 0; } })(),
      /* 投影版块（astkday）不应写进缓存，否则等于存了第二份真源 */
      derivedLeaked: Object.keys(o.tabs).filter(k => k === 'astkday') }); })()`);
    log.push('  ' + ls);

    log.push('');
    log.push('==================== 第 3 次加载（断网 + 清空缓存 → 应降级为内置快照）');
    await cdp.eval('localStorage.clear()');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(5000);
    const p3 = JSON.parse(await cdp.eval(PROBE));
    log.push('  来源 pill     = ' + p3.pill);
    log.push('  数据日期/更新于 = ' + p3.dataDate + ' / ' + p3.updatedAt);
    log.push('  tab 角标     = ' + JSON.stringify(p3.tabCounts));
    log.push('  AI 序号      = ' + p3.ai.idxSeq);
    log.push('  AI 版块      = ' + JSON.stringify(p3.ai.sections));
    log.push('  人气榜 分段   = ' + JSON.stringify(p3.astkday.segs) + '  日/周=' + p3.astkday.dayEntries + '/' + p3.astkday.weekEntries);
    for (const k of ['aihot', 'astock', 'hk', 'astkday', 'radar']) {
      log.push('    ' + k + ' 文本=' + p3.panes[k].textLen + ' 表格=' + p3.panes[k].tables + ' svg=' + p3.panes[k].svgs + ' 卡片=' + p3.panes[k].cards + ' 条目=' + p3.panes[k].entries);
    }
    log.push('  横向溢出     = ' + p3.overflowX);
    log.push('  页面异常     = ' + (errors.length ? errors.join(' | ') : '无'));
    await cdp.shot(path.join(TMP, 'tab-3-offline.png'), true);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    log.push('');
    log.push('==================== 强制刷新（从「当日缓存」态点「刷新数据」，应重新拉取）');
    /* 第一次：实时拉取并写入缓存 */
    loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    log.push('  预热加载     = ' + await cdp.eval(IDLE) + '  pill=' + await cdp.eval(`document.getElementById('srcPill').textContent.trim()`));
    /* 第二次：应命中缓存（0 请求） */
    loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    reqCount = 0; reqUrls = [];
    await cdp.eval(IDLE);
    const pillBefore = await cdp.eval(`document.getElementById('srcPill').textContent.trim()`);
    log.push('  缓存态       = pill=' + pillBefore + '  请求数=' + reqCount);
    /* 点击刷新：应绕过缓存重新拉取 */
    reqCount = 0; reqUrls = [];
    await cdp.eval(`document.getElementById('refreshBtn').click()`);
    const idle4 = await cdp.eval(IDLE);
    const pill4 = await cdp.eval(`document.getElementById('srcPill').textContent.trim()`);
    await sleep(600);
    const p4 = JSON.parse(await cdp.eval(PROBE));
    log.push('  拉取结束     = ' + idle4);
    log.push('  网络请求数   = ' + reqCount + (reqCount > 0 ? '（已绕过缓存重新拉取 ✅）' : '（未发起请求 ❌）'));
    log.push('  点击后 pill  = ' + pill4);
    log.push('  AI 序号      = ' + p4.ai.idxSeq);
    log.push('  A股 数据条   = ' + JSON.stringify(p4.astock.strip));
    log.push('  雷达 总体    = ' + p4.radar.overall + ' (' + p4.radar.level + ')');
    log.push('  页面异常     = ' + (errors.length ? errors.join(' | ') : '无'));
  } catch (e) {
    log.push('脚本错误: ' + e.message + '\n' + e.stack);
  } finally {
    try { child.kill(); } catch {}
  }
  fs.writeFileSync(OUT, log.join('\n'), 'utf8');
  console.log('written -> ' + OUT);
})();
