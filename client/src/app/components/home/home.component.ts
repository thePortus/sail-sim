import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

import { AuthService } from './../../services/auth.service';
import { User, UserService } from './../../services/user.service';
import { Settings } from '../../app.settings';

@Component({
  selector: 'app-home',
  imports: [CommonModule, RouterLink],
  standalone: true,
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})
export class HomeComponent implements OnInit {
  user: User | null = null;

  sailingCheck = false;
  sailError    = '';

  constructor(
    private _auth:   AuthService,
    private _user:   UserService,
    private _router: Router,
    private _http:   HttpClient
  ) {}

  ngOnInit(): void {
    if (this._auth.getUserDetails() != null) {
      const details = JSON.parse(this._auth.getUserDetails()!);
      this._user.login({
        username: details.username,
        callsign:    details.callsign,
        role:     details.role,
        token:    details.token,
      });
      // The stored token may have EXPIRED since last visit. Validate it now so we never strand the player on a
      // "logged in as X" screen they can't actually use — if it's dead, auto-log-out and send them to sign in
      // again (with an explanation), rather than waiting for them to puzzle out the logout button.
      this.validateSession();
    }
    this._user.user$.subscribe(u => (this.user = u));
  }

  /** Confirm the stored JWT is still accepted by the server; on 401/403 auto-logout + route to login. */
  private validateSession(): void {
    this._http.get(`${Settings.apiUrl}user/me`).subscribe({
      next: () => { /* token still valid — stay signed in */ },
      error: (e: HttpErrorResponse) => {
        if (e.status === 401 || e.status === 403) { this.expireSession(); }
        // other errors (network / 5xx) are transient — leave the session as-is
      },
    });
  }

  /** Stored credentials are expired/invalid: clear them, drop the logged-in state, and send the player to the
   *  login screen with a one-time "your session expired" notice. */
  private expireSession(): void {
    this._auth.flagSessionExpired();
    this._auth.clearStorage();
    this._user.logout();
    this._router.navigate(['/login']);
  }

  setSail(): void {
    this.sailError = '';

    if (!this.user?.loggedIn) {
      this.sailError = 'You must be logged in to sail. Please sign in or create an account.';
      return;
    }

    // Lightweight server reachability check against the vessels endpoint
    this.sailingCheck = true;
    this._http.get(`${Settings.apiUrl}vessels`, { responseType: 'json' }).subscribe({
      next: () => {
        this.sailingCheck = false;
        this._router.navigate(['/game']);
      },
      error: (e: HttpErrorResponse) => {
        this.sailingCheck = false;
        // An expired/invalid token here (token died between page-load and clicking Sail) → re-auth flow,
        // not a misleading "can't reach server" message.
        if (e?.status === 401 || e?.status === 403) { this.expireSession(); return; }
        this.sailError = 'Cannot reach the server. Please check your connection or try again shortly.';
      },
    });
  }

  logout(): void {
    this._auth.clearStorage();
    this._user.logout();
    this._router.navigate(['']);
  }
}
