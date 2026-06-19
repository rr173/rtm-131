const { TrajectoryModel, HeatmapModel } = require('./database');

const MAP_LNG_MIN = 116.0;
const MAP_LNG_MAX = 116.8;
const MAP_LAT_MIN = 39.5;
const MAP_LAT_MAX = 40.2;
const GRID_LNG_COUNT = 50;
const GRID_LAT_COUNT = 35;
const HEATMAP_WINDOW_MS = 60 * 60 * 1000;
const AGGREGATE_INTERVAL_MS = 60 * 1000;

class HeatmapManager {
  constructor(onHeatmapUpdate) {
    this.onHeatmapUpdate = onHeatmapUpdate;
    this.latestHeatmap = null;
    this.intervalId = null;
  }

  start() {
    if (this.intervalId) return;
    this.aggregateHeatmap();
    this.intervalId = setInterval(() => this.aggregateHeatmap(), AGGREGATE_INTERVAL_MS);
    console.log('[Heatmap] 热力聚合器已启动，每分钟聚合最近1小时数据');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async aggregateHeatmap() {
    const now = Date.now();
    const startTime = now - HEATMAP_WINDOW_MS;
    const points = await TrajectoryModel.query({
      start_time: startTime,
      end_time: now,
      limit: 100000
    });

    const gridData = this.computeGrid(points);
    const snapshot = {
      snapshot_time: now,
      grid_lng_count: GRID_LNG_COUNT,
      grid_lat_count: GRID_LAT_COUNT,
      lng_min: MAP_LNG_MIN,
      lng_max: MAP_LNG_MAX,
      lat_min: MAP_LAT_MIN,
      lat_max: MAP_LAT_MAX,
      grid_data: gridData
    };

    this.latestHeatmap = snapshot;

    HeatmapModel.saveSnapshot(snapshot).catch(console.error);

    if (this.onHeatmapUpdate) {
      this.onHeatmapUpdate(snapshot);
    }
    return snapshot;
  }

  computeGrid(points) {
    const grid = [];
    const lngStep = (MAP_LNG_MAX - MAP_LNG_MIN) / GRID_LNG_COUNT;
    const latStep = (MAP_LAT_MAX - MAP_LAT_MIN) / GRID_LAT_COUNT;

    for (let i = 0; i < GRID_LNG_COUNT; i++) {
      grid[i] = [];
      for (let j = 0; j < GRID_LAT_COUNT; j++) {
        grid[i][j] = 0;
      }
    }

    let maxValue = 0;
    points.forEach(p => {
      if (p.lng < MAP_LNG_MIN || p.lng >= MAP_LNG_MAX) return;
      if (p.lat < MAP_LAT_MIN || p.lat >= MAP_LAT_MAX) return;
      const i = Math.floor((p.lng - MAP_LNG_MIN) / lngStep);
      const j = Math.floor((p.lat - MAP_LAT_MIN) / latStep);
      if (i >= 0 && i < GRID_LNG_COUNT && j >= 0 && j < GRID_LAT_COUNT) {
        grid[i][j]++;
        if (grid[i][j] > maxValue) {
          maxValue = grid[i][j];
        }
      }
    });

    const result = [];
    for (let i = 0; i < GRID_LNG_COUNT; i++) {
      for (let j = 0; j < GRID_LAT_COUNT; j++) {
        if (grid[i][j] > 0) {
          result.push({
            grid_x: i,
            grid_y: j,
            value: grid[i][j]
          });
        }
      }
    }

    return {
      cells: result,
      max_value: maxValue,
      total_points: points.length
    };
  }

  getLatest() {
    return this.latestHeatmap;
  }

  async getLatestSnapshot() {
    if (this.latestHeatmap) return this.latestHeatmap;
    const latest = await HeatmapModel.getLatest();
    if (latest) {
      this.latestHeatmap = latest;
    }
    return latest;
  }

  lngToGridX(lng) {
    const lngStep = (MAP_LNG_MAX - MAP_LNG_MIN) / GRID_LNG_COUNT;
    return Math.floor((lng - MAP_LNG_MIN) / lngStep);
  }

  latToGridY(lat) {
    const latStep = (MAP_LAT_MAX - MAP_LAT_MIN) / GRID_LAT_COUNT;
    return Math.floor((lat - MAP_LAT_MIN) / latStep);
  }

  gridXToLng(gridX) {
    const lngStep = (MAP_LNG_MAX - MAP_LNG_MIN) / GRID_LNG_COUNT;
    return MAP_LNG_MIN + gridX * lngStep + lngStep / 2;
  }

  gridYToLat(gridY) {
    const latStep = (MAP_LAT_MAX - MAP_LAT_MIN) / GRID_LAT_COUNT;
    return MAP_LAT_MIN + gridY * latStep + latStep / 2;
  }
}

module.exports = {
  HeatmapManager,
  MAP_LNG_MIN,
  MAP_LNG_MAX,
  MAP_LAT_MIN,
  MAP_LAT_MAX,
  GRID_LNG_COUNT,
  GRID_LAT_COUNT
};
