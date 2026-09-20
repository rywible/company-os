window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.companyInstallPrompt = event as NonNullable<
    Window["companyInstallPrompt"]
  >;
});
window.addEventListener("appinstalled", () => {
  window.companyInstallPrompt = undefined;
});
if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .catch((error) => console.warn("Offline support unavailable", error));
  });
}
