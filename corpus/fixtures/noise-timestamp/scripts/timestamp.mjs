console.error(
  `error: health check failed at ${new Date().toISOString()} (pid ${process.pid})`
);
process.exit(1);
