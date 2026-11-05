import path from 'node:path'
import { createServerFiles } from './dictationServerFiles'
import { DATA_DIR, log } from './env'

// The server's one fetcher of dictation files (server/utils/dictationServerFiles.ts).
export const serverFiles = createServerFiles({ modelsDir: path.join(DATA_DIR, 'models'), log: m => log('dictation:', m) })
