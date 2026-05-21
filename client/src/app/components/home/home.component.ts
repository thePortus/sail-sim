import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';

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
        email:    details.email,
        role:     details.role,
        token:    details.token,
      });
    }
    this._user.user$.subscribe(u => (this.user = u));
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
      error: () => {
        this.sailingCheck = false;
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
