#!/usr/bin/env python3
"""快速验证 bug 修复（用 T003 10秒超时）"""
import json
import urllib.request
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
print("[测试1] 启动时无恢复事件")
evts = get("/api/offline-events")
print(f"  事件总数: {evts['count']}, 预期: 0  ✅" if evts['count'] == 0 else f"  ⚠️  有 {evts['count']} 条事件")

# 先看预置的待激活任务
tasks = get("/api/patrol-tasks")
pending = [t for t in tasks if t['status'] == 'pending']
print(f"\n  预置待激活任务: {len(pending)} 个")
for t in pending:
    print(f"    #{t['id']} {t['task_name']}, target={t['target_id']}")

print()
print("[测试2] 静默 T003，等 16 秒离线（10s超时 + 5s扫描 + 1s冗余）")
post("/api/targets/T003/silence")
print("  已静默 T003, 等待...")
time.sleep(16)

t003 = [t for t in get("/api/targets") if t['id'] == 'T003'][0]
print(f"  T003 状态: {t003['online_status']}, 离线时长: {t003['offline_duration_text']}")
assert t003['online_status'] == 'offline', "T003 应该已离线！"
print("  ✅ T003 已离线")

print()
print("[测试3] T003 已离线，现在创建 30 秒截止的巡检任务")
now = int(time.time() * 1000)
task = post("/api/patrol-tasks", {
    "task_name": "Bugfix-Test-离线激活",
    "target_id": "T003",
    "target_name": "车辆C-003",
    "frequency": "once",
    "planned_start_time": now,
    "deadline_time": now + 30 * 1000,
    "fence_ids": [1, 2]
})
print(f"  任务 #{task['id']} 已创建，等待调度器激活...")
time.sleep(4)

progress = get(f"/api/patrol-tasks/{task['id']}/progress")
print(f"\n  任务状态: {progress['status']}")
print(f"  is_paused: {progress.get('is_paused')}")
print(f"  pause_reason: {progress.get('pause_reason')}")
print(f"  elapsed: {progress['elapsed_seconds']}s (预期接近0)")
print(f"  remaining: {progress['remaining_seconds']}s (预期接近30)")
print(f"  current_pause: {progress.get('current_pause_seconds')}s (预期 > 0)")

ok1 = progress.get('is_paused') and progress.get('current_pause_seconds', 0) > 0
ok2 = progress['elapsed_seconds'] < 2
print("\n  ✅ 新激活任务自动暂停" if ok1 and ok2 else "  ❌ 失败！")

print()
print("[测试4] 保持离线 8 秒，验证不会判逾期（30秒截止，实际才过12秒但暂停了）")
time.sleep(8)
progress2 = get(f"/api/patrol-tasks/{task['id']}/progress")
print(f"  status: {progress2['status']} (预期 active, 不是 overdue)")
print(f"  elapsed: {progress2['elapsed_seconds']}s (预期仍<2)")
print(f"  current_pause: {progress2['current_pause_seconds']}s (预期 > 10)")

ok3 = progress2['status'] == 'active'
ok4 = progress2['elapsed_seconds'] < 2 and progress2['current_pause_seconds'] > 10
print("  ✅ 任务未逾期，计时暂停有效" if ok3 and ok4 else "  ❌ 任务逾期或计时未暂停！")

print()
print("[测试5] 恢复 T003，验证任务恢复计时")
post("/api/targets/T003/resume")
time.sleep(4)
progress3 = get(f"/api/patrol-tasks/{task['id']}/progress")
print(f"  status: {progress3['status']}")
print(f"  is_paused: {progress3.get('is_paused')} (预期 False)")
print(f"  elapsed: {progress3['elapsed_seconds']}s (预期 < 5, 重新走)")
print(f"  accumulated_pause: {progress3.get('accumulated_pause_seconds')}s (预期 ~ 16)")

ok5 = not progress3.get('is_paused', True) and progress3['elapsed_seconds'] < 5
print("  ✅ 恢复后任务继续计时" if ok5 else "  ⚠️  未恢复")

print()
print("=" * 70)
all_ok = ok1 and ok2 and ok3 and ok4 and ok5 and evts['count'] == 0
print("[全部修复验证通过]" if all_ok else "[存在未修复问题]")
