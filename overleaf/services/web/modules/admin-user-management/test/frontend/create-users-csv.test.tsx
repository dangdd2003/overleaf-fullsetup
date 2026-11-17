import { expect } from 'chai'
import { escapeCSV } from '../../frontend/js/components/create-users-modal'

describe('create-users-modal escapeCSV', function () {
  it('prefixes formula-triggering characters with a single quote before quoting', function () {
    expect(escapeCSV('=SUM(A1:A2)')).to.equal('"\'=SUM(A1:A2)"')
    expect(escapeCSV('+cmd|calc')).to.equal('"\'+cmd|calc"')
    expect(escapeCSV('-1+1')).to.equal('"\'-1+1"')
    expect(escapeCSV('@SUM(1,1)')).to.equal('"\'@SUM(1,1)"')
    expect(escapeCSV('\tcmd')).to.equal('"\'\tcmd"')
    expect(escapeCSV('\rcmd')).to.equal('"\'\rcmd"')
  })

  it('escapes double quotes and leaves safe values unchanged', function () {
    expect(escapeCSV('Alice "A"')).to.equal('"Alice ""A"""')
    expect(escapeCSV('user@example.com')).to.equal('"user@example.com"')
    expect(escapeCSV(null)).to.equal('""')
    expect(escapeCSV(undefined)).to.equal('""')
  })
})
