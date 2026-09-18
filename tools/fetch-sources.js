#!/usr/bin/env node
/**
 * 每日资讯看板数据抓取器（Node，零依赖）
 *   - 按「运行日」幂等：dashboard/data/<YYYY-MM-DD>.json 已存在则跳过网络请求
 *   - 抓全部数据源 → 归一化 → 落盘
 *   - 人气榜逐日归档（周榜/趋势的时间序列）沉淀在 data/heat-archive.json，
 *     随仓库提交：Actions 全新 checkout 靠它续上序列，本地则另有历史快照兜底回填。
 * 用法：
 *   node tools/fetch-sources.js            # 今天，幂等
 *   node tools/fetch-sources.js --force    # 强制重抓
 *   node tools/fetch-sources.js --date=2026-09-16
 */
const fs = require('fs');
const path = require('path');
const MB = require('../src/lib.js');
const Radar = require('../src/radar.js');
const U = MB.utils;

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const dateArg = (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
const TODAY = dateArg || U.localDateStr();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const log = [];
function say(s) { log.push(s); }

/* 东财 CDN 会对同一来源成簇地重置连接（undici 报 fetch failed / UND_ERR_SOCKET，
   Node 原生 https 报 ECONNRESET）。已做过的对照实验结论（勿重复验证）：
     · 与 URL 长度无关 —— 1 个 secid 的短 URL 曾连续 6/6 失败，13 个 secid 的长 URL 曾 6/6 成功；
     · 与请求头无关 —— 加 Connection: close 后仍 1/5 失败；
     · 与连接复用无关 —— 失败簇内连续 4 次重连仍被重置（实测 hkQuotes 退避 4.2s 未救回）。
   即服务端行为，客户端无确定性解法，只能靠重试跨过失败窗口：实测失败簇可持续约 1 秒，
   退避总跨度 ~15s 足以覆盖。只重试**传输层**故障；HTTP 状态码与「响应不是 JSON」
   这类语义错误重试无意义，直接抛出。 */
const RETRY_BACKOFF = [0, 800, 2000, 4000, 8000];

function isTransportError(e) {
  const code = (e && e.cause && e.cause.code) || '';
  return e instanceof TypeError
    || /fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|EPIPE|aborted/i.test(e.message + ' ' + code);
}

async function getJsonOnce(url, headers) {
  let lastErr = null;
  for (let i = 0; i < RETRY_BACKOFF.length; i++) {
    if (RETRY_BACKOFF[i]) await new Promise((r) => setTimeout(r, RETRY_BACKOFF[i]));
    try {
      const res = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, headers || {}) });
      const buf = Buffer.from(await res.arrayBuffer());
      const txt = buf.toString('utf8');
      try { return JSON.parse(txt); }
      catch (e) { throw new Error('非 JSON 响应（' + res.status + '）：' + txt.slice(0, 120)); }
    } catch (e) {
      lastErr = e;
      if (!isTransportError(e)) throw e;
      say('  retry ' + (i + 1) + '/' + RETRY_BACKOFF.length + '  ' + String(url).slice(0, 70) + '  ← ' + e.message);
    }
  }
  throw lastErr;
}

/* 退避重试用尽后，再换「同族备用域名」试一次（如 push2 → push2delay）。
   主域名整段拦截时常可持续十几秒以上，仅靠退避跨不过去；同族域名往往仍可达，且字段面一致。 */
async function getJson(url, headers) {
  const cands = MB.altUrls(url);
  let lastErr = null;
  for (let i = 0; i < cands.length; i++) {
    try { return await getJsonOnce(cands[i], headers); }
    catch (e) {
      lastErr = e;
      if (!isTransportError(e)) throw e;          /* 语义错误换域名无意义 */
      if (i + 1 < cands.length) say('  host-fallback → ' + String(cands[i + 1].replace(/^https?:\/\//, '')).slice(0, 68));
    }
  }
  throw lastErr;
}

/** 回溯 n 个交易日（跳过周末） */
const backDates = U.backDates;

/* 人气榜逐日归档的种子：
   ① data/heat-archive.json（随仓库提交，Actions 全新 checkout 的唯一来源）；
   ② 本地历史快照 data/<date>.json 里的人气榜日榜（仅本机存在，用来兜底回填）。
   两者交给 MB.mergeHeatArchive 去重合并 —— 同日冲突时 ①（更"官方"的入库序列）优先。 */
function loadPrevArchive() {
  const out = [];
  const archFile = path.join(DATA_DIR, 'heat-archive.json');
  if (fs.existsSync(archFile)) {
    try {
      const a = JSON.parse(fs.readFileSync(archFile, 'utf8'));
      if (Array.isArray(a)) out.push(...a);
    } catch (e) { /* 坏文件则跳过，靠历史快照兜底 */ }
  }
  if (fs.existsSync(DATA_DIR)) {
    fs.readdirSync(DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().forEach((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        const day = j && j.tabs && j.tabs.hotlist && j.tabs.hotlist.segments
          && j.tabs.hotlist.segments.astock && j.tabs.hotlist.segments.astock.day;
        const d = (j && j.fetch && j.fetch.today) || f.replace(/\.json$/, '');
        if (Array.isArray(day) && day.length) out.push({ date: d, items: day });
      } catch (e) { /* 单个坏快照不影响整体 */ }
    });
  }
  return out;
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, TODAY + '.json');

  if (fs.existsSync(target) && !FORCE) {
    say('SKIP  当日快照已存在，不重新拉取：' + path.relative(ROOT, target));
    say('      （如需强制重抓，加 --force）');
    say('DONE  skipped');
    fs.writeFileSync(path.join(__dirname, '_last-run.txt'), log.join('\n'), 'utf8');
    console.log(log.join('\n'));
    return;
  }

  let ctx = {
    today: TODAY,
    tradeDate: TODAY,
    tradeDate8: TODAY.replace(/-/g, ''),
    baselineDates: [],
    baselineDate8: '',
    secid: '1.000001',
    builtAt: U.nowIso(),
    prevArchive: MB.mergeHeatArchive([], loadPrevArchive())
  };
  say('  人气榜归档种子：' + ctx.prevArchive.length + ' 个数据日'
    + (ctx.prevArchive.length ? '（' + ctx.prevArchive[0].date + ' — ' + ctx.prevArchive[ctx.prevArchive.length - 1].date + '）' : ''));

  const raw = {};
  const fails = [];

  async function runTasks(tasks) {
    for (const t of tasks) {
      const t0 = Date.now();
      try {
        const j = await getJson(t.url, t.headers);
        if (t.id === 'ztpoolHist') { (raw.ztpoolHist = raw.ztpoolHist || []).push({ date: t.date, response: j }); }
        else if (t.id === 'indexKline') { (raw.indexKline = raw.indexKline || []).push({ secid: t.secid, name: t.name, response: j }); }
        else raw[t.id] = j;
        say('  ok   ' + t.id + (t.date ? '[' + t.date + ']' : '') + (t.name ? '[' + t.name + ']' : '') + '  ' + (Date.now() - t0) + 'ms');
      } catch (e) {
        fails.push(t.id + (t.date ? '[' + t.date + ']' : '') + ': ' + e.message);
        say('  FAIL ' + t.id + (t.date ? '[' + t.date + ']' : '') + '  ' + e.message);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  say('=== 阶段 1：解析交易日');
  await runTasks(MB.buildTasks(ctx, 'node').filter((t) => t.phase === 1));

  const tradeDate = MB.pickTradeDate(raw.lhbRange) || TODAY;
  ctx.tradeDate = tradeDate;
  ctx.tradeDate8 = tradeDate.replace(/-/g, '');
  say('  解析出参考交易日 tradeDate = ' + tradeDate + (tradeDate === TODAY ? '（当日）' : '（今日非交易日或当日数据未出）'));

  ctx.baselineDates = backDates(tradeDate, 6);
  say('  基线日期（用于涨停家数分位）：' + ctx.baselineDates.join(', '));

  say('=== 阶段 2：抓取其余数据源');
  await runTasks(MB.buildTasks(ctx, 'node').filter((t) => t.phase === 2));

  /* 基线补位：节假日返回 0 条的日期会被过滤，向前回溯直到凑够 4 条有效基线 */
  let base = MB.collectBaseline(raw).filter((x) => x.count > 0);
  let cursor = ctx.baselineDates[ctx.baselineDates.length - 1] || tradeDate;
  let guard = 0;
  while (base.length < 4 && guard++ < 4) {
    ctx.baselineDates = backDates(cursor, 4);
    cursor = ctx.baselineDates[ctx.baselineDates.length - 1];
    say('  有效基线仅 ' + base.length + ' 条，继续回溯至 ' + ctx.baselineDates.join(', '));
    await runTasks(MB.buildTasks(ctx, 'node').filter((t) => t.id === 'ztpoolHist'));
    base = MB.collectBaseline(raw).filter((x) => x.count > 0);
  }
  ctx.baselineDates = base.map((x) => x.date);

  say('=== 归一化 + 组装');
  ctx.snapshotAt = U.nowIso();
  const payload = Radar.derive(raw, ctx);
  payload.fetch = { today: TODAY, tradeDate, baselineDates: ctx.baselineDates, failures: fails };

  /* 兜底：某些 CDN 会整段瞬时拦截（见文件头的实验结论），一次 --force 就足以把
     「已抓到的好数据」覆盖成空 —— 实测 13 个品种会掉到 0、行业数掉到 0、雷达分跟着失真。
     故按版块比对「数据量」（判据与页面实时层共用 MB.qualityOf，不各写一份），
     新数据更差时沿用上一份快照的那一块，并在日志与 fetch 元信息里如实标注（不静默）。 */
  function bestPrev() {
    if (fs.existsSync(target)) { try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { /* 坏文件则不兜底 */ } }
    const older = fs.readdirSync(DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    if (!older.length) return null;
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, older[older.length - 1]), 'utf8')); } catch (e) { return null; }
  }
  const prev = bestPrev();
  const carried = [];
  if (prev && prev.tabs) {
    ['aihot', 'astock', 'hotlist', 'hk', 'news'].forEach((k) => {
      const fresh = payload.tabs[k], old = prev.tabs[k];
      if (!fresh || !old) return;
      const q = MB.qualityOf(k, fresh), q0 = MB.qualityOf(k, old);
      if (q < q0) {
        payload.tabs[k] = old;
        carried.push(k + '（新 ' + q + ' < 旧 ' + q0 + '）');
      }
    });
  }
  /* A股两个版块被沿用后，雷达必须按**最终的** astock / hotlist 重算，否则分数与所展示的
     盘面数据对不上（曾出现「展示旧盘面 + 新雷达分」这种自相矛盾的组合）。 */
  if (carried.some((c) => /^astock|^hotlist/.test(c))) {
    const base2 = (payload.tabs.astock && payload.tabs.astock.baseline) || MB.collectBaseline(raw);
    payload.tabs.radar = Radar.computeRadar(payload.tabs.astock, payload.tabs.hotlist, base2);
    carried.push('radar（随 astock/hotlist 重算）');
  }
  payload.fetch.carried = carried;

  /* 人气榜逐日归档落盘（今天的日榜已由 derive 并入）。放在兜底之后：
     若 hotlist 被沿用为旧版快照，写进去的就是旧版那份归档 —— 与页面实际展示的口径一致。 */
  const archOut = payload.tabs.hotlist && payload.tabs.hotlist.heatArchive;
  if (archOut && archOut.length) {
    fs.writeFileSync(path.join(DATA_DIR, 'heat-archive.json'), JSON.stringify(archOut), 'utf8');
  }

  fs.writeFileSync(target, JSON.stringify(payload, null, 1), 'utf8');

  const kb = (fs.statSync(target).size / 1024).toFixed(1);
  say('WROTE ' + path.relative(ROOT, target) + '  (' + kb + ' KB)');
  say('  AI 日报      dataDate=' + payload.tabs.aihot.dataDate + '  条数=' + payload.tabs.aihot.total
    + '  ' + payload.tabs.aihot.counts.map((c) => c.label.split(' ')[0] + ':' + c.count).join(' '));
  say('  AI 近7日     ' + (payload.tabs.aihot.items7d || {}).total + ' 条  '
    + ((payload.tabs.aihot.items7d || {}).groups || []).map((g) => g.label + ':' + g.count).join(' ')
    + '  跨度 ' + (payload.tabs.aihot.items7d || {}).from + ' — ' + (payload.tabs.aihot.items7d || {}).to);
  say('  财经市场·市场情绪 tradeDate=' + payload.tabs.astock.tradeDate
    + '  龙虎榜=' + payload.tabs.astock.lhb.count + '家  涨停=' + payload.tabs.astock.breadth.limitUp
    + '  封板率=' + payload.tabs.astock.breadth.limitUpRate + '%  行业=' + payload.tabs.astock.industries.count);
  const hotSeg = payload.tabs.hotlist.segments.astock;
  const hotArch = payload.tabs.hotlist.heatArchive || [];
  const hotWeek = MB.buildWeekList(hotArch, 5);
  say('  人气榜       日榜=' + hotSeg.day.length + '  小时榜（不上屏，供雷达算热度集中度）=' + hotSeg.hour.length
    + '  归档=' + hotArch.length + ' 个数据日  周榜=' + hotWeek.entries.length + ' 只（近 ' + hotWeek.days + ' 日累计）');
  say('  财经市场·风险雷达 总体=' + payload.tabs.radar.overall + '（' + payload.tabs.radar.level + '）  '
    + payload.tabs.radar.metrics.map((m) => m.label + ':' + m.value).join(' '));
  say('  财经市场·今日要闻   ' + (payload.tabs.hk.quotes || []).filter((q) => q.price !== null).length + '/' + (payload.tabs.hk.quotes || []).length
    + ' 个品种有数据  恒指 ' + (payload.tabs.hk.quotes || []).map((q) => q.key === 'hsi' ? q.priceTxt + ' ' + q.chgTxt : null).filter(Boolean).join(''));
  say('  财经市场·当天快讯   ' + (payload.tabs.news.total || 0) + ' 条 / ' + (payload.tabs.news.date || '—')
    + '  ' + (payload.tabs.news.groups || []).map((g) => g.label + ':' + g.count).join(' '));
  say('  基线         ' + payload.tabs.astock.baseline.map((x) => x.date.slice(5) + '=' + x.count).join(' '));
  if (archOut && archOut.length) say('  归档落盘     data/heat-archive.json  ' + archOut.length + ' 个数据日');
  if (fails.length) { say('  失败项 ' + fails.length + ' 个：'); fails.forEach((f) => say('    - ' + f)); }
  else say('  失败项 0 个');
  if (carried.length) { say('  兜底沿用上一份快照：'); carried.forEach((c) => say('    - ' + c)); }
  say('DONE  fetched');

  fs.writeFileSync(path.join(__dirname, '_last-run.txt'), log.join('\n'), 'utf8');
  console.log(log.join('\n'));
})().catch((e) => {
  log.push('FATAL ' + e.message + '\n' + e.stack);
  try { fs.writeFileSync(path.join(__dirname, '_last-run.txt'), log.join('\n'), 'utf8'); } catch {}
  console.log(log.join('\n'));
  process.exitCode = 1;
});
