import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Observable } from 'rxjs';
import { NgForm, FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';

import { ApiService } from './../../../services/api.service';
import { AuthService } from './../../../services/auth.service';
import { User, UserService } from './../../../services/user.service';
import { DownloadClientComponent } from '../../download-client/download-client.component';

@Component({
  selector: 'app-login',
  imports: [RouterLink, CommonModule, FormsModule, MatSnackBarModule, DownloadClientComponent],
  standalone: true,
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent implements OnInit {
  errorMsgs: string[] = [];
  userDetails$!: Observable<User>;
  user: any;
  /** True when the player was bounced here because their stored session had expired (shows a banner). */
  expiredNotice = false;

  constructor(
    private _api: ApiService,
    private _auth: AuthService,
    private _user: UserService,
    private _router: Router,
    private _snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.expiredNotice = this._auth.consumeSessionExpired();
    this.isUserLogin();
    this.userDetails$ = this._user.user$;
    this.userDetails$.subscribe(result => { this.user = result; });
  }

  onSubmit(form: NgForm) {
    this._api.postTypeRequest('user/login', form.value).subscribe((res: any) => {
      if (res.token) {
        this._auth.setDataInLocalStorage('userData', JSON.stringify(res));
        this._auth.setDataInLocalStorage('token', res.token);
        this._user.login({
          username: res.username,
          callsign:    res.callsign,
          role:     res.role,
          token:    res.token,
        });
        this._snackBar.open('Signed in!', '', { duration: 2000 });
        this._router.navigate(['']);
      } else {
        this._snackBar.open('Check your username and password.', '', { duration: 5000 });
      }
    }, (error: any) => {
      const msg = error?.error?.message;
      if (msg === 'User not found.' || msg === 'Invalid password.') {
        this._snackBar.open('Incorrect username or password.', '', { duration: 5000 });
      } else {
        this._snackBar.open('Could not reach the server.', '', { duration: 5000 });
      }
    });
  }

  isUserLogin() {
    if (this._auth.getUserDetails() != null) {
      const d = JSON.parse(this._auth.getUserDetails()!);
      this._user.login({ username: d.username, callsign: d.callsign, role: d.role, token: d.token });
    }
  }

  logout() {
    this._auth.clearStorage();
    this._user.logout();
    this._router.navigate(['']);
  }
}
