import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import { ToolCallCard } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'

const LEGACY = {
  id: 'c1',
  name: 'project_map',
  args: { view: 'outline' },
  result: { sections: [] },
}

describe('a stored call naming a tool that no longer exists', function () {
  it('renders without throwing', function () {
    expect(() => render(<ToolCallCard call={LEGACY as any} />)).to.not.throw()
  })

  it('shows the tool name it was recorded under', function () {
    render(<ToolCallCard call={LEGACY as any} />)
    expect(screen.getByText(/project_map/)).to.exist
  })

  it('shows the arguments as JSON when expanded', function () {
    const { container } = render(<ToolCallCard call={LEGACY as any} />)
    const summary = container.querySelector('.ai-assist-tool-call-summary')!
    ;(summary as HTMLElement).click()
    expect(container.textContent).to.contain('outline')
  })
})
