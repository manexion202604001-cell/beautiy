import { tokenStorage } from "./api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getPermissionState(): NotificationPermission | null {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return Notification.permission;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function getDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Unknown";
}

async function getVapidPublicKey(): Promise<string> {
  const token = tokenStorage.get();
  const res = await fetch(`${API_URL}/api/push/vapid-public-key`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to get VAPID key");
  const data = await res.json();
  return data.publicKey;
}

export async function subscribePush(): Promise<boolean> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    const registration = await navigator.serviceWorker.ready;
    const vapidPublicKey = await getVapidPublicKey();

    const appServerKey = urlBase64ToUint8Array(vapidPublicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey.buffer as ArrayBuffer,
    });

    const token = tokenStorage.get();
    const res = await fetch(`${API_URL}/api/push/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        device_name: getDeviceName(),
      }),
    });

    return res.ok;
  } catch (error) {
    console.error("Push subscription failed:", error);
    return false;
  }
}

export async function unsubscribePush(): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      const token = tokenStorage.get();
      await fetch(`${API_URL}/api/push/subscriptions`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      await subscription.unsubscribe();
    }
    return true;
  } catch (error) {
    console.error("Push unsubscribe failed:", error);
    return false;
  }
}

export async function isSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch {
    return false;
  }
}
