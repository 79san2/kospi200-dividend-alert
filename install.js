const installButton = document.getElementById("install-app");
const installHelp = document.getElementById("install-help");
let installPrompt = null;

if (!window.matchMedia("(display-mode: standalone)").matches && !navigator.standalone) {
  installButton.hidden = false;
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  installHelp.hidden = true;
  installButton.setAttribute("aria-expanded", "false");
});

installButton.addEventListener("click", async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    try {
      await prompt.prompt();
      await prompt.userChoice;
      return;
    } catch {
      // A browser can withdraw its install prompt while the page is open.
    }
  }
  installHelp.hidden = !installHelp.hidden;
  installButton.setAttribute("aria-expanded", String(!installHelp.hidden));
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  installButton.hidden = true;
  installHelp.hidden = true;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // The browser's install menu and the online app also work without a worker.
  });
}
