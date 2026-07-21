# Grindly logo — "Full Stop"

Picked 2026-07-21 from a 10-concept pitch. Thesis: no pictorial symbol — the
wordmark ends in a vermilion period.

## Files

- `mark.svg` — icon form ("g."), vermilion rounded square, paper "g" + period dot.
  Master at 512×512; every other icon size (favicon, PWA, apple-touch, extension,
  Android) is this same file rescaled, not a redraw.
- `wordmark.svg` — text lockup ("GRINDLY.") for contexts outside React (store
  listings, print, README badges).

## Palette

| Token       | Hex       |
|-------------|-----------|
| paper       | `#f2ece1` |
| ink         | `#17140f` |
| vermilion   | `#e3402a` |

## Where it's used

- `src/components/Brand.tsx` — canonical React `<Logo>`. `withWordmark` (default)
  renders "GRINDLY."; `withWordmark={false}` renders the `mark.svg` icon inline.
  Every in-app usage (nav, admin, login, dashboard, etc.) goes through this
  component — don't hand-roll the mark elsewhere.
- `public/favicon.svg`, `icon-192.svg`, `icon-512.svg`, `apple-touch-icon.svg`
  (+ their rasterized `.png` siblings) — same `mark.svg` geometry at each size.
- `public/manifest.json` — `theme_color`/`background_color` = vermilion/paper.
- `extension/icons/` — browser extension toolbar icon, same mark at 16/48/128px.
- `android/` (`colors.xml`, `AndroidManifest.xml`, `twa-manifest.json`) — TWA
  status bar / splash colors match the same palette; its launcher icon is
  pulled live from `icon-512.png` on grindly.in, so it updates automatically.

## Regenerating PNGs from an SVG source

No local rasterizer is installed; use `sharp` via npx (doesn't touch
`package.json`):

```
npx --yes -p sharp node -e "const sharp=require('sharp');sharp('public/favicon.svg').resize(192,192).png().toFile('public/icon-192.png')"
```
