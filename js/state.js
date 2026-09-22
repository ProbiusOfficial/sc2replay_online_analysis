/** 跨模块共享的可变状态（单页应用内统一从此读写） */
export const appState = {
  /** 解析内核（Worker + wasm）是否就绪。旧字段 `pyodide` 已随 Pyodide 下线移除。 */
  parserReady: false,
  lastData: null,
  lastFileMeta: null,
  lastFile: null,
  showUpgrades: true,
  showOriginal: false,
  showWorkers: true,
  mergeSameActions: true,
  showWorkerDeaths: false,
  chatVisible: false,
  translationData: null,
  batchItems: [],
  batchSearchKeyword: "",
  batchRailCollapsed: false,
  batchSelectedId: null,
  batchIdSeq: 0,

  voiceSteps: [],
  voiceCurrentIndex: -1,
  voiceIsRunning: false,
  voiceStartTime: 0,
  voicePausedTime: 0,
  voiceTimerId: null,
  voiceIntervalWindow: null,
  currentVoicePlayer: null,
  pipWindow: null,
  voiceTimelineDragging: false,

  chartInstances: [],
};
