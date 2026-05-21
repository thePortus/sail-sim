import { Component, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';

import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService } from './../../services/api.service';
import { AuthService } from './../../services/auth.service';
import { UserService } from './../../services/user.service';

@Component({
  selector: 'app-profile',
  imports: [
    RouterLink, CommonModule, MatCardModule, MatProgressSpinnerModule,
    MatIconModule, MatButtonModule, MatTooltipModule
  ],
  standalone: true,
  providers: [],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss'
})
export class ProfileComponent implements OnInit {
  // property to store data retreived from server
  public protectedData: any;
  // flags to store whether component has loaded fully and is error free
  public loading: boolean = true;
  public loadingError: boolean = false;

  constructor(
    private _api: ApiService,
    private _auth: AuthService,
    private _user: UserService,
    private _router: Router
  ) {}

  /**
   * Checks stored info for username, then gets updated user info from server
   */
  ngOnInit(): void {
    // get stored user information for username
    const userDetails = JSON.parse(this._auth.getUserDetails()!);
    // get updated user information from server
    this._api.getTypeRequest('profile/' + userDetails.username).subscribe((res: any) => {
      this.protectedData = res.data;
      this.loading = false;
    }, (error: any) => {
      this.loadingError = true;
    });
  }

  /**
   * Logs user out
   */
  logout() {
    this._auth.clearStorage();
    this._user.logout();
    this._router.navigate(['']);
  }


}
