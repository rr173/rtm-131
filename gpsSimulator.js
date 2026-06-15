const { distance } = require('./geometry');

const targets = [
  {
    id: 'T001',
    name: '车辆A-001',
    color: '#e74c3c',
    speed: 0.003,
    route: [
      { lng: 116.15, lat: 39.60 },
      { lng: 116.25, lat: 39.75 },
      { lng: 116.40, lat: 39.85 },
      { lng: 116.55, lat: 39.80 },
      { lng: 116.65, lat: 39.70 },
      { lng: 116.60, lat: 39.60 },
      { lng: 116.45, lat: 39.55 },
      { lng: 116.30, lat: 39.62 },
      { lng: 116.20, lat: 39.70 }
    ]
  },
  {
    id: 'T002',
    name: '车辆B-002',
    color: '#3498db',
    speed: 0.0025,
    route: [
      { lng: 116.70, lat: 40.10 },
      { lng: 116.55, lat: 40.00 },
      { lng: 116.40, lat: 39.95 },
      { lng: 116.30, lat: 40.00 },
      { lng: 116.20, lat: 39.90 },
      { lng: 116.35, lat: 39.80 },
      { lng: 116.50, lat: 39.85 },
      { lng: 116.65, lat: 39.95 }
    ]
  },
  {
    id: 'T003',
    name: '车辆C-003',
    color: '#2ecc71',
    speed: 0.0035,
    route: [
      { lng: 116.10, lat: 39.95 },
      { lng: 116.25, lat: 39.88 },
      { lng: 116.42, lat: 39.92 },
      { lng: 116.58, lat: 39.88 },
      { lng: 116.70, lat: 39.78 },
      { lng: 116.60, lat: 39.68 },
      { lng: 116.40, lat: 39.62 },
      { lng: 116.22, lat: 39.68 }
    ]
  },
  {
    id: 'T004',
    name: '车辆D-004',
    color: '#f39c12',
    speed: 0.0028,
    route: [
      { lng: 116.20, lat: 40.15 },
      { lng: 116.35, lat: 40.05 },
      { lng: 116.50, lat: 40.00 },
      { lng: 116.65, lat: 40.08 },
      { lng: 116.75, lat: 39.98 },
      { lng: 116.68, lat: 39.85 },
      { lng: 116.52, lat: 39.78 },
      { lng: 116.38, lat: 39.88 },
      { lng: 116.28, lat: 40.02 }
    ]
  },
  {
    id: 'T005',
    name: '车辆E-005',
    color: '#9b59b6',
    speed: 0.004,
    route: [
      { lng: 116.75, lat: 39.55 },
      { lng: 116.60, lat: 39.62 },
      { lng: 116.48, lat: 39.75 },
      { lng: 116.35, lat: 39.85 },
      { lng: 116.25, lat: 39.95 },
      { lng: 116.15, lat: 40.05 },
      { lng: 116.30, lat: 40.12 },
      { lng: 116.50, lat: 40.08 }
    ]
  }
];

class GPSSimulator {
  constructor(onPositionUpdate) {
    this.onPositionUpdate = onPositionUpdate;
    this.targetStates = new Map();
    this.isRunning = false;
    this.intervalId = null;
    this.initTargets();
  }

  initTargets() {
    targets.forEach(target => {
      this.targetStates.set(target.id, {
        ...target,
        segmentIndex: 0,
        segmentProgress: 0,
        currentPos: { ...target.route[0] },
        bearing: 0,
        trajectory: []
      });
    });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => this.tick(), 1000);
  }

  stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  tick() {
    this.targetStates.forEach((state, targetId) => {
      this.moveTarget(state);
      const posUpdate = {
        id: state.id,
        name: state.name,
        color: state.color,
        lng: state.currentPos.lng,
        lat: state.currentPos.lat,
        bearing: state.bearing,
        timestamp: Date.now()
      };
      state.trajectory.push({ ...posUpdate });
      if (state.trajectory.length > 30) {
        state.trajectory.shift();
      }
      if (this.onPositionUpdate) {
        this.onPositionUpdate(posUpdate);
      }
    });
  }

  moveTarget(state) {
    const route = state.route;
    const currentIdx = state.segmentIndex;
    const nextIdx = (currentIdx + 1) % route.length;
    const p1 = route[currentIdx];
    const p2 = route[nextIdx];
    const segLength = distance(p1, p2);
    if (segLength < 1e-10) {
      state.segmentIndex = nextIdx;
      state.segmentProgress = 0;
      return;
    }
    const progressPerTick = state.speed / segLength;
    state.segmentProgress += progressPerTick;
    if (state.segmentProgress >= 1) {
      state.segmentProgress = state.segmentProgress - 1;
      state.segmentIndex = nextIdx;
      return this.moveTarget(state);
    }
    const t = state.segmentProgress;
    state.currentPos.lng = p1.lng + (p2.lng - p1.lng) * t;
    state.currentPos.lat = p1.lat + (p2.lat - p1.lat) * t;
    state.bearing = Math.atan2(p2.lat - p1.lat, p2.lng - p1.lng) * 180 / Math.PI;
  }

  getTargetState(targetId) {
    return this.targetStates.get(targetId);
  }

  getAllTargets() {
    return Array.from(this.targetStates.values()).map(s => ({
      id: s.id,
      name: s.name,
      color: s.color,
      lng: s.currentPos.lng,
      lat: s.currentPos.lat,
      bearing: s.bearing,
      trajectory: s.trajectory
    }));
  }
}

module.exports = {
  GPSSimulator,
  getPresetTargets: () => targets
};
