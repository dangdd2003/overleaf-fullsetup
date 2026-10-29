import moment from 'moment'
import { Tooltip } from 'bootstrap'

const TOOLTIP_INNER = '.tooltip-inner'

// "Last Updated: N days ago" on detail pages: the tooltip shows the exact
// date in the viewer's timezone, formatted like the official gallery.
export function setupTimestampTooltips(root: ParentNode = document) {
  root
    .querySelectorAll<HTMLElement>('[data-timestamp-for-title]')
    .forEach(element => {
      const timestamp = parseInt(
        element.getAttribute('data-timestamp-for-title') || '',
        10
      )
      if (isNaN(timestamp)) {
        return
      }
      const title = moment.unix(timestamp).format('Do MMM YYYY, h:mm a')

      // The shared tooltip setup may already have created the instance from a
      // server-rendered title, so update its content rather than the attribute.
      if (!Tooltip.getInstance(element)) {
        element.setAttribute('title', title)
      }
      element.setAttribute('data-bs-original-title', title)
      Tooltip.getOrCreateInstance(element).setContent({
        [TOOLTIP_INNER]: title,
      })
    })
}
