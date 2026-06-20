#!/usr/bin/env python3
import json
import urllib.request
import time
import sys

BASE = "http://localhost:3000"

def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return json.loads(r.read())

def post(path, data=None):
    req = urllib.request.Request(BASE + path, method="POST")
    if data is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode()
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def put(path, data=None):
    req = urllib.request.Request(BASE + path, method="PUT")
    if data is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode()
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def print_targets():
    print("  目标状态:")
    for t in get("/api/targets"):
        off = t.get('offline_duration_text', '0秒')
        lra = t.get('last_report_seconds_ago', '-')
        print(f"    {t['id']:5s} | status={t['online_status']:7s} | "
              f"timeout={t['timeout_seconds']:2d}s | silenced={str(t['silenced']):5s} | "
              f"offline={off:8s} | last_report={lra}s ago")

# 1. 初始状态
print("=" * 70)
print("[1] 初始状态（全部目标应在线）")
print_targets()

# 2. 检查超时阈值配置
print()
print("[2] 超时阈值配置")
cfg = get("/api/heartbeat/timeout")
print(f"  全局默认: {cfg['default_timeout_seconds']}s")
for tid, info in cfg['per_target'].items():
    print(f"  单独配置 {tid}: {info['timeout_seconds']}s")

# 3. 静默 T003
print()
print("[3] 静默 T003，模拟设备掉线")
res = post("/api/targets/T003/silence")
print(f"  结果: silenced={res['silenced']}, target={res['target_name']}")

# 4. 等离线（T003 10秒超时 + 扫描5秒 = 最多15秒触发）
print()
print("[4] 等待 16 秒，让心跳扫描判 T003 离线...")
for i in range(16, 0, -4):
    time.sleep(4)
    print(f"    还剩 {i-4} 秒...")
time.sleep(0.5)

# 5. 检查离线状态
print()
print("[5] T003 应已离线")
print_targets()

# 6. 离线事件历史
print()
print("[6] T003 离线事件历史")
evts = get("/api/offline-events?target_id=T003")
print(f"  共 {evts['count']} 条:")
for e in evts['events']:
    tlabel = '离线' if e['event_type'] == 'offline' else '恢复'
    dur = f", 时长={e['offline_duration_ms']//1000}s" if e['offline_duration_ms'] else ""
    pos = f"({e['last_lng']:.4f},{e['last_lat']:.4f})" if e['last_lng'] is not None else "-"
    print(f"    [{tlabel}] #{e['id']} last_pos={pos}{dur}")

# 7. 恢复 T003
print()
print("[7] 调用 resume 恢复 T003 上报")
res = post("/api/targets/T003/resume")
print(f"  结果: silenced={res['silenced']}, was_silent={res['was_silent']}")
time.sleep(3)

# 8. 检查恢复
print()
print("[8] 恢复后状态（T003 应重新 online）")
print_targets()

# 9. 离线统计
print()
print("[9] T003 累计离线统计")
s = get("/api/offline-stats/T003")['memory_stats']
print(f"  累计离线次数: {s['total_offline_count']}")
print(f"  总离线时长: {s['total_offline_text']}")
print(f"  最长单次: {s['longest_single_offline_text']}")
if s['latest_offline_start_at']:
    print(f"  最近一次:  时长={s['latest_offline_duration_text']}")

# 10. 完整事件（离线+恢复）
print()
print("[10] 完整事件（离线+恢复）")
evts = get("/api/offline-events?target_id=T003")
print(f"  共 {evts['count']} 条:")
for e in evts['events']:
    tlabel = '离线' if e['event_type'] == 'offline' else '恢复'
    dur = f", 时长={e['offline_duration_ms']//1000}s" if e['offline_duration_ms'] else ""
    pos = f"({e['last_lng']:.4f},{e['last_lat']:.4f})" if e['last_lng'] is not None else "-"
    rpos = f"->({e['recover_lng']:.4f},{e['recover_lat']:.4f})" if e['recover_lng'] is not None else ""
    print(f"    [{tlabel}] #{e['id']} {pos}{rpos}{dur}")

# 11. 再验证全局状态
print()
print("[11] 全局系统状态")
status = get("/api/status")
print(f"  目标分布: online={status['target_status_breakdown']['online']}, "
      f"offline={status['target_status_breakdown']['offline']}, "
      f"unknown={status['target_status_breakdown']['unknown']}")
print(f"  静默目标数: {status['silenced_targets']}")
print(f"  心跳扫描运行: {status['heartbeat_scanner_running']}")

print()
print("=" * 70)
print("[全部测试完成]")
