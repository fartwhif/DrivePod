import { HttpInterceptorFn, HttpRequest, HttpHandlerFn } from '@angular/common/http';

const TOKEN_KEY = 'drivepod_token';

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn) => {
  const token = localStorage.getItem(TOKEN_KEY);

  if (token && !req.url.includes('/auth/login')) {
    const cloned = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`
      }
    });
    return next(cloned);
  }

  return next(req);
};
