document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('help-btn').addEventListener('click', showHelp);
});

function showHelp() {
  alert(
    'How to use:\n\n' +
    '1. Open a supported puzzle page.\n' +
    '2. Use the floating on-page widget in the bottom-right corner.\n' +
    '3. Click Detect, then use Solve, Loop, Hint, Apply, Undo, or Redo from the widget.\n\n' +
    'If the widget is collapsed, click the puzzle icon to expand it.'
  );
}
