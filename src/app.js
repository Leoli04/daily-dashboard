/* ============================================================================
 * 每日资讯看板 · 页面逻辑
 * 数据策略（四层，逐层降级）：
 *   L0 内置快照（HTML 内嵌 JSON）      → 立即渲染，无白屏
 *   L1 localStorage 当日缓存           → 同一天内不重新拉取
 *   L2 浏览器实时拉取（CORS 可用源）   → 刷新后回写 L1
 *   L3 单位置降级                       → 某源失败则该 tab 退回上一可用数据
 * 浏览器拉不到的源（如百度热搜）只能来自 L0 快照，不随刷新变化。
 * ==========================================================================*/
(function () {
  'use strict';
  var U = MB.utils;
  var esc = U.esc;
  var CACHE_KEY = 'mb.cache.v2';

  /* ------------------------------------------------------------ 运行状态 */
  var STATE = {
    active: 'aidyn',
    /* 分组 tab 各自记住上次选中的子 tab —— **必须是「每组一个」**。
       用单个字符串会让两个分组互相踩：从 market 切到 aidyn 时那个 'hk' 不属于 aidyn，
       回退逻辑只能每次都跳回第一个子 tab，用户在两个分组间来回切就永远回不到上次的位置。 */
    sub: { aidyn: 'aihot', market: 'hk' },
    tabs: {},            /* key -> { data, src:'live'|'cache'|'snap', at } */
    snapshot: null,
    liveRaw: null,
    lastFail: [],
    busy: false
  };

  var SRC_TEXT = { live: '实时拉取', cache: '当日缓存', snap: '内置快照' };
  var SRC_CLS = { live: 'live', cache: 'cache', snap: 'snap' };

  /* ------------------------------------------------------------ 缓存读写 */
  function readCache() {
    try {
      var s = localStorage.getItem(CACHE_KEY);
      if (!s) return null;
      var o = JSON.parse(s);
      if (!o || !o.cacheDate || !o.tabs) return null;
      /* 形状校验：tabs[k] 必须是载荷本身（旧版曾误存 {data,...} 包装，直接判为失效） */
      var keys = Object.keys(o.tabs);
      if (!keys.length) return null;
      for (var i = 0; i < keys.length; i++) {
        var v = o.tabs[keys[i]];
        if (!v || typeof v !== 'object' || v.data !== undefined) return null;
      }
      return o;
    } catch (e) { return null; }
  }
  function writeCache(cacheDate, payloads, at) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ cacheDate: cacheDate, at: at, tabs: payloads })); return true; }
    catch (e) { return false; }
  }
  /* 把 STATE.tabs 还原成「版块 -> 载荷」的纯数据映射 */
  function payloadMap() {
    var o = {};
    Object.keys(STATE.tabs).forEach(function (k) {
      if (DERIVED[k]) return;   /* 投影版块不进缓存，真源只存一份 */
      if (STATE.tabs[k] && STATE.tabs[k].data) o[k] = STATE.tabs[k].data;
    });
    return o;
  }

  /* ------------------------------------------------------------ 取数工具 */
  /* 主域名整段拦截时依次退到同族备用域名（改一个主机名、路径与字段不变）。
     只在「fetch 被 reject」（网络 / CORS 类故障）时换域名；HTTP 状态码错误属于语义错误，换了也没用。 */
  async function getJson(url, headers) {
    var cands = MB.altUrls(url), lastErr = null;
    for (var i = 0; i < cands.length; i++) {
      try {
        var res = await fetch(cands[i], { headers: headers || {}, cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (!(e instanceof TypeError)) throw e;
      }
    }
    throw lastErr;
  }

  /* 完整实时拉取（与 tools/fetch-sources.js 同构，仅限浏览器可直连源） */
  async function fetchAll() {
    var today = U.localDateStr();
    var ctx = {
      today: today, tradeDate: today, tradeDate8: today.replace(/-/g, ''),
      baselineDates: [], baselineDate8: '', builtAt: U.nowIso()
    };
    var raw = {}, fails = [];
    async function run(tasks) {
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        try {
          var j = await getJson(t.url, t.headers);
          if (t.id === 'ztpoolHist') { (raw.ztpoolHist = raw.ztpoolHist || []).push({ date: t.date, response: j }); }
          else raw[t.id] = j;
        } catch (e) { fails.push(t.id + ': ' + e.message); }
      }
    }
    await run(MB.buildTasks(ctx, 'browser').filter(function (t) { return t.phase === 1; }));
    var tradeDate = MB.pickTradeDate(raw.lhbRange) || today;
    ctx.tradeDate = tradeDate;
    ctx.tradeDate8 = tradeDate.replace(/-/g, '');
    ctx.baselineDates = U.backDates(tradeDate, 6);
    await run(MB.buildTasks(ctx, 'browser').filter(function (t) { return t.phase === 2; }));

    var base = MB.collectBaseline(raw).filter(function (x) { return x.count > 0; });
    var cursor = ctx.baselineDates[ctx.baselineDates.length - 1] || tradeDate;
    var guard = 0;
    while (base.length < 4 && guard++ < 3) {
      ctx.baselineDates = U.backDates(cursor, 4);
      cursor = ctx.baselineDates[ctx.baselineDates.length - 1];
      await run(MB.buildTasks(ctx, 'browser').filter(function (t) { return t.id === 'ztpoolHist'; }));
      base = MB.collectBaseline(raw).filter(function (x) { return x.count > 0; });
    }
    ctx.baselineDates = base.map(function (x) { return x.date; });
    ctx.snapshotAt = U.nowIso();
    return { raw: raw, ctx: ctx, fails: fails };
  }

  /* ------------------------------------------------------------ 小工具 */
  function pctCls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }
  function fmtPct(v) { return U.fmtPct(v); }
  function pctTag(v, text) {
    return '<span class="tagpill ' + (v > 0 ? 'up' : v < 0 ? 'dn' : '') + '">' + esc(text) + '</span>';
  }
  function bx(n, d) { return (Number(n) || 0).toFixed(d == null ? 2 : d); }

  /* SVG 横向条形图：数值右对齐到画布右缘，标签按需截断，保证不越界 */
  function barChart(rows, o) {
    o = o || {};
    if (!rows.length) return '<div class="empty">暂无数据</div>';
    var rowH = 20, gap = 7, top = 6, W = o.width || 620, valueW = o.valueW || 78;
    var maxLen = Math.min(13, Math.max.apply(null, rows.map(function (r) { return String(r.label).length; })));
    var labelW = Math.min(o.labelMax || 132, Math.max(52, maxLen * 12 + 10));
    var plotX = labelW + 9, plotW = W - plotX - valueW - 6;
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.value); }).concat([o.minMax || 0.0001]));
    var h = top + rows.length * (rowH + gap);
    var gid = 'g' + Math.random().toString(36).slice(2, 7);
    var out = [];
    out.push('<defs>');
    out.push('<linearGradient id="' + gid + 'u" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e02020" stop-opacity="0.72"/><stop offset="1" stop-color="#ff5252" stop-opacity="1"/></linearGradient>');
    out.push('<linearGradient id="' + gid + 'd" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0a9d5a" stop-opacity="0.72"/><stop offset="1" stop-color="#16c07a" stop-opacity="1"/></linearGradient>');
    out.push('</defs>');
    rows.forEach(function (r, i) {
      var y = top + i * (rowH + gap);
      var w = Math.max(2, Math.round(plotW * Math.abs(r.value) / max));
      var lbl = String(r.label);
      if (lbl.length > maxLen) lbl = lbl.slice(0, maxLen - 1) + '…';
      out.push('<text x="' + (plotX - 8) + '" y="' + (y + rowH * 0.74) + '" text-anchor="end" class="svg-lbl">' + esc(lbl) + '</text>');
      out.push('<rect x="' + plotX + '" y="' + y + '" width="' + w + '" height="' + rowH + '" rx="3" fill="url(#' + gid + (r.value >= 0 ? 'u' : 'd') + ')"/>');
      out.push('<text x="' + (W - 2) + '" y="' + (y + rowH * 0.74) + '" text-anchor="end" class="svg-val ' + (r.value >= 0 ? 'up' : 'down') + '">' + esc(r.text) + '</text>');
    });
    return '<svg viewBox="0 0 ' + W + ' ' + h + '" width="100%" role="img" aria-label="' + esc(o.aria || '条形图') + '">' + out.join('') + '</svg>';
  }

  function statStrip(cells) {
    return '<div class="strip c' + Math.min(5, cells.length) + '">' + cells.map(function (c, i) {
      return '<div class="cell k' + ((i % 5) + 1) + '">'
        + '<div class="cl">' + (c.dot ? '<span class="dot ' + c.dot + '"></span>' : '') + esc(c.label) + '</div>'
        + '<div class="cv ' + (c.cls || '') + '">' + c.value + (c.unit ? '<small>' + esc(c.unit) + '</small>' : '') + '</div>'
        + (c.note ? '<div class="cx">' + c.note + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  /* ======================================================== Tab 1 · AI 日报 */
  function renderAihot(d, meta) {
    var rep = d.report || {};
    var counts = d.counts || [];
    var maxC = Math.max.apply(null, counts.map(function (c) { return c.count; }).concat([1]));
    var dist = counts.map(function (c) {
      var w = c.count / (d.total || 1) * 100;
      if (!c.count) return '';
      return '<i style="width:' + w.toFixed(2) + '%;background:' + c.accent + '"></i>';
    }).join('');
    var legend = counts.map(function (c) {
      return '<span><em style="background:' + c.accent + '"></em>' + esc(c.label) + ' <b class="mono">' + c.count + '</b></span>';
    }).join('');

    var html = '';
    html += '<div class="hero">'
      + '<div class="kick">AI DAILY BRIEFING</div>'
      + '<h1>AI 日报</h1>'
      /* 原先此处有一行时间说明，已按用户要求移除：页面顶部已有唯一的时间标注，同页不再出现第二个 */
      + '<div class="hstats">'
      + '<div class="hstat"><div class="n">' + d.total + '</div><div class="l">今日收录条目</div></div>'
      + '<div class="hstat"><div class="n">' + counts.length + '</div><div class="l">固定版块</div></div>'
      + '<div class="hstat"><div class="n">' + counts.filter(function (c) { return c.count > 0; }).length + '</div><div class="l">有内容的版块</div></div>'
      + '<div class="hstat"><div class="n">' + esc((rep.date || '').slice(5) || '—') + '</div><div class="l">日报日期</div></div>'
      + '</div>'
      + '<div class="dist">' + dist + '</div>'
      + '<div class="dist-legend">' + legend + '</div>'
      + '</div>';

    /* 导航项：只列当日报的五个版块 —— 近 7 日条目流已独立成一级 tab，不再混在这里 */
    var navItems = counts.slice();
    html += '<nav class="anchors" aria-label="版块导航">' + navItems.map(function (c) {
      return '<button type="button" data-target="sec-' + esc(c.key) + '">' + esc(c.label.replace(/\s*\/\s*/g, '/'))
        + '<span class="nav-count' + (c.count ? '' : ' zero') + '">' + c.count + '</span></button>';
    }).join('') + '</nav>';

    d.sections.forEach(function (s) {
      html += '<section class="sec" id="sec-' + esc(s.key) + '">'
        + '<div class="sec-h"><span class="bar" style="background:linear-gradient(' + s.accent + ',' + s.accent + ')"></span>'
        + '<h2>' + esc(s.label) + '</h2>'
        + '<span class="note">' + s.items.length + ' 条' + (s.extra ? ' · 日报中未归入五个固定版块，按原标签保留' : '') + '</span></div>';
      if (!s.items.length) {
        html += '<div class="panel"><div class="empty">无</div></div>';
      } else {
        html += '<div class="cards">';
        s.items.forEach(function (it) {
          /* 直连原始来源：原文优先；AI HOT 条目页只作原文缺失时的兜底（并如实标注） */
          var orig = it.orig !== undefined ? it.orig : (it.altUrl || '');
          var entry = it.entry !== undefined ? it.entry : (it.altUrl ? it.url : '');
          var main = orig || entry || it.url || '';
          html += '<article class="card" style="border-left-color:' + s.accent + '">'
            + '<div class="card-head"><span class="idx" style="color:' + s.accent + '">' + U.pad2(it.idx) + '</span>'
            + '<h3 class="card-title">' + (main ? '<a href="' + esc(main) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + '</a>' : esc(it.title)) + '</h3></div>'
            + '<span class="chip"><span class="d" style="background:' + s.accent + '"></span>' + esc(it.source || '未知来源') + '</span>'
            + '<p class="card-summary">' + esc(it.summary) + '</p>'
            + '<div class="card-links">'
            + (orig ? '<a class="alt" href="' + esc(orig) + '" target="_blank" rel="noopener noreferrer">原始来源 ↗</a>'
              : (entry ? '<a class="alt" href="' + esc(entry) + '" target="_blank" rel="noopener noreferrer">原文链接缺失 · 条目页 ↗</a>' : ''))
            + '</div></article>';
        });
        html += '</div>';
      }
      html += '</section>';
    });

    return html;
  }

  /* ============================================= Tab 2 · AI 动态（近 7 日条目流）
     与当日日报出自同一提供方的另一个端点（7 天窗口的精选条目），但两者口径不同
     —— 日报是「当天五个版块的精选」，这里是「7 天窗口内按发布时间倒序」。
     原先两者叠在同一个 tab 里，一天的几条与一周的几十条连着滚到底；
     拆成独立一级 tab 后各自完整占一屏，互不干扰。
     形态与「全部要闻」一致：分类筛选条 + details 折叠卡，零额外 JS 依赖、键盘可达。 */
  function renderAi7d(d) {
    var s = d || { items: [], groups: [] };
    var items = s.items || [];
    var html = '<div class="hero">'
      + '<div class="kick">AI WEEKLY STREAM</div>'
      + '<h1>AI 动态 · 近 7 日</h1>'
      + '<div class="hstats">'
      + '<div class="hstat"><div class="n">' + items.length + '</div><div class="l">条目总数</div></div>'
      + '<div class="hstat"><div class="n">' + (s.groups || []).length + '</div><div class="l">分类数</div></div>'
      + '<div class="hstat"><div class="n">' + esc(String(s.from || '').slice(5) || '—') + '</div><div class="l">起始</div></div>'
      + '<div class="hstat"><div class="n">' + esc(String(s.to || '').slice(5) || '—') + '</div><div class="l">最新</div></div>'
      + '</div></div>';

    var head = '<div class="sec-h"><span class="bar" style="background:var(--t1)"></span><h2>近 7 日 AI 动态</h2>';
    if (!items.length) {
      return html + '<section class="sec" id="sec-items7d">' + head + '</div>'
        + '<div class="panel"><div class="empty">无</div></div></section>';
    }
    html += '<section class="sec" id="sec-items7d">' + head
      + '<span class="note">' + esc(s.from || '—') + ' — ' + esc(s.to || '—') + ' · 共 ' + items.length
      + ' 条 · 按发布时间倒序</span></div>';

    html += '<div class="segbar" id="ai7dSeg">'
      + '<button type="button" data-aseg="all" class="on">全部 <b>' + items.length + '</b></button>'
      + (s.groups || []).map(function (g) {
        return '<button type="button" data-aseg="' + esc(g.key) + '">' + esc(g.label) + ' <b>' + g.count + '</b></button>';
      }).join('')
      + '</div>';

    html += (s.groups || []).map(function (g) {
      return '<div class="newsgrp" data-agrp="' + esc(g.key) + '">'
        + '<h3 class="ng-h">' + esc(g.label) + '<span>' + g.count + ' 条</span></h3>'
        + g.items.map(function (x) { return aiItemCard(x, g.accent); }).join('')
        + '</div>';
    }).join('');

    return html + '</section>';
  }

  /* 条目卡：左侧色条用所属分类的配色（分类名与配色挂在分组上，条目侧只带 slug） */
  function aiItemCard(x, accent) {
    return '<details class="news" style="border-left-color:' + esc(accent) + '">'
      + '<summary><span class="nt">' + esc(x.time || '—') + '</span>'
      + '<span class="nh">' + (x.url
        ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + '</a>'
        : esc(x.title)) + '</span></summary>'
      + '<div class="nb">' + esc(x.summary) + '</div>'
      + '<div class="nf">'
      + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">原文 ↗</a>' : '')
      + '<span>' + esc(x.source || '未知来源') + '</span>'
      + '</div></details>';
  }

  /* ============================================== 一级 tab「A股盘面」· 子 tab 1 · 市场情绪 */
  function renderAstock(d, meta) {
    var b = d.breadth || {}, lhb = d.lhb || {}, lu = d.limitUp || {}, ind = d.industries || {}, con = d.concepts || {};
    var m = d.margin || {};
    var isToday = d.tradeDate === U.localDateStr();
    var html = '';

    html += '<div class="banner' + (isToday ? '' : ' warn') + '">'
      + '<span class="ic">' + (isToday ? '📅' : '⚠') + '</span>'
      + '<div><b>报告交易日 ' + esc(d.tradeDate || '—') + '</b>'
      + (isToday ? '（当日）' : '（今日非交易日，或当日龙虎榜尚未发布，已自动回退到最近一个数据齐备的交易日）')
      + '<br>龙虎榜、涨停池、涨停板块分布均按上述交易日精确取数；指数、行业、概念为实时快照口径。</div></div>';

    html += statStrip([
      { label: '龙虎榜上榜', dot: 'y', value: lhb.count || 0, unit: ' 家', note: '同股多原因已合并 · 净买入为正 <span class="up">' + (lhb.posCount || 0) + '</span> / 为负 <span class="down">' + (lhb.negCount || 0) + '</span>' },
      { label: '涨停家数', dot: 'r', value: b.limitUp == null ? '—' : b.limitUp, unit: ' 只', note: '跌停 <span class="down">' + (b.limitDown == null ? '—' : b.limitDown) + '</span> 只 · 前一日涨停 ' + (b.prevLimitUp == null ? '—' : b.prevLimitUp) },
      { label: '封板率', dot: 'r', value: b.limitUpRate == null ? '—' : b.limitUpRate, unit: '%', note: '炸板 <span class="down">' + (b.openNum == null ? '—' : b.openNum) + '</span> 只' },
      { label: '上涨占比', dot: 'b', value: b.upRatio == null ? '—' : b.upRatio, unit: '%', note: '涨 <span class="up">' + b.up + '</span> / 跌 <span class="down">' + b.down + '</span> / 平 ' + b.flat },
      { label: '两市成交额', dot: 'g', value: b.amountYi ? b.amountYi.toFixed(0) : '—', unit: ' 亿', note: '沪 + 深合计' }
    ]);

    html += '<div class="sec"><div class="sec-h"><span class="bar" style="background:linear-gradient(var(--t2),var(--gold))"></span><h2>指数行情</h2>'
      + '<span class="note">涨红跌绿</span></div>'
      + '<div class="strip c4">' + (d.indices || []).map(function (x, i) {
        return '<div class="cell k' + ((i % 4) + 1) + '">'
          + '<div class="cl">' + esc(x.name) + '</div>'
          + '<div class="cv ' + pctCls(x.chg) + '">' + (x.point == null ? '—' : x.point.toFixed(2)) + '</div>'
          + '<div class="cx"><span class="' + pctCls(x.chg) + ' mono">' + fmtPct(x.chg) + '</span>　'
          + '<span class="mono" style="color:var(--dim)">' + (x.delta > 0 ? '+' : '') + (x.delta == null ? '—' : x.delta.toFixed(2)) + '</span>　'
          + '额 ' + (x.amount ? (x.amount / 1e8).toFixed(0) + '亿' : '—') + '</div></div>';
      }).join('') + '</div></div>';

    html += '<div class="grid2">';

    /* 题材热度：同花顺涨停板块分布 */
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--gold)"></span><h2>题材热度榜</h2>'
      + '<span class="note">同花顺涨停板块分布 · 按板块涨停家数 · TOP 14</span></div><div class="panel">'
      + barChart((d.themes || []).slice(0, 14).map(function (t) {
        return { label: t.name, value: t.limitUpNum || 0, text: (t.limitUpNum || 0) + ' 只' };
      }), { width: 620, valueW: 62, aria: '题材涨停家数' })
      + '<div class="lg"><span class="li"><span class="sw r"></span><span>板块涨停家数越多 = 当日题材共振越强</span></span></div></div></section>';

    /* 涨停梯队 */
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--up)"></span><h2>涨停梯队</h2>'
      + '<span class="note">连板数降序 · 最高 ' + (lu.maxBoard || 0) + ' 连板 · 连板 ' + (lu.lianbanCount || 0) + ' 只</span></div>'
      + '<div class="tbl-wrap"><table><thead><tr><th>代码</th><th>名称</th><th class="r">涨幅</th><th class="r">连板</th><th class="r">封单额</th><th class="r">换手</th><th>行业</th></tr></thead><tbody>'
      + (lu.ladder || []).slice(0, 12).map(function (x) {
        return '<tr><td class="mono">' + esc(x.code) + '</td><td class="nm">' + esc(x.name) + '</td>'
          + '<td class="mono up r">' + fmtPct(x.chg) + '</td>'
          + '<td class="mono up r">' + (x.boardDays || 1) + ' 板</td>'
          + '<td class="mono r">' + U.fmtYi(x.sealAmt) + '</td>'
          + '<td class="mono flat r">' + (x.turn == null ? '—' : x.turn.toFixed(1) + '%') + '</td>'
          + '<td class="reason">' + esc(x.industry || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    html += '</div>';

    html += '<div class="grid2">';
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--up)"></span><h2>行业轮动 · 领涨 / 领跌</h2>'
      + '<span class="note">东财行业板块 · 共 ' + (ind.count || 0) + ' 个 · 涨红跌绿</span></div><div class="panel">'
      + '<div class="col-h"><span>涨幅榜 TOP 10</span><span class="tag r">领涨</span></div>'
      + barChart((ind.top || []).map(function (x) { return { label: x.name, value: x.chg, text: fmtPct(x.chg) }; }), { width: 620, valueW: 72, aria: '行业领涨' })
      + '<div class="col-h" style="margin:16px 0 9px"><span>涨幅垫底 TOP 10</span><span class="tag g">最弱</span></div>'
      + barChart((ind.bottom || []).map(function (x) { return { label: x.name, value: x.chg, text: fmtPct(x.chg) }; }), { width: 620, valueW: 72, aria: '行业领跌' })
      + '</div></section>';

    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--accent)"></span><h2>概念板块涨幅</h2>'
      + '<span class="note">东财概念板块 · 共 ' + (con.count || 0) + ' 个 · TOP 12</span></div>'
      + '<div class="tbl-wrap"><table><thead><tr><th>板块</th><th class="r">涨跌幅</th><th class="r">主力净流入</th></tr></thead><tbody>'
      + (con.top || []).map(function (x) {
        return '<tr><td class="nm">' + esc(x.name) + '</td>'
          + '<td class="mono ' + pctCls(x.chg) + ' r">' + fmtPct(x.chg) + '</td>'
          + '<td class="mono ' + pctCls(x.flow) + ' r">' + U.fmtYi(x.flow) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="lg"><span class="li">主力净流入 = 大单 + 超大单净额</span></div></section>';
    html += '</div>';

    /* 龙虎榜 */
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--gold)"></span><h2>龙虎榜核心</h2>'
      + '<span class="note">全市场上榜 ' + (lhb.count || 0) + ' 家（同一股票多个上榜原因已合并）· 净买入合计 ' + U.fmtYi(lhb.netSum) + ' · ' + esc(d.tradeDate) + '</span></div>';
    html += '<div class="panel" style="margin-bottom:14px"><div class="col-h"><span>净买入 TOP 15 排名</span><span class="tag r">资金流入</span></div>'
      + barChart((lhb.topBuy || []).map(function (x) { return { label: x.name, value: (x.net || 0) / 1e8, text: U.fmtYi(x.net) }; }),
        { width: 900, valueW: 86, labelMax: 120, aria: '龙虎榜净买入' }) + '</div>';
    html += '<div class="grid2">';
    html += '<div><div class="col-h"><span>净买入明细 TOP 12</span><span class="tag r">流入</span></div><div class="tbl-wrap"><table>'
      + '<thead><tr><th>代码</th><th>名称</th><th class="r">涨跌幅</th><th class="r">净买入</th><th class="r">换手</th><th>上榜原因</th></tr></thead><tbody>'
      + (lhb.topDetail || []).slice(0, 12).map(function (x) {
        return '<tr><td class="mono">' + esc(x.code) + '</td><td class="nm">' + esc(x.name) + '</td>'
          + '<td class="mono ' + pctCls(x.chg) + ' r">' + fmtPct(x.chg) + '</td>'
          + '<td class="mono ' + pctCls(x.net) + ' r">' + U.fmtYi(x.net) + '</td>'
          + '<td class="mono flat r">' + (x.turn == null ? '—' : x.turn.toFixed(2) + '%') + '</td>'
          + '<td class="reason">' + esc(x.reason) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    html += '<div><div class="col-h"><span>净卖出 TOP 8</span><span class="tag g">资金出逃</span></div><div class="tbl-wrap"><table>'
      + '<thead><tr><th>代码</th><th>名称</th><th class="r">涨跌幅</th><th class="r">净买入</th><th>上榜原因</th></tr></thead><tbody>'
      + (lhb.topSell || []).map(function (x) {
        return '<tr><td class="mono">' + esc(x.code) + '</td><td class="nm">' + esc(x.name) + '</td>'
          + '<td class="mono ' + pctCls(x.chg) + ' r">' + fmtPct(x.chg) + '</td>'
          + '<td class="mono down r">' + U.fmtYi(x.net) + '</td>'
          + '<td class="reason">' + esc(x.reason) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    html += '</div></section>';

    /* 强势股归因 */
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--t2)"></span><h2>涨停股题材归因</h2>'
      + '<span class="note">同花顺涨停池 reason_type · 当日涨停 ' + (b.limitUp == null ? '—' : b.limitUp) + ' 只 · 取前 18</span></div>'
      + '<div class="tbl-wrap"><table><thead><tr><th>代码</th><th>名称</th><th>连板</th><th>涨停类型</th><th class="r">封单额</th><th>题材归因</th></tr></thead><tbody>'
      + (lu.thsTop || []).slice(0, 18).map(function (x) {
        return '<tr><td class="mono">' + esc(x.code) + '</td><td class="nm">' + esc(x.name) + '</td>'
          + '<td class="mono up">' + esc(x.highDays || '—') + '</td>'
          + '<td class="mono flat">' + esc(x.type || '—') + '</td>'
          + '<td class="mono r">' + U.fmtYi(x.sealAmt) + '</td>'
          + '<td class="reason">' + esc(x.reason) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="lg"><span class="li"><span class="sw r"></span><span>红 = 上涨</span></span><span class="li"><span class="sw g"></span><span>绿 = 下跌</span></span>'
      + '<span class="li" style="color:var(--dim)">龙虎榜与涨停池按交易日取数；行业、概念、指数为实时快照</span></div></section>';

    return html;
  }

  /* 热股榜条目列表：原属热搜版块，随「A股人气榜 · 日榜」一起搬到 A股盘面 */
  function maxHeat(arr) { return Math.max.apply(null, arr.map(function (x) { return x.heat || 0; }).concat([1])); }

  function stockRows(arr) {
    if (!arr.length) return '<div class="panel"><div class="empty">暂无数据</div></div>';
    var mx = maxHeat(arr);
    return '<div class="entries">' + arr.slice(0, 30).map(function (x, i) {
      var pct = Math.max(6, Math.round((x.heat || 0) / mx * 100));
      var chgTag = x.chgRank ? (x.chgRank > 0 ? pctTag(1, '↑' + x.chgRank) : pctTag(-1, '↓' + Math.abs(x.chgRank))) : '';
      return '<div class="entry' + (i < 3 ? ' top' : '') + '">'
        + '<div class="rk"><div class="no">' + U.pad2(x.rank) + '</div><div class="src">' + esc(x.code) + '</div></div>'
        + '<div class="body">'
        + '<div class="hl">' + esc(x.name) + chgTag + (x.title ? '<span class="tagpill up" style="background:rgba(224,169,74,.18);color:var(--gold)">' + esc(x.title) + '</span>' : '') + '</div>'
        + '<div class="dek' + (x.analyse ? '' : ' empty') + '">' + esc(x.analyse || '暂无归因摘要') + '</div>'
        + '</div>'
        + '<div class="idx"><div class="val">' + esc(x.heatTxt) + '</div><div class="cap">热度指数</div>'
        + '<div class="bar"><i style="width:' + pct + '%"></i></div></div>'
        + '</div>';
    }).join('') + '</div>';
  }

  /* ======================================================== Tab 3 · 热搜
     本版块只上屏百度热搜（构建时快照）。同花顺热股榜只剩日榜上屏，且移到
     「A股盘面 · 人气榜 · 日榜」子版块；另一条短周期粒度榜不再展示，但其数据
     仍在载荷里 —— 风险雷达的「热度」维度要用它算集中度。 */
  function renderHotlist(d, meta) {
    var w = (d.segments && d.segments.web) || { items: [] };
    var html = '';

    /* 只剩一个分段也保留分段条：与「全部要闻」的维度筛选同一交互外观，
       日后往这里加榜不必改结构。单按钮由 :only-child 收窄，不铺满整行。 */
    html += '<div class="segbar" id="hotSeg">'
      + '<button type="button" data-seg="web" class="on">全网热搜 · 百度</button>'
      + '</div>';

    function webRows(arr) {
      if (!arr.length) return '<div class="panel"><div class="empty">暂无数据</div></div>';
      return '<div class="entries">' + arr.slice(0, 30).map(function (x, i) {
        return '<div class="entry' + (i < 3 ? ' top' : '') + '">'
          + '<div class="rk"><div class="no">' + U.pad2(x.rank) + '</div><div class="src">原榜 ' + (x.srcRank == null ? '—' : '#' + x.srcRank) + '</div></div>'
          + '<div class="body">'
          + '<div class="hl">' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + '</a>' : esc(x.title))
          + (x.isTop ? '<span class="tagpill hot">置顶</span>' : '') + '</div>'
          + '<div class="dek' + (x.desc ? '' : ' empty') + '">' + esc(x.desc || '暂无详情摘要') + '</div>'
          + '</div>'
          + '<div class="idx"><div class="val">#' + x.rank + '</div><div class="cap">百度名次</div>'
          + '<div class="bar"><i style="width:' + Math.max(6, 100 - (x.rank - 1) * 3) + '%"></i></div></div>'
          + '</div>';
      }).join('') + '</div>';
    }

    html += '<div id="seg-web">' + webRows(w.items || []) + '</div>';

    html += '<div class="panel hint" style="margin-top:16px">'
      + '全网热搜：百度热搜榜，展示名次按榜面顺序编号，另标注百度原始名次。'
      + '</div>';
    return html;
  }

  /* ========================================== A股盘面 · 人气榜日榜（子 tab）
     数据不是独立抓取的源，而是「热搜版块日榜」的投影（见 DERIVED / syncDerived），
     故本版块不单独入库 —— 真源只有一份。 */
  function renderAstkDay(d, meta) {
    var arr = (d && d.entries) || [];
    var tip = arr.length
      ? ('A股人气榜：同花顺热股榜，展示名次按接口返回顺序 01–' + U.pad2(arr.length) + ' 连续编号；热度指数为接口原始热度值。')
      : '';
    return '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--t3)"></span><h2>A股人气榜 · 日榜</h2>'
      + '<span class="note">同花顺热股榜 · 当日累计人气 · 共 ' + arr.length + ' 只</span></div>'
      + stockRows(arr)
      + (tip ? '<div class="panel hint" style="margin-top:14px">' + tip + '</div>' : '')
      + '</section>';
  }

  /* ======================================================== Tab 4 · 雷达 */
  function renderRadar(d, meta) {
    var html = '';
    var ov = d.overall;
    var tcls = 'tone-' + d.tone;
    var bcls = 'bg-' + d.tone;
    html += '<div class="verdict">'
      + '<div class="gauge"><div class="num ' + tcls + '">' + (ov == null ? '—' : ov) + '</div>'
      + '<div class="lvl">总体情绪温度 · ' + esc(d.level) + '</div>'
      + '<div class="meter"><i class="' + bcls + '" style="width:' + (ov || 0) + '%"></i></div></div>'
      + '<div><div class="vl">RULE-BASED SENTIMENT RADAR</div>'
      + '<h2>' + esc(d.headline) + '</h2><p>' + esc(d.body) + '</p>'
      + '<p style="margin-top:9px;font-size:11.5px;color:var(--dim)">报告交易日 ' + esc(d.dataDate || '—')
      + '　·　分数由当日公开数据按固定公式换算，非预测模型</p></div></div>';

    html += '<div class="scores">' + (d.metrics || []).map(function (m) {
      return '<div class="scorec"><div class="sn tone-' + m.tone + '">' + (m.value == null ? '—' : m.value) + '</div>'
        + '<div class="sl">' + esc(m.label) + '<span class="tagpill" style="background:rgba(255,255,255,.06);color:var(--sub);margin-left:auto">' + esc(m.level) + '</span></div>'
        + '<div class="sb"><i class="bg-' + m.tone + '" style="width:' + (m.value || 0) + '%"></i></div>'
        + '<div class="sx">' + esc(m.note) + '</div></div>';
    }).join('') + '</div>';

    html += '<div class="grid2">' + (d.evidence || []).map(function (g) {
      return '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--t4)"></span><h2>' + esc(g.title) + '</h2></div>'
        + '<div class="panel"><ul class="evlines">' + g.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div></section>';
    }).join('') + '</div>';

    html += '<div class="grid2">'
      + '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--gold)"></span><h2>接下来观察什么</h2></div>'
      + '<div class="panel"><ul class="watchlist">' + (d.watch || []).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div></section>'
      + '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--accent)"></span><h2>分数怎么来的</h2>'
      + '<span class="note">固定公式，可逐项核对</span></div>'
      + '<div class="panel"><ul class="evlines">' + (d.rules || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>'
      + '<div class="hint" style="margin-top:10px">分档：≥70 偏高（红）· 55–69 中等（黄）· &lt;55 较低（绿）。'
      + '基线取自近若干交易日的涨停家数；指数历史接口在当前网络不可达，故不使用 K 线分位。</div></div></section>'
      + '</div>';
    return html;
  }

  /* ============================================ 财经市场 · 今日要闻
     数字层 = 实时行情（公开行情接口，每次打开刷新）
     叙事层 = 当天财经快讯（华尔街见闻，浏览器可直连，与行情同节奏）
     两层是**两个独立数据版块**（hk / news），任一方拉取失败另一方照常显示。
     原「开盘前结构信号」表、版块来源说明横幅均已按用户要求移除 —— 页面只呈现数据本身，
     来源与更新方式的完整说明另见工作区根目录的《数据来源说明.md》。 */
  function renderHk(d, meta) {
    var qs = (d.quotes || []).filter(function (x) { return x.price !== null; });
    var all = d.quotes || [];
    var news = (STATE.tabs.news && STATE.tabs.news.data) || null;

    function qobj(key) { for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i]; return null; }

    var html = '';

    if (!qs.length) {
      html += '<div class="panel"><div class="empty">暂无可用行情数据</div></div>';
      html += renderNews(news);
      return html;
    }

    /* ---- 顶部大数：A股宽基一行 + 港股·宏观一行（每行 5 列，与 .strip 上限一致） ---- */
    function cellOf(x) {
      return {
        label: x.name, dot: x.key === 'us10y' ? 'p' : 'b',
        value: x.priceTxt + (x.isYield ? '<small>%</small>' : ''),
        cls: pctCls(x.chgPct),
        note: '<span class="mono ' + pctCls(x.chgPct) + '">' + x.chgTxt + '</span>　'
          + '<span class="mono" style="color:var(--dim)">' + x.dayTxt + '</span>'
      };
    }
    /* stripRows 由数据层给出（normalizeHk 的 STRIP_ROWS）；旧快照无该字段时退回原五行 */
    var rows = (d.stripRows && d.stripRows.length) ? d.stripRows
      : [{ quotes: ['hsi', 'hstech', 'hscei', 'dxy', 'us10y'].map(qobj).filter(Boolean) }];
    var strips = rows.map(function (r) {
      return statStrip((r.quotes || []).filter(function (x) { return x.price !== null; }).map(cellOf));
    }).filter(function (s) { return s.indexOf('class="cell') >= 0; });
    if (strips.length) html += '<div class="hkstrip">' + strips.join('') + '</div>';

    /* ---- 今日要点（原「开盘前结构信号」表已按用户要求移除） ---- */
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--accent)"></span><h2>今日要点</h2>'
      + '<span class="note">' + (news && news.present ? '当天新闻里最新的 ' + (news.latest || []).length + ' 条' : '当天新闻尚未抓取')
      + '</span></div>'
      + '<div class="panel">' + renderLatest(news) + '</div></section>';

    /* ---- 当天财经新闻（独立于行情：行情实时拉取失败时，新闻照常显示） ---- */
    html += renderNews(news);

    /* ---- 跨资产一览 ---- */
    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--t2)"></span><h2>跨资产一览 · 涨跌幅</h2>'
      + '<span class="note">' + qs.length + ' 个品种 · 单位统一为 % · 涨红跌绿</span></div><div class="panel">'
      + barChart(qs.map(function (x) { return { label: x.name, value: x.chgPct, text: x.chgTxt }; }),
        { width: 900, valueW: 80, labelMax: 150, aria: '今日财经要闻跨资产涨跌幅' })
      + '</div></section>';

    html += '<section class="sec"><div class="sec-h"><span class="bar" style="background:var(--t4)"></span><h2>品种明细</h2>'
      + '<span class="note">共 ' + all.length + ' 个品种</span></div>'
      + '<div class="tbl-wrap"><table><thead><tr><th>品种</th><th>代码</th><th class="r">最新</th><th class="r">涨跌</th><th class="r">涨跌幅</th><th>单位</th></tr></thead><tbody>'
      + all.map(function (x) {
        if (x.price === null) {
          return '<tr><td class="nm">' + esc(x.name) + '</td><td class="mono" style="color:var(--dim)">' + esc(x.secid) + '</td>'
            + '<td class="mono r" colspan="3" style="color:var(--dim)">该品种本次未返回数据</td><td style="color:var(--dim)">—</td></tr>';
        }
        return '<tr><td class="nm">' + esc(x.name) + '</td>'
          + '<td class="mono" style="color:var(--dim)">' + esc(x.secid) + '</td>'
          + '<td class="mono r ' + pctCls(x.chgPct) + '">' + esc(x.priceTxt) + '</td>'
          + '<td class="mono r ' + pctCls(x.chgPct) + '">' + esc(x.dayTxt) + '</td>'
          + '<td class="mono r ' + pctCls(x.chgPct) + '">' + esc(x.chgTxt) + '</td>'
          + '<td style="color:var(--dim)">' + esc(x.unit || '—') + '</td></tr>';
      }).join('')
      + '</tbody></table></div>'
      + '<div class="lg"><span class="li" style="color:var(--dim)">'
      + '美债收益率的「涨跌」为收益率绝对变动（百分点），「涨跌幅」为收益率的相对变动幅度。'
      + '</span></div></section>';

    return html;
  }

  /* 今日要点：只列标题与时间，不加工内容 */
  function renderLatest(news) {
    if (!news || !news.present || !(news.latest || []).length) {
      return '<div class="empty">暂无数据</div>';
    }
    return '<ul class="newslatest">' + news.latest.map(function (x) {
      return '<li><span class="nt">' + esc(x.time || '—') + '</span>'
        + '<span class="nd">' + esc(x.chLabel || '') + '</span>'
        + '<span class="nh">' + esc(x.title || x.excerpt) + '</span></li>';
    }).join('') + '</ul>';
  }

  /* 当天财经快讯：按频道分组；正文用 details 折叠，零额外 JS 依赖且键盘可达 */
  function renderNews(news) {
    var head = '<div class="sec-h"><span class="bar" style="background:var(--accent)"></span><h2>全部要闻</h2>';
    if (!news || !news.present || !news.total) {
      return '<section class="sec">' + head + '</div>'
        + '<div class="panel"><div class="empty">暂无数据</div></div></section>';
    }
    var html = '<section class="sec">' + head
      + '<span class="note">' + esc(news.date) + ' · 共 ' + news.total + ' 条</span></div>';

    html += '<div class="segbar" id="newsSeg">'
      + '<button type="button" data-nseg="all" class="on">全部 <b>' + news.total + '</b></button>'
      + news.groups.map(function (g) {
        return '<button type="button" data-nseg="' + esc(g.key) + '">' + esc(g.label) + ' <b>' + g.count + '</b></button>';
      }).join('')
      + '</div>';

    html += news.groups.map(function (g) {
      return '<div class="newsgrp" data-dim="' + esc(g.key) + '">'
        + '<h3 class="ng-h">' + esc(g.label) + '<span>' + g.count + ' 条</span></h3>'
        + g.items.map(newsCard).join('')
        + '</div>';
    }).join('');

    html += '</section>';
    return html;
  }

  function newsCard(x) {
    return '<details class="news">'
      + '<summary><span class="nt">' + esc(x.time || '—') + '</span>'
      + '<span class="nh">' + esc(x.title || x.excerpt) + '</span></summary>'
      + '<div class="nb">' + esc(x.content) + '</div>'
      + '<div class="nf">' + (x.url
        ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>' : '')
      + '<span>正文 ' + x.chars + ' 字</span></div>'
      + '</details>';
  }

  var RENDER = { aihot: renderAihot, ai7d: renderAi7d, astock: renderAstock, hk: renderHk, hotlist: renderHotlist, astkday: renderAstkDay, radar: renderRadar };
  /* 一级 tab 顺序：AI 动态 / 财经市场 / 实时热搜（除实时热搜外都是分组 tab，自身不持数据） */
  var TOPKEYS = ['aidyn', 'market', 'hotlist'];
  /* 分组 tab → 子 tab，**第一个即默认子 pane**：
       aidyn  「AI 动态」＝ 按时间范围切分同一份 AI 载荷：当日（官方日报精选）与近 7 日（条目流）。
              ai7d 是 aihot 的投影版块（真源 aihot.items7d），两者同源不同视图。
       market 「财经市场」＝ 原独立一级 tab「今日财经要闻」并入这里，与 A股盘面的三个子版块并列。
              注意组内数据节奏不同（要闻＝实时行情 + 实时快讯，盘面＝报告交易日快照），
              靠顶部「数据日期」随子 tab 切换来如实区分。 */
  var GROUP = { aidyn: ['aihot', 'ai7d'], market: ['hk', 'astock', 'radar', 'astkday'] };
  /* 真正持有数据的版块：渲染顺序与快照校验都用它（页脚曾用它列举入库日期，该行已移除）。
     news 有独立载荷但没有自己的 pane —— 它是「今日要闻」版块消费的第三份数据。
     之所以仍按版块处理：这样它能独立进出质量闸门，快讯整段失败时不会连累行情被一起保留。 */
  var DATATABS = ['aihot', 'hk', 'hotlist', 'astock', 'radar', 'news'];
  /* 不单独入库的投影版块：值 = 真源版块。
     astkday ← hotlist 的 A股人气榜日榜（数据始终只有一份：hotlist.segments.astock.day）；
     ai7d    ← aihot 的 7 日条目流（同一份载荷的另一个字段，不复制、不进缓存）。 */
  var DERIVED = { astkday: 'hotlist', ai7d: 'aihot' };

  /* ------------------------------------------------------------ 渲染调度 */
  function paneEl(k) { return document.getElementById('pane-' + k); }

  /* 各投影版块怎么从真源取数 —— 新增投影版块时只动这张表，调度逻辑不必改 */
  var PROJECT = {
    /* 日榜是「当日累计人气」，日期口径跟真源（= 抓取当日），
       与热搜版块上屏的百度快照日期不同，故单独投影 dataDate。 */
    astkday: function (d) {
      var day = (d.segments && d.segments.astock && d.segments.astock.day) || [];
      if (!day.length) return null;
      return { present: true, entries: day, dataDate: d.dataDate || '' };
    },
    /* 近 7 日条目流自带完整结构（items / groups / from / to），整份投出即可 */
    ai7d: function (d) {
      var s7 = d.items7d;
      if (!s7 || !(s7.items || []).length) return null;
      return s7;
    }
  };

  /* 投影版块同步：真源数据一换，投影版块随之重建（见 DERIVED）。
     真源为空时删掉投影键，让该版块走「暂无可用数据」的空态。 */
  function syncDerived() {
    Object.keys(DERIVED).forEach(function (k) {
      var src = STATE.tabs[DERIVED[k]];
      var out = (src && src.data && PROJECT[k]) ? PROJECT[k](src.data) : null;
      if (!out) { delete STATE.tabs[k]; return; }
      STATE.tabs[k] = { data: out, src: src.src, at: src.at };
    });
  }

  /* 当前分组 tab 该显示哪个子 pane：取该组自己记着的那个（STATE.sub[组名]），
     不属于本组（或还没记录）则回退到该组第一个子 tab。 */
  function subOfGroup(g) {
    if (!g) return '';
    var s = STATE.sub[STATE.active];
    return s && g.indexOf(s) >= 0 ? s : g[0];
  }
  /* 当前一级 tab 实际对应的数据版块：分组 tab 取当前选中的子 tab，非分组 tab 即它自己 */
  function dataKey() {
    var g = GROUP[STATE.active];
    if (!g) return STATE.active;
    return subOfGroup(g);
  }

  /* 当前版块的「数据日期」—— 内容本身属于哪一天，与「抓取时刻」是两个概念。
     实时接口拿回来的是最新读数，但它对应的交易日可能仍是上一交易日（当日龙虎榜 /
     涨停池未出时即如此），所以必须逐版块判定，不能全页共用一个时间戳。
       aihot          ：日报日期（接口给的 report.date）
       ai7d           ：7 日流里最新一条的日期（投影版块）
       hk             ：当天快讯的日期（叙事主干是快讯；行情只是当前读数，不表达内容属于哪天）
       hotlist        ：百度热搜快照日期（本版块上屏内容只剩百度一段）
       astock / radar ：报告交易日（龙虎榜 / 涨停池按交易日取数）
       astkday        ：同花顺热股榜当日累计（投影版块，日期口径取自真源 hotlist）
      缺失时一律回退到载荷自带的 dataDate，再缺则由调用方显示「—」。 */
  function dataDateOf(k) {
    var t = STATE.tabs[k];
    var d = t && t.data;
    if (!d) return '';
    if (k === 'ai7d') return d.to || d.dataDate || '';
    if (k === 'hk') {
      var nw = STATE.tabs.news && STATE.tabs.news.data;
      return (nw && nw.present && nw.date) || d.dataDate || '';
    }
    if (k === 'hotlist') return d.baiduDate || d.dataDate || '';
    if (k === 'astock') return d.tradeDate || d.dataDate || '';
    return d.dataDate || '';
  }

  /* 把子 tab 的可见性与 aria 状态同步到当前分组的选中项。
     取数一律走 subOfGroup()，并把结果**写回本组自己的那一格** —— 两个分组 tab 各记各的，
     从别组分回来时仍停在上次那个子 tab。DOM 选择器按 data-group 限定，不会误伤另一组的按钮。 */
  function syncSub() {
    var g = GROUP[STATE.active];
    if (!g) return;
    var cur = subOfGroup(g);
    STATE.sub[STATE.active] = cur;
    g.forEach(function (x) {
      var el = paneEl(x);
      if (el) el.classList.toggle('hide', x !== cur);
      var b = document.querySelector('.subtabs[data-group="' + STATE.active + '"] button[data-sub="' + x + '"]');
      if (b) b.setAttribute('aria-selected', String(x === cur));
    });
  }

  function switchSub(s) {
    var g = GROUP[STATE.active];
    if (g && g.indexOf(s) >= 0) STATE.sub[STATE.active] = s;
    syncSub();
    var dk = dataKey();
    if (!STATE.tabs[dk] || !STATE.tabs[dk]._rendered) renderTab(dk);
    updateChrome();
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { window.scrollTo(0, 0); }
  }

  function renderTab(k) {
    var t = STATE.tabs[k];
    var el = paneEl(k);
    if (!el) return;
    if (!t || !t.data) { el.innerHTML = '<div class="panel"><div class="empty">该版块暂无可用数据</div></div>'; return; }
    try {
      el.innerHTML = RENDER[k](t.data, t);
      t._rendered = true;
    } catch (e) {
      el.innerHTML = '<div class="panel"><div class="empty">渲染失败：' + esc(e.message) + '</div></div>';
      return;
    }
    if (k === 'aihot') { setupAnchors(el); setCardCounts(t.data); }
    if (k === 'ai7d') setupAi7dSeg(el);
    if (k === 'hotlist') setupSegbar(el);
    if (k === 'hk') setupNewsSeg(el);
  }

  function setupAnchors(root) {
    var nav = root.querySelector('.anchors');
    if (!nav) return;
    nav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-target]') : null;
      if (!btn) return;
      var el = document.getElementById(btn.dataset.target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if (!('IntersectionObserver' in window)) return;
    var spy = new IntersectionObserver(function (entries) {
      var inside = [];
      entries.forEach(function (en) { if (en.isIntersecting) inside.push(en.target.id); });
      var btns = Array.prototype.slice.call(nav.querySelectorAll('button[data-target]'));
      var cur = btns.filter(function (b) { return b.classList.contains('on'); })[0];
      if (!inside.length) {
        if (cur) { btns.forEach(function (b) { b.classList.remove('on'); }); }
        return;
      }
      root.querySelectorAll('section.sec').forEach(function (s) {
        if (inside.indexOf(s.id) < 0) return;
        btns.forEach(function (b) { b.classList.toggle('on', b.dataset.target === s.id); });
      });
    }, { rootMargin: '-70px 0px -62% 0px', threshold: 0 });
    root.querySelectorAll('section.sec').forEach(function (s) { spy.observe(s); });
  }

  function setCardCounts(d) {
    var el = document.querySelector('[data-cnt="aihot"]');
    if (el) el.textContent = d.total;
  }

  function setupSegbar(root) {
    var bar = root.querySelector('#hotSeg');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-seg]') : null;
      if (!b) return;
      Array.prototype.forEach.call(bar.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
      /* 按分段条里实际存在的按钮切换，不再硬编码段名 —— 加段或减段都不必改这里 */
      Array.prototype.forEach.call(bar.querySelectorAll('button[data-seg]'), function (x) {
        var el = document.getElementById('seg-' + x.dataset.seg);
        if (el) el.classList.toggle('hide', x !== b);
      });
    });
  }

  /* 新闻维度筛选：与热搜分段同一交互范式（纯 class 切换） */
  function setupNewsSeg(root) {
    var bar = root.querySelector('#newsSeg');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-nseg]') : null;
      if (!b) return;
      Array.prototype.forEach.call(bar.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var want = b.dataset.nseg;
      Array.prototype.forEach.call(root.querySelectorAll('.newsgrp[data-dim]'), function (g) {
        g.classList.toggle('hide', want !== 'all' && g.dataset.dim !== want);
      });
    });
  }

  /* 近 7 日条目流的分类筛选：与新闻维度筛选同一范式，只是分组键换成分类 slug */
  function setupAi7dSeg(root) {
    var bar = root.querySelector('#ai7dSeg');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-aseg]') : null;
      if (!b) return;
      Array.prototype.forEach.call(bar.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var want = b.dataset.aseg;
      Array.prototype.forEach.call(root.querySelectorAll('.newsgrp[data-agrp]'), function (g) {
        g.classList.toggle('hide', want !== 'all' && g.dataset.agrp !== want);
      });
    });
  }

  function updateChrome() {
    var dk = dataKey();
    var t = STATE.tabs[dk] || {};
    /* 两个时间各司其职：「数据日期」随版块切换（内容属于哪一天），
       「更新于」是全页共用的抓取时刻 —— 降级时各版块会停在各自的上次抓取时间。 */
    var dd = dataDateOf(dk);
    document.getElementById('dataDate').textContent = dd || '—';
    var badge = document.getElementById('editionBadge');
    if (badge) badge.textContent = dd || '—';
    document.getElementById('updatedAt').textContent = t.at ? U.fmtBeijing(t.at) : '—';
    /* 投资风险提示只在涉及投资的一级 tab 出现。判据用**一级 tab 名**（AI 动态 是资讯汇总，
       组内的「当日」「近 7 日」只是它的子 tab），不再按数据版块名判 —— 否则再加子 tab 就得跟着改。 */
    var rw = document.getElementById('riskWarn');
    if (rw) rw.classList.toggle('hide', STATE.active === 'aidyn');
    var pill = document.getElementById('srcPill');
    pill.className = 'pill ' + (SRC_CLS[t.src] || 'snap');
    pill.innerHTML = '<i></i>' + (SRC_TEXT[t.src] || '内置快照');
    document.querySelectorAll('[data-cnt]').forEach(function (el) {
      var k = el.dataset.cnt, tt = STATE.tabs[k];
      if (!tt || !tt.data) { el.textContent = '—'; return; }
      try {
        if (k === 'aihot') el.textContent = tt.data.total;
        else if (k === 'ai7d') el.textContent = (tt.data.items || []).length || '—';
        else if (k === 'astock') el.textContent = tt.data.lhb ? tt.data.lhb.count : '—';
        else if (k === 'hk') {
          /* 角标数快讯条数（本版块的叙事主干），快讯缺失时才回退到行情品种数 */
          var nw = STATE.tabs.news && STATE.tabs.news.data;
          el.textContent = (nw && nw.present && nw.total) ? String(nw.total)
            : ((tt.data.quotes || []).filter(function (x) { return x.price !== null; }).length || '—');
        }
        else if (k === 'hotlist') el.textContent = (tt.data.segments && tt.data.segments.web) ? (tt.data.segments.web.items || []).length : '—';
        else if (k === 'astkday') el.textContent = (tt.data.entries || []).length || '—';
        else el.textContent = tt.data.overall == null ? '—' : tt.data.overall;
      } catch (e) { el.textContent = '—'; }
    });
  }

  function switchTab(k) {
    if (TOPKEYS.indexOf(k) < 0) k = TOPKEYS[0];
    STATE.active = k;
    document.querySelectorAll('#tabs button[data-pane]').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.pane === k));
    });
    /* 只切换一级容器：子 pane 由 syncSub 管理，二者不互相覆盖 */
    TOPKEYS.forEach(function (x) {
      var el = paneEl(x);
      if (el) el.classList.toggle('hide', x !== k);
    });
    syncSub();
    var dk = dataKey();
    if (!STATE.tabs[dk] || !STATE.tabs[dk]._rendered) renderTab(dk);
    updateChrome();
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { window.scrollTo(0, 0); }
  }

  /* ------------------------------------------------------------ 主流程 */
  function applySnapshot() {
    var snap = STATE.snapshot;
    if (!snap || !snap.tabs) return;
    Object.keys(snap.tabs).forEach(function (k) {
      if (STATE.tabs[k]) return;
      STATE.tabs[k] = { data: snap.tabs[k], src: 'snap', at: snap.builtAt };
    });
    syncDerived();
  }

  function applyTabs(tabs, src, at) {
    Object.keys(tabs).forEach(function (k) { STATE.tabs[k] = { data: tabs[k], src: src, at: at }; });
    syncDerived();
  }

  async function refresh(force) {
    if (STATE.busy) return;
    var btn = document.getElementById('refreshBtn');
    var today = U.localDateStr();
    var cache = readCache();

    if (!force && cache && cache.cacheDate === today) {
      applySnapshot();
      applyTabs(cache.tabs, 'cache', cache.at);
      Object.keys(STATE.tabs).forEach(function (k) { STATE.tabs[k]._rendered = false; });
      renderAll();
      updateChrome();
      return;
    }

    STATE.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    try {
      var r = await fetchAll();
      STATE.lastFail = (r.fails || []).slice();
      var payload = MBRadar.derive(r.raw, r.ctx);
      /* 浏览器拉不到的段（百度热搜）沿用快照数据 */
      if (STATE.snapshot && STATE.snapshot.tabs && STATE.snapshot.tabs.hotlist) {
        var snapHot = STATE.snapshot.tabs.hotlist;
        if (!payload.tabs.hotlist.segments.web.items.length && snapHot.segments.web.items.length) {
          payload.tabs.hotlist.segments.web = snapHot.segments.web;
        }
        payload.tabs.hotlist.baiduDate = snapHot.baiduDate || '';
      }
      /* 非空闸门：空结果一律不覆盖（「更少」的判定在下面用 qualityOf 统一做） */
      function hasData(k, d) {
        if (!d || !d.present) return false;
        if (k === 'aihot') return (d.total || 0) > 0;
        if (k === 'astock') return (d.lhb && d.lhb.count > 0) || (d.industries && d.industries.count > 0);
        if (k === 'hk') return (d.quotes || []).some(function (x) { return x.price !== null; });
        if (k === 'news') return (d.total || 0) > 0;
        if (k === 'hotlist') {
          /* 页面只用得上 web（全网热搜）与 astock.day（投影成 A股人气榜日榜）两段 */
          var s = d.segments || {};
          return !!((s.web && (s.web.items || []).length > 0)
            || (s.astock && (s.astock.day || []).length > 0));
        }
        return d.overall != null;
      }
      /* 只接受「确实有数据、且不比手上那份更差」的实时载荷。
         光判「非空」不够：某些源被瞬时拦截时实时层会返回半残结果（实测行业/概念会变 0、
         上涨占比变 —、13 个品种全空），照单全收等于把快照里的好数据抹掉，还挂着「实时拉取」。
         雷达依赖盘面与热搜，二者被拒时雷达必须跟着拒，否则会出现「展示旧盘面、算新雷达」。 */
      var okTabs = {}, rejected = [];
      ['aihot', 'hk', 'news', 'hotlist', 'astock', 'radar'].forEach(function (k) {
        var fresh = payload.tabs[k];
        if (!fresh) return;
        var cur = STATE.tabs[k] && STATE.tabs[k].data;
        var q = MB.qualityOf(k, fresh), q0 = MB.qualityOf(k, cur);
        var why = '';
        if (!hasData(k, fresh)) why = '实时数据为空';
        else if (cur && q < q0) why = '实时数据比现有更少（' + q + ' < ' + q0 + '）';
        else if (k === 'radar' && (rejected.indexOf('astock') >= 0 || rejected.indexOf('hotlist') >= 0)) {
          why = '盘面/热搜被保留，雷达随之保留';
        }
        if (why) { rejected.push(k); STATE.lastFail.push(k + ': ' + why + '，保留上一可用数据'); }
        else okTabs[k] = fresh;
      });
      applySnapshot();
      applyTabs(okTabs, 'live', r.ctx.snapshotAt);
      writeCache(today, payloadMap(), r.ctx.snapshotAt);
      Object.keys(STATE.tabs).forEach(function (k) { STATE.tabs[k]._rendered = false; });
      renderAll();
    } catch (e) {
      applySnapshot();
      STATE.lastFail = [e.message];
      /* 别静默吞掉：这里吞了，浏览器回归看起来仍是「页面异常 = 无」，
         实时层整体失效却毫无痕迹（踩过：qualityOf 挂在 MB 根对象上，调用处却写成
         utils 命名空间下，抛错被吞、构建仍全绿，整套实时拉取静默失效） */
      try { console.error('[每日资讯看板] 实时拉取失败：' + e.message); } catch (e2) { /* 忽略 */ }
    } finally {
      STATE.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '刷新数据'; }
      updateChrome();
    }
  }

  /* ------------------------------------------------------------ 启动 */
  function renderAll() {
    DATATABS.concat(Object.keys(DERIVED)).forEach(function (k) {
      if (STATE.tabs[k] && STATE.tabs[k].data) renderTab(k);
    });
  }

  function boot() {
    var node = document.getElementById('snapshot');
    try { STATE.snapshot = JSON.parse(node.textContent); } catch (e) { STATE.snapshot = null; }

    document.getElementById('tabs').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-pane]') : null;
      if (b) switchTab(b.dataset.pane);
    });
    /* 每个分组 tab 都有自己的子 tab 条 —— 逐个绑定（同一个委托处理器） */
    Array.prototype.forEach.call(document.querySelectorAll('.subtabs'), function (bar) {
      bar.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-sub]') : null;
        if (b) switchSub(b.dataset.sub);
      });
    });
    document.getElementById('refreshBtn').addEventListener('click', function () { refresh(true); });

    applySnapshot();
    /* 先用快照把四个版块一次性渲染出来，避免白屏与切换空窗 */
    renderAll();
    updateChrome();

    /* 再看缓存 / 实时拉取：缓存命中与实时拉取共用同一条路径，避免两处逻辑漂移 */
    refresh(false).then(function () {
      renderAll();
      updateChrome();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
