# Icons

The Chrome Web Store requires PNG icons. Add these three, then wire them into
`manifest.json`:

- `icon16.png` — 16×16 (toolbar)
- `icon48.png` — 48×48 (extensions page)
- `icon128.png` — 128×128 (store listing, required)

Then add to `manifest.json`:

```json
"icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
"action": {
  "default_title": "Grindly Apply Assistant",
  "default_popup": "src/popup/popup.html",
  "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

Use the Grindly mark (the coral “G”) on a transparent background. `logo.svg` here is
the source; export it to the three PNG sizes with any tool (e.g. `rsvg-convert`,
Figma, or an online SVG→PNG). Icons are intentionally left out of the committed
manifest so the extension loads cleanly for development without binary assets.
