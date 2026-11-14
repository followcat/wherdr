// Runs before the node-server preset reads its shutdown settings (plugins load first).
import { capShutdownWait } from '../utils/shutdown'

export default defineNitroPlugin(() => { capShutdownWait() })
