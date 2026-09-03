#!/usr/bin/env node
import { checkAndPullImages } from '../app/js/AutoPullManager.js'

checkAndPullImages()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    console.error('Fatal error during auto-pull:', err)
    process.exit(1)
  })
