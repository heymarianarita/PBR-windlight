// Theme: Light, Dark or System (follows the OS), picked in the header's three-option switch.
// An explicit choice is saved; System clears it.
const KEY = 'sky-maker:theme';
const root = document.documentElement;
const themeSwitch = document.getElementById('theme-switch');
const themeButtons = [...themeSwitch.querySelectorAll('[role="radio"]')];

const current = () => root.dataset.theme || 'system';

// Only the current option is in the tab order (radio-group pattern).
function renderThemeSwitch(mode) {
  for (const b of themeButtons) {
    const on = b.dataset.mode === mode;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
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
  renderThemeSwitch(mode);
  void root.offsetHeight;
  setTimeout(() => root.classList.remove('mds-theme-switching'), 0);
}

themeSwitch.addEventListener('click', (e) => {
  const b = e.target.closest('[role="radio"]');
  if (b) apply(b.dataset.mode);
});

// Radio-group keyboard: arrows move and select, Home/End jump.
themeSwitch.addEventListener('keydown', (e) => {
  const i = themeButtons.indexOf(document.activeElement);
  if (i < 0) return;
  const n = themeButtons.length;
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const b = themeButtons[(to + n) % n];
  b.focus();
  apply(b.dataset.mode);
});

renderThemeSwitch(current());
