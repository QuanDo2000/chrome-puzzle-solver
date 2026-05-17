# Content Script (content.js, 1899 lines)

Main orchestrator: widget UI, action handlers, canvas preview, localStorage caching, state watching.

## Widget (line 1001)

Fixed-position floating panel (bottom-left). Glassmorphism styling, collapsible to 48px circle.

### Buttons
- Detect: finds puzzle on page
- Solve: runs solver, shows preview
- Loop: hint preview -> Confirm -> auto-loop
- Hint: single hint display
- Apply: applies pending hint
- Undo/Redo: grid state stack (max 50)
- Fix Timer: restores game timer

### Canvas Preview (drawPreview, line 1148)
Renders grid cells (filled/crossed/empty), region borders (aquarium), galaxies boundaries and stars, hint highlights (row/col highlight, target cells, galaxy boundary lines, extra aquarium cells).

## Action Handlers

### detectHandler (line 1401)
Runs detection, reads state, draws preview, starts MutationObserver.

### solveHandler (line 1433)
Two-phase: first click solves and caches solution, shows preview (button -> Confirm). Second click applies solution to game board.

### loopHandler (line 1534)
First click: computes hint, shows preview (button -> Confirm). Second click: applies hint, starts auto-loop (button -> Stop). Auto-loop reads state, gets hint, applies, delays 300ms, repeats.

### hintHandler (line 1677)
Computes single hint, stores in puzzleData.pendingHint, enables Apply button, shows hint description with highlighted preview.

### applyHintHandler (line 1713)
Applies pending hint to game board (galaxies-lines or hintCells), redraws.

### undoHandler / redoHandler (lines 1842-1872)
Stack-based undo/redo using applySolution with skipUndo flag.

### timerFixHandler (line 1874)
Calls fixGameTimer in page's MAIN world via callMainWorld.

## State Watcher (line 1781)

MutationObserver watching attributes on detected puzzle element. On change: debounced 200ms, then re-reads state, redraws preview, recomputes hint if one is pending.

## Caching (lines 628-827)

LocalStorage-based caching for:
- Galaxy solutions (per puzzle dimensions + star positions)
- Partial grids (for retry on large puzzles)
- Failed partials (up to 20, to avoid re-exploring dead branches)
- Frontier grids (up to 80, for incremental Galaxies solving)

## Hint Utilities

- hintAbsoluteCells (line 829): converts row/col-relative hint cells to absolute coordinates
- applyHintToGrid (line 843): modifies grid in-place from hint data
- addAquariumRegionHints (line 853): expands aquarium hints to same-region cells
- hintStatusText (line 1125): unified format helper for hint status display
- fmtList (line 1737): collapses number sequences to ranges (e.g. "1-3, 5, 7-9")
