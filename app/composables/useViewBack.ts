import { internalBack } from '~/utils/viewHistory'

export function useViewBack() {
  const router = useRouter()
  return () => {
    if (internalBack(history.state?.back)) router.back()
    else void router.replace('/')
  }
}
