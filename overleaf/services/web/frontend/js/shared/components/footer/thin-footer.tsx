import type {
  FooterItem,
  FooterMetadata,
} from '@/shared/components/types/footer-metadata'
import OLRow from '@/shared/components/ol/ol-row'
import LanguagePicker from '@/shared/components/language-picker'
import React from 'react'
import { useTranslation } from 'react-i18next'

function FooterItemLi({
  text,
  translatedText,
  url: href,
  class: className,
  label,
}: FooterItem) {
  const textToDisplay = translatedText || text

  if (!href) {
    return <li dangerouslySetInnerHTML={{ __html: textToDisplay }} />
  }

  const linkProps = {
    href,
    className,
    'aria-label': label,
  }

  return (
    <li>
      <a {...linkProps}>{textToDisplay}</a>
    </li>
  )
}

function Separator() {
  return (
    <li role="separator" className="text-muted">
      <strong>|</strong>
    </li>
  )
}

function ThinFooter({
  showPoweredBy,
  showLegal,
  subdomainLang,
  leftItems,
  rightItems,
}: FooterMetadata) {
  const { t } = useTranslation()
  const showLanguagePicker = Boolean(
    subdomainLang && Object.keys(subdomainLang).length > 1
  )

  const hasCustomLegal = Boolean(leftItems?.some(item => item.url === '/legal'))
  const shouldShowLegal = Boolean(showLegal && !hasCustomLegal)
  const hasCustomLeftNav = Boolean(leftItems && leftItems.length > 0)

  return (
    <footer className="site-footer">
      <div className="site-footer-content d-print-none">
        <OLRow>
          <ul className="site-footer-items col-lg-9">
            {showPoweredBy ? (
              <>
                <li>
                  {/* year of Server Pro release, static */}© 2026{' '}
                  <a href="https://www.overleaf.com/for/enterprises">
                    Powered by Overleaf
                  </a>
                </li>
                {showLanguagePicker || shouldShowLegal || hasCustomLeftNav ? (
                  <Separator />
                ) : null}
              </>
            ) : null}
            {showLanguagePicker ? (
              <>
                <li>
                  <LanguagePicker showHeader />
                </li>
                {shouldShowLegal || hasCustomLeftNav ? <Separator /> : null}
              </>
            ) : null}
            {shouldShowLegal ? (
              <>
                <li>
                  <a href="/legal">{t('privacy_and_terms')}</a>
                </li>
                {hasCustomLeftNav ? <Separator /> : null}
              </>
            ) : null}
            {leftItems?.map(item => (
              <FooterItemLi key={item.text} {...item} />
            ))}
          </ul>
          <ul className="site-footer-items col-lg-3 text-end">
            {rightItems?.map(item => (
              <FooterItemLi key={item.text} {...item} />
            ))}
          </ul>
        </OLRow>
      </div>
    </footer>
  )
}

export default ThinFooter
