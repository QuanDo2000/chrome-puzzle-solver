const PUZZLE_SELECTORS = {
  grid: [
    'table.nonogram_grid td',
    '.nonogram-grid td',
    '.puzzle-grid td',
    '.grid-cell',
    '[class*="grid"] td',
    '[class*="grid"] [class*="cell"]',
  ],
  rowClues: [
    '.row-clues td, .row-clues li, .row_clues td',
    '[class*="rowClue"] td, [class*="rowClue"] li',
    '[class*="row-clue"] td, [class*="row-clue"] li',
    '[class*="row_clue"] td, [class*="row_clue"] li',
  ],
  colClues: [
    '.col-clues td, .col-clues li, .col_clues td',
    '[class*="colClue"] td, [class*="colClue"] li',
    '[class*="col-clue"] td, [class*="col-clue"] li',
    '[class*="col_clue"] td, [class*="col_clue"] li',
  ],
};
