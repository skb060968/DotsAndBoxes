let toastTimer;

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.hidden = screen.id !== id;
  });
  document.getElementById(id)?.focus({ preventScroll: true });
}

export function showToast(message, duration = 2200) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('visible'));
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => { toast.hidden = true; }, 180);
  }, duration);
}
