import { expect, describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const profilePath = path.join(
  import.meta.dirname,
  '../../../seccomp/clsi-profile.json'
)
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))

const CLONE_NAMESPACE_FLAGS =
  0x00020000 | // CLONE_NEWNS
  0x02000000 | // CLONE_NEWCGROUP
  0x04000000 | // CLONE_NEWUTS
  0x08000000 | // CLONE_NEWIPC
  0x10000000 | // CLONE_NEWUSER
  0x20000000 | // CLONE_NEWPID
  0x40000000 // CLONE_NEWNET

// the rules that name syscall, in file order
function rulesFor(name) {
  return profile.syscalls.filter(rule => rule.names.includes(name))
}

describe('clsi seccomp profile', () => {
  it('only allows clone when no namespace flag is requested', () => {
    const rules = rulesFor('clone')
    expect(rules).to.have.length(1)
    const [rule] = rules
    expect(rule.action).to.equal('SCMP_ACT_ALLOW')
    expect(rule.args).to.have.length(1)
    const [arg] = rule.args
    expect(arg.index).to.equal(0)
    expect(arg.op).to.equal('SCMP_CMP_MASKED_EQ')
    expect(arg.valueTwo).to.equal(0)
    // exact mask: a wider one (e.g. CLONE_VM, which thread creation needs)
    // would deny clone(2) for threads and must fail this test
    expect(arg.value).to.equal(CLONE_NAMESPACE_FLAGS)
    expect(arg.value).to.equal(0x7e020000)
  })

  it('refuses clone3 so libc falls back to the filtered clone', () => {
    const rules = rulesFor('clone3')
    expect(rules).to.have.length(1)
    const [rule] = rules
    expect(rule.action).to.equal('SCMP_ACT_ERRNO')
    expect(rule.errnoRet).to.equal(38) // ENOSYS
  })
})
