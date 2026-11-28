import { compressResponse } from '../utils/compression'

// Every response passes here before h3 writes it (Nitro's runtime
// `beforeResponse` hook): /api/* JSON and text answers are compressed for a
// client that takes it (server/utils/compression.ts). A Nitro hook rather than
// a defineApi helper: /api/health and /api/client-plugins skip defineApi, and a
// body is encoded in one place, once.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event, response) => {
    compressResponse(event, response)
  })
})
