import { Injectable } from '@angular/core';
import { HttpEvent, HttpHandler, HttpRequest, HttpInterceptor } from '@angular/common/http';
import { Observable } from 'rxjs';

import { AuthService } from './auth.service';

@Injectable()
export class InterceptorService implements HttpInterceptor {

  constructor(private _auth: AuthService) { }

  intercept (
    request: HttpRequest<any>,
    next: HttpHandler
  ): Observable<HttpEvent<any>> {
    const token = this._auth.getToken();

    let headers = request.headers
      .set('Accept', 'application/json');

    // Only set Content-Type for requests with a body
    if (request.body) {
      headers = headers.set('Content-Type', 'application/json');
    }

    // Attach Authorization header if token exists
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }

    const authReq = request.clone({ headers });

    return next.handle(authReq);
  }
}