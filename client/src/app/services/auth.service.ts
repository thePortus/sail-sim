import { Injectable, signal } from '@angular/core';

/**
 * AuthService provides methods to store and retrieve user info
 * from local client storage. It does not provide methods
 * to check on user login status. For that user UserService.
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor() { }

  /** Set when a stored session is found to be expired/invalid (a 401/403 on a validated request), so the auth
   *  flow auto-logs-out and the login screen can explain WHY the player is back there ("session expired"). In
   *  memory (not localStorage) so it survives clearStorage but is gone on a real page refresh. */
  readonly sessionExpired = signal(false);
  flagSessionExpired(): void { this.sessionExpired.set(true); }
  /** Read-and-clear: true exactly once after a session expiry, for the login banner. */
  consumeSessionExpired(): boolean {
    const v = this.sessionExpired();
    if (v) { this.sessionExpired.set(false); }
    return v;
  }

  /**
   * Checks local storage for stored data. Returns null if no data stored.
   * 
   * @returns JSON of user data, or null if not found
   */
  getUserDetails() {
    if(localStorage.getItem('userData')) {
      return localStorage.getItem('userData');
    }
    // return null if no data found
    else {
      return null;
    }
  }

  /**
   * Stores data at a specific property in local storage.
   * 
   * @param variableName - Name of the property to be set
   * @param data - Data to be stored at property
   */
  setDataInLocalStorage(variableName: string, data: any) {
    localStorage.setItem(variableName, data);
  }

  /**
   * Gets the value of the user's current JSON Web Token
   * 
   * @returns - String of the JWT
   */
  getToken() {
    return localStorage.getItem('token');
  }

  /**
   * Clear AUTH/session state, but PRESERVE the player's game settings (every `ignis_*` key — music on/off &
   * volume, graphics presets, draft/mask overrides, physics, etc.). This runs on every auth flow (login,
   * register, logout, profile update, game teardown); a blanket `localStorage.clear()` here was wiping those
   * preferences, so e.g. music-off was forgotten and music restarted itself after a re-login/session refresh.
   */
  clearStorage() {
    const keep: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ignis_')) { const v = localStorage.getItem(k); if (v !== null) keep[k] = v; }
    }
    localStorage.clear();
    for (const k of Object.keys(keep)) localStorage.setItem(k, keep[k]);
  }
}
