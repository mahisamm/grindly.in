# Icons

Done — `icon16.png`, `icon48.png`, `icon128.png` are generated from `logo.svg`
(via `sharp`) and wired into `manifest.json`. To regenerate after changing the
logo:

```
node -e "const s=require('sharp');['16','48','128'].forEach(n=>s('logo.svg').resize(+n,+n).png().toFile('icon'+n+'.png'))"
```

(run from this `icons/` directory).
