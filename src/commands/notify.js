import { notifyTest } from '../core/notify/index.js';
import { line } from '../ui/logger.js';

export async function notifyTestCommand() {
  const result = await notifyTest();
  for (const row of result.lines) {
    line(row);
  }
  return true;
}
