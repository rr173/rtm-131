#!/usr/bin/env python3
"""验证两个 bug 修复：
1. 服务启动时不冒恢复事件
2. 目标离线后新激活的巡检任务自动暂停
"""
import json
import urllib.request
import urllib.parse
import time

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

print("=" * 70)
print("[测试1] 启动后不冒恢复事件 - 检查离线事件")
evts = get("/api/offline-events")
print(f"  当前离线事件总数: {evts['count']}")
if evts['count'] == 0:
    print("  ✅ 正确：启动时没有产生恢复事件")
else:
    print(f"  ⚠️  有 {evts['count']} 条事件，检查是否都是启动前产生的")
    for e in evts['events'][:5]:
        print(f"    #{e['id']} {e['event_type']} target={e['target_id']}")

print()
print("[测试2] 静默 T001 让它离线")
post("/api/targets/T001/silence")
print("  已静默 T001，等待 35 秒让它离线（全局阈值30秒 + 扫描5秒）...")
for i in range(35, 0, -5):
    time.sleep(5)
    print(f"    还剩 {i-5} 秒...")

print()
print("  T001 状态检查:")
t001 = [t for t in get("/api/targets") if t['id'] == 'T001'][0]
print(f"    status={t001['online_status']}, offline={t001['offline_duration_text']}")
assert t001['online_status'] == 'offline', "T001 应该已离线！"
print("  ✅ T001 已离线")

print()
print("[测试3] T001 离线状态下创建并立即激活巡检任务")
now = int(time.time() * 1000)
task = post("/api/patrol-tasks", {
    "task_name": "Bugfix-Test-T001-离线任务",
    "target_id": "T001",
    "target_name": "车辆A-001",
    "frequency": "once",
    "planned_start_time": now,
    "deadline_time": now + 60 * 1000,
    "fence_ids": [1, 2]
})
print(f"  任务已创建: #{task['id']} {task['task_name']}")
print(f"  任务状态: {task['status']}")

print()
print("  等待 3 秒让调度器激活任务...")
time.sleep(3)

print()
print("[测试4] 检查任务进度是否已暂停")
progress = get(f"/api/patrol-tasks/{task['id']}/progress")
print(f"  任务 #{task['id']} 进度:")
print(f"    status={progress['status']}")
print(f"    is_paused={progress.get('is_paused')}")
print(f"    pause_reason={progress.get('pause_reason')}")
print(f"    elapsed_seconds={progress['elapsed_seconds']}")
print(f"    remaining_seconds={progress['remaining_seconds']}")
print(f"    accumulated_pause_seconds={progress.get('accumulated_pause_seconds')}")
print(f"    current_pause_seconds={progress.get('current_pause_seconds')}")

if progress.get('is_paused') and progress.get('current_pause_seconds', 0) > 0:
    print("  ✅ 正确：新激活的任务已自动暂停，current_pause_seconds > 0")
else:
    print("  ❌ 错误：任务没有被暂停！")

print()
print("[测试5] 保持 T001 离线，等待任务原本应该逾期（60秒截止），验证不会逾期")
print("  任务实际 deadline_time:", progress['deadline_time'])
print("  等待 15 秒后再检查 remaining_seconds 是否还在正常范围...")
for i in range(15, 0, -5):
    time.sleep(5)
    print(f"    还剩 {i-5} 秒...")

progress2 = get(f"/api/patrol-tasks/{task['id']}/progress")
print()
print("  15 秒后检查:")
print(f"    status={progress2['status']} (预期仍是 active, 不是 overdue)")
print(f"    is_paused={progress2.get('is_paused')}")
print(f"    elapsed_seconds={progress2['elapsed_seconds']} (预期仍接近 0，因为离线暂停了)")
print(f"    remaining_seconds={progress2['remaining_seconds']} (预期仍接近 60)")
print(f"    accumulated_pause_seconds={progress2.get('accumulated_pause_seconds')}")
print(f"    current_pause_seconds={progress2.get('current_pause_seconds')} (预期约 18 秒)")

if progress2['status'] == 'active' and progress2['elapsed_seconds'] < 3 and progress2['current_pause_seconds'] > 15:
    print("  ✅ 正确：elapsed 几乎没走，current_pause 持续累积，任务没判逾期")
elif progress2['status'] == 'overdue':
    print("  ❌ 错误：任务被判逾期了！离线暂停计时没生效！")
else:
    print("  ⚠️  部分正确，状态:", progress2['status'])

print()
print("[测试6] 恢复 T001 上报，验证任务恢复计时")
post("/api/targets/T001/resume")
print("  已恢复 T001，等待 5 秒让心跳恢复...")
time.sleep(5)

progress3 = get(f"/api/patrol-tasks/{task['id']}/progress")
print()
print("  恢复后检查:")
print(f"    status={progress3['status']}")
print(f"    is_paused={progress3.get('is_paused')} (预期 False)")
print(f"    elapsed_seconds={progress3['elapsed_seconds']}")
print(f"    accumulated_pause_seconds={progress3.get('accumulated_pause_seconds')} (预期约 18~23 秒)")

if not progress3.get('is_paused', True) and progress3['elapsed_seconds'] < 5:
    print("  ✅ 正确：恢复后任务继续计时，elapsed 从 0 开始走")
else:
    print("  ⚠️  恢复后状态检查:", "is_paused=", progress3.get('is_paused'))

print()
print("=" * 70)
print("[Bugfix 测试完成]")
