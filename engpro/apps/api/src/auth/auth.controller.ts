import {
  Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { AllowWhenMustChangePassword, CurrentUser, JwtUser, Public } from '../common/auth.types';
import { LoginThrottlerGuard } from '../common/guards';
import { AuthService } from './auth.service';

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(64) username!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}

const COOKIE = 'engpro_rt';

function setRefreshCookie(res: Response, raw: string) {
  const days = parseInt(process.env.REFRESH_TTL_DAYS || '7', 10);
  res.cookie(COOKIE, raw, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: days * 86400_000,
  });
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: parseInt(process.env.THROTTLE_LIMIT || '5', 10), ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, user } = await this.auth.login(
      dto.username, dto.password, req.ip, req.headers['user-agent'],
    );
    setRefreshCookie(res, refreshToken);
    const full = await this.auth.me(user.id);
    return { accessToken, ...full };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[COOKIE];
    const { accessToken, refreshToken, user } = await this.auth.refresh(raw, req.headers['user-agent']);
    setRefreshCookie(res, refreshToken);
    const full = await this.auth.me(user.id);
    return { accessToken, ...full };
  }

  @AllowWhenMustChangePassword()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }

  @AllowWhenMustChangePassword()
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: JwtUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.auth.changePassword(
      user.sub, dto.currentPassword, dto.newPassword,
    );
    setRefreshCookie(res, refreshToken);
    return { accessToken, ok: true };
  }

  @AllowWhenMustChangePassword()
  @Get('me')
  async me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user.sub);
  }
}
