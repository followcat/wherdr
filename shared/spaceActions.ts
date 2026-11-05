// Labels of spaces (workspaces), tabs and panes given by the app.
const LABEL_MAX = 60

// Clean label: collapsed spaces, 60 characters max.
export const cleanLabel = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)
