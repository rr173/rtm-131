const { DutyScheduleModel, WorkOrderModel, WorkOrderEscalationModel } = require('./database');

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ESCALATIONS = 3;

class WorkOrderEngine {
  constructor(onWorkOrderUpdate) {
    this.onWorkOrderUpdate = onWorkOrderUpdate;
    this.escalationTimer = null;
  }

  async createWorkOrderFromAlert(alert) {
    if (!alert || !alert.level) return null;
    if (alert.level !== 'critical' && alert.level !== 'warning') return null;

    const existing = await WorkOrderModel.getByAlertId(alert.id);
    if (existing) return existing;

    const schedules = await DutyScheduleModel.getByFenceIdsAndTime([alert.fence_id]);

    let assignedOfficer = null;
    let assignedContact = null;
    let status = 'unattended';
    let priorityLevel = 0;

    if (schedules.length > 0) {
      const top = schedules[0];
      assignedOfficer = top.officer_name;
      assignedContact = top.contact;
      status = 'pending';
      priorityLevel = top.priority;
    }

    const alertTimestamp = alert.timestamp || Date.now();

    const workOrder = await WorkOrderModel.create({
      alert_id: alert.id,
      target_id: alert.target_id,
      target_name: alert.target_name,
      fence_id: alert.fence_id,
      fence_name: alert.fence_name,
      event_type: alert.event_type,
      level: alert.level,
      lng: alert.lng,
      lat: alert.lat,
      alert_timestamp: alertTimestamp,
      assigned_officer: assignedOfficer,
      assigned_contact: assignedContact,
      status: status,
      priority_level: priorityLevel,
      escalation_count: 0,
      created_at: Date.now(),
      last_assigned_at: Date.now()
    });

    console.log(`[WorkOrder] 工单 #${workOrder.id} 已创建: 告警#${alert.id}, 值班人: ${assignedOfficer || '无人'}, 状态: ${status}`);

    this._notifyUpdate(workOrder, 'created');
    return workOrder;
  }

  async claimWorkOrder(workOrderId, officerName) {
    const order = await WorkOrderModel.getById(workOrderId);
    if (!order) throw new Error('工单不存在');
    if (order.status === 'resolved' || order.status === 'closed' || order.status === 'unattended') {
      throw new Error(`当前状态 ${order.status} 无法认领`);
    }
    if (order.assigned_officer && order.assigned_officer !== officerName) {
      throw new Error('该工单分配给其他人，您无法认领');
    }
    if (order.claimed_at) {
      throw new Error('该工单已被认领');
    }
    if (!order.assigned_officer) {
      throw new Error('该工单无人值班，无法认领');
    }

    const updated = await WorkOrderModel.update(workOrderId, {
      status: 'claimed',
      claimed_at: Date.now()
    });

    console.log(`[WorkOrder] 工单 #${workOrderId} 已被 ${officerName} 认领`);
    this._notifyUpdate(updated, 'claimed');
    return updated;
  }

  async startProcessing(workOrderId, officerName) {
    const order = await WorkOrderModel.getById(workOrderId);
    if (!order) throw new Error('工单不存在');
    if (order.status !== 'claimed') throw new Error('只有已认领的工单才能开始处理');
    if (order.assigned_officer !== officerName) throw new Error('该工单不属于您');

    const updated = await WorkOrderModel.update(workOrderId, {
      status: 'processing',
      processing_at: Date.now()
    });

    console.log(`[WorkOrder] 工单 #${workOrderId} 开始处理`);
    this._notifyUpdate(updated, 'processing');
    return updated;
  }

  async resolveWorkOrder(workOrderId, officerName, resolutionNote) {
    const order = await WorkOrderModel.getById(workOrderId);
    if (!order) throw new Error('工单不存在');
    if (order.status !== 'processing') {
      throw new Error('只有处理中的工单才能关闭，请先开始处理');
    }
    if (order.assigned_officer !== officerName) throw new Error('该工单不属于您');
    if (!resolutionNote || !resolutionNote.trim()) throw new Error('必须填写处理备注');

    const now = Date.now();
    const updated = await WorkOrderModel.update(workOrderId, {
      status: 'resolved',
      resolved_at: now,
      closed_at: now,
      resolution_note: resolutionNote.trim()
    });

    console.log(`[WorkOrder] 工单 #${workOrderId} 已关闭`);
    this._notifyUpdate(updated, 'resolved');
    return updated;
  }

  async getWorkOrderLifecycle(workOrderId) {
    const order = await WorkOrderModel.getById(workOrderId);
    if (!order) return null;
    const escalations = await WorkOrderEscalationModel.getByWorkOrderId(workOrderId);
    return {
      work_order: order,
      escalation_history: escalations
    };
  }

  async _escalateWorkOrder(workOrderId) {
    const order = await WorkOrderModel.getById(workOrderId);
    if (!order) return null;
    if (order.status === 'resolved' || order.status === 'unattended' || order.claimed_at) return order;
    if (order.escalation_count >= MAX_ESCALATIONS) {
      return await WorkOrderModel.update(workOrderId, { status: 'unattended' });
    }

    const schedules = await DutyScheduleModel.getByFenceIdsAndTime([order.fence_id]);
    if (schedules.length === 0) {
      const updated = await WorkOrderModel.update(workOrderId, { status: 'unattended' });
      await WorkOrderEscalationModel.create({
        work_order_id: workOrderId,
        from_officer: order.assigned_officer,
        to_officer: null,
        to_contact: null,
        escalation_time: Date.now(),
        reason: '无可用值班人'
      });
      this._notifyUpdate(updated, 'escalated');
      return updated;
    }

    const currentPriority = order.priority_level;
    const currentOfficer = order.assigned_officer;

    let nextSchedule = null;
    if (order.escalation_count === 0 && schedules.length > 0) {
      nextSchedule = schedules.find(s => s.priority < currentPriority) || schedules[0];
    } else {
      const higherOrEqual = schedules.filter(s => s.priority <= currentPriority && s.officer_name !== currentOfficer);
      nextSchedule = higherOrEqual.length > 0 ? higherOrEqual[0] : (schedules[0].officer_name !== currentOfficer ? schedules[0] : null);
    }

    if (!nextSchedule) {
      const updated = await WorkOrderModel.update(workOrderId, { status: 'unattended' });
      await WorkOrderEscalationModel.create({
        work_order_id: workOrderId,
        from_officer: order.assigned_officer,
        to_officer: null,
        to_contact: null,
        escalation_time: Date.now(),
        reason: '无下一级值班人'
      });
      this._notifyUpdate(updated, 'escalated');
      return updated;
    }

    const newCount = order.escalation_count + 1;
    const now = Date.now();
    const updated = await WorkOrderModel.update(workOrderId, {
      assigned_officer: nextSchedule.officer_name,
      assigned_contact: nextSchedule.contact,
      status: newCount >= MAX_ESCALATIONS ? 'unattended' : 'pending',
      priority_level: nextSchedule.priority,
      escalation_count: newCount,
      last_assigned_at: now
    });

    await WorkOrderEscalationModel.create({
      work_order_id: workOrderId,
      from_officer: currentOfficer,
      to_officer: nextSchedule.officer_name,
      to_contact: nextSchedule.contact,
      escalation_time: Date.now(),
      reason: `超时升级(第${newCount}次)`
    });

    console.log(`[WorkOrder] 工单 #${workOrderId} 已升级: ${currentOfficer} → ${nextSchedule.officer_name} (第${newCount}次)`);
    this._notifyUpdate(updated, 'escalated');
    return updated;
  }

  async checkAndEscalate() {
    const pending = await WorkOrderModel.getPendingOlderThan(CLAIM_TIMEOUT_MS);
    for (const order of pending) {
      try {
        const assignedAt = order.last_assigned_at || order.created_at;
        const age = Date.now() - assignedAt;
        if (age >= CLAIM_TIMEOUT_MS && !order.claimed_at) {
          await this._escalateWorkOrder(order.id);
        }
      } catch (err) {
        console.error(`[WorkOrder] 升级工单 #${order.id} 失败:`, err.message);
      }
    }
  }

  startEscalationScanner(intervalMs = 30000) {
    if (this.escalationTimer) return;
    this.escalationTimer = setInterval(() => {
      this.checkAndEscalate().catch(err => {
        console.error('[WorkOrder] 升级扫描失败:', err);
      });
    }, intervalMs);
    console.log(`[WorkOrder] 升级扫描器已启动，间隔 ${intervalMs / 1000}秒`);
  }

  stopEscalationScanner() {
    if (this.escalationTimer) {
      clearInterval(this.escalationTimer);
      this.escalationTimer = null;
      console.log('[WorkOrder] 升级扫描器已停止');
    }
  }

  _notifyUpdate(workOrder, event) {
    if (this.onWorkOrderUpdate && workOrder) {
      try {
        this.onWorkOrderUpdate({
          event: event,
          work_order_id: workOrder.id,
          status: workOrder.status,
          assigned_officer: workOrder.assigned_officer,
          work_order: workOrder
        });
      } catch (err) {
        console.error('[WorkOrder] 通知更新失败:', err);
      }
    }
  }
}

module.exports = { WorkOrderEngine };
