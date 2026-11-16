// A form that saves by itself (WHR-400): each field belongs to a group (what
// one Saved mark covers). A switch or a pick saves at once (`change(g, true)`),
// typed text after a pause in typing or on blur (`flush`), whichever comes
// first. One save at a time: a change during a save is sent once it ends, with
// the form's latest values (`send` reads them). An invalid group (`invalid`)
// shows its message and holds every save until it is fixed; a failed save
// shows the server's message on the groups it carried and keeps what was typed.
export type SaveState = '' | 'saving' | 'saved' | 'error'

export function useAutosave(send: () => Promise<unknown>, invalid: () => Record<string, string> = () => ({}), delay = 800) {
  const state = reactive<Record<string, SaveState>>({})
  const errors = reactive<Record<string, string>>({})
  const pending = new Set<string>()
  const busy = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let again = false

  const mark = (g: string, s: SaveState, message = '') => {
    state[g] = s
    errors[g] = message
    // Saved fades out on its own; a later state is left alone.
    if (s === 'saved') setTimeout(() => { if (state[g] === 'saved') state[g] = '' }, 2000)
  }

  async function flush() {
    clearTimeout(timer)
    if (busy.value) { again = true; return }
    const bad = invalid()
    for (const g of pending) mark(g, bad[g] ? 'error' : '', bad[g])
    if (Object.keys(bad).length || !pending.size) return
    const groups = [...pending]
    pending.clear()
    groups.forEach(g => mark(g, 'saving'))
    busy.value = true
    try {
      await send()
      groups.forEach(g => mark(g, pending.has(g) ? '' : 'saved'))
    }
    catch (e) {
      groups.forEach((g) => { pending.add(g); mark(g, 'error', (e as Error).message) })
    }
    finally { busy.value = false }
    if (again) { again = false; await flush() }
  }

  function change(g: string, now = false) {
    pending.add(g)
    if (state[g] === 'saved') state[g] = ''
    clearTimeout(timer)
    if (now) void flush()
    else timer = setTimeout(flush, delay)
  }

  onBeforeUnmount(() => { if (pending.size) void flush() })
  return { state, errors, busy, change, flush }
}
