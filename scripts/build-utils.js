'use strict';

// Shared helpers for the two bundlers (build-solver-bundle.js,
// build-content-bundle.js). Kept here so a fix to one applies to both — e.g.
// the directive strip below: divergent copies once let a comment-first
// 'use strict' leak a stray no-op statement into one bundle but not the other.

// Remove a file's leading `'use strict';` directive, tolerating header comments
// before it (a directive prologue may legally follow comments). After
// concatenation the directive would otherwise become a stray no-op string
// statement mid-bundle. Each bundle keeps a single top-of-file 'use strict'.
function stripLeadingUseStrict(s) {
  return s.replace(
    /^((?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*)'use strict';[ \t]*\r?\n/,
    '$1',
  );
}

module.exports = { stripLeadingUseStrict };
