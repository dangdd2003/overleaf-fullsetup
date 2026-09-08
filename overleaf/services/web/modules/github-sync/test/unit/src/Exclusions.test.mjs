import { describe, it, expect } from 'vitest'

describe('Exclusions', function () {
  let Exclusions

  it('excludes .git, .overleaf and .github/workflows paths', async function () {
    ;({ default: Exclusions } = await import('../../../app/src/Exclusions.mjs'))
    expect(Exclusions.isExcludedSyncPath('.git/config')).to.equal(true)
    expect(Exclusions.isExcludedSyncPath('submodule/.git/config')).to.equal(true)
    expect(Exclusions.isExcludedSyncPath('.overleaf/x')).to.equal(true)
    expect(Exclusions.isExcludedSyncPath('nested/.overleaf/data')).to.equal(true)
    expect(Exclusions.isExcludedSyncPath('.github/workflows/ci.yml')).to.equal(true)
    expect(Exclusions.isExcludedSyncPath('src/main.tex')).to.equal(false)
  })

  it('classifies LaTeX sources as text and images as binary', async function () {
    ;({ default: Exclusions } = await import('../../../app/src/Exclusions.mjs'))
    expect(Exclusions.classifyText('main.tex')).to.equal(true)
    expect(Exclusions.classifyText('refs.bib')).to.equal(true)
    expect(Exclusions.classifyText('Makefile')).to.equal(true)
    expect(Exclusions.classifyText('.latexmkrc')).to.equal(true)
    expect(Exclusions.classifyText('notes')).to.equal(true)
    expect(Exclusions.classifyText('logo.png')).to.equal(false)
    expect(Exclusions.classifyText('paper.pdf')).to.equal(false)
  })

  it('skips oversized files and symlinks with distinct codes', async function () {
    ;({ default: Exclusions } = await import('../../../app/src/Exclusions.mjs'))
    const big = Exclusions.classifySyncEntry('huge.pdf', {
      sizeBytes: 60 * 1024 * 1024,
      symlinkTarget: null,
    })
    expect(big.verdict).to.equal('skip')
    expect(big.code).to.equal('github_large_files_error')

    const link = Exclusions.classifySyncEntry('lnk', {
      sizeBytes: 10,
      symlinkTarget: '/etc/passwd',
    })
    expect(link.verdict).to.equal('skip')
    expect(link.code).to.equal('github_symlink_error')

    const ok = Exclusions.classifySyncEntry('main.tex', {
      sizeBytes: 10,
      symlinkTarget: null,
    })
    expect(ok.verdict).to.equal('sync')
  })

  it('skips git and workflow entries with distinct codes', async function () {
    ;({ default: Exclusions } = await import('../../../app/src/Exclusions.mjs'))
    const gitDir = Exclusions.classifySyncEntry('.git', {
      sizeBytes: 0,
      symlinkTarget: null,
    })
    expect(gitDir.verdict).to.equal('skip')
    expect(gitDir.code).to.equal('github_git_folder_error')

    const gitFile = Exclusions.classifySyncEntry('.git/HEAD', {
      sizeBytes: 10,
      symlinkTarget: null,
    })
    expect(gitFile.verdict).to.equal('skip')
    expect(gitFile.code).to.equal('github_git_folder_error')

    const workflow = Exclusions.classifySyncEntry('.github/workflows/deploy.yml', {
      sizeBytes: 10,
      symlinkTarget: null,
    })
    expect(workflow.verdict).to.equal('skip')
    expect(workflow.code).to.equal('github_workflow_files_error')
  })

  it('exports named functions and constants', async function () {
    const mod = await import('../../../app/src/Exclusions.mjs')
    expect(mod.MAX_SYNC_FILE_SIZE).to.equal(50 * 1024 * 1024)
    expect(typeof mod.classifyText).to.equal('function')
    expect(typeof mod.isExcludedSyncPath).to.equal('function')
    expect(typeof mod.classifySyncEntry).to.equal('function')
  })
})
