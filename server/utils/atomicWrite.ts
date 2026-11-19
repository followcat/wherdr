// A whole file written at once: into a temporary file next to it, then renamed
// over it. A write cut halfway (a crash, a full disk) leaves the old file as it
// was, never half of the new one. The folder is created when missing.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AtomicOptions { mode?: number, dirMode?: number }

export async function writeFileAtomic(file: string, data: string | Buffer, { mode = 0o600, dirMode }: AtomicOptions = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, ...(dirMode ? { mode: dirMode } : {}) })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temp, data, { mode })
    await fs.promises.rename(temp, file)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export function writeFileAtomicSync(file: string, data: string | Buffer, { mode = 0o600, dirMode }: AtomicOptions = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, ...(dirMode ? { mode: dirMode } : {}) })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, data, { mode })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

// As JSON, two-space indented, ending with a newline.
export const writeJsonAtomic = (file: string, data: unknown, opts?: AtomicOptions) => writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', opts)
export const writeJsonAtomicSync = (file: string, data: unknown, opts?: AtomicOptions) => writeFileAtomicSync(file, JSON.stringify(data, null, 2) + '\n', opts)

// A JSON file about to be changed and written back: undefined only when it does
// not exist. Any other failure (EMFILE, EIO, EACCES, invalid JSON) throws, so a
// read-modify-write never starts from empty and drops what the file held.
export async function readJsonOrMissing(file: string): Promise<unknown> {
  let text: string
  try { text = await fs.promises.readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}
