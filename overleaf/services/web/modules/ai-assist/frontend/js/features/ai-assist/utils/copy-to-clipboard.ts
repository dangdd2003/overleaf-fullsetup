/**
 * Copies text to the system clipboard using navigator.clipboard with fallback
 * to document.execCommand('copy').
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  const nav = typeof navigator !== 'undefined' ? navigator : null

  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text)
      return true
    } catch {
      // Fall back to execCommand
    }
  }
  if (typeof document !== 'undefined') {
    try {
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.left = '-9999px'
      textArea.style.top = '-9999px'
      textArea.setAttribute('readonly', '')
      document.body.appendChild(textArea)
      textArea.select()
      const successful = document.execCommand('copy')
      document.body.removeChild(textArea)
      return successful
    } catch {
      return false
    }
  }
  return false
}
