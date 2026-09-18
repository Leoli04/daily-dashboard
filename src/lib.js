/* ============================================================================
 * 每日资讯看板 · 数据层：数据源定义 + 归一化 + 指标计算
 * 浏览器与 Node 共用同一份代码（UMD）。这是唯一的形状契约来源。
 * ==========================================================================*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ 工具 */
  var UA_REF = 'chrome';

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function nowIso() { return new Date().toISOString(); }
  function localDateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function localTimeStr(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function isoDay(s) { return String(s == null ? '' : s).slice(0, 10); }
  function d8(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, '').slice(0, 8); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function r0(n) { return Math.round(n); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function num(v) {
    if (v === null || v === undefined || v === '' || v === '-') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  function shiftDay(dateStr, delta) {
    var p = String(dateStr).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  /* 从 fromDate 往前取 n 个工作日（跳过周末） */
  function backDates(fromDate, n) {
    var out = [], d = fromDate, guard = 0;
    while (out.length < n && guard++ < n * 4) {
      d = shiftDay(d, -1);
      var wd = new Date(d + 'T00:00:00Z').getUTCDay();
      if (wd === 0 || wd === 6) continue;
      out.push(d);
    }
    return out;
  }
  function cjkCount(s) { return (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 摘要裁剪：优先在句末/分号/逗号处收口，绝不在逗号上断句 */
  function trimSummary(text, maxCjk) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (cjkCount(s) <= maxCjk) return s;
    var cut = 0;
    for (var i = 0; i < s.length; i++) {
      if (cjkCount(s.slice(0, i + 1)) > maxCjk) break;
      cut = i + 1;
    }
    var head = s.slice(0, cut);
    var floor = Math.max(8, Math.floor(maxCjk * 0.55));
    var m = head.match(/^[\s\S]*[。！？]/);
    if (m && cjkCount(m[0]) >= floor) return m[0];
    m = head.match(/^[\s\S]*[；;]/);
    if (m && cjkCount(m[0]) >= floor) return m[0];
    m = head.match(/^[\s\S]*[，、：,]/);
    if (m && cjkCount(m[0]) >= floor) return m[0].replace(/[，、：,\s]+$/, '');
    return head.replace(/[，、；：,;.\s]+$/, '') + '…';
  }

  /* ISO → 北京时间人话 */
  function fmtBeijing(iso) {
    if (!iso) return '';
    var t = new Date(iso);
    if (isNaN(t.getTime())) return String(iso);
    var b = new Date(t.getTime() + 8 * 3600 * 1000);
    return b.getUTCFullYear() + '-' + pad2(b.getUTCMonth() + 1) + '-' + pad2(b.getUTCDate()) + ' ' + pad2(b.getUTCHours()) + ':' + pad2(b.getUTCMinutes());
  }

  /* 北京时间「月-日 时:分」：条目流的发布时间用这个粒度就够（同年不必带年份） */
  function fmtClock(iso) {
    var full = fmtBeijing(iso);
    return full ? full.slice(5) : '';
  }
  /* unix 秒 → 北京时间「日期」与「时:分」。
     财经快讯的时间字段是秒级时间戳（display_time），不是 ISO 串，故单独给一对助手。
     一律走 UTC+8 换算，与页面其他时间的口径一致，不受本机时区影响。 */
  function bjDay(ts) {
    var n = num(ts);
    if (!n) return '';
    return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 10);
  }
  function bjClock(ts) {
    var n = num(ts);
    if (!n) return '—';
    return new Date((n + 8 * 3600) * 1000).toISOString().slice(11, 16);
  }

  /* 金额（元）→ 人话，带正负号 */
  function fmtYi(amount, opts) {
    opts = opts || {};
    var n = num(amount);
    if (n === null) return '—';
    var sign = n > 0 && opts.sign !== false ? '+' : '';
    var a = Math.abs(n);
    if (a >= 1e8) return sign + (n / 1e8).toFixed(opts.dp == null ? 2 : opts.dp) + '亿';
    if (a >= 1e4) return sign + (n / 1e4).toFixed(1) + '万';
    return sign + n.toFixed(0);
  }
  function fmtPct(v, dp) {
    var n = num(v);
    if (n === null) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(dp == null ? 2 : dp) + '%';
  }
  function fmtHeat(v) {
    var n = num(v);
    if (n === null) return '—';
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(r0(n));
  }
  /* 数值 → 0~100 分位（给定升序基线数组） */
  function percentileOf(sorted, v) {
    if (!sorted || !sorted.length || v === null || v === undefined) return null;
    var below = 0;
    for (var i = 0; i < sorted.length; i++) if (sorted[i] <= v) below++;
    return r0(100 * below / sorted.length);
  }

  /* ------------------------------------------------------------ 数据源定义 */
  /* kind: browser = 浏览器可直连（CORS 已验证）；node = 仅 Node 可直连 */
  var EAST = 'https://push2.eastmoney.com';
  var EAST_HIS = 'https://push2his.eastmoney.com';
  var DC = 'https://datacenter-web.eastmoney.com';
  /* 财经快讯：华尔街见闻。它按请求的 Origin 回显 ACAO —— file:// 页面的 origin 是
     「null」，服务端就回 ACAO: null，浏览器判定为匹配而放行（已用真实 Chrome 复验：
     HTTP 200 + ACAO=null + 无 loadingFailed 事件）。故本源**不需要** JSONP 或代理，
     既是实时层也是快照层。 */
  var WSC = 'https://api-one.wallstcn.com/apiv1/content/lives';

  /* ------------------------------------------------ 同族备用域名（传输层兜底）
     主域名会「整段瞬时拦截」（见 fetch-sources.js 顶部的对照实验结论），此时同族域名常常仍可达：
     实测 push2 主域名 4 连全败的同一时刻，push2delay 返回 200 + ACAO:*，且 ulist.np 的
     字段面完全一致（f104/f105/f106 齐全）。因此只换主机名、不动路径与字段 —— 改一个字符串就能切。
     ⚠ 只在「传输层失败」时切换；HTTP 状态码错误与「响应不是 JSON」属于语义错误，换域名无意义。 */
  var HOST_ALTS = {
    'push2.eastmoney.com': ['push2delay.eastmoney.com'],
    'push2his.eastmoney.com': ['push2delay.eastmoney.com']
  };
  /* 返回「主地址 + 同族备用地址」的候选列表，顺序即尝试顺序；无备用时长度为 1 */
  function altUrls(url) {
    var out = [url];
    var m = /^(https?:\/\/)([^\/]+)([\s\S]*)$/.exec(String(url));
    if (!m) return out;
    (HOST_ALTS[m[2]] || []).forEach(function (h) { out.push(m[1] + h + m[3]); });
    return out;
  }

  /* ------------------------------------------------ 今日财经要闻：盯盘品种清单
     顺序即展示顺序，group 决定顶部大数条的分行（a = A股宽基 / hk = 港股 / macro = 宏观）。
     drag=true 表示「数值走高 → 压制权益估值」（美元 / 利率 / 油价）。
     全部 secid 已实测：东财 push2 ulist.np 单次请求可全部返回，响应头 ACAO:*，file:// 可直连。
     ⚠ 探测 secid 时必须打印完整的 f13 + '.' + f12（市场前缀 + 代码）。
     只打印 f12 会导致前缀错误看不出来：恒生科技指数是 124.HSTECH 而非 100.HSTECH，
     用错前缀时接口静默丢弃该条目（不报错、不返回空对象），症状是「13 个品种只回来 12 个」。 */
  var HK_SECIDS = [
    /* A股宽基：与「A股盘面」的指数行情同源同 secid（1.000300 = 沪深300） */
    { secid: '1.000001', key: 'sh', name: '上证指数', unit: '点', dp: 2, role: 'index', group: 'a', noise: 0.3 },
    { secid: '0.399001', key: 'sz', name: '深证成指', unit: '点', dp: 2, role: 'index', group: 'a', noise: 0.3 },
    { secid: '0.399006', key: 'cyb', name: '创业板指', unit: '点', dp: 2, role: 'index', group: 'a', noise: 0.3 },
    { secid: '1.000300', key: 'hs300', name: '沪深300', unit: '点', dp: 2, role: 'index', group: 'a', noise: 0.3 },
    { secid: '1.000688', key: 'kc50', name: '科创50', unit: '点', dp: 2, role: 'index', group: 'a', noise: 0.3 },
    { secid: '100.HSI', key: 'hsi', name: '恒生指数', unit: '点', dp: 2, role: 'index', group: 'hk', noise: 0.3 },
    { secid: '124.HSTECH', key: 'hstech', name: '恒生科技指数', unit: '点', dp: 2, role: 'index', group: 'hk', noise: 0.3 },
    { secid: '100.HSCEI', key: 'hscei', name: '国企指数', unit: '点', dp: 2, role: 'index', group: 'hk', noise: 0.3 },
    { secid: '101.GC00Y', key: 'gold', name: 'COMEX 黄金', unit: '美元/盎司', dp: 2, role: 'macro', group: 'macro', noise: 0.5 },
    { secid: '112.B00Y', key: 'brent', name: '布伦特原油', unit: '美元/桶', dp: 2, role: 'macro', group: 'macro', drag: true, noise: 0.5 },
    { secid: '102.CL00Y', key: 'wti', name: 'NYMEX 原油', unit: '美元/桶', dp: 2, role: 'macro', group: 'macro', drag: true, noise: 0.5 },
    { secid: '100.UDI', key: 'dxy', name: '美元指数', unit: '', dp: 2, role: 'macro', group: 'macro', drag: true, noise: 0.25 },
    /* 收益率用「绝对变动（百分点）」判方向，noise 即 0.03pp —— 相对涨跌幅在小基数上会放大噪声 */
    { secid: '171.US10Y', key: 'us10y', name: '美国 10 年期国债收益率', unit: '%', dp: 3, role: 'macro', group: 'macro', drag: true, isYield: true, noise: 0.03 }
  ];

  function urlLhbRange(ctx) {
    var to = ctx.today;
    var from = shiftDay(ctx.today, -14);
    var filter = encodeURIComponent("(TRADE_DATE>='" + from + "')(TRADE_DATE<='" + to + "')");
    return DC + '/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL'
      + '&pageNumber=1&pageSize=500&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1'
      + '&source=WEB&client=WEB&filter=' + filter;
  }

  var SOURCES = [
    { id: 'aihot', kind: 'browser', tab: 'aihot',
      url: function () { return 'https://aihot.virxact.com/api/v1/dailies/latest'; } },

    /* 近 7 日条目流：与「日报」是同一提供方的两个端点。日报是当日编辑精选汇总
       （今天只有个位数条），条目流是 7 天窗口的精选条目（实测 71 条），且字段更全
       （category / publishedAt / score）。浏览器可直连（ACAO:*），故进实时层。
       参数面：window 只接受 '24h' | '7d'；limit 上限 100；category / by / mode / q / cursor 可选。 */
    { id: 'aihotItems', kind: 'browser', tab: 'aihot',
      url: function () { return 'https://aihot.virxact.com/api/v1/items?window=7d&limit=100'; } },

    { id: 'lhbRange', kind: 'browser', tab: 'astock', url: urlLhbRange },

    { id: 'ztpool', kind: 'browser', tab: 'astock',
      url: function (ctx) {
        return 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989'
          + '&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=' + ctx.tradeDate8;
      } },

    /* 涨停家数基线：回溯若干个交易日的涨停池 */
    { id: 'ztpoolHist', kind: 'browser', tab: 'astock', multi: true,
      url: function (ctx) {
        return 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989'
          + '&dpt=wz.ztzt&Pageindex=0&pagesize=100&sort=fbt%3Aasc&date=' + ctx.baselineDate8;
      } },

    /* 注意：东财 fs 参数里的 ‘+’ 必须字面传递，编码成 %20 / %2B 会退化为个股列表；
       且服务端把 pz 限制在 100，故涨/跌两端各取一次。 */
    { id: 'indUp', kind: 'browser', tab: 'astock',
      url: function () {
        return EAST + '/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3'
          + '&fs=m:90+t:2&fields=f12,f14,f3,f62,f6';
      } },

    { id: 'indDown', kind: 'browser', tab: 'astock',
      url: function () {
        return EAST + '/api/qt/clist/get?pn=1&pz=100&po=0&np=1&fltt=2&invt=2&fid=f3'
          + '&fs=m:90+t:2&fields=f12,f14,f3,f62,f6';
      } },

    { id: 'conUp', kind: 'browser', tab: 'astock',
      url: function () {
        return EAST + '/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3'
          + '&fs=m:90+t:3&fields=f12,f14,f3,f62';
      } },

    { id: 'thsBlock', kind: 'browser', tab: 'astock',
      url: function (ctx) {
        return 'https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR&date=' + ctx.tradeDate8;
      } },

    { id: 'thsLimit', kind: 'browser', tab: 'astock',
      url: function (ctx) {
        return 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?page=1&limit=200'
          + '&field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003'
          + '&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + ctx.tradeDate8;
      } },

    { id: 'indices', kind: 'browser', tab: 'astock',
      url: function () {
        return EAST + '/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006,1.000688'
          + '&fields=f1,f2,f3,f4,f6,f104,f105,f106';
      } },

    /* 注：push2his.eastmoney.com 在部分网络下被 socket 层阻断，故不依赖 K 线历史 */

    { id: 'margin', kind: 'browser', tab: 'astock',
      url: function () {
        return DC + '/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageNumber=1&pageSize=130'
          + '&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB';
      } },

    { id: 'hotHour', kind: 'browser', tab: 'hotlist',
      url: function () { return 'https://eq.10jqka.com.cn/open/api/hot_list/v1/hot_stock/a/hour/data.txt'; } },

    { id: 'hotDay', kind: 'browser', tab: 'hotlist',
      url: function () { return 'https://eq.10jqka.com.cn/open/api/hot_list/v1/hot_stock/a/day/data.txt'; } },

    /* 港股开盘：恒指 / 恒科 / 国企 / 黄金 / 双油 / 美元 / 美债 一次取全 */
    { id: 'hkQuotes', kind: 'browser', tab: 'hk',
      url: function () {
        return EAST + '/api/qt/ulist.np/get?fltt=2&secids='
          + HK_SECIDS.map(function (x) { return x.secid; }).join(',')
          + '&fields=f1,f2,f3,f4,f12,f13,f14,f124';
      } },

    /* 当天财经快讯：四个频道各取一页，频道即上屏分组（见 NEWS_CH）。
       原「今日财经要闻」的叙事层靠构建时抓取（语义搜索接口，需 12 小时短时凭证，
       凭证一过期整块新闻就停在上一天），改为浏览器可直连的快讯源后，打开即刷当天内容
       —— 实时层与快照层用的是同一份数据定义，两处不会漂移。 */
    { id: 'newsA', kind: 'browser', tab: 'news',
      url: function () { return WSC + '?client=pc&limit=30&channel=a-stock-channel'; } },
    { id: 'newsHk', kind: 'browser', tab: 'news',
      url: function () { return WSC + '?client=pc&limit=30&channel=hk-stock-channel'; } },
    { id: 'newsUs', kind: 'browser', tab: 'news',
      url: function () { return WSC + '?client=pc&limit=30&channel=us-stock-channel'; } },
    { id: 'newsGlobal', kind: 'browser', tab: 'news',
      url: function () { return WSC + '?client=pc&limit=30&channel=global-channel'; } }
  ];

  function byId(id) { for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i]; return null; }
  function planFor(tab, channel) {
    var out = [];
    for (var i = 0; i < SOURCES.length; i++) {
      if (SOURCES[i].tab !== tab) continue;
      if (channel === 'browser' && SOURCES[i].kind !== 'browser') continue;
      out.push(SOURCES[i]);
    }
    return out;
  }
  /* 生成一次抓取所需的全部请求任务（含 multi 展开、两阶段） */
  function buildTasks(ctx, channel) {
    var tasks = [];
    planFor('aihot', channel).forEach(function (s) { tasks.push({ id: s.id, url: s.url(ctx), headers: s.headers, phase: 1 }); });
    planFor('hotlist', channel).forEach(function (s) { tasks.push({ id: s.id, url: s.url(ctx), headers: s.headers, phase: 1 }); });
    planFor('hk', channel).forEach(function (s) { tasks.push({ id: s.id, url: s.url(ctx), headers: s.headers, phase: 1 }); });
    planFor('news', channel).forEach(function (s) { tasks.push({ id: s.id, url: s.url(ctx), headers: s.headers, phase: 1 }); });
    /* A股：先取龙虎榜区间解析交易日，再取其余 */
    var ast = planFor('astock', channel);
    ast.forEach(function (s) {
      if (s.id === 'lhbRange') { tasks.push({ id: s.id, url: s.url(ctx), headers: s.headers, phase: 1 }); return; }
      if (s.id === 'ztpoolHist') {
        (ctx.baselineDates || []).forEach(function (d) {
          var c2 = Object.assign({}, ctx, { baselineDate8: d.replace(/-/g, '') });
          tasks.push({ id: 'ztpoolHist', url: s.url(c2), headers: s.headers, phase: 2, date: d });
        });
        return;
      }
      if (s.id === 'indexKline') { return; }
      tasks.push({ id: s.id, url: s.url(ctx), headers: s.headers, phase: 2 });
    });
    return tasks;
  }

  /* 版块「数据量」打分：只用于「这一份新数据是不是比手上那份更差」的兜底判断，
     不参与任何展示口径。快照构建器与页面实时层共用同一判据，避免两处口径漂移。
     背景：部分 CDN 会整段瞬时拦截（同一个 URL 隔几分钟就好），一次失败就足以让
     行业/概念变 0、上涨占比变 —、甚至 13 个品种全空，照单全收等于抹掉已有的好数据。 */
  var TAB_QUALITY = {
    aihot: function (t) {
      return (t.total || 0) + ((t.items7d && t.items7d.total) || 0);
    },
    astock: function (t) {
      var b = t.breadth || {};
      var has = function (v) { return v !== null && v !== undefined; };
      /* 基础量：龙虎榜家数 + 行业/概念（主体，×2）+ 涨停数 */
      var base = ((t.lhb && t.lhb.count) || 0)
        + (((t.industries && t.industries.count) || 0) + ((t.concepts && t.concepts.count) || 0)) * 2
        + ((b.limitUp) || 0);
      /* 关键字段「覆盖分」：涨跌家数 / 成交额 / 指数行情三者各值 120 分。
         这三项在部分源失败时会一起变空（页面显示「上涨占比 —%」「成交额 — 亿」），
         而它们的缺失不影响上面那些计数 —— 不加覆盖分就会「半残数据拿满分」而通过闸门。 */
      var cover = (has(b.upRatio) ? 1 : 0) + (has(b.amountYi) ? 1 : 0)
        + ((t.indices && t.indices.length) ? 1 : 0);
      return base + cover * 120;
    },
    hotlist: function (t) {
      var s = t.segments || {};
      var a = (s.astock && s.astock.day.length) || 0;
      var h = (s.astock && s.astock.hour.length) || 0;
      return a + h;
    },
    hk: function (t) {
      return (t.quotes || []).filter(function (q) { return q.price !== null; }).length;
    },
    /* 快讯与行情分属两个独立数据版块（news / hk），任一方整段失败不得拖累另一方被「保留」。
       条数之外再给「还有几个频道」加权：只剩一个频道的半残结果分数要明显低于四个频道齐备的。 */
    news: function (t) {
      return (t.total || 0) + ((t.groups || []).length * 10);
    }
  };
  function qualityOf(k, t) {
    if (!t) return -1;
    if (TAB_QUALITY[k]) return TAB_QUALITY[k](t);
    return t.present ? 1 : 0;
  }

  /* ------------------------------------------------------- AI HOT 归一化 */
  var CANON = [
    { key: 'model', label: '模型发布 / 更新', accent: '#7c9cff', match: ['模型', 'model'] },
    { key: 'product', label: '产品发布 / 更新', accent: '#4fd1a5', match: ['产品', '应用', 'product', 'app'] },
    { key: 'industry', label: '行业动态', accent: '#e0a94a', match: ['行业', '动态', '资讯', 'industry', 'news'] },
    { key: 'paper', label: '论文研究', accent: '#c084fc', match: ['论文', '研究', 'paper', 'research'] },
    { key: 'tips', label: '技巧与观点', accent: '#f0836b', match: ['技巧', '观点', '教程', 'tips', 'opinion', '实践'] }
  ];

  function matchCanon(label) {
    var s = String(label || '').toLowerCase();
    for (var i = 0; i < CANON.length; i++) {
      for (var j = 0; j < CANON[i].match.length; j++) {
        if (s.indexOf(CANON[i].match[j].toLowerCase()) >= 0) return CANON[i];
      }
    }
    return null;
  }

  function normalizeAihot(j) {
    var rep = (j && j.report) || {};
    var raw = rep.sections || [];
    var buckets = {}, extras = [], seen = {};
    CANON.forEach(function (c) { buckets[c.key] = []; });
    raw.forEach(function (s) {
      var hit = matchCanon(s.label);
      if (hit) {
        (s.items || []).forEach(function (it) { buckets[hit.key].push(it); });
      } else if ((s.items || []).length) {
        extras.push({ label: s.label || '其他', items: s.items });
        (s.items || []).forEach(function (it) { /* 计入总数 */ });
      }
    });
    var seq = 0, total = 0, sections = [];
    /* 链接三态：orig = 原文（优先，卡片可直接点进原始来源）；entry = AI HOT 条目页（原文缺失时的兜底）。
       url 统一取「原文优先」，让调用方只用一个字段就能拿到最该去的地址。 */
    function linksOf(it) {
      var lk = it.links || {};
      var orig = lk.original || '';
      var entry = lk.aihot || '';
      return { orig: orig, entry: entry === orig ? '' : entry, url: orig || entry };
    }
    CANON.forEach(function (c) {
      var items = buckets[c.key].map(function (it) {
        seq++; total++;
        var lk = linksOf(it);
        return {
          idx: seq, title: it.title || '', source: (it.source && it.source.name) || '',
          summary: trimSummary(it.summary || '', 60),
          url: lk.url, orig: lk.orig, entry: lk.entry,
          altUrl: lk.orig && lk.orig !== lk.url ? lk.orig : ''
        };
      });
      sections.push({ key: c.key, label: c.label, accent: c.accent, items: items });
    });
    extras.forEach(function (ex) {
      var items = ex.items.map(function (it) {
        seq++; total++;
        var lk = linksOf(it);
        return {
          idx: seq, title: it.title || '', source: (it.source && it.source.name) || '',
          summary: trimSummary(it.summary || '', 60),
          url: lk.url, orig: lk.orig, entry: lk.entry,
          altUrl: lk.orig && lk.orig !== lk.url ? lk.orig : ''
        };
      });
      sections.push({ key: 'extra-' + ex.label, label: ex.label, accent: '#8a97ab', items: items, extra: true });
    });
    var sourceUrl = (rep.links && (rep.links.aihot || rep.links.original)) || '';
    return {
      present: total > 0,
      dataDate: isoDay(rep.date),
      sourceLabel: 'AI HOT 日报',
      sourceUrl: sourceUrl,
      report: {
        date: isoDay(rep.date),
        generatedAt: rep.generatedAt || '',
        windowStart: rep.windowStart || '',
        windowEnd: rep.windowEnd || ''
        /* 不再派生供那一行使用的两个展示串：行已移除，派生串即成死代码
           （同上，不在此处复述被删的文案字样，避免构建期自检把注释误判成残留） */
      },
      sections: sections,
      total: total,
      counts: sections.map(function (s) { return { key: s.key, label: s.label, count: s.items.length, accent: s.accent }; })
    };
  }

  /* ------------------------------------------- AI 条目流（近 7 日）归一化 */
  /* 条目流的 category 是 slug，与日报的 section label 是两套词表。
     顺序即展示顺序；映射不到的 slug 不丢弃，追加到末尾并用灰色标识。 */
  var AI_CATS = [
    { key: 'ai-models', label: '模型与能力', accent: '#7c9cff' },
    { key: 'ai-products', label: '产品与应用', accent: '#4fd1a5' },
    { key: 'tip', label: '技巧与观点', accent: '#f0836b' },
    { key: 'industry', label: '行业动态', accent: '#e0a94a' },
    { key: 'paper', label: '论文研究', accent: '#c084fc' }
  ];
  var AI_CAT_FALLBACK = '#8a97ab';

  function normalizeAihotItems(j) {
    var list = (j && j.items) || [];
    var cats = AI_CATS.slice(), seen = {};
    cats.forEach(function (c) { seen[c.key] = c; });
    list.forEach(function (it) {
      var k = it.category || 'other';
      if (seen[k]) return;
      seen[k] = { key: k, label: k, accent: AI_CAT_FALLBACK };
      cats.push(seen[k]);
    });
    /* 只留上屏要用的字段：条目流原始字段里 id / originalTitle / discoveredAt / reason /
       attribution 都不上屏，原样存进快照会让载荷翻倍（实测 71 条会多占 ~60KB）。
       分类的展示名与配色挂在分组上，条目侧只留 slug。 */
    var items = list.map(function (it) {
      var lk = it.links || {};
      var orig = lk.original || '';
      var entry = lk.aihot || '';
      return {
        title: it.title || '',
        source: (it.source && it.source.name) || '',
        summary: trimSummary(it.summary || '', 76),
        url: orig || entry,
        time: fmtClock(it.publishedAt),
        day: fmtBeijing(it.publishedAt).slice(0, 10),
        category: it.category || 'other',
        score: it.score == null ? null : it.score
      };
    }).filter(function (x) { return x.title; });

    /* 端点默认排序是 timeline（同一时刻内不保证稳定），这里统一按发布时间倒序，
       与本版块「近 7 日」的时间口径一致，且两次打开顺序一致。 */
    items.sort(function (a, b) {
      if (a.day + a.time === b.day + b.time) return (b.score || 0) - (a.score || 0);
      return (a.day + a.time) < (b.day + b.time) ? 1 : -1;
    });

    var groups = cats.map(function (c) {
      var mine = items.filter(function (x) { return x.category === c.key; });
      return { key: c.key, label: c.label, accent: c.accent, count: mine.length, items: mine };
    }).filter(function (g) { return g.count > 0; });

    var days = items.map(function (x) { return x.day; }).filter(Boolean).sort();
    return {
      present: items.length > 0,
      total: items.length,
      window: '7d',
      from: days[0] || '',
      to: days[days.length - 1] || '',
      groups: groups,
      items: items
    };
  }

  /* --------------------------------------------------------- A股 归一化 */
  function pickTradeDate(rangeJson) {
    var rows = (rangeJson && rangeJson.result && rangeJson.result.data) || [];
    var max = '';
    rows.forEach(function (r) { var d = isoDay(r.TRADE_DATE); if (d > max) max = d; });
    return max;
  }

  function normalizeAstock(raw) {
    var rangeRows = (raw.lhbRange && raw.lhbRange.result && raw.lhbRange.result.data) || [];
    var tradeDate = pickTradeDate(raw.lhbRange);
    var lhbRows = rangeRows.filter(function (r) { return isoDay(r.TRADE_DATE) === tradeDate; });

    /* 龙虎榜：东财 RPT_DAILYBILLBOARD_DETAILSNEW 按「上榜原因」返回，
       同一股票当日可能命中多个上榜原因而出现多行（各原因的席位榜单相互独立）。
       若直接按行渲染，会出现同一只股票在 TOP 榜里重复出现、且「上榜家数」= 行数虚高。
       故按股票代码聚合：净买入/买入/卖出求和，上榜原因合并；换手率/涨跌幅同股各行一致，取首行。 */
    var lhbByCode = {};
    lhbRows.forEach(function (r) {
      var code = r.SECURITY_CODE || '';
      if (!code) return;
      var rec = lhbByCode[code];
      if (!rec) {
        rec = lhbByCode[code] = {
          code: code, name: r.SECURITY_NAME_ABBR || '',
          chg: num(r.CHANGE_RATE), net: 0, buy: 0, sell: 0,
          turn: num(r.TURNOVERRATE), market: r.TRADE_MARKET || '', reasons: []
        };
      }
      rec.net += num(r.BILLBOARD_NET_AMT) || 0;
      rec.buy += num(r.BILLBOARD_BUY_AMT) || 0;
      rec.sell += num(r.BILLBOARD_SELL_AMT) || 0;
      var ex = r.EXPLANATION || r.EXPLAIN || '';
      if (ex && rec.reasons.indexOf(ex) < 0) rec.reasons.push(ex);
    });
    var lhbAll = Object.keys(lhbByCode).map(function (k) {
      var x = lhbByCode[k];
      return {
        code: x.code, name: x.name, chg: x.chg, net: r2(x.net), buy: x.buy, sell: x.sell,
        turn: x.turn, market: x.market, reason: x.reasons.join('；'), reasonCount: x.reasons.length
      };
    }).sort(function (a, b) { return (b.net || 0) - (a.net || 0); });
    var netSum = lhbAll.reduce(function (s, x) { return s + (x.net || 0); }, 0);
    var posCount = lhbAll.filter(function (x) { return (x.net || 0) > 0; }).length;

    /* 涨停池 */
    var pool = (raw.ztpool && raw.ztpool.data && raw.ztpool.data.pool) || [];
    var poolItems = pool.map(function (p) {
      return {
        code: p.c || '', name: p.n || '', chg: num(p.zdp), boardDays: num(p.lbc) || 1,
        sealAmt: num(p.fund), turn: num(p.hs), amount: num(p.amount), industry: p.hybk || ''
      };
    }).sort(function (a, b) { return (b.boardDays - a.boardDays) || ((b.sealAmt || 0) - (a.sealAmt || 0)); });

    /* 同花顺涨停池（含封板率、炸板、涨跌停家数） */
    var td = (raw.thsLimit && raw.thsLimit.data) || {};
    var lu = td.limit_up_count && td.limit_up_count.today || {};
    var ld = td.limit_down_count && td.limit_down_count.today || {};
    var luY = td.limit_up_count && td.limit_up_count.yesterday || {};
    var thsItems = (td.info || []).map(function (x) {
      return { code: x.code, name: x.name, reason: x.reason_type || '', highDays: x.high_days || '', type: x.limit_up_type || '', sealAmt: num(x.order_amount) };
    });

    /* 行业 / 概念：涨端、跌端各取一次（服务端 pz 上限 100） */
    function mapClist(node, withFlow) {
      var arr = (node && node.data && node.data.diff) || [];
      return arr.map(function (x) {
        return { code: x.f12, name: x.f14, chg: num(x.f3), flow: withFlow ? num(x.f62) : null, amount: num(x.f6) };
      }).filter(function (x) { return x.name && x.chg !== null; });
    }
    var indUpRows = mapClist(raw.indUp, true).sort(function (a, b) { return b.chg - a.chg; });
    var indDownRows = mapClist(raw.indDown, true).sort(function (a, b) { return a.chg - b.chg; });
    var conUpRows = mapClist(raw.conUp, true).sort(function (a, b) { return b.chg - a.chg; });
    var indTotal = num(raw.indUp && raw.indUp.data && raw.indUp.data.total);
    var conTotal = num(raw.conUp && raw.conUp.data && raw.conUp.data.total);

    /* 指数 & 广度 */
    var idxRows = (raw.indices && raw.indices.data && raw.indices.data.diff) || [];
    var idxName = { 2: '', 1: '' };
    var IDX_META = [
      { secid: '1.000001', name: '上证指数' }, { secid: '0.399001', name: '深证成指' },
      { secid: '0.399006', name: '创业板指' }, { secid: '1.000688', name: '科创50' }
    ];
    var indices = idxRows.map(function (r, i) {
      return { name: (IDX_META[i] && IDX_META[i].name) || '', point: num(r.f2), chg: num(r.f3), delta: num(r.f4), amount: num(r.f6), up: num(r.f104), down: num(r.f105), flat: num(r.f106) };
    });
    var upSum = 0, downSum = 0, flatSum = 0, amtSum = 0;
    indices.forEach(function (x) {
      if (x.name === '上证指数' || x.name === '深证成指') {
        upSum += x.up || 0; downSum += x.down || 0; flatSum += x.flat || 0; amtSum += x.amount || 0;
      }
    });
    var breadth = {
      up: upSum, down: downSum, flat: flatSum,
      upRatio: (upSum + downSum) ? r0(100 * upSum / (upSum + downSum)) : null,
      limitUp: num(lu.num), limitUpRate: num(lu.rate) === null ? null : r0(num(lu.rate) * 100),
      openNum: num(lu.open_num), prevLimitUp: num(luY.num),
      limitDown: num(ld.num), amountYi: amtSum ? amtSum / 1e8 : null
    };

    /* 融资融券 */
    var mRows = (raw.margin && raw.margin.result && raw.margin.result.data) || [];
    var m0 = mRows[0] || {};
    var rzHist = mRows.map(function (r) { return num(r.RZYE); }).filter(function (v) { return v !== null; }).reverse();
    var margin = {
      date: isoDay(m0.DIM_DATE), rzye: num(m0.RZYE), rzyeYi: num(m0.RZYE) ? num(m0.RZYE) / 1e8 : null,
      rzjme: num(m0.RZJME), rzjme5d: num(m0.RZJME5D), rzjme10d: num(m0.RZJME10D),
      rzmezB: num(m0.RZYEZB), rzrqye: num(m0.RZRQYE),
      hist: rzHist
    };

    /* 成交额 / 指数历史：push2his 不可达，此处留空 */

    var themes = ((raw.thsBlock && raw.thsBlock.data) || []).map(function (t) {
      return {
        name: t.name, limitUpNum: num(t.limit_up_num), conNum: num(t.continuous_plate_num),
        chg: num(t.change), high: t.high || '', days: num(t.days)
      };
    }).sort(function (a, b) { return (b.limitUpNum || 0) - (a.limitUpNum || 0); });

    return {
      present: lhbAll.length > 0 || indUpRows.length > 0 || indices.length > 0 || poolItems.length > 0,
      dataDate: tradeDate,
      snapshotAt: '',
      sourceLabel: '东方财富 · 同花顺',
      tradeDate: tradeDate,
      breadth: breadth,
      indices: indices,
      lhb: {
        count: lhbAll.length, posCount: posCount, negCount: lhbAll.length - posCount,
        netSum: netSum,
        topBuy: lhbAll.filter(function (x) { return (x.net || 0) > 0; }).slice(0, 15),
        topSell: lhbAll.filter(function (x) { return (x.net || 0) < 0; }).slice(-8).reverse(),
        topDetail: lhbAll.slice(0, 20)
      },
      limitUp: {
        poolCount: poolItems.length,
        ladder: poolItems.slice(0, 14),
        maxBoard: poolItems.length ? poolItems[0].boardDays : 0,
        lianbanCount: poolItems.filter(function (x) { return x.boardDays >= 2; }).length,
        thsTop: thsItems.slice(0, 20)
      },
      themes: themes,
      industries: {
        top: indUpRows.slice(0, 10),
        bottom: indDownRows.slice(0, 10),
        all: indUpRows,
        count: indUpRows.length,
        total: indTotal
      },
      concepts: {
        top: conUpRows.slice(0, 12),
        all: conUpRows,
        count: conUpRows.length,
        total: conTotal
      },
      margin: margin,
      baseline: { limitUpCounts: [], dates: [] }
    };
  }

  /* 涨停家数基线（回溯交易日），按日期去重升序 */
  function collectBaseline(raw) {
    var seen = {}, out = [];
    (raw.ztpoolHist || []).forEach(function (item) {
      var tc = item && item.response && item.response.data ? item.response.data.tc : null;
      var dt = item && item.date;
      if (tc === null || tc === undefined || !dt || seen[dt]) return;
      seen[dt] = 1;
      out.push({ date: dt, count: num(tc) });
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out;
  }

  /* -------------------------------------------- 人气榜逐日归档（周榜 / 趋势的底座）
     周榜与个股人气趋势没有现成端点（同花顺 eq/fuyao、东财 emappdata 全系探测过，
     均无 week 榜；东财 getHisList 只有单股排名历史且无 CORS 头），故由「每日日榜 Top30」
     滚动归档自建：每天一行（代码/名称/热度/名次），保留最近 HOT_ARCHIVE_MAX 个数据日。
     归档随 data/heat-archive.json 入库（仓库内提交，Actions 全新 checkout 也能续用时间序列），
     页面侧再把内置快照归档并入 localStorage 逐日累积 —— 看得越勤，周榜与趋势越全。 */
  var HOT_ARCHIVE_MAX = 15;

  /* 日榜条目 → 归档条目（只留周榜与趋势要用的四个字段，其余不上屏字段不进归档） */
  function slimDayItems(items) {
    return (items || []).slice(0, 30).map(function (x) {
      return { code: x.code || '', name: x.name || '', heat: x.heat || 0, rank: x.rank || 0 };
    }).filter(function (x) { return x.code; });
  }

  /* 按 date 去重合并（added 同日优先），按日期升序，超出上限裁掉最旧的。
     空日（抓取失败时 day 为空）不进归档，避免拿空行污染时间序列。 */
  function mergeHeatArchive(prev, added) {
    var seen = {}, out = [];
    (added || []).concat(prev || []).forEach(function (day) {
      var d = day && day.date;
      var items = slimDayItems(day && day.items);
      if (!d || !items.length || seen[d]) return;
      seen[d] = 1;
      out.push({ date: d, items: items });
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out.length > HOT_ARCHIVE_MAX ? out.slice(out.length - HOT_ARCHIVE_MAX) : out;
  }

  /* 周榜 = 最近 windowDays 个数据日的累计热度排名（覆盖面 = 每日 Top30 的并集）。
     这是自建口径而非官方周榜，上屏时必须带「近 N 个数据日累计」字样如实标注。 */
  function buildWeekList(archive, windowDays) {
    var days = (archive || []).slice(-Math.max(1, windowDays || 5));
    var by = {}, order = [];
    days.forEach(function (day) {
      (day.items || []).forEach(function (x) {
        var r = by[x.code];
        if (!r) { r = by[x.code] = { code: x.code, name: x.name, heat: 0, days: 0 }; order.push(r); }
        if (x.name) r.name = x.name;
        r.heat += x.heat || 0;
        r.days += 1;
      });
    });
    var entries = order.map(function (x) {
      return {
        code: x.code, name: x.name, heat: x.heat, days: x.days,
        heatTxt: fmtHeat(x.heat),
        daysTxt: days.length > 1 ? ('近 ' + days.length + ' 个数据日中 ' + x.days + ' 日在榜') : ''
      };
    }).sort(function (a, b) { return b.heat - a.heat; }).slice(0, 30);
    entries.forEach(function (x, i) { x.rank = i + 1; });
    return { entries: entries, days: days.length, dates: days.map(function (d) { return d.date; }) };
  }

  /* 趋势 = 个股逐日（热度, 名次）序列，代码 → 序列 的映射，供悬浮/点击弹层用 */
  function buildTrendMap(archive) {
    var by = {};
    (archive || []).forEach(function (day) {
      (day.items || []).forEach(function (x) {
        var t = by[x.code] = by[x.code] || { code: x.code, name: x.name || '', pts: [] };
        t.pts.push({ d: day.date, heat: x.heat || 0, rank: x.rank || 0 });
        if (x.name) t.name = x.name;
      });
    });
    return by;
  }

  /* ---------------------------------------------------- 人气榜 归一化 */
  function normalizeHotlist(raw) {
    var hour = (raw.hotHour && raw.hotHour.data && raw.hotHour.data.stock_list) || [];
    var day = (raw.hotDay && raw.hotDay.data && raw.hotDay.data.stock_list) || [];
    function mapStocks(list) {
      return list.slice(0, 30).map(function (s, i) {
        return {
          rank: num(s.order) || (i + 1), code: s.code || '', name: s.name || '',
          heat: num(s.rate), heatTxt: fmtHeat(s.rate),
          chgRank: num(s.hot_rank_chg), title: s.analyse_title || '',
          analyse: trimSummary(s.analyse || '', 70)
        };
      });
    }
    return {
      present: hour.length > 0 || day.length > 0,
      dataDate: '',
      sourceLabel: '同花顺人气榜',
      segments: {
        astock: { label: 'A股人气榜', sub: '同花顺热股榜 · 小时榜 / 日榜', kind: 'live', hour: mapStocks(hour), day: mapStocks(day) }
      }
    };
  }

  /* ---------------------------------------------------- 港股开盘 归一化
     本函数只管「数字层」：实时行情（东财公开接口，浏览器可直连、每次打开刷新）。
     叙事层是独立数据版块 news（见 normalizeLiveNews），由本版块的渲染器消费 ——
     分成两个版块是为了让任一方拉取失败时，另一方照常显示。 */
  function normalizeHk(raw) {
    var rows = (raw.hkQuotes && raw.hkQuotes.data && raw.hkQuotes.data.diff) || [];
    var bySecid = {};
    rows.forEach(function (r) {
      var id = String(r.f13 == null ? '' : r.f13) + '.' + String(r.f12 == null ? '' : r.f12);
      bySecid[id] = r;
    });

    var quotes = HK_SECIDS.map(function (def) {
      var r = bySecid[def.secid] || null;
      var price = r ? num(r.f2) : null;
      var chgPct = r ? num(r.f3) : null;
      var chg = r ? num(r.f4) : null;
      return {
        key: def.key, secid: def.secid,
        name: def.name, nameEn: def.nameEn,
        price: price, priceTxt: price === null ? '—' : price.toFixed(def.dp),
        chgPct: chgPct,
        chgTxt: fmtPct(chgPct, 2),
        dayTxt: chg === null ? '—' : (chg > 0 ? '+' : '') + chg.toFixed(def.dp),
        unit: def.unit, dp: def.dp,
        role: def.role, group: def.group || 'macro',
        drag: !!def.drag, isYield: !!def.isYield, noise: def.noise || 0.3,
        dir: chgPct === null ? 0 : (chgPct > 0.0001 ? 1 : (chgPct < -0.0001 ? -1 : 0))
      };
    });

    function q(key) { for (var i = 0; i < quotes.length; i++) if (quotes[i].key === key) return quotes[i]; return null; }
    function pick(keys) { return keys.map(q).filter(Boolean); }
    var present = quotes.some(function (x) { return x.price !== null; });

    /* 顶部大数条按 group 分行：A股宽基 / 港股 / 宏观。
       每行 5 列（.strip 最多 c5），故三个分组必须各自 ≤5 个品种。 */
    var STRIP_ROWS = {
      a: ['sh', 'sz', 'cyb', 'hs300', 'kc50'],
      hk: ['hsi', 'hstech', 'hscei', 'dxy', 'us10y']
    };

    /* 原「开盘前结构信号」表及其读法推导（moveOf / dirOf / quotePhrase / chg / abs
       与全部方向变量）已整段删除 —— 该表由用户决定去掉，叙事改由当天真实中文财经新闻
       承担；这些辅助函数若保留即为死代码。 */

    return {
      present: present,
      dataDate: '',
      sourceLabel: '东方财富 · 实时行情',
      quotes: quotes,
      stripRows: Object.keys(STRIP_ROWS).map(function (g) {
        return { group: g, quotes: pick(STRIP_ROWS[g]) };
      }),
      indices: pick(['hsi', 'hstech', 'hscei']),
      aShare: pick(['sh', 'sz', 'cyb', 'hs300', 'kc50']),
      macro: pick(['gold', 'brent', 'wti', 'dxy', 'us10y'])
    };
  }

  /* ---------------------------------------------------- 当天财经快讯 归一化
     源：华尔街见闻四频道（见 SOURCES 的 newsA / newsHk / newsUs / newsGlobal）。
     与它替代的旧叙事层有根本差别：旧通道是语义搜索接口，在浏览器侧不可用，只能构建时
     抓一次且依赖 12 小时短时凭证 —— 凭证一过期，整块新闻就停在上一天（页面照常显示，
     只是内容陈旧）。本通道按 Origin 回显 CORS 头，浏览器可直连，所以「打开页面看到的
     就是当天快讯」；同一份归一化同时服务实时层与构建快照，两处不会漂移。 */
  var NEWS_CH = [
    { key: 'a', label: 'A股', srcId: 'newsA' },
    { key: 'hk', label: '港股', srcId: 'newsHk' },
    { key: 'us', label: '美股', srcId: 'newsUs' },
    { key: 'global', label: '全球', srcId: 'newsGlobal' }
  ];
  /* 单条正文上限：快讯正文通常 50~300 字，留冗余的同时防个别长文把载荷撑大
     （载荷既要进 localStorage 当日缓存，也要进构建快照） */
  var NEWS_MAX_CHARS = 600;

  function normalizeLiveNews(raw) {
    raw = raw || {};
    var seen = {}, pool = [];
    NEWS_CH.forEach(function (ch) {
      var items = (raw[ch.srcId] && raw[ch.srcId].data && raw[ch.srcId].data.items) || [];
      items.forEach(function (x) {
        /* 同一条快讯会同时出现在多个频道（实测「华龙一号投产」在港股与全球频道各有一份），
           按 NEWS_CH 的顺序去重 —— 频道定义顺序即优先级。 */
        var id = String(x.id || x.uri || '');
        if (!id || seen[id]) return;
        seen[id] = 1;
        var ts = num(x.display_time) || 0;
        var content = String(x.content_text || x.content || '').replace(/\s+/g, ' ').trim();
        if (content.length > NEWS_MAX_CHARS) content = content.slice(0, NEWS_MAX_CHARS) + '…';
        /* 约一半快讯没有独立标题（短讯的正文即标题），回退成正文首句，
           否则上屏会是一列空白标题。 */
        var title = String(x.title || '').trim() || trimSummary(content, 44);
        if (!title && !content) return;
        pool.push({
          title: title,
          content: content,
          excerpt: trimSummary(content, 110),
          chars: content.length,
          ts: ts,
          day: bjDay(ts),
          time: bjClock(ts),
          url: String(x.uri || ''),
          ch: ch.key,
          chLabel: ch.label
        });
      });
    });

    if (!pool.length) {
      return { present: false, date: '', total: 0, groups: [], latest: [], items: [], sourceLabel: '华尔街见闻 · 实时快讯' };
    }
    pool.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

    /* 只保留「最新一天」：非交易时段最新一页会带出前一天的条目，一并上屏的话，
       页面顶部的「数据日期」与列表内容就对不上了。 */
    var date = pool[0].day;
    var items = pool.filter(function (x) { return x.day === date; });

    var byCh = {};
    items.forEach(function (x) { (byCh[x.ch] = byCh[x.ch] || []).push(x); });
    var groups = [];
    NEWS_CH.forEach(function (ch) {
      if (!(byCh[ch.key] || []).length) return;
      groups.push({ key: ch.key, label: ch.label, count: byCh[ch.key].length, items: byCh[ch.key] });
    });

    return {
      present: true,
      date: date,
      total: items.length,
      groups: groups,
      latest: items.slice(0, 6),
      items: items,
      sourceLabel: '华尔街见闻 · 实时快讯'
    };
  }

  return {
    VERSION: '1.1.0',
    SOURCES: SOURCES, CANON: CANON,
    byId: byId, planFor: planFor, buildTasks: buildTasks,
    altUrls: altUrls, HOST_ALTS: HOST_ALTS,
    normalizeAihot: normalizeAihot, normalizeAihotItems: normalizeAihotItems, AI_CATS: AI_CATS,
    qualityOf: qualityOf, TAB_QUALITY: TAB_QUALITY,
    normalizeAstock: normalizeAstock,
    normalizeHotlist: normalizeHotlist, normalizeHk: normalizeHk,
    mergeHeatArchive: mergeHeatArchive, buildWeekList: buildWeekList, buildTrendMap: buildTrendMap,
    HOT_ARCHIVE_MAX: HOT_ARCHIVE_MAX,
    normalizeLiveNews: normalizeLiveNews, NEWS_CH: NEWS_CH,
    collectBaseline: collectBaseline, HK_SECIDS: HK_SECIDS,
    pickTradeDate: pickTradeDate,
    utils: {
      nowIso: nowIso, localDateStr: localDateStr, localTimeStr: localTimeStr,
      isoDay: isoDay, d8: d8, shiftDay: shiftDay, backDates: backDates, clamp: clamp, r0: r0, num: num,
      fmtYi: fmtYi, fmtPct: fmtPct, fmtHeat: fmtHeat, fmtBeijing: fmtBeijing, fmtClock: fmtClock,
      cjkCount: cjkCount, trimSummary: trimSummary, esc: esc, percentileOf: percentileOf, pad2: pad2
    }
  };
});
