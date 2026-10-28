import '../../../../../frontend/js/marketing'

// Like overleaf.com/legal: choosing a tab (or opening /legal#Tab) brings the
// tab bar to the top of the viewport so the section starts right below it
function scrollTabsToTop(behavior: ScrollBehavior) {
  const tabset = document.querySelector('[data-ol-bookmarkable-tabset]')
  if (!tabset) return
  const top = tabset.getBoundingClientRect().top + window.scrollY
  window.scrollTo({ top, behavior })
}

function findTab(hash: string | null) {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-ol-bookmarkable-tab]')
  ).find(tab => tab.getAttribute('href') === hash)
}

document
  .querySelectorAll<HTMLElement>('[data-ol-bookmarkable-tab]')
  .forEach(tab =>
    tab.addEventListener('click', () => scrollTabsToTop('smooth'))
  )

// In-text links to a tab, e.g. the Privacy Notice link in the overview
document
  .querySelectorAll<HTMLElement>('[data-ol-legal-tab-link]')
  .forEach(link =>
    link.addEventListener('click', event => {
      const tab = findTab(link.getAttribute('href'))
      if (!tab) return
      event.preventDefault()
      tab.click()
    })
  )

if (findTab(window.location.hash)) {
  scrollTabsToTop('auto')
}
