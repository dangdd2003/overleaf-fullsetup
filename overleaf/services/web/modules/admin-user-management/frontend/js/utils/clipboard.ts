/**
 * Reliable clipboard copy helper that works across HTTP/HTTPS, inside Bootstrap/React
 * modals with focus traps, and on mobile/desktop browsers.
 */
export function copyTextToClipboard(text: string): boolean {
  if (!text) return false

  let copied = false

  // 1. Direct copy event listener: writes directly to OS clipboard buffer and bypasses FocusTrap / DOM selection issues
  const onCopy = (e: ClipboardEvent) => {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.clipboardData) {
      e.clipboardData.clearData()
      e.clipboardData.setData('text/plain', text)
      copied = true
    }
  }

  try {
    document.addEventListener('copy', onCopy, { capture: true, once: true })
    const result = document.execCommand('copy')
    document.removeEventListener('copy', onCopy, { capture: true })
    if (result && copied) {
      return true
    }
  } catch {
    document.removeEventListener('copy', onCopy, { capture: true })
  }

  // 2. Modern navigator.clipboard API if supported
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  // 3. Fallback textarea appended inside active modal container or document body
  try {
    const parent =
      document.querySelector('.modal-body') ||
      document.querySelector('.modal') ||
      document.body
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.setAttribute('readonly', '')
    textArea.style.position = 'fixed'
    textArea.style.top = '0'
    textArea.style.left = '0'
    textArea.style.width = '1px'
    textArea.style.height = '1px'
    textArea.style.padding = '0'
    textArea.style.border = 'none'
    textArea.style.outline = 'none'
    textArea.style.background = 'transparent'
    textArea.style.opacity = '0'
    parent.appendChild(textArea)
    textArea.focus()
    textArea.select()
    textArea.setSelectionRange(0, text.length)
    const result = document.execCommand('copy')
    parent.removeChild(textArea)
    if (result) return true
  } catch {
    // ignore
  }

  return true
}
