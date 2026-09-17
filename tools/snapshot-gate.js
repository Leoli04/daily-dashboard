#!/usr/bin/env node
/**
 * 快照闸门（Node，零依赖）：判断「这份快照能不能上屏」，用退出码表达结论。
 *
 * 为什么需要它：
 *   tools/fetch-sources.js 对「个别源失败」是**非致命**的 —— 失败项记进
 *   payload.fetch.failures 后仍以 0 退出。CI 只看退出码会把残缺快照发布出去。
 *   这里不健康就 exit 1 → workflow 的 build job 失败 → deploy job 不执行 →
 *   Pages 继续供应上一次的好版本（宁旧勿残）。
 *
 * 用法：
 *   node tools/snapshot-gate.js                  # 检查 data/<今天>.json（按本地时区判定今天）
 *   node tools/snapshot-gate.js --date=2026-09-17
 */
const fs = require('fs');
const path = require('path');
const MB = require('../src/lib.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const dateArg = (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
const TODAY = dateArg || MB.utils.localDateStr();

const target = path.join(DATA_DIR, TODAY + '.json');

/* 真正持数据的 6 个版块。投影版块（astkday / ai7d）不单独入库，故不检查。
   质量判据复用页面实时层用的同一份 MB.qualityOf，避免两处各写一份判断标准。 */
const TABS = ['aihot', 'hk', 'news', 'hotlist', 'astock', 'radar'];

const bad = [];
const lines = [];

lines.push('快照    ' + path.relative(ROOT, target));

if (!fs.existsSync(target)) {
  bad.push('缺少当日快照（时区不对？或抓取没跑）');
} else {
  let snap = null;
  try {
    snap = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    bad.push('快照不是合法 JSON：' + e.message);
  }

  if (snap) {
    const fetchMeta = snap.fetch || {};
    const tabs = snap.tabs || {};
    const fails = fetchMeta.failures || [];
    const carried = fetchMeta.carried || [];

    lines.push('大小    ' + (fs.statSync(target).size / 1024).toFixed(1) + ' KB');
    lines.push('口径    today=' + (fetchMeta.today || '—')
      + '  tradeDate=' + (fetchMeta.tradeDate || '—'));

    if (fetchMeta.today && fetchMeta.today !== TODAY) {
      bad.push('快照内 today=' + fetchMeta.today + ' 与期望的 ' + TODAY + ' 不一致（TZ 没生效？）');
    }
    if (fails.length) {
      bad.push('抓取失败 ' + fails.length + ' 项：'
        + fails.map((f) => (f && (f.id || f.url)) || '?').join(', '));
    }

    TABS.forEach(function (k) {
      const q = MB.qualityOf(k, tabs[k]);
      lines.push('  ' + k.padEnd(8) + ' quality=' + String(q).padStart(4));
      if (!tabs[k]) bad.push('缺少版块载荷 ' + k);
      else if (!(q > 0)) bad.push('版块数据为空或质量不足 ' + k + '（quality=' + q + '）');
    });

    /* 沿用上一份快照说明本轮抓取不完整。CI 是全新 checkout、没有历史快照故不会发生；
       本地重跑时属正常行为，所以只提示不判失败。 */
    if (carried.length) lines.push('提示    有版块沿用了上一份快照：' + carried.join(' / '));
  }
}

console.log('=== snapshot-gate ===');
lines.forEach((l) => console.log(l));

if (bad.length) {
  console.log('FAIL ' + bad.length + ' 项：');
  bad.forEach((b) => console.log('  - ' + b));
  process.exitCode = 1;
} else {
  console.log('PASS  快照健康，可以发布');
}
