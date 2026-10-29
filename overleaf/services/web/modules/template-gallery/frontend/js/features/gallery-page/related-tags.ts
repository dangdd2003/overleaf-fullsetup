// "Show more" for the related tags on tagged listing pages. The list is
// clamped by CSS (`.gallery .related-tags { max-height }`); the button is only
// revealed while the list overflows, and expanding adds `.all-tags`.

function updateOverflow(
  container: HTMLElement,
  button: HTMLElement,
  list: HTMLElement
) {
  if (list.scrollHeight > list.clientHeight) {
    list.classList.remove('all-tags')
    button.setAttribute('aria-expanded', 'false')
    container.classList.remove('d-none')
  } else {
    container.classList.add('d-none')
  }
}

export function setupRelatedTags(root: ParentNode = document) {
  const container = root.querySelector<HTMLElement>('#more-tags-container')
  const button = root.querySelector<HTMLElement>('#more-tags')
  const list = root.querySelector<HTMLElement>('#related-tags')
  if (!container || !button || !list) {
    return
  }

  let observer: ResizeObserver | undefined
  if ('ResizeObserver' in window) {
    observer = new ResizeObserver(([entry]) =>
      updateOverflow(container, button, entry.target as HTMLElement)
    )
    observer.observe(list)
  }
  updateOverflow(container, button, list)

  button.addEventListener('click', () => {
    list.classList.add('all-tags')
    button.setAttribute('aria-expanded', 'true')
    container.classList.add('d-none')
    observer?.unobserve(list)
  })
}
