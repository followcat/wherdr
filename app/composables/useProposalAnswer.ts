// Accept or refuse a coordinator's proposed workflow change (the review and
// the card in its conversation). An outdated one is refused by the server:
// `error` holds its reason.
export function useProposalAnswer(project: () => string, done?: (accepted: boolean) => void) {
  const busy = ref<'' | 'accept' | 'refuse'>('')
  const error = ref('')
  async function answer(accept: boolean) {
    if (busy.value) return
    busy.value = accept ? 'accept' : 'refuse'
    error.value = ''
    try {
      await api('/api/pm/template-proposal', { project: project(), accept })
      done?.(accept)
    }
    catch (e) { error.value = (e as Error).message }
    finally { busy.value = ''; await loadCoordinators() }
  }
  return { busy, error, answer }
}
