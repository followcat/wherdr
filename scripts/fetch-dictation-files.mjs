#!/usr/bin/env node
// Downloads the files of on-device dictation into DATA_DIR/models, where the
// /models/** route serves them (the code: scripts/dictation-files.mjs). The
// wherdr server does the same by itself when Install finds a model missing;
// this script is for admins who fetch ahead, or on another machine. Both files
// and the catalog ship in the npm package.
//
//   DATA_DIR=~/.local/share/wherdr node scripts/fetch-dictation-files.mjs [set...]
//   wherdr dictation fetch [set...]   (installed package: DATA_DIR of wherdr)
//
// Sets: runtime (sherpa-onnx WASM, 13 MB), parakeet (Parakeet v3, French,
// English and 23 more, 670 MB), sensevoice (237 MB, no French), ort
// (onnxruntime-web, 59 MB, for WebGPU models only), the read-aloud voices
// tts-siwis-medium (French, 64 MB), tts-cori-medium (English, 64 MB) and
// tts-mls-medium (French, 78 MB), all. Default: runtime parakeet.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchSets, setsOf } from './dictation-files.mjs'

// `wherdr dictation fetch` imports this file for these.
export * from './dictation-files.mjs'

async function main() {
  let names
  try { names = setsOf(process.argv.slice(2)) }
  catch (err) { console.error(err.message); process.exit(2) }
  const modelsDir = path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')), 'models')
  await fetchSets(modelsDir, names, { log: m => console.log(m) })
  console.log('done')
}

// Run, not imported (the CLI imports it).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1) })
}
