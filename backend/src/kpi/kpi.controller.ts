import {
  BadRequestException, Body, Controller, Get, HttpCode, Post, Put, Query, Req, Res,
} from '@nestjs/common';
import {
  ArrayNotEmpty, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Request, Response } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { Heavy } from '../common/throttle';
import { KpiService } from './kpi.service';
import { ServiceScoped } from '../common/route-policy';

class SettingsDto {
  @IsInt() @Min(0) @Max(100) pointOpening!: number;
  @IsInt() @Min(0) @Max(100) pointOnTarget!: number;
  @IsInt() @Min(-100) @Max(0) pointMissTarget!: number;
}
class OpeningItemDto {
  @IsUUID() userId!: string;
  @IsInt() @Min(-100) @Max(100) points!: number;
}
class OpeningDto {
  @IsInt() @Min(2020) @Max(2100) year!: number;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => OpeningItemDto)
  items!: OpeningItemDto[];
}
class ManualEntryDto {
  @IsUUID() userId!: string;
  @IsInt() @Min(2020) @Max(2100) year!: number;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsInt() @Min(-100) @Max(100) points!: number;
  @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(200) description!: string;
}

@Controller('kpi')
export class KpiController {
  constructor(private kpi: KpiService) {}

  @ServiceScoped('scoring parameters are workspace-wide and read-only here')
  @Get('settings')
  getSettings(@CurrentUser() user: JwtUser) {
    return this.kpi.getSettings(user.ws);
  }

  @RequirePerm('kpi', 'edit')
  @Put('settings')
  putSettings(@CurrentUser() user: JwtUser, @Body() dto: SettingsDto, @Req() req: Request) {
    return this.kpi.putSettings(user, dto, req.ip);
  }

  @ServiceScoped('kpi.view sees the team; everyone else sees only their own row')
  @Heavy()
  @Get('summary')
  summary(@CurrentUser() user: JwtUser, @Query('year') year?: string, @Query('month') month?: string) {
    const y = parseInt(year || '', 10) || new Date().getFullYear();
    const m = parseInt(month || '', 10) || new Date().getMonth() + 1;
    if (m < 1 || m > 12) throw new BadRequestException('month must be 1-12');
    return this.kpi.summary(user, y, m);
  }

  @ServiceScoped('kpi.view sees the team; everyone else sees only their own entries')
  @Heavy()
  @Get('entries')
  entries(
    @CurrentUser() user: JwtUser,
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('userId') userId?: string,
  ) {
    const y = parseInt(year || '', 10) || new Date().getFullYear();
    const m = month ? parseInt(month, 10) : undefined;
    return this.kpi.entries(user, y, m, userId);
  }

  @RequirePerm('kpi', 'create')
  @Post('opening')
  @HttpCode(200)
  opening(@CurrentUser() user: JwtUser, @Body() dto: OpeningDto, @Req() req: Request) {
    return this.kpi.setOpening(user, dto, req.ip);
  }

  @RequirePerm('kpi', 'create')
  @Post('entries')
  manual(@CurrentUser() user: JwtUser, @Body() dto: ManualEntryDto, @Req() req: Request) {
    if (dto.points === 0) throw new BadRequestException('Points must be non-zero');
    return this.kpi.addManual(user, dto, req.ip);
  }

  @Heavy()
  @RequirePerm('kpi', 'view')
  @Get('export')
  async export(@CurrentUser() user: JwtUser, @Query('year') year: string, @Res() res: Response) {
    const y = parseInt(year || '', 10) || new Date().getFullYear();
    const csv = await this.kpi.exportCsv(user, y);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="engpro-kpi-${y}.csv"`);
    res.send(csv);
  }
}
