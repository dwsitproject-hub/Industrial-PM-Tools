import {
  Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Request, Response } from 'express';
import { AllowWhenMustChangePassword, CurrentUser, JwtUser, Public } from '../common/auth.types';
import { LoginThrottlerGuard } from '../common/guards';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { PrismaService } from '../prisma.service';

class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
class ForgotPasswordDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) email!: string;
}
class TokenPasswordDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MaxLength(128) newPassword!: string;
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
  constructor(
    private auth: AuthService,
    private tokens: TokensService,
    private prisma: PrismaService,
  ) {}

  private async company(): Promise<string> {
    const ws = await this.prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
    return ws?.company || 'EngPro';
  }

  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: parseInt(process.env.THROTTLE_LIMIT || '5', 10), ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, user } = await this.auth.login(
      dto.email, dto.password, req.ip, req.headers['user-agent'],
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

  /** Always 200 — never reveals whether an address is registered. */
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: parseInt(process.env.THROTTLE_LIMIT || '5', 10), ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, await this.company(), req.ip);
    return { ok: true, message: 'If that address belongs to an account, a reset link is on its way.' };
  }

  /** Link pre-flight so the page can show a clear message instead of failing on submit. */
  @Public()
  @Get('reset-password/:token')
  async checkReset(@Param('token') token: string) {
    const row = await this.tokens.peek(token, 'PASSWORD_RESET');
    return { valid: true, email: row.user.email, fullName: row.user.fullName };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: TokenPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto.token, dto.newPassword, req.ip);
  }

  @Public()
  @Get('activate/:token')
  async checkActivation(@Param('token') token: string) {
    const row = await this.tokens.peek(token, 'ACTIVATION');
    return { valid: true, email: row.user.email, fullName: row.user.fullName };
  }

  @Public()
  @Post('activate')
  @HttpCode(200)
  activate(@Body() dto: TokenPasswordDto, @Req() req: Request) {
    return this.auth.activate(dto.token, dto.newPassword, req.ip);
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
