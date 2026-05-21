import { Component, OnInit, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Observable } from 'rxjs';
import { NgForm, FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { MatInputModule } from '@angular/material/input';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBarModule, MatSnackBar, MatSnackBarRef } from '@angular/material/snack-bar';

import { ApiService } from './../../../services/api.service';
import { AuthService } from './../../../services/auth.service';
import { User, UserService } from './../../../services/user.service';

@Component({
  selector: 'app-update-password',
  imports: [
    CommonModule, FormsModule, MatInputModule, MatCardModule, MatButtonModule, MatSnackBarModule
  ],
  standalone: true,
  providers: [],
  templateUrl: './update.component.html',
  styleUrl: './update.component.scss'
})
export class UpdatePasswordComponent implements OnInit {
  // string input for the desired user to update, only used by admins
  @Input() userToUpdate: string = ''
  // local and server error messages
  errorMsgs: string[] = [];
  // observable and local object for user data
  userDetails$!: Observable<User>;
  user: any;
  
  constructor(
    private _api: ApiService,
    private _auth: AuthService,
    private _user: UserService,
    private _router: Router,
    private _snackBar: MatSnackBar
  ) {}

  /**
   * Checks if the user is logged in, and gets user details as an
   * observable if so.
   */
  ngOnInit(): void {
    // check local storage data whether user is already logged in
    this.isUserLogin();
    // get observable & set behavior on change
    this.userDetails$ = this._user.user$;
    this.userDetails$.subscribe(result => {
      this.user = result;
    });
  }

  /**
   * Submits user data to server and stores local user data from server response.
   * 
   * @param form Form data with user login info
   */
  onSubmit(form: NgForm) {
    if (form.value.newPassword != form.value.newPasswordConfirm) {
      this._snackBar.open('Confirmation password does not match!', '', { duration: 2000 });
      return;
    }
    let requestString = '';
    if (this.userToUpdate == '') {
      requestString = 'user/update/' + this.user.username
    }
    else {
      requestString = 'user/update/' + this.userToUpdate
    }
    let reqObject = {
      oldPassword: form.value.oldPassword,
      password: form.value.newPassword,
    };
    this._api.putTypeRequest(requestString, reqObject).subscribe((res: any) => {
      // if successful
      if (res.message == 'User was updated successfully.') {
        this._snackBar.open('User successfully updated!', '', { duration: 2000 });
        // navigate home after delay ONLY if user is not an admin (meaning this is the change password view)
        if (!this.userToUpdate) {
          setTimeout(() => { this._router.navigate(['']) }, 2000);
        }
      }
      // send error message
      else {
        this._snackBar.open('There was a problem updating the password, perhaps you did not enter matching passwords', '', { duration: 5000 });
      }
    }, (error: any) => {
      if (error.error.message == 'Password cannot be updated without matching old password.') {
        this._snackBar.open('There was a problem updating, Your old password did not match the one existing on file', '', { duration: 5000 });
      }
      else if (error.error.message == 'User not found or password incorrect') {
        this._snackBar.open('There was a problem updating, perhaps you did not enter matching passwords', '', { duration: 5000 });
      }
      else {
        this._snackBar.open('Problem connecting to server, perhaps server is down?!', '', { duration: 5000 });
      }
    });
  }

  /**
   * Uses auth service to see if user already has stored login data
   * in local storage. If so, then uses the user service to
   * store that data for the application.
   */
  isUserLogin() {
    if(this._auth.getUserDetails() != null) {
      const userDetails = JSON.parse(this._auth.getUserDetails()!);
      this._user.login({
        username: userDetails.username,
        email: userDetails.email,
        role: userDetails.role,
        token: userDetails.token
      });
    }
  }

  /**
   * Clears user data both from user service and from local storage
   */
  logout() {
    this._auth.clearStorage();
    this._user.logout();
    this._router.navigate(['']);
  }

}
