import { useEffect, useState } from "react";
import { Download, Smartphone, Check, WifiOff } from "lucide-react";

type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export function useConnection() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

// iOS changes the visual viewport when its keyboard opens, even when dvh is unchanged.
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      if (viewport && viewport.scale !== 1) return;
      document.documentElement.style.setProperty(
        "--viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
      document.documentElement.classList.toggle(
        "keyboard-open",
        !!viewport && window.innerHeight - viewport.height > 120,
      );
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
}
export function ConnectionNotice({
  online,
  stale,
}: {
  online: boolean;
  stale: boolean;
}) {
  if (online && !stale) return null;
  return (
    <div className="connection-notice" role="status">
      <WifiOff size={16} />
      <span>
        {online
          ? "Reconnecting. Showing the last update."
          : "You’re offline. Reconnect to save changes or talk to the Foreman."}
      </span>
    </div>
  );
}
export function InstallCard() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  const [working, setWorking] = useState(false);
  const [installError, setInstallError] = useState(false);
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallEvent);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", done);
    // The listener in pwa.ts captures a prompt that arrives before Settings opens.
    setPrompt(window.companyInstallPrompt ?? null);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  return (
    <section className="install-card" aria-label="Install Company OS">
      <span className="install-icon">
        {installed ? <Check size={24} /> : <Smartphone size={24} />}
      </span>
      <div>
        <h2>{installed ? "App installed" : "Install Company OS"}</h2>
        <p>
          {installed
            ? "Company OS is running as an installed app."
            : ios
              ? "In Safari, open Share, then choose Add to Home Screen."
              : prompt
                ? "Open Company OS as its own app, right from your home screen or dock."
                : "Open your browser’s menu and choose Install app or Add to Home Screen, if available."}
        </p>
        <small>
          {installError
            ? "Use your browser’s menu to install the app."
            : "Conversations and changes need a connection."}
        </small>
      </div>
      {!installed && prompt && (
        <button
          className="primary"
          disabled={working}
          onClick={async () => {
            setWorking(true);
            try {
              await prompt.prompt();
              await prompt.userChoice;
              setPrompt(null);
              window.companyInstallPrompt = undefined;
            } catch {
              setInstallError(true);
            } finally {
              setWorking(false);
            }
          }}
        >
          <Download size={17} /> Install app
        </button>
      )}
    </section>
  );
}
declare global {
  interface Window {
    companyInstallPrompt?: InstallEvent;
  }
}
