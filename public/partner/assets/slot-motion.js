/* One shared, keyboard-accessible control for decorative slot motion. */
(() => {
  const controls = [...document.querySelectorAll('[data-slot-toggle]')];
  controls.forEach(control => control.addEventListener('click', () => {
    const paused = document.documentElement.classList.toggle('slot-paused');
    controls.forEach(button => {
      const label = paused ? 'Play slot animation' : 'Pause slot animation';
      button.setAttribute('aria-pressed', String(paused));
      button.setAttribute('aria-label', label);
      button.title = label;
    });
  }));
})();
