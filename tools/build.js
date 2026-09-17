#!/usr/bin/env node
/**
 * 每日资讯看板构建器（Node，零依赖）
 *   把 src/{styles.css,shell.html,lib.js,radar.js,app.js} + data/<date>.json
 *   组装为单文件离线 HTML（资源全内联、零 CDN）。
 * 用法：
 *   node tools/build.js
 *   node tools/build.js --out=F:\path\to\out.html
 */
const fs = require('fs');
const path = require('path');
const MB = require('../src/lib.js');
const U = MB.utils;

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const SRC = path.join(ROOT, 'src');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const outArg = (argv.find((a) => a.startsWith('--out=')) || '').split('=')[1];
const OUT = outArg || path.join(WORKSPACE, '每日资讯看板.html');
/* --nonews：把快照里的快讯载荷清空，用于验证「快讯缺失」时的降级渲染 */
const NO_NEWS = argv.indexOf('--nonews') >= 0;

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

function latestData() {
  if (!fs.existsSync(DATA)) throw new Error('缺少数据目录：' + DATA + '（请先运行 tools/fetch-sources.js）');
  const files = fs.readdirSync(DATA).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) throw new Error('data/ 下没有快照 JSON（请先运行 tools/fetch-sources.js）');
  const name = files[files.length - 1];
  return { name, json: JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')) };
}

/** JSON 放进 <script> 时必须转义 '<'，避免出现 </script> 截断 */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const css = read('styles.css');
let shell = read('shell.html');
const lib = read('lib.js');
const radar = read('radar.js');
const app = read('app.js');

const { name, json: snapshot } = latestData();
/* --nonews：抹掉快照里的快讯载荷，页面应走空态而不是报错 */
if (NO_NEWS && snapshot.tabs && snapshot.tabs.news) {
  snapshot.tabs.news = { present: false, date: '', total: 0, groups: [], latest: [], items: [] };
}
const builtAt = U.nowIso();
const builtAtBj = U.fmtBeijing(builtAt);

const edition = (snapshot.tabs && snapshot.tabs.aihot && snapshot.tabs.aihot.dataDate)
  || (snapshot.ctx && snapshot.ctx.tradeDate) || U.localDateStr();
shell = shell
  .replace(/\{\{EDITION\}\}/g, edition)
  .replace(/\{\{BUILT_AT_BJ\}\}/g, builtAtBj)
  .replace(/\{\{VERSION\}\}/g, MB.VERSION);

const html = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="color-scheme" content="dark">',
  '<title>每日资讯看板 · AI日报 / AI动态 / 财经市场 / 实时热搜</title>',
  '<style>' + css + '</style>',
  '</head>',
  '<body>',
  shell,
  '<script id="snapshot" type="application/json">' + safeJson(snapshot) + '</script>',
  '<script>' + lib + '</script>',
  '<script>' + radar + '</script>',
  '<script>' + app + '</script>',
  '</body>',
  '</html>',
  ''
].join('\n');

if (html.indexOf('{{') >= 0) {
  const i = html.indexOf('{{');
  throw new Error('构建产物仍残留占位符：' + html.slice(i, i + 40));
}

fs.writeFileSync(OUT, html, 'utf8');

const log = [];
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
log.push('BUILT ' + OUT);
log.push('  size          ' + kb + ' KB');
log.push('  snapshot      data/' + name + '  (builtAt ' + snapshot.builtAtBj + ')');
const snapNews = (snapshot.tabs && snapshot.tabs.news) || {};
log.push('  news          ' + (snapNews.total
  ? snapNews.total + ' 条 / ' + snapNews.date + ' · ' + (snapNews.groups || []).length + ' 个频道（随快照入库）'
  : '快照内无快讯（页面将显示空态）'));
log.push('  edition       ' + edition);
log.push('  css/js 字符    ' + css.length + ' / ' + (lib.length + radar.length + app.length));
log.push('  外部资源检查   <link>=' + (html.match(/<link\b/gi) || []).length
  + '  <script src>=' + (html.match(/<script[^>]*\ssrc=/gi) || []).length
  + '  <img src>=' + (html.match(/<img[^>]*\ssrc=/gi) || []).length);

const checks = [];
/* 一级容器（pane-aidyn / pane-market 是两个分组 tab，自身不持数据）与持数据的 pane 分开列 */
const TOP_PANES = ['pane-aidyn', 'pane-market', 'pane-hotlist'];
const DATA_PANES = ['pane-aihot', 'pane-ai7d', 'pane-hk', 'pane-hotlist', 'pane-astock', 'pane-radar', 'pane-astkday'];
const ALL_PANES = TOP_PANES.concat(DATA_PANES.filter((k) => TOP_PANES.indexOf(k) < 0));
/* 不单独入库的投影版块：由真源在渲染前投出
   （astkday ← hotlist 的 A股人气榜日榜；ai7d ← aihot 的 7 日条目流） */
const DERIVED_TABS = ['astkday', 'ai7d'];
/* 有独立数据载荷但没有自己 pane 的版块 —— news 由「财经市场 · 今日要闻」消费 */
const PANELESS_TABS = ['news'];
checks.push(['快照可解析', (() => { try { const s = html.split('<script id="snapshot" type="application/json">')[1].split('</script>')[0]; JSON.parse(s); return true; } catch (e) { return 'FAIL ' + e.message; } })()]);
checks.push(['无 </script> 截断风险', snapshot ? html.indexOf('</script>', html.indexOf('type="application/json"')) > 0 : false]);
/* 快讯是构建快照的一部分（断网降级时「全部要闻」还得有内容）。
   旧叙事层曾是一个独立的 <script id="news"> 标签，靠构建时的短时凭证抓取 ——
   凭证一过期内容就停在前一天，故整条链路换成了浏览器可直连的快讯源，标签也随之取消。 */
checks.push(['快讯随快照入库且分组齐全', (() => {
  const n = snapshot.tabs && snapshot.tabs.news;
  if (!n) return 'FAIL 快照缺 news 版块（需 fetch-sources.js 重抓）';
  if (NO_NEWS) return n.present === false && n.total === 0 ? true : 'FAIL --nonews 未清空载荷';
  if (!n.present) return 'FAIL present=false（抓取时快讯源全部失败）';
  const bad = [];
  if (!(n.total > 0)) bad.push('条数 0');
  if (n.date > U.localDateStr()) bad.push('日期在未来 ' + n.date);
  if (!(n.groups || []).length) bad.push('无频道分组');
  const sum = (n.groups || []).reduce((a, g) => a + g.count, 0);
  if (sum !== n.total) bad.push('分组计数之和 ' + sum + ' ≠ 总条数 ' + n.total);
  const badItems = (n.items || []).filter((x) => !x.title || !x.time || !x.day || !x.url);
  if (badItems.length) bad.push(badItems.length + ' 条缺标题/时间/链接');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
checks.push(['快讯源为浏览器可直连（不再依赖构建时凭证）', (() => {
  const bad = [];
  if (lib.indexOf('api-one.wallstcn.com') < 0) bad.push('数据层未定义快讯源');
  ['newsA', 'newsHk', 'newsUs', 'newsGlobal'].forEach((id) => {
    if (!MB.byId(id)) bad.push('缺源 ' + id);
    else if (MB.byId(id).kind !== 'browser') bad.push(id + ' 不是 browser 源');
    else if (MB.byId(id).tab !== 'news') bad.push(id + ' 未归属 news 版块');
  });
  if (lib.indexOf('normalizeNews') >= 0) bad.push('旧叙事层归一化函数仍在');
  if (app.indexOf('getElementById(\'news\')') >= 0) bad.push('app.js 仍在读旧的 #news 快照标签');
  if (html.indexOf('id="news"') >= 0) bad.push('产物仍内嵌 #news 标签');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
checks.push([ALL_PANES.length + ' 个 pane 容器存在', ALL_PANES.every((k) => html.indexOf('id="' + k + '"') >= 0)]);
/* 一级导航：三个 tab（AI 动态 / 财经市场 都是分组 tab，自身不持数据） */
checks.push(['一级 tab 顺序 = aidyn → market → hotlist（共 3 个）', (() => {
  const got = (shell.match(/data-pane="([a-z0-9]+)"/g) || []).map((s) => s.replace(/.*"([a-z0-9]+)"/, '$1'));
  const want = ['aidyn', 'market', 'hotlist'];
  return JSON.stringify(got) === JSON.stringify(want) ? true : 'FAIL ' + JSON.stringify(got);
})()]);
/* 分组 tab 的子 tab 归属：**按 data-group 逐组解析**，比扫一遍全局 data-sub 更能锁住「谁属于谁」——
   两个分组 tab 并存时，全局扫描只能得到一条扁平序列，子 tab 挂错了组也看不出来。 */
function subGroups(src) {
  const out = {};
  const re = /<div class="subtabs" data-group="([a-z0-9]+)"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1]] = (m[2].match(/data-sub="([a-z0-9]+)"/g) || []).map((s) => s.replace(/.*"([a-z0-9]+)"/, '$1'));
  }
  return out;
}
checks.push(['两个分组 tab 的子 tab 归属正确（AI 动态 2 + 财经市场 4）', (() => {
  const got = subGroups(shell);
  const want = { aidyn: ['aihot', 'ai7d'], market: ['hk', 'astock', 'radar', 'astkday'] };
  const bad = [];
  Object.keys(want).forEach((k) => {
    if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) bad.push(k + '=' + JSON.stringify(got[k]));
  });
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 原一级 tab「今日财经要闻」不得再以一级身份存在（应只剩 pane-hk 这个子 pane） */
checks.push(['今日财经要闻已并入财经市场（不再是一级 tab）', (() => {
  const bad = [];
  if (shell.indexOf('data-pane="hk"') >= 0) bad.push('shell.html 仍把 hk 当一级 tab');
  if (html.indexOf('id="pane-market"') < 0) bad.push('缺少分组容器 pane-market');
  const g = subGroups(shell);
  if (!g.market || g.market[0] !== 'hk') bad.push('财经市场的首个子 tab 应为 hk（今日要闻）');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 结构信号表已按用户要求移除：渲染层与数据层都不得残留。
   注意判据必须是「渲染代码」而非「字样」—— 注释里说明「已移除」是允许的。 */
checks.push(['「开盘前结构信号」已彻底移除', (() => {
  const bad = [];
  if (app.indexOf('<h2>开盘前结构信号</h2>') >= 0) bad.push('app.js 仍在渲染该表');
  if (/structure:\s*structure/.test(lib)) bad.push('lib.js 仍导出 structure');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* AI 日报不再外链 AI HOT：卡片只指向原始来源 */
checks.push(['AI 日报不再渲染 AI HOT 外链', (() => {
  const bad = [];
  if (app.indexOf('查看官方日报页') >= 0) bad.push('「查看官方日报页」未删');
  if (app.indexOf('AI HOT 条目 ↗') >= 0) bad.push('「AI HOT 条目」未删');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 全页只允许顶部那一处时间戳：渲染层除 updateChrome 外不得再调 U.fmtBeijing，
   也不得出现「本次更新 / 计算时间 / 抓取于 / 页面构建时间」这类二次时间标注。 */
checks.push(['更新时间只在顶部出现一次', (() => {
  const bad = [];
  app.split('\n').forEach((line, i) => {
    if (/U\.fmtBeijing\s*\(/.test(line) && line.indexOf('updatedAt') < 0) bad.push('app.js:' + (i + 1));
  });
  ['本次更新', '计算时间', '抓取于', '分时快照', '页面构建时间'].forEach((w) => {
    if (html.indexOf(w) >= 0) bad.push('产物含「' + w + '」');
  });
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* AI 日报 hero 里原有的「覆盖时段 / 日报生成时间」一行已按用户要求移除（顶栏已有唯一时间标注）。
   判据分两层：产物里不得出现该行文案；app.js / lib.js 里不得出现只为该行服务的派生串与工具函数。
   注意只在源码判 windowText / generatedAtBj / fmtBeijingShort —— 快照 JSON 里可能仍带历史键，
   而注释里复述被删文案会被误判，故本轮注释刻意不复述字样。 */
checks.push(['AI 日报 hero 不再重复展示时段与生成时间', (() => {
  const bad = [];
  ['覆盖时段', '日报生成'].forEach((w) => {
    if (html.indexOf(w) >= 0) bad.push('产物含「' + w + '」');
  });
  ['windowText', 'generatedAtBj', 'fmtBeijingShort'].forEach((w) => {
    if (app.indexOf(w) >= 0) bad.push('app.js 仍含 ' + w);
    if (lib.indexOf(w) >= 0) bad.push('lib.js 仍含 ' + w);
  });
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);

/* AI 日报页脚说明（「本版块共 N 条 / 全局连续 / 摘要裁剪」）已按用户要求删除 */
checks.push(['AI 日报版块说明文案已移除', (() => {
  const bad = [];
  if (app.indexOf('全局连续（不按版块重新计数）') >= 0) bad.push('说明文案未删');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 单条版块不得居中：.cards.single 的 max-width + margin:auto 会把孤卡推到中间 */
checks.push(['单条版块卡片左对齐（无 .cards.single 居中）', (() => {
  const bad = [];
  if (/\.cards\.single\s*\{[^}]*margin\s*:\s*0\s+auto/.test(css)) bad.push('styles.css 仍在居中单卡片');
  if (app.indexOf("' single'") >= 0) bad.push('app.js 仍在输出 single 类');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
checks.push(['UMD 双端导出存在', html.indexOf('root.MB = api') >= 0 && html.indexOf('root.MBRadar = api') >= 0]);
/* 每个 tab 容器在 snapshot 里都有对应载荷，避免「有壳无数据」静默失败。
   投影版块不单独入库，改判其真源（人气榜日榜 ← 热搜版块的日榜）非空。 */
checks.push(['快照含全部数据版块载荷（投影版块除外）', DATA_PANES.map((k) => k.replace('pane-', ''))
  .concat(PANELESS_TABS)
  .filter((k) => DERIVED_TABS.indexOf(k) < 0)
  .every((k) => snapshot.tabs && snapshot.tabs[k] !== undefined)]);
checks.push(['投影版块的真源非空（热搜版块的 A股人气榜日榜）', (() => {
  const seg = snapshot.tabs.hotlist && snapshot.tabs.hotlist.segments && snapshot.tabs.hotlist.segments.astock;
  const n = seg && Array.isArray(seg.day) ? seg.day.length : 0;
  return n > 0 ? true : 'FAIL 日榜条数 ' + n + '（应为投影源）';
})()]);
/* 今日财经要闻：13 个品种的 secid 与实际返回的 f12 必须一一对应，否则会静默丢品种
   （A股宽基 5 · 港股 3 · 宏观 5） */
checks.push(['今日财经要闻品种数 = 13', (() => {
  const n = (snapshot.tabs.hk && snapshot.tabs.hk.quotes) ? snapshot.tabs.hk.quotes.length : 0;
  return n === 13 ? true : 'FAIL 实际 ' + n + '（改过品种清单需 fetch-sources.js --force 重抓快照）';
})()]);
checks.push(['今日财经要闻含 5 个 A股宽基指数', (() => {
  const want = ['1.000001', '0.399001', '0.399006', '1.000300', '1.000688'];
  const got = ((snapshot.tabs.hk && snapshot.tabs.hk.quotes) || [])
    .filter((x) => x.group === 'a').map((x) => x.secid);
  return JSON.stringify(got) === JSON.stringify(want) ? true : 'FAIL ' + JSON.stringify(got);
})()]);
checks.push(['今日财经要闻顶部大数条分两行（A股宽基 / 港股·宏观）', (() => {
  const rows = (snapshot.tabs.hk && snapshot.tabs.hk.stripRows) || [];
  const g = rows.map((r) => r.group);
  if (JSON.stringify(g) !== JSON.stringify(['a', 'hk'])) return 'FAIL 分组 ' + JSON.stringify(g);
  const bad = rows.filter((r) => !r.quotes.length || r.quotes.length > 5).map((r) => r.group + ':' + r.quotes.length);
  return bad.length ? 'FAIL 每行必须 1–5 个（.strip 上限 c5）：' + bad.join(' ') : true;
})()]);
/* 品种数改成 13 之后，跨资产图与明细表的「N 个品种」必须随实际数据走，不能再写死 */
checks.push(['跨资产图与明细表的品种数按实际数据渲染', (() => {
  const bad = [];
  if (app.indexOf("'8 个品种 · 单位统一为 %") >= 0) bad.push('跨资产图仍写死 8 个品种');
  if (app.indexOf("qs.length + ' 个品种 · 单位统一为 %") < 0) bad.push('跨资产图未按实际品种数渲染');
  /* needle 不能带字符串起始引号：「共」在源码里前面是 `class="note">`，不是引号。
     写 `"'共 ' + all.length"` 会永远命中不了，是判据自身的 bug（踩过）。 */
  if (app.indexOf("共 ' + all.length + ' 个品种") < 0) bad.push('明细表未按全部品种计数');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
checks.push(['今日财经要闻有实时读数', (() => {
  const q = (snapshot.tabs.hk && snapshot.tabs.hk.quotes) || [];
  const ok = q.filter((x) => x.price !== null).length;
  return ok === q.length ? true : 'FAIL ' + ok + '/' + q.length;
})()]);
/* 顶部两段时间并置：数据日期（随版块切）与更新于（抓取时刻）。
   判据分两层 —— 产物里必须有这两处 DOM 与标签；渲染层必须由 updateChrome 统一写，
   且「数据日期」的逐版块口径必须落在 dataDateOf 里（不能退回全页共用一个时间戳）。 */
checks.push(['顶部并置「数据日期」与「更新于」', (() => {
  const bad = [];
  ['id="dataDate"', 'id="updatedAt"', 'id="editionBadge"'].forEach((w) => {
    if (html.indexOf(w) < 0) bad.push('缺 ' + w);
  });
  if (html.indexOf('数据日期') < 0) bad.push('缺「数据日期」标签');
  if (html.indexOf('更新于') < 0) bad.push('缺「更新于」标签');
  /* 旧标签「数据更新时间」是单一时间戳时代的写法，必须整体消失 */
  if (html.indexOf('数据更新时间') >= 0) bad.push('旧标签「数据更新时间」仍在');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
checks.push(['数据日期逐版块判定且徽标与顶部同源', (() => {
  const bad = [];
  if (app.indexOf('function dataDateOf(') < 0) bad.push('app.js 缺 dataDateOf');
  ['aihot', 'ai7d', 'hk', 'hotlist', 'astock'].forEach((k) => {
    if (app.indexOf("k === '" + k + "'") < 0) bad.push('dataDateOf 未覆盖 ' + k);
  });
  /* 横幅删除后，热搜版块的快照日期只能靠 dataDateOf 的 baiduDate 分支体现 */
  if (app.indexOf('d.baiduDate || d.dataDate') < 0) bad.push('热搜数据日期未取百度快照日期');
  /* 徽标必须与顶部同源：同一个 dd 变量同时写两处，不得各算各的 */
  if (!/badge\.textContent\s*=\s*dd\s*\|\|\s*'—'/.test(app)) bad.push('徽标未与顶部数据日期同源');
  if (!/getElementById\('dataDate'\)\.textContent\s*=\s*dd\s*\|\|\s*'—'/.test(app)) bad.push('顶部数据日期未由 dd 写入');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* AI 日报空版块：直接显示「无」，不附解释性备注 */
checks.push(['AI 日报空版块只显示「无」', (() => {
  const bad = [];
  if (app.indexOf('本期日报未收录该版块条目') >= 0) bad.push('解释性备注未删');
  if (app.indexOf('<div class="empty">无</div>') < 0) bad.push('未渲染「无」');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 投资风险提示只在涉及投资的一级 tab 出现：靠 #riskWarn 按当前**一级 tab 名**切换。
   不能用数据版块名判 —— 「AI 动态」下的两个子 tab（当日 / 近 7 日）都是资讯汇总，
   逐数据版块列举会随子 tab 增加而越列越长。 */
checks.push(['投资风险提示只在涉及投资的一级 tab 出现', (() => {
  const bad = [];
  if (shell.indexOf('id="riskWarn"') < 0) bad.push('shell.html 缺 #riskWarn');
  if (app.indexOf("STATE.active === 'aidyn'") < 0) bad.push('app.js 未按一级 tab 切换展示');
  /* 反向判据：出现任何数据版块名都说明又退回「逐版块判」的老写法了 */
  if (/rw\.classList\.toggle\('hide',\s*[^)]*'ai(?:hot|7d)'/.test(app)) bad.push('仍在按数据版块名判风险提示');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 页脚来源与版本同行：左侧「数据来源:公共接口数据抓取」，右侧「版本: v1.0.0」 */
checks.push(['页脚来源与版本同行且版本靠右', (() => {
  const bad = [];
  if (html.indexOf('公共接口数据抓取') < 0) bad.push('缺少统一来源声明');
  ['AI 日报</b> 数据源', 'A股盘面 · 市场情绪</b> 数据源', '热搜</b> 数据源'].forEach((w) => {
    if (html.indexOf(w) >= 0) bad.push('旧的逐 tab 来源句仍在：' + w);
  });
  /* 旧文案不得残留：`<b>数据来源</b>` = 原先「标签加粗 + 全角空格」的写法 */
  ['构建版本', '<b>数据来源</b>'].forEach((w) => {
    if (html.indexOf(w) >= 0) bad.push('旧文案仍在：' + w);
  });
  /* 两者必须在同一个 .fl.single 行内 */
  const row = (shell.match(/<div class="fl single">[\s\S]*?<\/div>/) || [''])[0];
  if (!row) bad.push('shell.html 无同行的 .fl.single');
  else {
    if (row.indexOf('数据来源:') < 0) bad.push('行内缺「数据来源:」');
    if (row.indexOf('版本:') < 0) bad.push('行内缺「版本:」');
  }
  /* 靠右靠的是 margin-left:auto（flex 自动外边距），不是 text-align */
  if (!/footer\s+\.fver\s*\{[^}]*margin-left\s*:\s*auto/.test(css)) bad.push('版本未靠右（.fver 缺 margin-left:auto）');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 页脚不再暴露「内部构建细节」：入库快照清单（#ftData）与本地数据目录路径
   都属工具链信息，对看板的读者无意义。判据分两层：产物不得含该文案，
   渲染层不得再引用被删的 #ftData（删了 DOM 却留着赋值语句 = 死代码）。 */
checks.push(['页脚不再暴露本地快照清单与数据目录', (() => {
  const bad = [];
  ['已入库本地快照', '本地数据目录', 'dashboard/data/'].forEach((w) => {
    if (html.indexOf(w) >= 0) bad.push('产物含「' + w + '」');
  });
  if (app.indexOf('ftData') >= 0) bad.push('app.js 仍引用 #ftData');
  if (shell.indexOf('ftData') >= 0) bad.push('shell.html 仍有 #ftData');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 页面只呈现数据本身：不渲染「来源 / 更新方式」说明横幅与零散来源句
   （完整来源说明另见工作区根目录《数据来源说明.md》）。判据只针对被删的**具体句子**，
   不扫「CORS」「快照」这类泛词 —— 泛词会被新闻正文或合法口径说明命中。 */
checks.push(['页面无版块来源说明横幅与零散来源句', (() => {
  const bad = [];
  ['东方财富公开行情接口', '不返回 CORS 头', '浏览器无法直连', '页面无法自行拉取',
   '与上方实时行情属不同更新节奏', '百度热搜需由本地脚本抓取'].forEach((w) => {
    if (html.indexOf(w) >= 0) bad.push('产物含「' + w + '」');
  });
  /* 两处横幅的渲染代码必须整段移除 */
  if (app.indexOf('<div class="banner t5">') >= 0) bad.push('app.js 仍渲染「今日财经要闻」横幅');
  if (app.indexOf('<span class="ic">🔥</span>') >= 0) bad.push('app.js 仍渲染「实时热搜」横幅');
  /* 横幅专属样式不得留成死 CSS */
  if (/\.banner\.t5/.test(css)) bad.push('styles.css 仍有 .banner.t5 死规则');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 热搜版块瘦身：A股人气榜的「小时榜」不再上屏，日榜归到「A股盘面」。
   判据只看 app.js —— lib.js 的段落描述与快照 JSON 仍带该数据，因为小时榜要留给
   风险雷达算热度集中度，删的是「上屏」而不是「数据」。 */
checks.push(['热搜版块不再上屏 A股人气榜小时榜', (() => {
  const bad = [];
  /* 只扫被删的完整按钮文案，不扫「小时榜」单字 —— 注释里叙述「哪条不再上屏」是允许的 */
  if (app.indexOf('A股人气榜 · 小时榜') >= 0) bad.push('app.js 仍含被删的分段按钮文案');
  if (app.indexOf('id="seg-hour"') >= 0) bad.push('app.js 仍渲染 seg-hour 段');
  if (app.indexOf("data-seg=\"hour\"") >= 0) bad.push('app.js 仍有小时榜分段按钮');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 日榜归属：财经市场内的第四个子 tab，且由 hotlist 投影而来（真源只有一份，不单独入库） */
checks.push(['人气榜日榜在财经市场内且为投影版块', (() => {
  const bad = [];
  if (app.indexOf('id="seg-day"') >= 0) bad.push('app.js 仍把日榜渲染在热搜版块内');
  if (app.indexOf('astkday: renderAstkDay') < 0) bad.push('app.js 未注册 astkday 渲染器');
  if (!/DERIVED\s*=\s*\{[^}]*astkday\s*:\s*'hotlist'/.test(app)) bad.push('app.js 缺 astkday ← hotlist 投影声明');
  if (app.indexOf('syncDerived()') < 0) bad.push('app.js 未在数据换新后同步投影版块');
  if (app.indexOf('if (DERIVED[k]) return;') < 0) bad.push('缓存层未排除投影版块（会写出第二份真源）');
  if (html.indexOf('data-sub="astkday"') < 0) bad.push('shell.html 缺 astkday 子 tab 按钮');
  if (html.indexOf('id="pane-astkday"') < 0) bad.push('shell.html 缺 astkday 子 pane');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 近 7 日 AI 条目流：与当日日报出自同一提供方的另一端点（window=7d，实测 71 条）。
   判据分两层 —— 快照里必须有非空载荷（否则断网降级时该版块是空的），
   渲染层必须有对应版块、筛选条与事件绑定。 */
checks.push(['AI 日报含「近 7 日」条目流载荷', (() => {
  const s = snapshot.tabs.aihot && snapshot.tabs.aihot.items7d;
  if (!s || !s.present) return 'FAIL 载荷缺失（需 fetch-sources.js 重抓快照）';
  const bad = [];
  const n = (s.items || []).length;
  if (!(n > 0)) bad.push('条目数 0');
  if (!(s.groups || []).length) bad.push('无分类分组');
  const sum = (s.groups || []).reduce((a, g) => a + g.count, 0);
  if (sum !== n) bad.push('分组计数之和 ' + sum + ' ≠ 条目数 ' + n);
  const badItems = (s.items || []).filter((x) => !x.title || !x.time || !x.day || !x.category);
  if (badItems.length) bad.push(badItems.length + ' 条缺标题/时间/分类');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* AI 动态是一级分组 tab：当日（官方日报精选）与近 7 日（条目流）是它下面的两个子 tab。
   判据分三层 —— 渲染器与投影声明在 app.js；两者都必须挂在 aidyn 这个分组下（而不是各占一级 tab）；
   且 AI 日报页内不得残留 7 日流锚点（否则两处渲染同一批内容，产物白胖一倍而页面看不出来）。 */
checks.push(['AI 动态：当日与近 7 日同为 aidyn 下的子 tab', (() => {
  const bad = [];
  if (app.indexOf('function renderAi7d(') < 0) bad.push('缺渲染函数');
  if (app.indexOf('id="sec-items7d"') < 0) bad.push('缺版块容器');
  if (app.indexOf('id="ai7dSeg"') < 0) bad.push('缺分类筛选条');
  if (app.indexOf('setupAi7dSeg') < 0) bad.push('筛选条未绑定事件');
  if (app.indexOf('ai7d: renderAi7d') < 0) bad.push('未注册 ai7d 渲染器');
  /* 它取自 aihot 载荷的另一个字段，不额外入库，故必须有投影声明 */
  if (!/DERIVED\s*=\s*\{[^}]*ai7d\s*:\s*'aihot'/.test(app)) bad.push('app.js 缺 ai7d ← aihot 投影声明');
  /* 一级 tab 只应有 aidyn —— ai7d 不能再以一级身份出现 */
  if (!/TOPKEYS\s*=\s*\[[^\]]*'aidyn'/.test(app)) bad.push('app.js TOPKEYS 未含 aidyn');
  if (html.indexOf('data-pane="ai7d"') >= 0) bad.push('shell.html 仍把 ai7d 当一级 tab');
  if (!/GROUP\s*=\s*\{\s*aidyn\s*:\s*\['aihot',\s*'ai7d'\]/.test(app)) bad.push('app.js 缺 aidyn 分组成员声明');
  if (html.indexOf('data-sub="ai7d"') < 0) bad.push('shell.html 缺 ai7d 子 tab 按钮');
  if (html.indexOf('id="pane-aidyn"') < 0) bad.push('shell.html 缺分组容器 pane-aidyn');
  if (html.indexOf('id="pane-ai7d"') < 0) bad.push('shell.html 缺 ai7d 子 pane');
  /* 两个子 tab 的标签必须是约定的「当日 / 近 7 日」 */
  ['当日', '近 7 日'].forEach((w) => { if (html.indexOf('>' + w + '<') < 0) bad.push('缺子 tab 标签「' + w + '」'); });
  /* 合并回同一个 tab 后，AI 日报仍不得把 7 日流内联渲染在自己页面里 */
  if (app.indexOf('renderAihot7d') >= 0) bad.push('AI 日报仍内联渲染 7 日流');
  if (app.indexOf("'items7d'") >= 0) bad.push('AI 日报导航仍含 7 日项');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 品牌改名：源文件（会被内联进产物）里不得再出现旧称。
   只扫我们自己的源文件，不扫产物整串 —— 新闻正文里出现「晨报」是合法的。 */
checks.push(['品牌与产物名已改为「每日资讯看板」', (() => {
  const bad = [];
  if (html.indexOf('<title>每日资讯看板') < 0) bad.push('<title> 未改');
  if (!/<span class="zh">每日资讯看板<\/span>/.test(shell)) bad.push('页头品牌未改');
  const src = css + shell + lib + radar + app;
  if (src.indexOf('晨报') >= 0) bad.push('源码仍残留旧称「晨报」（会被内联进产物）');
  /* 产物文件名只在「用默认输出路径」时才该检查：显式 --out= 是调用方的选择
     （CI 需要 dist/index.html 这种托管约定名），拿默认名去套是判据越界。 */
  if (!outArg && OUT.indexOf('每日资讯看板.html') < 0) bad.push('默认产物文件名未改');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 瞬时拦截兜底：新数据「更少」时不得覆盖手上那份好数据。
   两处共用同一判据（lib.qualityOf），避免页面与快照构建器各写一套口径。 */
checks.push(['数据质量闸门（实时层与快照层共用判据）', (() => {
  const bad = [];
  if (lib.indexOf('function qualityOf(') < 0) bad.push('lib.js 缺 qualityOf');
  /* 打分必须计入「关键字段覆盖分」：只数条数的话，涨跌家数 / 成交额一起变空的半残数据仍会拿满分 */
  if (lib.indexOf('cover * 120') < 0) bad.push('质量打分未计入关键字段覆盖分');
  if (app.indexOf('MB.qualityOf(k, fresh)') < 0) bad.push('app.js 实时层未用 qualityOf');
  if (typeof MB.qualityOf !== 'function') bad.push('lib.js 导出的 qualityOf 不是函数');
  if (app.indexOf("rejected.indexOf('astock')") < 0) bad.push('雷达未与盘面联动保留');
  const fsjs = fs.readFileSync(path.join(__dirname, 'fetch-sources.js'), 'utf8');
  if (fsjs.indexOf('MB.qualityOf(k, fresh)') < 0) bad.push('抓取器未用同一判据');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
/* 渲染层引用的每个 MB.utils.* 必须真的存在。
   踩过：把 qualityOf 写成 U.qualityOf（它挂在 MB 根上而非 utils 上），抛错又被 refresh 的
   try/catch 吞掉 —— 构建全绿、浏览器回归仍是「页面异常 = 无」，实则整套实时拉取已失效。
   文字判据查不出「符号写错对象」，故改成逐符号存在性校验。 */
checks.push(['app.js 引用的 MB.utils.* 逐一存在', (() => {
  /* 先剥掉注释再扫：注释会被内联进产物，且注释里复述踩坑记录是常态，
     拿它当判据会误报（本项目因此 FAIL 过两次） */
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const used = Array.from(new Set((code.match(/U\.([A-Za-z_$][\w$]*)/g) || []).map((s) => s.slice(2))));
  const missing = used.filter((k) => typeof MB.utils[k] === 'undefined');
  return missing.length ? 'FAIL 不存在的成员：' + missing.join(',') : true;
})()]);
/* 主域名整段拦截时的同族备用域名兜底。
   踩过：push2 整体不可达时「涨跌家数 / 成交额」随之变空（页面显示 —%），而退避重试跨不过十几秒的失败簇；
   同族 push2delay 同时刻仍返回 200 + ACAO:*，字段面一致 —— 只换主机名即可恢复，不动路径与字段。 */
checks.push(['同族备用域名兜底（抓取器 + 实时层都已接）', (() => {
  const bad = [];
  if (typeof MB.altUrls !== 'function') bad.push('lib.js 未导出 altUrls');
  const cands = MB.altUrls('https://push2.eastmoney.com/api/qt/ulist.np/get?x=1');
  if (cands.length !== 2) bad.push('push2 未映射到备用域名（候选数 ' + cands.length + '）');
  else if (cands[1].indexOf('push2delay.eastmoney.com') < 0) bad.push('备用域名不是 push2delay');
  if (MB.altUrls('https://aihot.virxact.com/api/v1/items?window=7d').length !== 1) bad.push('非东财源不该被改主机名');
  const fsjs = fs.readFileSync(path.join(__dirname, 'fetch-sources.js'), 'utf8');
  if (fsjs.indexOf('MB.altUrls(url)') < 0) bad.push('抓取器未接兜底');
  if (app.indexOf('MB.altUrls(url)') < 0) bad.push('实时层未接兜底');
  return bad.length ? 'FAIL ' + bad.join('；') : true;
})()]);
log.push('  自检:');
checks.forEach((c) => log.push('    ' + (c[1] === true ? '✅' : '❌') + ' ' + c[0] + (c[1] === true ? '' : ' → ' + c[1])));

/* 自检不能只是打印：任何一项未通过都以非零退出。否则 CI 里的 ❌ 会被静默吞掉
   （部署流程只认退出码），本地人工构建也会以为「构建成功」。 */
const failedChecks = checks.filter((c) => c[1] !== true);
log.push('');
log.push(failedChecks.length
  ? 'FAIL ' + failedChecks.length + '/' + checks.length + ' 项自检未通过'
  : 'PASS 全部 ' + checks.length + ' 项自检通过');
if (failedChecks.length) process.exitCode = 1;

fs.writeFileSync(path.join(__dirname, '_last-build.txt'), log.join('\n'), 'utf8');
console.log(log.join('\n'));
