import { pathToFileURL } from 'node:url';
import { createServer } from './server.js';

const PORT = parseInt(process.env.PORT || '7690', 10);

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const server = createServer(PORT);
  console.log(`ttym server listening on http://localhost:${PORT} (ws + http api)`);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { createServer } from './server.js';
