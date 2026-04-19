/** 跨模块共享的可变状态（单页应用内统一从此读写） */
export const appState = {
  pyodide: null,
  lastData: null,
  lastFileMeta: null,
  showUpgrades: true,
  showOriginal: false,
  showWorkers: true,
  mergeSameActions: true,
  showWorkerDeaths: false,
  chatVisible: false,
  translationData: null,
  batchItems: [],
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
