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
  selector: 'app-register',
  imports: [RouterLink, CommonModule, FormsModule, MatSnackBarModule, DownloadClientComponent],
  standalone: true,
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss'
})
export class RegisterComponent implements OnInit {
  errorMessage: any;
  showErrorMessage = false;
  loading = false;
  userDetails$!: Observable<User>;
  user: any;

  constructor(
    private _api: ApiService,
    private _auth: AuthService,
    private _user: UserService,
    private _router: Router,
    private _snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.isUserLogin();
    this.userDetails$ = this._user.user$;
    this.userDetails$.subscribe(result => { this.user = result; });
  }

  isUserLogin() {
    if (this._auth.getUserDetails() != null) {
      const d = JSON.parse(this._auth.getUserDetails()!);
      this._user.login({ username: d.username, callsign: d.callsign, role: d.role, token: d.token });
    }
  }

  onSubmit(form: NgForm) {
    this.showErrorMessage = false;

    if (form.value.password !== form.value.password2) {
      this.errorMessage = 'Passwords must match.';
      this.showErrorMessage = true;
      return;
    }

    this.loading = true;
    this._api.postTypeRequest('user/register', form.value).subscribe((res: any) => {
      if (res.user) {
        // Auto-login with the same credentials immediately after registration
        this._api.postTypeRequest('user/login', {
          username: form.value.username,
          password: form.value.password,
        }).subscribe((loginRes: any) => {
          this.loading = false;
          if (loginRes.token) {
            this._auth.setDataInLocalStorage('userData', JSON.stringify(loginRes));
            this._auth.setDataInLocalStorage('token', loginRes.token);
            this._user.login({
              username: loginRes.username,
              callsign:    loginRes.callsign,
              role:     loginRes.role,
              token:    loginRes.token,
            });
            this._snackBar.open('Account created — welcome!', '', { duration: 3000 });
            this._router.navigate(['']);
          } else {
            // Registered OK but auto-login didn't return a token — go to login
            this._router.navigate(['/login']);
          }
        }, () => {
          this.loading = false;
          this._router.navigate(['/login']);
        });
      } else {
        this.loading = false;
        this.errorMessage = res.message || 'Registration failed.';
        this.showErrorMessage = true;
      }
    }, (error: any) => {
      this.loading = false;
      this.errorMessage = error?.error?.message || 'Could not reach the server.';
      this.showErrorMessage = true;
    });
  }

  logout() {
    this._auth.clearStorage();
    this._user.logout();
    this._router.navigate(['']);
  }
}
