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

async function initPresetData(FenceModel, POIModel) {
  const existingFences = await FenceModel.getAll();
  if (existingFences.length === 0) {
    for (const fence of presetFences) {
      await FenceModel.create(fence);
    }
    console.log('[Preset] 已创建3个演示围栏');
  }
  const existingPOIs = await POIModel.getAll();
  if (existingPOIs.length === 0) {
    for (const poi of presetPOIs) {
      await POIModel.create(poi);
    }
    console.log('[Preset] 已创建5个演示POI');
  }
}

module.exports = {
  initPresetData,
  presetFences,
  presetPOIs
};
