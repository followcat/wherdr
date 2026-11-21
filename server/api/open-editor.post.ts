// "Open in editor": the pane's folder in the default editor, on the agent's machine
// (see server/utils/openEditor.ts).
import { openEditor } from '../utils/openEditor'

export default defineApi((_event, b) => openEditor(b))
