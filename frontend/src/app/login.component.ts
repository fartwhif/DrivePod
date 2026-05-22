import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { AuthService, LoginCredentials, LoginResponse } from './services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: []
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  username = 'admin';
  password = 'demo123';
  error = '';
  loading = false;

  onSubmit() {
    this.error = '';
    this.loading = true;

    const credentials: LoginCredentials = {
      username: this.username,
      password: this.password
    };

    this.authService.login(credentials).subscribe({
      next: (response: LoginResponse) => {
        this.authService.saveAuth(response.token, response.user);
        this.router.navigate(['/']);
      },
      error: (err: any) => {
        this.error = err.error?.error || 'Login failed';
        this.loading = false;
      }
    });
  }
}
