import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface User {
  username: string,
  callsign: string,
  role: string,
  token: string,
  loggedIn: boolean
}

@Injectable({
  providedIn: 'root'
})
export class UserService {

  private _user = new BehaviorSubject<User>({
    username: '',
    callsign: '',
    role: '',
    token: '',
    loggedIn: false
  });
  readonly user$ = this._user.asObservable();
  private user = {
    username: '',
    callsign: '',
    role: '',
    token: '',
    loggedIn: false
  };

  constructor() { }

  /**
   * Stores user login info for later use and sets login state, given a JSON of user data
   * Also stores the JWT token in localStorage for the interceptor.
   */
  login(userDetails: any) {
    this.user.username = userDetails.username;
    this.user.callsign = userDetails.callsign;
    this.user.role = userDetails.role;
    this.user.token = userDetails.token;
    this.user.loggedIn = true;
    this._user.next(Object.assign({}, this.user));
    // Store token in localStorage for interceptor
    localStorage.setItem('token', userDetails.token);
    localStorage.setItem('userData', JSON.stringify(userDetails));
  }

  /**
   * Logs the user out and removes user data.
   * Also removes the JWT token from localStorage.
   */
  logout() {
    this.user.username = '';
    this.user.callsign = '';
    this.user.role = '';
    this.user.token = '';
    this.user.loggedIn = false;
    this._user.next(Object.assign({}, this.user));
    // Remove token from localStorage
    localStorage.removeItem('token');
    localStorage.removeItem('userData');
  }
}