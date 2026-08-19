// Builds a self-contained init script (source string) that hides all
// elements matching `selector` for `ms` milliseconds after document start.
// Building block for provoking timing-dependent test failures.
export function temporalScript(selector, ms) {
  const delay = Number(ms);
  return `(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(selector)} + ' { visibility: hidden !important; }';
    const attach = () => {
      if (document.documentElement) {
        document.documentElement.appendChild(style);
        return true;
      }
      return false;
    };
    if (!attach()) {
      new MutationObserver((records, observer) => {
        if (attach()) observer.disconnect();
      }).observe(document, { childList: true });
    }
    setTimeout(() => style.remove(), ${delay});
  })();`;
}
