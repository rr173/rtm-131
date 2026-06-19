const presetFences = [
  {
    name: '禁入区-军事管理区',
    type: 'forbidden_enter',
    color: '#e74c3c',
    vertices: [
      { lng: 116.30, lat: 39.70 },
      { lng: 116.50, lat: 39.70 },
      { lng: 116.55, lat: 39.85 },
      { lng: 116.40, lat: 39.92 },
      { lng: 116.25, lat: 39.85 }
    ]
  },
  {
    name: '禁出区-安全保护区',
    type: 'forbidden_leave',
    color: '#f39c12',
    vertices: [
      { lng: 116.45, lat: 39.80 },
      { lng: 116.65, lat: 39.80 },
      { lng: 116.68, lat: 39.95 },
      { lng: 116.50, lat: 40.00 },
      { lng: 116.40, lat: 39.92 }
    ]
  },
  {
    name: '普通区-监控区域',
    type: 'normal',
    color: '#3498db',
    vertices: [
      { lng: 116.20, lat: 39.85 },
      { lng: 116.42, lat: 39.85 },
      { lng: 116.48, lat: 40.00 },
      { lng: 116.28, lat: 40.08 },
      { lng: 116.15, lat: 39.98 }
    ]
  }
];

const presetPOIs = [
  { name: '起点站', lng: 116.15, lat: 39.60, color: '#27ae60' },
  { name: '中转站A', lng: 116.40, lat: 39.85, color: '#9b59b6' },
  { name: '终点站', lng: 116.75, lat: 40.10, color: '#e67e22' },
  { name: '观测点1', lng: 116.30, lat: 40.00, color: '#1abc9c' },
  { name: '观测点2', lng: 116.60, lat: 39.70, color: '#34495e' }
];

const presetGroups = [
  { name: '货运车队', color: '#e74c3c', description: '货运车辆分组，负责物资运输', default_level: 'warning' },
  { name: '巡逻车辆', color: '#3498db', description: '巡逻车辆分组，负责区域巡逻', default_level: 'info' },
  { name: 'VIP车辆', color: '#f1c40f', description: 'VIP车辆分组，重要人员接送', default_level: 'critical' }
];

const presetBindings = [
  { target_id: 'T001', group_name: '货运车队' },
  { target_id: 'T002', group_name: '巡逻车辆' },
  { target_id: 'T003', group_name: 'VIP车辆' },
  { target_id: 'T004', group_name: '货运车队' },
  { target_id: 'T005', group_name: '巡逻车辆' }
];

async function initPresetData(FenceModel, POIModel, TargetGroupModel, TargetBindingModel, FenceTimeWindowModel, FenceAlertRuleModel, FenceActionModel) {
  const existingFences = await FenceModel.getAll();
  let fenceMap = new Map();
  if (existingFences.length === 0) {
    for (const fence of presetFences) {
      const created = await FenceModel.create(fence);
      fenceMap.set(fence.name, created);
    }
    console.log('[Preset] 已创建3个演示围栏');
  } else {
    existingFences.forEach(f => fenceMap.set(f.name, f));
  }

  const existingPOIs = await POIModel.getAll();
  if (existingPOIs.length === 0) {
    for (const poi of presetPOIs) {
      await POIModel.create(poi);
    }
    console.log('[Preset] 已创建5个演示POI');
  }

  const existingGroups = await TargetGroupModel.getAll();
  let groupMap = new Map();
  if (existingGroups.length === 0) {
    for (const group of presetGroups) {
      const created = await TargetGroupModel.create(group);
      groupMap.set(group.name, created);
    }
    console.log('[Preset] 已创建3个目标分组');
  } else {
    existingGroups.forEach(g => groupMap.set(g.name, g));
  }

  const existingBindings = await TargetBindingModel.getAllBindings();
  if (existingBindings.length === 0) {
    for (const binding of presetBindings) {
      const group = groupMap.get(binding.group_name);
      if (group) {
        await TargetBindingModel.bind(binding.target_id, group.id);
      }
    }
    console.log('[Preset] 已绑定5个目标到分组');
  }

  const forbiddenEnterFence = fenceMap.get('禁入区-军事管理区');
  const normalFence = fenceMap.get('普通区-监控区域');
  const forbiddenLeaveFence = fenceMap.get('禁出区-安全保护区');
  const freightGroup = groupMap.get('货运车队');
  const vipGroup = groupMap.get('VIP车辆');

  if (forbiddenEnterFence) {
    const existingTW = await FenceTimeWindowModel.getByFenceId(forbiddenEnterFence.id);
    if (!existingTW) {
      await FenceTimeWindowModel.set(forbiddenEnterFence.id, {
        mode: 'weekday_time',
        start_time: '07:00',
        end_time: '19:00',
        weekdays: [1, 2, 3, 4, 5]
      });
      console.log('[Preset] 已为禁入区围栏设置工作日7:00-19:00生效时间窗口');
    }

    const existingRules = await FenceAlertRuleModel.getByFenceId(forbiddenEnterFence.id);
    if (existingRules.length === 0) {
      if (vipGroup) {
        await FenceAlertRuleModel.create({
          fence_id: forbiddenEnterFence.id,
          group_id: String(vipGroup.id),
          enter_level: 'info',
          leave_level: 'none',
          message_template: 'VIP车辆{target_name}于{time}进入围栏{fence_name}，请注意接待'
        });
      }
      if (freightGroup) {
        await FenceAlertRuleModel.create({
          fence_id: forbiddenEnterFence.id,
          group_id: String(freightGroup.id),
          enter_level: 'critical',
          leave_level: 'warning',
          message_template: '警告：货运车辆{target_name}于{time}非法进入禁入区{fence_name}！'
        });
      }
      await FenceAlertRuleModel.create({
        fence_id: forbiddenEnterFence.id,
        group_id: 'default',
        enter_level: 'warning',
        leave_level: 'info',
        message_template: '目标{target_name}于{time}{event_type}围栏{fence_name}'
      });
      console.log('[Preset] 已为禁入区围栏配置差异化告警规则');
    }
  }

  if (normalFence && forbiddenLeaveFence) {
    const existingActions = await FenceActionModel.getByFenceId(normalFence.id);
    if (existingActions.length === 0) {
      await FenceActionModel.create({
        fence_id: normalFence.id,
        action_type: 'fence_activate',
        trigger_condition: 'enter',
        target_group_id: 'all',
        action_config: {
          target_fence_id: forbiddenLeaveFence.id,
          activate: true,
          propagate_events: false
        }
      });
      console.log('[Preset] 已为普通区围栏配置fence_activate联动动作');
    }
  }
}

module.exports = {
  initPresetData,
  presetFences,
  presetPOIs,
  presetGroups,
  presetBindings
};
