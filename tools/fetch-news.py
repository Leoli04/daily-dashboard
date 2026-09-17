# -*- coding: utf-8 -*-
"""抓取当天财经新闻（数据通道：neodata-financial-search）

幂等：dashboard/data/news-<DATE>.json 存在则跳过（--force 强制重抓）。

关键事实（实测得出，勿改）：
  1. query 必须显式带日期前缀，否则召回的是语义相关但陈旧的旧闻
     （实测「最新财经新闻」→ 0/8 当天；「2026-09-16 港股今日要闻」→ 8/8 当天）
  2. 凭证来自 neodata skill 的 .neodata_token 缓存（12 小时）；过期时脚本报
     TOKEN_EXPIRED，需由 Agent 调 connect_cloud_service 后 --save-token
  3. 端点不回 CORS 头，浏览器 file:// 无法直连 → 只能构建时抓取后内嵌快照

用法:
  python fetch-news.py [--date 2026-09-16] [--force] [--probe]
"""
import argparse
import datetime
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

ENDPOINT = "https://copilot.tencent.com/agenttool/v1/neodata"
ROOT = Path(__file__).resolve().parent.parent          # dashboard/
DATA_DIR = ROOT / "data"
TOKEN_FILE = Path.home() / ".workbuddy" / "skills" / ".neodata_token"

# skill 规定的五个维度，顺序即展示优先级。
# 每个维度可给多个 query，按序尝试直到命中当日新闻 —— 实测 query 措辞对召回影响极大：
#   「香港地产市场新闻」/「香港楼市新闻」→ 0 条；「香港房地产 政策 成交」→ 8/8 当日命中。
DIMENSIONS = [
    ("hk", "港股市场", ["{DATE} 港股今日要闻", "{DATE} 港股市场 恒生指数"]),
    ("global", "国际财经", ["{DATE} 国际财经新闻", "{DATE} 全球市场 美联储"]),
    ("cn", "内地财经", ["{DATE} 中国财经新闻", "{DATE} A股市场 政策"]),
    ("property", "地产市场", ["{DATE} 香港房地产 政策 成交", "{DATE} 房地产 楼市 新闻"]),
    ("market", "金融市场", ["{DATE} 金融市场大宗商品外汇新闻", "{DATE} 大宗商品 外汇 债券"]),
]


def load_token():
    try:
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "TOKEN_MISSING"
    except Exception as e:
        return None, "TOKEN_READ_ERR " + repr(e)
    if time.time() - data.get("saved_at", 0) > 12 * 3600:
        return None, "TOKEN_EXPIRED"
    return data.get("token", ""), None


def query(q, token, data_type="all", timeout=40):
    payload = {"query": q, "channel": "neodata", "sub_channel": "workbuddy"}
    if data_type != "all":
        payload["data_type"] = data_type
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return None, "HTTP %s %s" % (e.code, raw[:160])
    except Exception as e:
        return None, "EXC " + repr(e)


def extract(resp):
    """从 docData.docRecall[].docList[] 提取条目"""
    out = []
    d = (resp or {}).get("data") or {}
    for batch in (d.get("docData") or {}).get("docRecall") or []:
        for e in batch.get("docList") or []:
            out.append(e)
    return out


def day_of(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else ""


def norm_title(t):
    t = unicodedata.normalize("NFKC", str(t or ""))
    t = re.sub(r"[\s\u3000]+", "", t)
    t = re.sub(r"[|｜·:：,，。.、!！?？\-—–_（）()\[\]【】\"'“”‘’]+", "", t)
    return t


def dedupe(items):
    """URL 完全相同，或标题相似度>0.8 且发布时间差<30 分钟，视为同一条"""
    kept, dropped = [], []
    for it in items:
        dup = False
        for k in kept:
            if it["url"] and it["url"] == k["url"]:
                dup = True
                break
            same_time = abs(it["ts"] - k["ts"]) < 1800
            if same_time and it["titleNorm"] and k["titleNorm"]:
                if SequenceMatcher(None, it["titleNorm"], k["titleNorm"]).ratio() > 0.8:
                    dup = True
                    break
        if dup:
            dropped.append(it["title"])
        else:
            kept.append(it)
    return kept, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--probe", action="store_true", help="只抓不写，打印统计")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / ("news-%s.json" % args.date)

    if out_path.exists() and not args.force and not args.probe:
        print("SKIP  已存在 %s（--force 可强制重抓）" % out_path.name)
        return 0

    token, err = load_token()
    if err:
        print("ERROR %s：请先获取凭证并执行 query.py --save-token <凭证>" % err, file=sys.stderr)
        return 2

    all_items, stats = [], []
    for key, label, templates in DIMENSIONS:
        chosen, batch, today_n, err = None, [], 0, None
        for tpl in templates:
            q = tpl.replace("{DATE}", args.date)
            resp, qerr = query(q, token)
            if qerr:
                err = qerr
                continue
            cand = extract(resp)
            n = sum(1 for e in cand if day_of(e.get("publishTime")) == args.date)
            if n > 0:
                chosen, batch, today_n = q, cand, n
                break
            if not batch:                      # 记住最后一次结果，便于报告「为何为空」
                batch, today_n = cand, n
            time.sleep(1.5)
        if err and not batch:
            print("  %-8s 查询失败 %s" % (label, err), file=sys.stderr)
            stats.append({"key": key, "label": label, "query": templates[0].replace("{DATE}", args.date),
                          "count": 0, "today": 0, "error": err})
            continue
        for e in batch:
            day = day_of(e.get("publishTime"))
            all_items.append({
                "dim": key,
                "dimLabel": label,
                "title": str(e.get("title") or "").strip(),
                "content": str(e.get("content") or "").strip(),
                "ts": e.get("publishTime") or 0,
                "timeStr": str(e.get("publishTimeStr") or ""),
                "day": day,
                "url": str(e.get("url") or ""),
                "tag": str(e.get("tag") or ""),
                "titleNorm": norm_title(e.get("title")),
            })
        print("  %-8s 返回 %2d 条（当日 %d）  ← %s" % (label, len(batch), today_n, chosen or templates[-1]))
        stats.append({"key": key, "label": label, "query": chosen or "", "count": len(batch), "today": today_n})
        time.sleep(1.5)

    # 只保留当天，按时间倒序
    same_day = [x for x in all_items if x["day"] == args.date]
    same_day.sort(key=lambda x: x["ts"], reverse=True)
    kept, dropped = dedupe(same_day)

    payload = {
        "schemaVersion": 1,
        "date": args.date,
        "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "source": "neodata-financial-search",
        "stats": stats,
        "rawCount": len(all_items),
        "sameDayCount": len(same_day),
        "keptCount": len(kept),
        "dropped": dropped,
        "items": kept,
    }

    print("\n原始 %d 条 → 当日 %d 条 → 去重后 %d 条" % (len(all_items), len(same_day), len(kept)))

    if args.probe:
        print("（--probe 模式，未写入文件）")
        lens = sorted(len(x["content"]) for x in kept)
        if lens:
            print("正文长度: min=%d 中位=%d max=%d" % (lens[0], lens[len(lens) // 2], lens[-1]))
        for x in kept[:6]:
            print("  %s [%s] %s" % (x["timeStr"][11:16] or "??:??", x["dimLabel"], x["title"][:44]))
        return 0

    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print("WROTE %s (%.1f KB)" % (out_path.name, size_kb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
