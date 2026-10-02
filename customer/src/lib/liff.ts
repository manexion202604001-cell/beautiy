import liff from "@line/liff";

let liffInitialized = false;

export async function initLiff(liffId: string): Promise<boolean> {
  if (liffInitialized) return true;

  try {
    await liff.init({ liffId });
    liffInitialized = true;
    return true;
  } catch (error) {
    console.error("[LIFF] Init failed:", error);
    return false;
  }
}

export function isInLiffBrowser(): boolean {
  if (!liffInitialized) return false;
  return liff.isInClient();
}

export function getLiffAccessToken(): string | null {
  if (!liffInitialized || !liff.isLoggedIn()) return null;
  return liff.getAccessToken();
}

export function isLiffLoggedIn(): boolean {
  if (!liffInitialized) return false;
  return liff.isLoggedIn();
}

export function liffLogin(redirectUri?: string): void {
  if (!liffInitialized) return;
  liff.login({ redirectUri });
}

export function closeLiffWindow(): void {
  if (liffInitialized) {
    liff.closeWindow();
  }
}
