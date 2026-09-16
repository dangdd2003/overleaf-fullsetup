import { CustomRailTabIcon } from '@/features/ide-react/util/rail-types'

/**
 * The AI assistant's rail tab icon.
 *
 * A MaterialIcon is not usable here. Only the *filled* Material Symbols font is
 * a complete set; the outlined face is a subset built by
 * `frontend/fonts/material-symbols/build-unfilled.mjs` from the names listed in
 * `unfilled-symbols.mjs`, and no sparkle glyph is in that list. A material
 * sparkle would therefore stay filled while every other rail tab renders
 * outlined whenever its panel is closed.
 *
 * So we inline Overleaf's own sparkle artwork instead — the path is the one
 * shared by `shared/svgs/sparkle-small-green.svg` and `sparkle-small-white.svg`,
 * which differ only in their hardcoded fill. Painting it with `currentColor`
 * lets the rail's own tokens (`--ide-rail-color`, and
 * `--ide-rail-link-active-color` under `.open-rail`) drive it, so it tracks the
 * light and dark themes without either SVG's baked-in colour.
 */
export const AiRailIcon: CustomRailTabIcon = ({ title }) => (
  <>
    <svg
      className="ai-assist-rail-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 21"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14.87 12.18c-4.74-1.07-5.48-1.8-6.55-6.54a.48.48 0 0 0-.93 0c-1.07 4.74-1.8 5.47-6.54 6.54a.48.48 0 0 0 0 .93c4.74 1.08 5.47 1.8 6.54 6.55a.48.48 0 0 0 .93 0c1.07-4.74 1.8-5.47 6.55-6.55a.48.48 0 0 0 0-.93Zm4.28-7.38c-2.52-.56-2.87-.92-3.44-3.44a.48.48 0 0 0-.93 0c-.57 2.52-.92 2.88-3.44 3.44a.48.48 0 0 0 0 .93c2.52.57 2.87.93 3.44 3.45a.48.48 0 0 0 .93 0c.57-2.52.92-2.88 3.44-3.45a.48.48 0 0 0 0-.93Z" />
    </svg>
    <span className="visually-hidden">{title}</span>
  </>
)
