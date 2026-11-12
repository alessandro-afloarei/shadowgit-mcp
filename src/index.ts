import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { outlineAtStart } from './outline.js';
import { buildServer, OUTLINE_BUDGET } from './server.js';
import { report } from './tools/shared.js';

// Read as the process starts, so the first message waits at most the outline's 300 ms
const outline = outlineAtStart(OUTLINE_BUDGET).catch((error: unknown) => {
  report(error);
  return null;
});

serveStdio(async () => buildServer(await outline), { onerror: report });
