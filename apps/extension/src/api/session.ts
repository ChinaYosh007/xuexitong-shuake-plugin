import type { LoginResponse } from "@study/contracts";

const SESSION_KEY = "studyAssistantSession";

export interface StoredSession {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  username: string;
  userId: string;
}

export async function ensureTrustedStorageAccess(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // setAccessLevel is best effort on older builds; content scripts never request storage.
  }
}

export function isSessionExpired(session: StoredSession, now = Date.now()): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export async function saveSession(login: LoginResponse): Promise<StoredSession> {
  const session: StoredSession = {
    accessToken: login.accessToken,
    tokenType: "Bearer",
    expiresAt: login.expiresAt,
    username: login.user.username,
    userId: login.user.id
  };
  await ensureTrustedStorageAccess();
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  return session;
}

export async function loadSession(): Promise<StoredSession | null> {
  await ensureTrustedStorageAccess();
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const value = stored[SESSION_KEY] as StoredSession | undefined;
  if (!value || typeof value.accessToken !== "string" || !value.accessToken) {
    return null;
  }
  if (isSessionExpired(value)) {
    await clearSession();
    return null;
  }
  return value;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
