import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs/operators';

import { Settings } from '../app.settings';

@Injectable({
  providedIn: 'root',
})

export class ApiService {

  baseUrl = Settings.apiUrl;

  constructor(private _http: HttpClient) {}

  /**
   * Returns the http response of a desired url.
   * 
   * @param url - URL of desired get request
   * @returns The http response object
   */
  getTypeRequest(url: string) {
    return this._http.get(`${this.baseUrl}${url}`).pipe(map(res => {
      return res;
    }));
  }

  /**
   * Returns the http response of a desired url as a blob.
   * 
   * @param url - URL of desired get request
   * @returns The http response object as a blob
   */
  getBlobRequest(url: string) {
    return this._http.get(`${this.baseUrl}${url}`, { responseType: 'blob' }).pipe(map(res => {
      return res;
    }));
  }

  /**
   * Returns the http response after posting data to desired url.
   * 
   * @param url - URL of desired post request
   * @param payload - The data to be posted
   * @returns The http response object
   */
  postTypeRequest(url: string, payload: object) {
    return this._http.post(`${this.baseUrl}${url}`, payload).pipe(map(res => {
      return res;
    }));
  }

  /**
   * Returns the http response after updating data to desired url.
   * 
   * @param url - URL of desired update request
   * @param payload - The data to be updated
   * @returns The http response object
   */
  putTypeRequest(url: string, payload: object) {
    return this._http.put(`${this.baseUrl}${url}`, payload).pipe(map(res => {
      return res;
    }));
  }

  /**
   * Returns the http response after deleting item at desired url.
   * 
   * @param url - URL of desired delete request
   * @returns The http response object
   */
  deleteTypeRequest(url: string) {
    return this._http.delete(`${this.baseUrl}${url}`).pipe(map(res => {
      return res;
    }));
  }

}
