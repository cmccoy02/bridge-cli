import { formatConfig, readConfigFile } from '../core/configReader.js';
import { line } from '../ui/logger.js';

export async function configCommand({ cwd = process.cwd() } = {}) {
  const { configPath, config } = await readConfigFile(cwd);

  line(configPath);
  line();
  line(formatConfig(config));

  return true;
}
