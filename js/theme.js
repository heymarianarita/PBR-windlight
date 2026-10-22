// Theme: System (follows the OS), Light or Dark. The header button cycles them; an explicit choice is saved.
const KEY = 'sky-maker:theme';
const MODES = ['system', 'light', 'dark'];
const root = document.documentElement;
const button = document.getElementById('theme-toggle');

const current = () => root.dataset.theme || 'system';

function render(mode) {
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  button.setAttribute('aria-label', `Theme: ${mode}. Switch to ${next}`);
  button.title = `Theme: ${mode}`;
  for (const icon of button.querySelectorAll('.theme-icon')) icon.hidden = icon.dataset.mode !== mode;
}

function apply(mode) {
  // Pause transitions for the frame the theme changes in, so every control switches together.
  root.classList.add('mds-theme-switching');
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch { /* storage unavailable */ }
  render(mode);
  void root.offsetHeight;
  setTimeout(() => root.classList.remove('mds-theme-switching'), 0);
}

button.addEventListener('click', () => apply(MODES[(MODES.indexOf(current()) + 1) % MODES.length]));
render(current());
