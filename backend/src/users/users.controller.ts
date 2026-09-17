import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import {
  IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { UsersService } from './users.service';

class CreateUserDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) email!: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  /** optional: derived from the email local-part when omitted (legacy identifier, not used to log in) */
  @IsOptional() @IsString() @Matches(/^[a-z0-9._-]{3,32}$/i, { message: 'username must be 3-32 chars: letters, digits, . _ -' })
  username?: string;
  @IsIn(['MANAGER', 'ADMIN', 'SITE_ADMIN', 'ESTIMATOR']) role!: string;
  @IsOptional() @IsUUID() siteId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) avatarColor?: number;
}
class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) email?: string;
  @IsOptional() @IsIn(['MANAGER', 'ADMIN', 'SITE_ADMIN', 'ESTIMATOR']) role?: string;
  @IsOptional() @IsUUID() siteId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) avatarColor?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  async list(@CurrentUser() user: JwtUser, @Query('role') role?: string, @Query('active') active?: string) {
    return this.users.list(user, role, active);
  }

  @RequirePerm('stUsers', 'create')
  @Post()
  async create(@CurrentUser() user: JwtUser, @Body() dto: CreateUserDto, @Req() req: Request) {
    if (dto.role === 'SITE_ADMIN' && !dto.siteId) {
      throw new BadRequestException('siteId is required for SITE_ADMIN users');
    }
    return this.users.create(user, dto, req.ip);
  }

  @RequirePerm('stUsers', 'edit')
  @Patch(':id')
  async update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: Request) {
    const found = await this.users.update(user, id, dto, req.ip);
    if (!found) throw new NotFoundException();
    return found;
  }

  @RequirePerm('stUsers', 'edit')
  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.users.resetPassword(user, id, req.ip);
  }

  @RequirePerm('stUsers', 'edit')
  @Post(':id/resend-activation')
  @HttpCode(200)
  async resendActivation(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.users.resendActivation(user, id, req.ip);
  }

  @RequirePerm('stUsers', 'delete')
  @Delete(':id')
  async deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.users.softDelete(user, id, req.ip);
  }
}
