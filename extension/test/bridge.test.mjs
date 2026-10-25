import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoApplyCodeFromUrl, autofillIdFromUrl } from '../src/bridge.js';

test('reads the application id and the one-time Auto apply code from the link', () => {
  const url = 'https://www.linkedin.com/jobs/view/9#jobhunt-autofill=12&jobhunt-auto=AbC_def-0123456789xyz';
  assert.equal(autofillIdFromUrl(url), 12);
  assert.equal(autoApplyCodeFromUrl(url), 'AbC_def-0123456789xyz');
  // Open & Autofill links have no code; "jobhunt-autofill" isn't one.
  assert.equal(autoApplyCodeFromUrl('https://x.test/job#jobhunt-autofill=12'), null);
  assert.equal(autoApplyCodeFromUrl('https://x.test/job#jobhunt-auto=short'), null);
  assert.equal(autoApplyCodeFromUrl('not a url'), null);
  // Only the fragment counts: a query string can be set by any page that links here.
  assert.equal(autoApplyCodeFromUrl('https://x.test/job?jobhunt-auto=AbC_def-0123456789xyz'), null);
});
