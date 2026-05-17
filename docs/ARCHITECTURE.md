# Architecture

## Overview

Chrome extension (Manifest v3) for solving puzzles on `puzzles-mobile.com`. Supports **Nonogram**, **Aquarium**, and **Galaxies** puzzle types.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  popup.html │────▶│   popup.js       │────▶│  background.js  │
│  (shell UI) │     │ (help/send msg)  │     │ (service worker)│
└─────────────┘     └──────────────────┘     └───────┬─────────┘
                                                     │
                                          chrome.runtime.sendMessage
                                          ("execMain" / "sendToContent")
                                                     │
                    ┌────────────────────────────────┤
                    ▼                                ▼
           ┌───────────────┐               ┌──────────────────┐
           │  content.js   │◀─────imports──│   handler.js     │
           │ (orchestrator)│               │ (detect/read/    │
           └───────┬───────┘               │  apply + registry)│
                   │                       └────────┬─────────┘
                   │                                │
           imports │                        imports │
                   ▼                                ▼
           ┌───────────────┐               ┌──────────────────┐
           │  solver.js    │               │   utils.js       │
           │ (puzzle logic)│               │ (PUZZLE_SELECTORS)│
           └───────────────┘               └──────────────────┘

   manifest.json ── declares all the above relationships
```

## File Roles

| File | Role |
|------|------|
| `manifest.json` | Extension config: permissions, content scripts, web resources |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup — informational only, no puzzle logic |
| `utils.js` | CSS selector constants (`PUZZLE_SELECTORS`) |
| `handler.js` | Puzzle abstraction layer: handler registry, detect/read/apply per type |
| `solver.js` | Three solver classes: `NonogramSolver`, `GalaxiesSolver`, `AquariumSolver` |
| `content.js` | Main orchestrator: widget UI, solve/loop/hint/apply/undo flows, canvas preview |
| `background.js` | Service worker: MAIN-world bridge, game API accessors, timer management |

## Handler Registry

Handlers implement `matches()` → `detect()` → `readState()` / `applySolution()`. Ordered by priority:

| Priority | Handler | Matches |
|----------|---------|---------|
| 25 | `galaxiesHandler` | `/galaxies/` path on puzzles-mobile |
| 20 | `aquariumHandler` | `/aquarium/` path on puzzles-mobile |
| 10 | `puzzlesMobileHandler` | Any puzzles-mobile page (task-based nonogram) |
| 1 | `genericHandler` | Always (DOM-scraping fallback) |

## MAIN World Bridge

`handler.js` exports `callMainWorld(funcName, args)` which sends a message to `background.js`. The service worker uses `chrome.scripting.executeScript` with `world: 'MAIN'` to inject the named function into the page's JavaScript context. This is how the extension reads/writes `window.Game` state.

## Widget UI

Fixed-position floating widget (bottom-left, glassmorphism). Canvas preview renders grid cells, region borders, galaxies boundaries/stars, and hint highlights. Buttons: Detect, Solve, Loop, Hint, Apply, Undo, Redo, Fix Timer.
