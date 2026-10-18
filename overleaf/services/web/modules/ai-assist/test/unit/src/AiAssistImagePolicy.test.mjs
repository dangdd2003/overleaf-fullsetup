import { describe, it, expect } from 'vitest'

const {
  CLAUDE_HIGH_RES_EDGE_PX,
  CLAUDE_STANDARD_EDGE_PX,
  IMAGE_TOKEN_FALLBACK,
  estimateImageTokens,
  imagePolicyFor,
  inspectOptionsFor,
  isClaudeHighResModel,
  isOpenAiOriginalModel,
  wantsColor,
} = await import('../../../app/src/AiAssistImagePolicy.mjs')

const { detachToolImages } = await import(
  '../../../app/src/AiAssistImages.mjs'
)

describe('AiAssistImagePolicy', () => {
  describe('model families', () => {
    it.each([
      ['claude-opus-4-7', true],
      ['claude-sonnet-4-7-20260101', true],
      ['claude-opus-4-6', false],
      ['claude-sonnet-4-5-20250929', false],
      ['claude-haiku-4-5', false],
      ['claude-opus-5-5', true],
      ['claude-sonnet-5-0', true],
      ['claude-haiku-5-5', true],
      ['claude-fable-5-1', true],
      ['claude-3-7-sonnet', false],
    ])('%s is high-resolution: %s', (model, expected) => {
      expect(isClaudeHighResModel(model)).toBe(expected)
    })

    it.each([
      ['gpt-5.5', true],
      ['gpt-5.4-mini', true],
      ['gpt-5.6-luna', true],
      ['gpt-6-astra', true],
      ['gpt-5', false],
      ['gpt-5.1', false],
      ['gpt-5.2', false],
      ['gpt-4o', false],
      ['gpt-4.1', false],
    ])('%s takes detail original: %s', (model, expected) => {
      expect(isOpenAiOriginalModel(model)).toBe(expected)
    })
  })

  describe('imagePolicyFor', () => {
    it('gives Claude 4.7+ and Claude 5 a full page at 2576 px', () => {
      for (const model of ['claude-opus-4-7', 'claude-sonnet-5-0']) {
        const policy = imagePolicyFor({ type: 'anthropic', model })
        expect(policy).toMatchObject({
          tier: 'claude-high',
          maxEdgePx: CLAUDE_HIGH_RES_EDGE_PX,
          split: 'none',
          detail: null,
        })
      }
    })

    it('splits older Claude into halves at 1568 px', () => {
      const policy = imagePolicyFor({
        type: 'anthropic',
        model: 'claude-sonnet-4-5',
      })
      expect(policy).toMatchObject({
        tier: 'claude-standard',
        maxEdgePx: CLAUDE_STANDARD_EDGE_PX,
        split: 'halves',
      })
    })

    it('uses detail high with halves for gpt-4o and gpt-4.1', () => {
      for (const model of ['gpt-4o', 'gpt-4.1']) {
        expect(imagePolicyFor({ type: 'openai', model })).toMatchObject({
          tier: 'openai-high',
          maxEdgePx: 2048,
          split: 'halves',
          detail: 'high',
        })
      }
    })

    it('uses detail original on gpt-5.5 with a full page', () => {
      expect(imagePolicyFor({ type: 'openai', model: 'gpt-5.5' })).toMatchObject(
        { tier: 'openai-original', split: 'none', detail: 'original' }
      )
    })

    it('keeps a full page for Gemini and asks for high media resolution on 3+', () => {
      expect(
        imagePolicyFor({ type: 'google', model: 'gemini-3-pro' })
      ).toMatchObject({
        tier: 'gemini',
        maxEdgePx: 2048,
        split: 'none',
        mediaResolution: 'high',
      })
      expect(
        imagePolicyFor({ type: 'google', model: 'gemini-2.5-pro' })
          .mediaResolution
      ).toBeNull()
    })

    it('falls back to 1568 px halves for unknown and local models', () => {
      expect(imagePolicyFor({ type: 'ollama', model: 'llava' })).toMatchObject({
        tier: 'fallback',
        maxEdgePx: 1568,
        split: 'halves',
        detail: null,
      })
      expect(
        imagePolicyFor({ type: 'openai', model: 'llama3-local' }).tier
      ).toBe('fallback')
    })

    it('is grayscale unless colour is wanted', () => {
      expect(imagePolicyFor({ type: 'anthropic', model: 'claude-opus-4-7' }).grayscale).toBe(true)
      expect(
        imagePolicyFor({ type: 'anthropic', model: 'claude-opus-4-7', color: true })
          .grayscale
      ).toBe(false)
    })

    it('maps to inspector options', () => {
      expect(
        inspectOptionsFor(
          imagePolicyFor({ type: 'anthropic', model: 'claude-sonnet-4-5' })
        )
      ).toEqual({ maxEdgePx: 1568, split: 'halves', grayscale: true })
    })
  })

  describe('wantsColor', () => {
    it('is true for figures, TikZ and colour commands', () => {
      expect(wantsColor('\\includegraphics{plot.png}')).toBe(true)
      expect(wantsColor('\\begin{tikzpicture}\n\\draw (0,0);')).toBe(true)
      expect(wantsColor('\\textcolor{red}{warning}')).toBe(true)
    })

    it('is false for plain text', () => {
      expect(wantsColor('The quick brown fox.\n\\section{Intro}')).toBe(false)
      expect(wantsColor(undefined)).toBe(false)
    })
  })

  describe('estimateImageTokens', () => {
    it('counts 28 px patches on Claude and caps at the tier budget', () => {
      // 1920x1080 is listed in the Anthropic table at 2691 tokens on the high tier.
      expect(
        estimateImageTokens({
          width: 1920,
          height: 1080,
          provider: 'anthropic',
          model: 'claude-opus-4-7',
        })
      ).toBe(2691)
      // A full A4 page at 2576 px long edge is over 4784 tokens and is scaled down.
      const big = estimateImageTokens({
        width: 1822,
        height: 2576,
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      })
      expect(big).toBeLessThanOrEqual(4784)
      expect(big).toBeGreaterThan(4000)
    })

    it('uses the 1568 token standard cap on older Claude', () => {
      const tokens = estimateImageTokens({
        width: 2000,
        height: 1500,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      })
      expect(tokens).toBeLessThanOrEqual(1568)
    })

    it('uses the tile formula for gpt-4o high detail', () => {
      // 1654x1169 fits 2048; short side 1169 shrinks to 768 (1086x768): 3x2 tiles.
      expect(
        estimateImageTokens({
          width: 1654,
          height: 1169,
          provider: 'openai',
          model: 'gpt-4o',
          detail: 'high',
        })
      ).toBe(85 + 170 * 6)
    })

    it('uses the gpt-5 base and tile costs', () => {
      expect(
        estimateImageTokens({
          width: 512,
          height: 512,
          provider: 'openai',
          model: 'gpt-5',
          detail: 'high',
        })
      ).toBe(70 + 140)
    })

    it('uses 32 px patches times 1.2 for original-detail models', () => {
      // 1024x1024 is 1024 patches; 1.2x is 1229 (the OpenAI example).
      expect(
        estimateImageTokens({
          width: 1024,
          height: 1024,
          provider: 'openai',
          model: 'gpt-6-astra',
          detail: 'original',
        })
      ).toBe(1229)
    })

    it('uses the Gemini level table on 3+ and tiles of 258 on older models', () => {
      expect(
        estimateImageTokens({
          width: 1000,
          height: 1000,
          provider: 'google',
          model: 'gemini-3-pro',
          detail: 'high',
        })
      ).toBe(1120)
      expect(
        estimateImageTokens({
          width: 1536,
          height: 1536,
          provider: 'google',
          model: 'gemini-2.5-pro',
        })
      ).toBe(4 * 258)
    })

    it('falls back to the flat estimate when the size is unknown', () => {
      expect(
        estimateImageTokens({ provider: 'anthropic', model: 'claude-opus-4-7' })
      ).toBe(IMAGE_TOKEN_FALLBACK)
    })
  })

  describe('detachToolImages with a provider', () => {
    const png = 'iVBORw0KGgo='

    it('carries detail, media resolution and token cost on each image', () => {
      const { images, result } = detachToolImages(
        {
          status: 'ok',
          image: { mediaType: 'image/png', data: png, width: 1920, height: 1080 },
        },
        { provider: 'anthropic', model: 'claude-opus-4-7' }
      )
      expect(images).toEqual([
        {
          mediaType: 'image/png',
          data: png,
          width: 1920,
          height: 1080,
          tokens: 2691,
        },
      ])
      expect(result.image).toEqual({
        mediaType: 'image/png',
        width: 1920,
        height: 1080,
      })
    })

    it('handles a split page: two images, each stripped from the result', () => {
      const { images, result } = detachToolImages(
        {
          status: 'ok',
          images: [
            { mediaType: 'image/png', data: png, width: 800, height: 600, part: 'top' },
            { mediaType: 'image/png', data: png, width: 800, height: 600, part: 'bottom' },
          ],
        },
        { provider: 'openai', model: 'gpt-4o' }
      )
      expect(images).toHaveLength(2)
      expect(images[0].detail).toBe('high')
      expect(result.images.every(image => !('data' in image))).toBe(true)
      expect(result.images[1].part).toBe('bottom')
    })

    it('leaves the result alone when there is no image', () => {
      const result = { status: 'ok' }
      expect(detachToolImages(result, { provider: 'anthropic' })).toEqual({
        result,
        images: [],
      })
    })
  })
})
