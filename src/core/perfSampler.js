export function startPerfSampler({ intervalMs = 250, now = () => Date.now() } = {}) {
  const startedAtMs = now();
  const startCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let samples = 1;

  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    samples += 1;
    if (rss > peakRssBytes) {
      peakRssBytes = rss;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  const snapshot = () => {
    const cpu = process.cpuUsage(startCpu);
    return {
      durationMs: Math.max(0, now() - startedAtMs),
      peakRssBytes,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      samples
    };
  };

  return {
    snapshot,
    stop() {
      clearInterval(timer);
      return snapshot();
    }
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function summarizeBatchPerformance(runPerfs = [], batchPerf = null) {
  const peakRssBytes = Math.max(
    0,
    ...runPerfs.map((entry) => Number(entry?.peakRssBytes) || 0),
    Number(batchPerf?.peakRssBytes) || 0
  );
  const cpuUserMs = runPerfs.reduce(
    (sum, entry) => sum + (Number(entry?.cpuUserMs) || 0),
    0
  );
  const cpuSystemMs = runPerfs.reduce(
    (sum, entry) => sum + (Number(entry?.cpuSystemMs) || 0),
    0
  );
  const runWallMs = runPerfs.reduce(
    (sum, entry) => sum + (Number(entry?.durationMs) || 0),
    0
  );

  return {
    wallMs: Number(batchPerf?.durationMs) || 0,
    runWallMs,
    peakRssBytes,
    cpuUserMs,
    cpuSystemMs
  };
}
