import { Injectable } from '@angular/core';

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
   * Clears all local storage data.
   */
  clearStorage() {
    localStorage.clear();
  }
}
