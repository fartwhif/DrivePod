import { Routes } from '@angular/router';
import { LoginComponent } from './login.component';
import { AppComponent } from './app.component';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: AppComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' }
];
