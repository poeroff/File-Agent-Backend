import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { GoogleSignInDto } from './dto/google-signin.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  async signInWithGoogle(@Body() dto: GoogleSignInDto) {
    const { accessToken } = await this.authService.signInWithGoogle(dto);
    return { accessToken };
  }
}
