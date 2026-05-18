# Puzzle Solver

A Chrome (MV3) extension that solves **Nonogram**, **Aquarium**, and **Galaxies** puzzles on [puzzles-mobile.com](https://www.puzzles-mobile.com).

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and toggle **Developer mode** on.
3. Click **Load unpacked** and select the project directory.

## Use

Open any supported puzzle page. A floating widget appears in the bottom-right corner:

- **Detect** — parse the puzzle from the page.
- **Solve** — run the solver and show a preview.
- **Apply** — write the solution back into the page.
- **Hint** — fill one or a few cells without revealing the full answer.
- **Loop** — keep solving + applying as the puzzle changes (e.g., for daily puzzles).
- **Undo / Redo** — step through prior apply states.

## Development

Requirements: Node 20+, `npm`.

```sh
npm install         # installs ESLint + tsc
npm test            # node:test suite, ~4s
npm run lint        # ESLint flat config
npm run typecheck   # tsc --noEmit; CI gates on this too
npm run capture     # regenerate tests/golden.js after solver changes
```

### Iterating on the extension

After editing any file under the project root, reload the extension to pick up changes:

1. Go to `chrome://extensions`.
2. Click the circular **reload** icon on the **Puzzle Solver** card.
3. Reload the puzzles-mobile.com tab — the content script only injects on page load.

UI bugs surface in DevTools opened on the *puzzle page* (the widget is a content script, not a popup). Service worker logs live under **service worker** on the `chrome://extensions` card.

### Bench scripts

```sh
node tests/bench.js            # synthetic 15×15 nonogram (intentionally ambiguous; solved=false is expected)
node tests/bench-galaxies.js   # 12×12 / 5-star galaxies
node tests/bench-aquarium.js   # 15×15 aquariumLarge fixture
node tests/bench-real.js       # all puzzles in tests/fixtures/real-puzzles.js
```

`bench-real.js` requires `tests/fixtures/real-puzzles.js` to be populated. To add a captured puzzle: open any supported puzzle page, click the widget's **📋 Dump** button — it writes a JSON snippet (matching the file's format) both to the clipboard and to `console.log` with prefix `[puzzle-solver dump]`. Paste it into `tests/fixtures/real-puzzles.js`.

Each bench warms up for 2 untimed iterations and exits nonzero on missing fixtures or unsolved puzzles (except `bench.js`, see comment above).

### Version control

This repo is a [Jujutsu](https://github.com/jj-vcs/jj) + git colocated workspace. Use `jj` for working-copy operations (`jj status`, `jj commit`, `jj log`). See `CLAUDE.md` for the conventional table of commands.

### Architecture

- `solver.js` — three solver classes (pure logic, runs in Node + Web Worker + content script).
- `solver.worker.js` — Web Worker entry point.
- `content.js` — widget UI, message dispatch, worker proxy.
- `handler.js` — per-puzzle-type page handlers (galaxies, aquarium, puzzles-mobile fallback).
- `background.js` — MV3 service worker; dispatches MAIN-world function calls.
- `main-world.js` — functions injected into the page context via `chrome.scripting.executeScript`.

`CLAUDE.md` covers the non-obvious bits (MV3 Worker cross-origin workaround, MAIN-world function serialization, performance patterns).

## License

Personal project, no license declared. Treat as all-rights-reserved unless that changes.
