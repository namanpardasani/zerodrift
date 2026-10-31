# Design

- `zerodrift-design-reference.html`: the approved design, the source of truth for colours, type, spacing, components and
  every animation. Open it in a browser; each "plate" has a replay button.
- `refs/increase.png`, `refs/teenage-engineering.png`: inspiration only (never copy their logos, images or copy).
- `shoot.mjs`: screenshots every plate of the reference (`screenshots/reference/`). Run it in the e2e image:

```bash
docker run --rm -v "$PWD/design:/design:ro" -v "$PWD/screenshots/reference:/shots" \
  -v "$PWD/design/shoot.mjs:/e2e/shoot.mjs:ro" zerodrift-e2e node /e2e/shoot.mjs
```

The implementation lives in `packages/ui` (tokens in `src/theme.css`, components in `src/*.tsx`), and `/styleguide`
in the console shows every token and component on the real components. See the "Design system" section of NOTES.md.
