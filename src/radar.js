/* ============================================================================
 * 每日资讯看板 · 数据层：群体情绪雷达（规则化打分）+ 载荷组装
 * 所有分数均由当日公开数据按固定公式换算，公式随页面一起展示，可逐项核对。
 * ==========================================================================*/
(function (root, factory) {
  var lib = (typeof module === 'object' && module.exports) ? require('./lib.js') : root.MB;
  var api = factory(lib);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MBRadar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MB) {
  'use strict';
  var U = MB.utils;
  var clamp = U.clamp, r0 = U.r0, num = U.num;

  function tone(v) { return v >= 70 ? 'high' : v >= 55 ? 'mid' : 'low'; }
  function toneLabel(t) { return t === 'high' ? '偏高' : t === 'mid' ? '中等' : '较低'; }
  function avg(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function stdev(a) {
    if (a.length < 2) return 0;
    var m = avg(a);
    return Math.sqrt(avg(a.map(function (x) { return (x - m) * (x - m); })));
  }

  /* ------------------------------------------------------------ 指标计算 */
  function computeRadar(astock, hotlist, baseline) {
    var b = astock.breadth || {};
    var lu = astock.limitUp || {};
    var ind = astock.industries || { top: [], bottom: [], all: [] };
    var margin = astock.margin || {};
    var baselineCounts = (baseline || []).map(function (x) { return x.count; }).filter(function (v) { return v !== null; });

    /* 1. 广度：全市场上涨占比 */
    var breadthScore = b.upRatio === null || b.upRatio === undefined ? null : r0(b.upRatio);

    /* 2. 拥挤：涨停家数在近 N 日基线中的分位(60%) + 连板股占比(40%) */
    var luPct = U.percentileOf(baselineCounts.slice().sort(function (x, y) { return x - y; }), b.limitUp);
    var poolCount = lu.poolCount || 0;
    var lianbanShare = poolCount ? r0(100 * (lu.lianbanCount || 0) / poolCount) : 0;
    var lianbanShareScore = clamp(r0(lianbanShare * 4), 0, 100);   /* 25% 连板占比视为满分 */
    var crowdingScore = (luPct === null)
      ? clamp(r0(0.6 * clamp(r0((b.limitUp || 0) * 100 / 100), 0, 100) + 0.4 * lianbanShareScore), 0, 100)
      : clamp(r0(0.6 * luPct + 0.4 * lianbanShareScore), 0, 100);

    /* 3. 杠杆：融资余额在近 130 交易日中的分位(70%) + 5 日净买入方向(30%) */
    var rzHist = (margin.hist || []).slice().sort(function (x, y) { return x - y; });
    var rzPct = U.percentileOf(rzHist, margin.rzye);
    var rz5 = margin.rzjme5d;
    var dirScore = rz5 === null || rz5 === undefined ? 50 : clamp(r0(50 + 50 * Math.tanh(rz5 / 3e10)), 0, 100);
    var leverageScore = (rzPct === null) ? dirScore : clamp(r0(0.7 * rzPct + 0.3 * dirScore), 0, 100);

    /* 4. 热度：封板率(60%) + 人气榜热度集中度(40%) */
    var sealRate = b.limitUpRate;
    var sealScore = sealRate === null || sealRate === undefined ? null : clamp(r0(sealRate), 0, 100);
    var top10 = (hotlist && hotlist.segments && hotlist.segments.astock && hotlist.segments.astock.hour || []).slice(0, 30);
    var sumAll = top10.reduce(function (s, x) { return s + (x.heat || 0); }, 0);
    var sumTop10 = top10.slice(0, 10).reduce(function (s, x) { return s + (x.heat || 0); }, 0);
    var concScore = sumAll ? clamp(r0(100 * sumTop10 / sumAll * 1.6), 0, 100) : null;
    var heatScore = (sealScore === null)
      ? (concScore === null ? 50 : concScore)
      : (concScore === null ? sealScore : clamp(r0(0.6 * sealScore + 0.4 * concScore), 0, 100));

    /* 5. 分化：行业涨跌离散度(60%) + 指数涨跌离散度(40%) */
    var topAvg = avg(ind.top.slice(0, 10).map(function (x) { return x.chg || 0; }));
    var botAvg = avg(ind.bottom.slice(0, 10).map(function (x) { return x.chg || 0; }));
    var spread = topAvg - botAvg;
    var spreadScore = clamp(r0(spread / 10 * 100), 0, 100);
    var idxDisp = stdev((astock.indices || []).map(function (x) { return x.chg || 0; }));
    var idxDispScore = clamp(r0(idxDisp * 40), 0, 100);
    var divScore = clamp(r0(0.6 * spreadScore + 0.4 * idxDispScore), 0, 100);

    /* 总体加权 */
    function wsum(pairs) {
      var sw = 0, sv = 0;
      pairs.forEach(function (p) {
        if (p[1] === null || p[1] === undefined) return;
        sw += p[0]; sv += p[0] * p[1];
      });
      return sw ? r0(sv / sw) : null;
    }
    var overall = wsum([[0.15, breadthScore], [0.25, crowdingScore], [0.20, leverageScore], [0.20, heatScore], [0.20, divScore]]);

    /* 文案生成（模板化，全部由实盘数字驱动） */
    var leadInd = ind.top[0] || null, lagInd = ind.bottom[0] || null;
    var topTheme = (astock.themes || [])[0] || null;
    var ovTone = tone(overall);

    function pct(x) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(2) + '%'; }
    function yi(x) { return U.fmtYi(x); }

    var metrics = [
      { key: 'breadth', label: '广度', value: breadthScore, tone: tone(breadthScore), note: '全市场上涨家数占比，直读' },
      { key: 'crowding', label: '拥挤', value: crowdingScore, tone: tone(crowdingScore), note: '涨停家数基线分位 60% + 连板占比 40%' },
      { key: 'leverage', label: '杠杆', value: leverageScore, tone: tone(leverageScore), note: '融资余额 130 日分位 70% + 5 日净买入方向 30%' },
      { key: 'heat', label: '热度', value: heatScore, tone: tone(heatScore), note: '封板率 60% + 人气榜热度集中度 40%' },
      { key: 'divergence', label: '分化', value: divScore, tone: tone(divScore), note: '行业涨跌离散度 60% + 指数离散度 40%' }
    ];
    metrics.forEach(function (m) { m.level = toneLabel(m.tone); });

    /* 文案由实际读数驱动：先排序再取最高/最低项，避免出现与分项矛盾的表述 */
    var ranked = metrics.filter(function (m) { return m.value !== null && m.value !== undefined; })
      .slice().sort(function (a, b) { return b.value - a.value; });
    var top2 = ranked.slice(0, 2).map(function (m) { return m.label + '分 ' + m.value; });
    var lowItem = ranked.length ? ranked[ranked.length - 1] : null;
    var headline, body;
    if (ovTone === 'high') {
      headline = '情绪温度偏高';
      body = '最高的两项是 ' + top2.join('、') + '；'
        + (b.limitUp !== null ? '当日 ' + b.limitUp + ' 只涨停、封板率 ' + sealRate + '%，' : '')
        + (topTheme ? '涨停最集中的方向是「' + topTheme.name + '」（' + topTheme.limitUpNum + ' 只）。' : '')
        + '高分项之间相互印证，说明短线资金仍在高弹性品种上聚焦，属于典型的情绪高位区。';
    } else if (ovTone === 'mid') {
      headline = '情绪温度中等';
      body = '最高的两项是 ' + top2.join('、')
        + (lowItem ? '，最低的是 ' + lowItem.label + '分 ' + lowItem.value : '') + '；'
        + (leadInd && lagInd ? '行业层面「' + leadInd.name + '」' + pct(leadInd.chg) + ' 领涨、「' + lagInd.name + '」' + pct(lagInd.chg) + ' 垫底，' : '')
        + '结构而非总量在决定盘面。整体没有极端读数，属于常态区间。';
    } else {
      headline = '情绪温度偏低';
      body = '各项读数普遍不高（最低的是 ' + (lowItem ? lowItem.label + '分 ' + lowItem.value : '—') + '）；'
        + (b.limitUp !== null ? '当日涨停 ' + b.limitUp + ' 只、封板率 ' + sealRate + '%，' : '')
        + '短线资金的参与强度有限，情绪处在偏冷一侧。';
    }

    /* 证据组 */
    function topNames(arr, n, f) {
      return arr.slice(0, n).map(function (x) { return x.name + ' ' + (f ? f(x) : pct(x.chg)); }).join('　');
    }
    var evidence = [
      { key: 'breadth', title: '广度', lines: [
        '上涨 / 下跌 / 平盘：' + (b.up || 0) + ' / ' + (b.down || 0) + ' / ' + (b.flat || 0) + ' 只，上涨占比 ' + (b.upRatio === null ? '—' : b.upRatio + '%'),
        '涨停 ' + (b.limitUp === null ? '—' : b.limitUp) + ' 只（封板率 ' + (sealRate === null ? '—' : sealRate + '%') + '，炸板 ' + (b.openNum === null ? '—' : b.openNum) + ' 只），跌停 ' + (b.limitDown === null ? '—' : b.limitDown) + ' 只',
        '前一日涨停 ' + (b.prevLimitUp === null ? '—' : b.prevLimitUp) + ' 只；两市成交额 ' + (b.amountYi ? b.amountYi.toFixed(0) + ' 亿' : '—'),
        '主要指数：' + (astock.indices || []).map(function (x) { return x.name + ' ' + pct(x.chg); }).join('　')
      ] },
      { key: 'style', title: '风格', lines: [
        '领涨行业：' + (topNames(ind.top, 5) || '—'),
        '领跌行业：' + (topNames(ind.bottom, 5) || '—'),
        '行业涨跌离散度：' + spread.toFixed(2) + ' 个百分点（前 10 均值 ' + pct(topAvg) + ' vs 后 10 均值 ' + pct(botAvg) + '）',
        '概念涨幅前列：' + (topNames((astock.concepts || {}).top || [], 5) || '—')
      ] },
      { key: 'leverage', title: '杠杆', lines: [
        '融资余额 ' + (margin.rzyeYi ? margin.rzyeYi.toFixed(0) + ' 亿元' : '—') + '（' + (margin.date || '—') + '）',
        '融资净买入：当日 ' + yi(margin.rzjme) + '，5 日 ' + yi(margin.rzjme5d) + '，10 日 ' + yi(margin.rzjme10d),
        '融资余额占流通市值比 ' + (margin.rzmezB === null || margin.rzmezB === undefined ? '—' : Number(margin.rzmezB).toFixed(2) + '%') + '；130 日分位 ' + (rzPct === null ? '—' : rzPct + '%'),
        '两融余额合计 ' + (margin.rzrqye ? (margin.rzrqye / 1e8).toFixed(0) + ' 亿元' : '—')
      ] },
      { key: 'heat', title: '热度', lines: [
        '涨停家数 ' + (b.limitUp === null ? '—' : b.limitUp) + ' 只（近 ' + baselineCounts.length + ' 个交易日分位 ' + (luPct === null ? '—' : luPct + '%') + '）',
        '连板 ' + (lu.lianbanCount || 0) + ' 只，最高 ' + (lu.maxBoard || 0) + ' 连板，占涨停总数 ' + lianbanShare + '%',
        '涨停集中板块：' + ((astock.themes || []).slice(0, 4).map(function (t) { return t.name + '(' + t.limitUpNum + ')'; }).join('　') || '—'),
        '人气榜前五：' + (top10.slice(0, 5).map(function (x) { return x.name; }).join('　') || '—')
      ] }
    ];

    /* 观察点 */
    var watch = [];
    if (crowdingScore >= 65) watch.push('拥挤分 ' + crowdingScore + ' 偏高：连板股占比 ' + lianbanShare + '%，若封板率回落而炸板数上升，短线情绪可能先转弱。');
    else watch.push('拥挤分 ' + crowdingScore + ' 不高：短线资金参与有限，需观察涨停家数能否扩散。');
    if (rz5 !== null && rz5 !== undefined && rz5 < 0) watch.push('融资 5 日净买入 ' + yi(rz5) + '（净流出），资金在降杠杆；若连续为负配合广度走弱，风险偏好下移。');
    else watch.push('融资 5 日净买入 ' + yi(rz5) + '，杠杆资金仍在净增，注意与指数背离时的反噬。');
    watch.push('分化分 ' + divScore + '：' + (leadInd ? '「' + leadInd.name + '」' : '领涨方向') + ' 与 ' + (lagInd ? '「' + lagInd.name + '」' : '垫底方向') + ' 的强弱切换，是本轮风格能否延续的关键。');
    if (topTheme) watch.push('涨停最集中的「' + topTheme.name + '」当日涨停 ' + topTheme.limitUpNum + ' 只、板块 ' + pct(topTheme.chg) + '，是当前情绪主线的体温计。');

    return {
      present: !!astock.present,
      dataDate: astock.tradeDate,
      metrics: metrics,
      overall: overall,
      tone: ovTone,
      level: toneLabel(ovTone),
      headline: headline,
      body: body,
      evidence: evidence,
      watch: watch,
      rules: [
        '广度 = 全市场上涨家数 ÷（上涨 + 下跌）× 100',
        '拥挤 = 涨停家数在近 ' + baselineCounts.length + ' 个交易日的分位 × 0.6 + 连板股占涨停总数比例(以 25% 为满分) × 0.4',
        '杠杆 = 融资余额在近 130 个交易日的分位 × 0.7 + 5 日融资净买入方向(压缩映射到 0~100) × 0.3',
        '热度 = 封板率 × 0.6 + 人气榜前 10 热度占前 30 比重 × 0.4',
        '分化 = 行业前 10 涨幅均值与后 10 涨幅均值之差(以 10 个百分点为满分) × 0.6 + 主要指数涨跌幅标准差(以 2.5 为满分) × 0.4',
        '总体 = 广度 15% + 拥挤 25% + 杠杆 20% + 热度 20% + 分化 20%（缺失项自动剔除并归一权重）'
      ]
    };
  }

  /* ------------------------------------------------------------ 载荷组装 */
  function derive(raw, ctx) {
    ctx = ctx || {};
    var aihot = MB.normalizeAihot(raw.aihot || {});
    /* 近 7 日条目流与当日日报同属 AI 版块，但口径不同（7 天窗口 / 发布时间倒序），
       故并列挂在同一载荷下，互不覆盖。 */
    aihot.items7d = MB.normalizeAihotItems(raw.aihotItems || {});
    var astock = MB.normalizeAstock(raw);
    var hotlist = MB.normalizeHotlist(raw);
    var hk = MB.normalizeHk(raw);
    var baseline = MB.collectBaseline(raw);

    astock.dataDate = astock.tradeDate;
    astock.baseline = baseline;
    astock.isToday = astock.tradeDate === ctx.today;
    var newsIdx = (astock.indices || [])[0];
    astock.snapshotAt = ctx.snapshotAt || '';

    var hotDate = ctx.today;
    hotlist.dataDate = hotDate;
    /* 人气榜逐日归档：构建侧 ctx.prevArchive 由抓取器装入（data/heat-archive.json + 本地历史快照），
       页面实时侧由 app.js 装入（localStorage + 内置快照）—— 两边共用 lib 的同一套合并口径，
       今天这行日榜总是追加在归档最前（同日去重、空日不收）。 */
    hotlist.heatArchive = MB.mergeHeatArchive(ctx.prevArchive || [], [{ date: hotDate, items: hotlist.segments.astock.day }]);

    hk.dataDate = ctx.today;
    hk.snapshotAt = ctx.snapshotAt || '';

    /* 当天财经快讯：与行情分属两个数据版块 —— 行情是实时读数，快讯是叙事主干，
       两者会各自独立失败。合成一个版块的话，任一方缺失都会连带另一方被整块保留或丢弃。 */
    var news = MB.normalizeLiveNews(raw);
    news.dataDate = news.date;

    var radar = computeRadar(astock, hotlist, baseline);

    return {
      schemaVersion: 1,
      builtAt: ctx.builtAt || U.nowIso(),
      builtAtBj: U.fmtBeijing(ctx.builtAt || U.nowIso()),
      ctx: { today: ctx.today, tradeDate: astock.tradeDate, baselineDates: ctx.baselineDates || [] },
      tabs: {
        aihot: aihot,
        astock: astock,
        hotlist: hotlist,
        hk: hk,
        news: news,
        radar: radar
      }
    };
  }

  return { computeRadar: computeRadar, derive: derive, tone: tone, toneLabel: toneLabel };
});
