# DESIGN — SachetSathi

> **Redesign note:** the palette, type scale and layout below describe the first
> build. The shipped design system now lives in `web/tokens.css` (dark · light ·
> Sunlight) and `web/style.css`; see `web/REDESIGN.md` for the current tokens,
> components, breakpoints and the problem-by-problem changelog.

> Built to be legible on a cracked phone screen at 2 a.m. Low light, high contrast, no shading games.

## Color palette (tokens in `web/style.css`)
| Token | Hex | Use |
|---|---|---|
| `bg` | `#0B1220` | Page deep navy — dark mode default |
| `surface` | `#121A2B` | Cards |
| `surface-2` | `#1B2438` | Inputs, hover |
| `text` | `#E8ECF4` | Primary text |
| `text-muted` | `#8A93A5` | Secondary text, tags |
| `accent` | `#2E7CF6` | Interactive blue (open-source blue, DO-adjacent) |
| `sev-low` | `#22C55E` | Low severity card edge |
| `sev-moderate` | `#F59E0B` | Moderate |
| `sev-severe` | `#EF4444` | Severe — also headline/alerts |
| `err` | `#DC2626` | System errors (distinct from severity color) |

Contrast: all text/background pairs are WCAG AA at minimum (dark theme with light text passes cleanly). No dark grey on dark navy.

## Fonts & typography
- **Latin:** `Inter` (system fallback first, self-broken-if-offline is fine — SW precaches)
- **Odia:** `Noto Sans Odia` (Google Fonts, precached in the safety pack)
- Scale: `identity = 16 px base`. Headlines `clamp(18–24 px/700)`, card title `17/600`, body `15.5/400/1.5`, tag/meta `13/500/uppercase`.
- Severity shown with a colored left border (4 px) + small uppercase tag — redundancy ensures readability in low light.

## Layout principles
- Single column, max-width 720 px, 16 px gutters; bottom safe-area padding.
- Cards vertically stacked (alerts on top, incidents filtered below) — one-hand scroll; no multi-column grid on mobile.
- "Send report" action accessible under thumb (floating bottom-right, 56 px tap target).
- Flashing dots: never — Accessibility: no pulsing; severity uses palette only.

## Component tokens
- Card: `surface` bg, `12 px` radius, `1 px` border `#223`, subtle `box-shadow: 0 2px 8px rgb(0 0 0/.35)`.
- Button primary: `accent` bg, white text, `10 px` radius; destructive actions disabled in MVP.
- Images: full-width, `object-fit: cover`, caption from triage `odia_summary`.
