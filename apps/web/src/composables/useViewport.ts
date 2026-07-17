import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useViewport() {
  const width = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
  const coarsePointer = ref(false)

  const update = () => {
    width.value = window.innerWidth
    coarsePointer.value = matchMedia('(pointer: coarse)').matches
  }

  onMounted(() => {
    update()
    window.addEventListener('resize', update, { passive: true })
  })
  onBeforeUnmount(() => window.removeEventListener('resize', update))

  return { width, coarsePointer }
}
