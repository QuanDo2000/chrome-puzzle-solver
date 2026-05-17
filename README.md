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
npm install        # installs ESLint
npm test           # node:test suite, ~4s
npm run lint       # ESLint flat config, no errors expected
```

### Bench scripts

```sh
node tests/bench.js            # synthetic nonograms
node tests/bench-galaxies.js
node tests/bench-aquarium.js
node tests/bench-real.js       # captured real puzzles
```

Capture a new real puzzle: click the widget's **📋 Dump** button on a puzzle page; it copies a JSON snippet (matching `tests/fixtures/real-puzzles.js`) to the clipboard.

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
