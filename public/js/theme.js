(function selectInitialTheme() {
  'use strict';

  let storedTheme = null;
  try {
    storedTheme = window.localStorage?.getItem('theme');
  } catch {
    storedTheme = null;
  }

  let theme = storedTheme === 'light' || storedTheme === 'dark'
    ? storedTheme
    : 'light';

  if (storedTheme !== 'light' && storedTheme !== 'dark') {
    try {
      theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    } catch {
      theme = 'light';
    }
  }

  document.documentElement.dataset.theme = theme;
})();
